import { resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { describe, expect, test } from 'vitest';
import { McpManager, serverConfigSchema } from '../src/mcp/manager.js';
import { createSafeLookup, validateHttpEndpoint } from '../src/mcp/validation.js';
import { redact, registerSecretValue, unregisterSecretValue } from '../src/core/redaction.js';

const tsxCli = resolve('node_modules/tsx/dist/cli.mjs');
const sampleServer = resolve('examples/sample-mcp-server.ts');
const httpSampleServer = resolve('examples/sample-http-mcp-server.ts');
const execFileAsync = promisify(execFile);
const stderrLeakRunner = resolve('test/fixtures/stdio-secret-leak-runner.ts');

describe('MCP endpoint validation', () => {
  test.each([
    'file:///tmp/socket',
    'http://user:pass@127.0.0.1:3000/mcp',
    'http://169.254.169.254/latest/meta-data',
    'http://metadata.google.internal/mcp',
  ])('blocks unsafe endpoint %s', async (endpoint) => {
    await expect(validateHttpEndpoint(endpoint)).rejects.toThrow();
  });

  test('accepts a loopback HTTP endpoint', async () => {
    await expect(validateHttpEndpoint('http://127.0.0.1:3000/mcp')).resolves.toBeInstanceOf(URL);
  });

  test('revalidates and returns the same DNS answer used by the actual socket connection', async () => {
    let call = 0;
    const lookup = createSafeLookup((_hostname, _options, callback) => {
      call += 1;
      callback(null, call === 1 ? [{ address: '203.0.113.10', family: 4 }] : [{ address: '169.254.169.254', family: 4 }]);
    });
    await expect(new Promise((resolveResult, reject) => lookup('example.test', { all: true }, (error, addresses) => error ? reject(error) : resolveResult(addresses))))
      .resolves.toEqual([{ address: '203.0.113.10', family: 4 }]);
    await expect(new Promise((resolveResult, reject) => lookup('example.test', { all: true }, (error, addresses) => error ? reject(error) : resolveResult(addresses))))
      .rejects.toThrow(/blocked/i);
  });
});

describe('MCP secret references', () => {
  test('rejects inline secrets anywhere an environment variable name is required', () => {
    expect(() => serverConfigSchema.parse({
      id: 'stdio', name: 'stdio', transport: 'stdio', command: 'node',
      envRefs: { API_TOKEN: 'Bearer raw-secret' },
    })).toThrow(/environment variable name/i);

    expect(() => serverConfigSchema.parse({
      id: 'http', name: 'http', transport: 'http', url: 'http://127.0.0.1:3000/mcp',
      headerEnv: { Authorization: 'Bearer raw-secret' },
      oauth: { clientId: 'public-client', clientSecretEnv: 'client-secret-value' },
    })).toThrow(/environment variable name/i);
  });

  test('rejects invalid stdio environment target names', () => {
    for (const input of [
      { envRefs: { 'BAD=NAME': 'SOURCE_ENV' } },
      { env: { 'BAD=NAME': { source: 'env' as const, name: 'SOURCE_ENV' } } },
    ]) {
      expect(() => serverConfigSchema.parse({
        id: 'stdio', name: 'stdio', transport: 'stdio', command: 'node', ...input,
      })).toThrow(/environment variable name/i);
    }
  });

  test('rejects duplicate targets across stdio environment maps', () => {
    expect(() => serverConfigSchema.parse({
      id: 'stdio', name: 'stdio', transport: 'stdio', command: 'node',
      envRefs: { API_TOKEN: 'LEGACY_TOKEN' },
      env: { api_token: { source: 'env', name: 'MANAGED_TOKEN' } },
    })).toThrow(/duplicate environment target/i);
  });
});

describe('real sample MCP server over stdio', () => {
  test('discovers identity, capabilities, schemas and invokes deterministic tools', async () => {
    const manager = new McpManager();
    try {
      await manager.connect({
        id: 'sample',
        name: 'Deterministic sample',
        transport: 'stdio',
        command: process.execPath,
        args: [tsxCli, sampleServer],
      });

      const inspection = await manager.inspect('sample');
      expect(inspection.identity).toMatchObject({ name: 'mcp-riksa-sample', version: '1.0.0' });
      expect(inspection.capabilities).toHaveProperty('tools');
      expect(inspection.tools.map((tool) => tool.name)).toEqual(['add', 'unannotated_read', 'echo', 'dangerous_reset']);
      expect(inspection.tools[0]?.inputSchema).toHaveProperty('properties');

      const sum = await manager.call('sample', 'add', { a: 2, b: 3 });
      expect(sum.structuredContent).toEqual({ sum: 5 });
      const unannotated = await manager.call('sample', 'unannotated_read', {});
      expect(unannotated.structuredContent).toEqual({ value: 'read-only' });

      await expect(manager.call('sample', 'dangerous_reset', {})).rejects.toThrow(/confirmation/i);
      const confirmed = await manager.call('sample', 'dangerous_reset', {}, { confirmDangerous: true });
      expect(confirmed.structuredContent).toEqual({ reset: false, reason: 'sample-only' });
    } finally {
      await manager.closeAll();
    }
    expect(manager.connectionCount).toBe(0);
  });

  test('does not inherit child stderr when managed credentials are injected', async () => {
    const result = await execFileAsync(process.execPath, [tsxCli, stderrLeakRunner], { cwd: resolve('.') });
    expect(result.stderr).not.toContain('stdio-leak-regression-secret');
    expect(result.stderr).not.toContain('child stderr secret=');
    expect(Buffer.byteLength(result.stderr, 'utf8')).toBeLessThan(1024);
  });

  test('retains resolved credentials for the connected transport lifetime', async () => {
    let current = 'old-connected-secret';
    let registered: string | undefined;
    const resolver = async () => {
      if (registered !== current) {
        unregisterSecretValue(registered);
        registerSecretValue(current);
        registered = current;
      }
      return current;
    };
    const manager = new McpManager(resolver);
    try {
      await manager.connect({
        id: 'leased-stdio', name: 'Leased stdio', transport: 'stdio', command: process.execPath,
        args: [tsxCli, sampleServer], env: { API_TOKEN: { source: 'env', name: 'IGNORED_BY_TEST_RESOLVER' } },
      });
      current = 'new-connected-secret';
      await resolver();
      expect(redact('old-connected-secret new-connected-secret')).toBe('[REDACTED] [REDACTED]');

      await manager.disconnect('leased-stdio');
      expect(redact('old-connected-secret new-connected-secret')).toBe('old-connected-secret [REDACTED]');
    } finally {
      await manager.closeAll();
      unregisterSecretValue(registered);
    }
  });

  test('redacts connection errors that reflect the resolved credential before releasing the lease', async () => {
    const credential = 'http-connect-failure-secret';
    const server = createServer((request, response) => {
      response.writeHead(502, { 'content-type': 'text/plain' });
      response.end(`upstream rejected credential: ${request.headers.authorization ?? ''}`);
    });
    server.listen(0);
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Expected a bound TCP address');
    const url = `http://127.0.0.1:${address.port}/mcp`;
    const manager = new McpManager(async () => credential);
    try {
      await expect(manager.connect({
        id: 'failing-http', name: 'Failing HTTP', transport: 'http', url, allowUnsafeEndpoint: true,
        headers: { authorization: { source: 'env', name: 'IGNORED_BY_TEST_RESOLVER' } },
      })).rejects.toThrow(/\[REDACTED\]/);
      expect(manager.connectionCount).toBe(0);
      expect(redact(credential)).toBe(credential);
    } finally {
      await manager.closeAll();
      await new Promise((resolveClose) => server.close(() => resolveClose(undefined)));
    }
  });
});

describe('real sample MCP server over Streamable HTTP', () => {
  test('discovers and invokes tools through the HTTP transport', async () => {
    const child = spawn(process.execPath, [tsxCli, httpSampleServer], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    const errorChunks: Buffer[] = [];
    child.stdout.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => errorChunks.push(Buffer.from(chunk)));
    const deadline = Date.now() + 5000;
    let url = '';
    while (!url && Date.now() < deadline) {
      const match = Buffer.concat(chunks).toString('utf8').match(/MCP_HTTP_URL=(\S+)/);
      if (match) url = match[1]!;
      else await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
    if (!url) throw new Error('Streamable HTTP sample did not become ready');

    const manager = new McpManager();
    try {
      const inspection = await manager.connect({ id: 'http-sample', name: 'HTTP sample', transport: 'http', url, allowUnsafeEndpoint: true });
      expect(inspection.transport).toBe('http');
      expect(inspection.tools.map((tool) => tool.name)).toEqual(['add']);
      const result = await manager.call('http-sample', 'add', { a: 19, b: 23 });
      expect(result.structuredContent).toEqual({ sum: 42 });
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nHTTP sample stderr: ${Buffer.concat(errorChunks).toString('utf8')}`);
    } finally {
      await manager.closeAll();
      child.kill('SIGTERM');
      if (child.exitCode === null) await once(child, 'exit');
    }
  });
});
