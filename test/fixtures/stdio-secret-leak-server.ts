import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

process.stderr.write(`child stderr secret=${process.env.TEST_STDIO_SECRET ?? 'missing'} ${'diagnostic'.repeat(131_072)}\n`);
const server = new McpServer({ name: 'stderr-leak-test', version: '1.0.0' });
server.registerTool('ready', { inputSchema: {}, outputSchema: { ready: z.boolean() } }, async () => ({
  content: [{ type: 'text', text: 'ready' }],
  structuredContent: { ready: true },
}));
await server.connect(new StdioServerTransport());
