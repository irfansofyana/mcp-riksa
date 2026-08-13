#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer(
  { name: 'mcp-local-workbench-sample', version: '1.0.0' },
  { capabilities: { logging: {} }, instructions: 'Deterministic tools for MCP Local Workbench tests.' },
);

server.registerTool(
  'add',
  {
    description: 'Add two finite numbers.',
    inputSchema: { a: z.number().finite(), b: z.number().finite() },
    outputSchema: { sum: z.number() },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async ({ a, b }) => ({
    content: [{ type: 'text', text: String(a + b) }],
    structuredContent: { sum: a + b },
  }),
);

server.registerTool(
  'echo',
  {
    description: 'Return exactly the supplied text.',
    inputSchema: { text: z.string() },
    outputSchema: { text: z.string() },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async ({ text }) => ({
    content: [{ type: 'text', text }],
    structuredContent: { text },
  }),
);

server.registerTool(
  'dangerous_reset',
  {
    description: 'Demonstrate a destructive annotation without changing anything.',
    inputSchema: {},
    outputSchema: { reset: z.boolean(), reason: z.string() },
    annotations: { destructiveHint: true, idempotentHint: false },
  },
  async () => ({
    content: [{ type: 'text', text: 'No state changed: sample-only' }],
    structuredContent: { reset: false, reason: 'sample-only' },
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('MCP Local Workbench sample server ready on stdio');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void server.close().finally(() => process.exit(0));
  });
}
