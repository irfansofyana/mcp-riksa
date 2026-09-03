import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, test } from 'vitest';
import { runBrowserSmoke } from '../scripts/smoke-browser.js';

const children: ChildProcess[] = [];
const directories: string[] = [];

function start(command: string, args: string[], marker: RegExp, env = process.env) {
  return new Promise<{ child: ChildProcess; match: RegExpMatchArray; output(): string }>((resolveStart, reject) => {
    const child = spawn(command, args, { cwd: resolve('.'), env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let output = '';
    const receive = (chunk: unknown) => {
      output += String(chunk);
      const match = output.match(marker);
      if (match) resolveStart({ child, match, output: () => output });
    };
    child.stdout?.on('data', receive);
    child.stderr?.on('data', receive);
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`Process exited ${code}: ${output}`)));
  });
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (!child.killed) child.kill('SIGTERM');
  }
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('browser success path', () => {
  test('adds, inspects, invokes, plays, saves, runs, traces and compares at desktop and mobile', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mcp-browser-'));
    directories.push(directory);
    const tsx = resolve('node_modules/tsx/dist/cli.mjs');
    const fake = await start(process.execPath, [tsx, resolve('scripts/fake-provider.ts'), '--port', '0', '--delay-ms', '250'], /Fake provider listening at (http:\/\/127\.0\.0\.1:\d+)/);
    const providerUrl = fake.match[1]!;
    const app = await start(
      process.execPath,
      [tsx, resolve('src/cli/index.ts'), 'serve', '--dev', '--port', '0', '--data-dir', join(directory, 'data')],
      /MCP Riksa listening at (http:\/\/127\.0\.0\.1:\d+)/,
      { ...process.env, MCP_RIKSA_PROVIDER_API_KEY: 'browser-only-secret' },
    );
    const appUrl = app.match[1]!;

    let result;
    try {
      result = await runBrowserSmoke({ appUrl, providerUrl: `${providerUrl}/v1`, outputDirectory: join(directory, 'screens') });
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nAPP PROCESS:\n${app.output()}\nFAKE PROVIDER:\n${fake.output()}`);
    }
    expect(result.steps).toEqual([
      'theme-checked', 'secret-managed', 'provider-added', 'server-added', 'server-inspected', 'tool-invoked', 'suite-creation-checked',
      'playground-complete', 'suite-saved', 'direct-editor-cleanup-checked', 'case-id-cleanup-checked',
      'turn-id-cleanup-checked', 'first-run-inspected-live-progress', 'first-run-inspected',
      'second-run-inspected-live-progress', 'second-run-inspected', 'run-refresh-race-guarded',
      'active-run-reselection-guarded', 'conformance-page-checked', 'runs-compared', 'mobile-checked',
    ]);
    expect(result.consoleErrors).toEqual([]);
    expect(result.lightScreenshot).toMatch(/light-mode\.png$/);
    expect(result.secretsScreenshot).toMatch(/secrets\.png$/);
    expect(result.serverScreenshot).toMatch(/stdio-server\.png$/);
    expect(result.suiteScreenshot).toMatch(/suite-creation\.png$/);
    expect(result.desktopScreenshot).toMatch(/desktop\.png$/);
    expect(result.mobileScreenshot).toMatch(/mobile\.png$/);
  }, 120_000);
});
