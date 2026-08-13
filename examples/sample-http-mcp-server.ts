import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const mcp = new McpServer(
  { name: 'mcp-local-workbench-http-sample', version: '1.0.0' },
  { instructions: 'Deterministic Streamable HTTP test server.' },
);

mcp.registerTool(
  'add',
  {
    description: 'Add two finite numbers over Streamable HTTP.',
    inputSchema: { a: z.number().finite(), b: z.number().finite() },
    outputSchema: { sum: z.number() },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async ({ a, b }) => ({
    content: [{ type: 'text', text: String(a + b) }],
    structuredContent: { sum: a + b },
  }),
);

const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
await mcp.connect(transport);

const http = createServer(async (request: IncomingMessage, response: ServerResponse) => {
  if (new URL(request.url ?? '/', 'http://127.0.0.1').pathname !== '/mcp') {
    response.writeHead(404).end();
    return;
  }
  await transport.handleRequest(request, response);
});

const requestedPort = Number.parseInt(process.env.MCP_HTTP_PORT ?? '0', 10);
await new Promise<void>((resolve) => http.listen(requestedPort, '127.0.0.1', resolve));
const address = http.address();
if (!address || typeof address === 'string') throw new Error('HTTP sample failed to bind');
console.log(`MCP_HTTP_URL=http://127.0.0.1:${address.port}/mcp`);

async function close(): Promise<void> {
  await mcp.close();
  await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void close().finally(() => process.exit(0)));
