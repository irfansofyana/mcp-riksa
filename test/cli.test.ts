import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, test } from 'vitest';
import { EncryptedFileSecretBackend } from '../src/secrets/encrypted-file.js';
import { SecretStore } from '../src/secrets/store.js';
import { DEFAULT_DATA_DIRECTORY, dataDirectoryStartupMessage, resolveDataDirectory } from '../src/cli/data-dir.js';
import { httpServerOrigin, loopbackCallbackUrl, prepareServeWorkspace, resolveServeWorkspace, serveWorkspaceStartupMessages } from '../src/cli/workspace.js';

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

function startServe(args: string[], marker: RegExp, beforeStop?: (stdout: string) => Promise<void>) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveRun, reject) => {
    const child = spawn(process.execPath, [tsxCli, workbenchCli, 'serve', ...args], { cwd: resolve('.'), env: process.env });
    let stdout = '';
    let stderr = '';
    let stopping = false;
    let inspectionError: Error | undefined;
    const receive = (chunk: unknown) => {
      stdout += String(chunk);
      if (!stopping && marker.test(stdout)) {
        stopping = true;
        void (beforeStop?.(stdout) ?? Promise.resolve())
          .catch((error: unknown) => { inspectionError = error instanceof Error ? error : new Error(String(error)); })
          .finally(() => setTimeout(() => child.kill('SIGTERM'), 50));
      }
    };
    child.stdout.on('data', receive);
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('close', (code) => inspectionError ? reject(inspectionError) : resolveRun({ code, stdout, stderr }));
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
    expect(serveHelp.stdout).toContain('--workspace <path>');
    expect(serveHelp.stdout).toContain('--suites-dir <path>');
  });

  test('resolves repository suites separately from ignored runtime state', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mcp-workspace-'));
    directories.push(directory);
    const workspaceDirectory = join(directory, 'repo');
    mkdirSync(workspaceDirectory);
    writeFileSync(join(workspaceDirectory, 'mcp-riksa.config.yaml'), 'version: 2\nservers: []\nproviders: []\n');

    const workspace = resolveServeWorkspace({ workspace: workspaceDirectory }, {});
    expect(workspace).toEqual({
      mode: 'repository',
      workspaceDirectory: resolve(workspaceDirectory),
      configPath: resolve(workspaceDirectory, 'mcp-riksa.config.yaml'),
      suiteDirectory: resolve(workspaceDirectory, 'suites'),
      dataDirectory: resolve(workspaceDirectory, '.mcp-riksa'),
    });
    expect(serveWorkspaceStartupMessages(workspace)).toContain(`MCP Riksa suites: ${resolve(workspaceDirectory, 'suites')}`);
    mkdirSync(join(workspace.dataDirectory, 'suites'), { recursive: true });
    writeFileSync(join(workspace.dataDirectory, 'suites', 'legacy.yaml'), 'legacy');
    expect(serveWorkspaceStartupMessages(workspace)).toContain(
      `MCP Riksa migration: suites exist in ${join(workspace.dataDirectory, 'suites')}; review and copy them into ${workspace.suiteDirectory}`,
    );

    const custom = resolveServeWorkspace({
      workspace: workspaceDirectory,
      suitesDir: join(directory, 'tracked-suites'),
      dataDir: join(directory, 'state'),
    }, {});
    expect(custom.suiteDirectory).toBe(resolve(directory, 'tracked-suites'));
    expect(custom.dataDirectory).toBe(resolve(directory, 'state'));
  });

  test('preserves local suite defaults and rejects overlapping repository paths', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mcp-layout-'));
    directories.push(directory);
    const workspaceDirectory = join(directory, 'repo');
    mkdirSync(workspaceDirectory);
    writeFileSync(join(workspaceDirectory, 'mcp-riksa.config.yaml'), 'version: 2\nservers: []\nproviders: []\n');

    expect(resolveServeWorkspace({ dataDir: 'state' }, {}, directory)).toMatchObject({
      mode: 'local',
      dataDirectory: resolve(directory, 'state'),
      suiteDirectory: resolve(directory, 'state/suites'),
    });
    expect(() => resolveServeWorkspace({ workspace: workspaceDirectory, dataDir: workspaceDirectory }, {}))
      .toThrow('Runtime data directory cannot be the workspace root');
    expect(() => resolveServeWorkspace({ workspace: workspaceDirectory, dataDir: join(workspaceDirectory, 'state'), suitesDir: join(workspaceDirectory, 'state/suites') }, {}))
      .toThrow('cannot overlap');
  });

  test.skipIf(process.platform === 'win32')('rejects symlinked managed directories and symlink-parent escapes', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mcp-symlink-layout-'));
    directories.push(directory);
    const workspaceDirectory = join(directory, 'repo');
    const externalDirectory = join(directory, 'external');
    mkdirSync(workspaceDirectory);
    mkdirSync(join(externalDirectory, 'suites'), { recursive: true });
    writeFileSync(join(workspaceDirectory, 'mcp-riksa.config.yaml'), 'version: 2\nservers: []\nproviders: []\n');

    symlinkSync(join(externalDirectory, 'suites'), join(workspaceDirectory, 'suites'));
    expect(() => prepareServeWorkspace(resolveServeWorkspace({ workspace: workspaceDirectory }, {})))
      .toThrow('Suite directory cannot be a symbolic link');
    rmSync(join(workspaceDirectory, 'suites'));
    rmSync(join(workspaceDirectory, '.mcp-riksa'), { recursive: true, force: true });

    symlinkSync(externalDirectory, join(workspaceDirectory, '.mcp-riksa'));
    expect(() => prepareServeWorkspace(resolveServeWorkspace({ workspace: workspaceDirectory }, {})))
      .toThrow('Runtime data directory cannot be a symbolic link');
    rmSync(join(workspaceDirectory, '.mcp-riksa'));

    symlinkSync(externalDirectory, join(workspaceDirectory, 'linked-parent'));
    const escapedSuiteDirectory = join(workspaceDirectory, 'linked-parent/new-suites');
    expect(() => prepareServeWorkspace(resolveServeWorkspace({
      workspace: workspaceDirectory,
      suitesDir: escapedSuiteDirectory,
    }, {}))).toThrow('cannot escape the workspace');
    expect(existsSync(join(externalDirectory, 'new-suites'))).toBe(false);
  });

  test('formats reachable loopback callback URLs', () => {
    expect(loopbackCallbackUrl('127.0.0.1', 4317)).toBe('http://127.0.0.1:4317/api/oauth/callback');
    expect(loopbackCallbackUrl('localhost', 4317)).toBe('http://localhost:4317/api/oauth/callback');
    expect(loopbackCallbackUrl('::1', 4317)).toBe('http://[::1]:4317/api/oauth/callback');
    expect(httpServerOrigin('::1', 4317)).toBe('http://[::1]:4317');
  });

  test('rejects duplicate repository configuration IDs before listening', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mcp-duplicate-config-'));
    directories.push(directory);
    writeFileSync(join(directory, 'mcp-riksa.config.yaml'), `version: 2
servers:
  - { id: duplicate, name: First, transport: stdio, command: node }
  - { id: duplicate, name: Second, transport: stdio, command: node }
providers: []
`);
    const result = await execute(['serve', '--workspace', directory, '--port', '0']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Duplicate server ID duplicate');
  });

  test('starts repository mode with tracked suites and explicit diagnostics', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mcp-repository-serve-'));
    directories.push(directory);
    mkdirSync(join(directory, 'suites'));
    writeFileSync(join(directory, 'mcp-riksa.config.yaml'), 'version: 2\nservers: []\nproviders: []\n');
    writeFileSync(join(directory, 'suites', 'smoke.yaml'), 'version: 1\nname: smoke\ncases:\n  - id: smoke\n    kind: direct\n    server: notion\n    call: { tool: search, arguments: {} }\n    assertions: []\n');

    const result = await startServe(['--workspace', directory, '--port', '0'], /MCP Riksa OAuth: process memory only/, async (output) => {
      const origin = output.match(/MCP Riksa listening at (http:\/\/[^\s]+)/)?.[1];
      if (!origin) throw new Error('Listening origin missing');
      const settings = await (await fetch(`${origin}/api/settings`)).json() as { callbackUrl?: string };
      if (settings.callbackUrl !== `${origin}/api/oauth/callback`) {
        throw new Error(`Ephemeral OAuth callback mismatch: ${settings.callbackUrl}`);
      }
    });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('MCP Riksa mode: repository');
    expect(result.stdout).toContain(`MCP Riksa suites: ${join(directory, 'suites')}`);
    expect(result.stdout).toContain(`MCP Riksa data: ${join(directory, '.mcp-riksa')}`);
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
