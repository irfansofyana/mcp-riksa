import { resolve } from 'node:path';
import { McpManager } from '../../src/mcp/manager.js';

const secret = 'stdio-leak-regression-secret';
const manager = new McpManager(async () => secret);
try {
  await manager.connect({
    id: 'stderr-leak',
    name: 'Stderr leak test',
    transport: 'stdio',
    command: process.execPath,
    args: [resolve('node_modules/tsx/dist/cli.mjs'), resolve('test/fixtures/stdio-secret-leak-server.ts')],
    envRefs: {},
    env: { TEST_STDIO_SECRET: { source: 'session', id: 'secret_00000000-0000-4000-8000-000000000000' } },
  });
} finally {
  await manager.closeAll();
}
