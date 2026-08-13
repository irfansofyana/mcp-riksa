import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, test } from 'vitest';
import { McpManager, serverConfigSchema } from '../src/mcp/manager.js';
import { createSafeLookup, validateHttpEndpoint } from '../src/mcp/validation.js';

const tsxCli = resolve('node_modules/tsx/dist/cli.mjs');
const sampleServer = resolve('examples/sample-mcp-server.ts');
const httpSampleServer = resolve('examples/sample-http-mcp-server.ts');

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
      expect(inspection.identity).toMatchObject({ name: 'mcp-local-workbench-sample', version: '1.0.0' });
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
