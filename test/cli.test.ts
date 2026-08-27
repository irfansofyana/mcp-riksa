import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, test } from 'vitest';
import { EncryptedFileSecretBackend } from '../src/secrets/encrypted-file.js';
import { SecretStore } from '../src/secrets/store.js';
import { DEFAULT_DATA_DIRECTORY, dataDirectoryStartupMessage, resolveDataDirectory } from '../src/cli/data-dir.js';

const directories: string[] = [];
const tsxCli = resolve('node_modules/tsx/dist/cli.mjs');
const workbenchCli = resolve('src/cli/index.ts');

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function execute(args: string[], environment: NodeJS.ProcessEnv = process.env) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveRun, reject) => {
    const child = spawn(process.execPath, [tsxCli, workbenchCli, ...args], { cwd: resolve('.'), env: environment });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('close', (code) => resolveRun({ code, stdout, stderr }));
  });
}

describe('headless CLI', () => {
  test('resolves explicit, environment, then project-local runtime data directories', () => {
    expect(resolveDataDirectory('/tmp/explicit', { MCP_RIKSA_DATA_HOME: '/tmp/environment' })).toBe('/tmp/explicit');
    expect(resolveDataDirectory(undefined, { MCP_RIKSA_DATA_HOME: '/tmp/environment' })).toBe('/tmp/environment');
    expect(resolveDataDirectory(undefined, {})).toBe(resolve(DEFAULT_DATA_DIRECTORY));
    expect(dataDirectoryStartupMessage('/tmp/mcp-riksa')).toBe('MCP Riksa data: /tmp/mcp-riksa');
  });

  test('exposes MCP Riksa package and CLI identifiers', async () => {
    const packageMetadata = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { name?: string; bin?: Record<string, string> };
    expect(packageMetadata).toMatchObject({
      name: 'mcp-riksa',
      bin: { 'mcp-riksa': 'dist/src/cli/index.js' },
    });
    const result = await execute(['--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Usage: mcp-riksa');
    const serveHelp = await execute(['serve', '--help']);
    expect(serveHelp.stdout).toContain('MCP_RIKSA_DATA_HOME');
  });

  test('inspects the real deterministic sample server as JSON', async () => {
    const result = await execute(['inspect', '--sample', '--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      identity: { name: 'mcp-riksa-sample' },
      tools: expect.arrayContaining([expect.objectContaining({ name: 'add' })]),
    });
  });

  test('inspects a configured server with a vault-backed stdio value', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mcp-cli-vault-'));
    directories.push(directory);
    const dataDirectory = join(directory, 'data');
    const configDirectory = join(directory, 'config-home');
    const store = new SecretStore({ vaultBackend: new EncryptedFileSecretBackend({ dataDirectory, configDirectory }) });
    const secret = await store.create({ backend: 'vault', label: 'CLI token', purposes: ['stdio-env'], value: 'cli-vault-secret' });
    await store.close();
    const config = join(directory, 'config.yaml');
    writeFileSync(config, `version: 2\nservers:\n  - id: sample\n    name: Sample\n    transport: stdio\n    command: ${JSON.stringify(process.execPath)}\n    args:\n      - ${JSON.stringify(tsxCli)}\n      - ${JSON.stringify(resolve('examples/sample-mcp-server.ts'))}\n    env:\n      TEST_TOKEN:\n        source: vault\n        id: ${secret.id}\nproviders: []\n`);

    const result = await execute(
      ['inspect', '--config', config, '--server', 'sample', '--data-dir', dataDirectory, '--json'],
      { ...process.env, MCP_RIKSA_CONFIG_HOME: configDirectory },
    );

    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ identity: { name: 'mcp-riksa-sample' } });
    expect(result.stdout).not.toContain('cli-vault-secret');
  });

  test('runs the portable sample suite and emits JSON, HTML and JUnit reports', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mcp-cli-'));
    directories.push(directory);
    const reports = join(directory, 'reports');
    const config = join(directory, 'config.yaml');
    writeFileSync(config, `version: 2\nservers:\n  - id: sample\n    name: Sample\n    transport: stdio\n    command: ${JSON.stringify(process.execPath)}\n    args:\n      - ${JSON.stringify(tsxCli)}\n      - ${JSON.stringify(resolve('examples/sample-mcp-server.ts'))}\nproviders: []\n`);
    const result = await execute([
      'run', resolve('examples/sample-suite.yaml'), '--config', config, '--data-dir', join(directory, 'data'), '--output', reports,
    ]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'passed', summary: { passRate: 1 } });
    expect(JSON.parse(readFileSync(join(reports, 'run.json'), 'utf8')).status).toBe('passed');
    expect(readFileSync(join(reports, 'run.html'), 'utf8')).toMatch(/^<!doctype html>/i);
    expect(readFileSync(join(reports, 'junit.xml'), 'utf8')).toContain('<testsuite');
  });
});
