import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { redact } from '../core/redaction.js';
import { normalizeConformanceChecks } from './model.js';
import type { ConformanceExecution, ConformanceRunner, ConformanceSelection } from './types.js';

const MAX_STREAM_BYTES = 256 * 1024;
const MAX_REPORT_BYTES = 5 * 1024 * 1024;
const MAX_CHECK_FILE_BYTES = 1024 * 1024;
const require = createRequire(import.meta.url);

function executablePath(): string {
  return join(dirname(require.resolve('@modelcontextprotocol/conformance/package.json')), 'dist', 'index.js');
}

function appendBounded(current: string, chunk: Buffer, limit: number): string {
  if (Buffer.byteLength(current) >= limit) return current;
  const remaining = limit - Buffer.byteLength(current);
  const next = chunk.subarray(0, remaining).toString('utf8');
  return current + next;
}

async function checkFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name === 'checks.json') output.push(path);
    }
  };
  await walk(root);
  return output.sort();
}

function scenarioFromPath(path: string, selection: ConformanceSelection): string {
  if (selection.kind === 'scenario') return selection.scenario;
  const directory = dirname(path).split(/[\\/]/).at(-1) ?? 'unknown';
  return directory.replace(/^server-/, '').replace(/-\d{4}-\d{2}-\d{2}T.*$/, '') || 'unknown';
}

export class OfficialConformanceRunner implements ConformanceRunner {
  async run(input: { endpoint: string; selection: ConformanceSelection; timeoutMs: number }, signal: AbortSignal): Promise<ConformanceExecution> {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'mcp-conformance-'));
    const args = [
      executablePath(), 'server', '--url', input.endpoint,
      ...(input.selection.kind === 'scenario' ? ['--scenario', input.selection.scenario] : ['--suite', 'active']),
      '--output-dir', outputDirectory, '--verbose',
    ];
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let cancelled = false;
    let terminationTimer: NodeJS.Timeout | undefined;
    let timeout: NodeJS.Timeout | undefined;
    try {
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(process.execPath, args, {
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { PATH: process.env.PATH ?? '', NO_COLOR: '1' },
        });
        const terminate = (reason: 'cancelled' | 'timeout') => {
          if (child.exitCode !== null || child.signalCode !== null) return;
          cancelled = reason === 'cancelled';
          timedOut = reason === 'timeout';
          child.kill('SIGTERM');
          terminationTimer = setTimeout(() => child.kill('SIGKILL'), 2_000);
          terminationTimer.unref();
        };
        const abort = () => terminate('cancelled');
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        timeout = setTimeout(() => terminate('timeout'), input.timeoutMs);
        timeout.unref();
        child.stdout?.on('data', (chunk: Buffer) => { stdout = appendBounded(stdout, chunk, MAX_STREAM_BYTES); });
        child.stderr?.on('data', (chunk: Buffer) => { stderr = appendBounded(stderr, chunk, MAX_STREAM_BYTES); });
        child.once('error', reject);
        child.once('close', (code) => {
          signal.removeEventListener('abort', abort);
          resolve(code);
        });
      });
      const files: Array<{ scenario: string; value: unknown }> = [];
      let reportBytes = 0;
      for (const path of await checkFiles(outputDirectory)) {
        const size = (await stat(path)).size;
        if (size > MAX_CHECK_FILE_BYTES || reportBytes + size > MAX_REPORT_BYTES) throw new Error('Conformance report exceeded storage bounds');
        reportBytes += size;
        const value: unknown = JSON.parse(await readFile(path, 'utf8'));
        files.push({ scenario: scenarioFromPath(path, input.selection), value });
      }
      const checks = normalizeConformanceChecks(files);
      const diagnostic = checks.length === 0 || (exitCode !== 0 && checks.every((entry) => entry.status === 'passed'))
        ? redact((stderr || stdout || `Conformance runner exited with code ${exitCode}`).slice(0, MAX_STREAM_BYTES))
        : undefined;
      return {
        checks,
        exitCode,
        timedOut,
        cancelled,
        rawReport: redact({ runner: '@modelcontextprotocol/conformance', files, stdout, stderr, exitCode }),
        ...(diagnostic ? { diagnostic } : {}),
      };
    } finally {
      if (timeout) clearTimeout(timeout);
      if (terminationTimer) clearTimeout(terminationTimer);
      await rm(outputDirectory, { recursive: true, force: true });
    }
  }
}
