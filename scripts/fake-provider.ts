#!/usr/bin/env node
import { createServer } from 'node:http';

const portIndex = process.argv.indexOf('--port');
const port = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 4000;
const delayIndex = process.argv.indexOf('--delay-ms');
const delayMs = delayIndex >= 0 ? Number(process.argv[delayIndex + 1]) : 0;

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const json = (value: unknown, status = 200) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value));
  };
  if (request.method === 'GET' && url.pathname === '/v1/models') {
    return json({ object: 'list', data: [{ id: 'test-model', object: 'model', created: 1, owned_by: 'local-fake' }] });
  }
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;

  if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    const messages = Array.isArray(body.messages) ? body.messages as Array<{ role?: string; content?: unknown }> : [];
    const isSuiteGeneration = messages.some((message) => message.role === 'system' && String(message.content).includes('author MCP test case plans'));
    const hasToolResult = messages.some((message) => message.role === 'tool');
    if (body.stream === true) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (value: unknown) => response.write(`data: ${JSON.stringify(value)}\n\n`);
      if (hasToolResult) {
        send({ id: 'fake-final', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta: { content: '## Result\n\nThe **sum ' }, finish_reason: null }] });
        send({ id: 'fake-final', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta: { content: 'is 5**.\n\n- Tool: `add`\n- Status: complete' }, finish_reason: 'stop' }] });
      } else {
        send({ id: 'fake-tool', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'fake-call-1', function: { name: 'add', arguments: '{"a":2,"b":3}' } }] }, finish_reason: 'tool_calls' }] });
      }
      send({ id: 'fake-usage', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [], usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 } });
      response.end('data: [DONE]\n\n');
      return;
    }
    if (isSuiteGeneration) {
      return json({
        id: 'fake-suite-generation', object: 'chat.completion', created: 1, model: 'test-model',
        choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({
          cases: [
            { tool: 'add', prompt: 'Add 2 and 3.', arguments: { a: 2, b: 3 } },
            { tool: 'unannotated_read', prompt: 'Read the deterministic sample value.', arguments: {} },
            { tool: 'echo', prompt: 'Echo the text hello.', arguments: { text: 'hello' } },
          ],
          exclusions: [],
        }) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 },
      });
    }
    return json({
      id: hasToolResult ? 'fake-final' : 'fake-tool', object: 'chat.completion', created: 1, model: 'test-model',
      choices: [{ index: 0, message: hasToolResult
        ? { role: 'assistant', content: '## Result\n\nThe **sum is 5**.\n\n- Tool: `add`\n- Status: complete' }
        : { role: 'assistant', content: null, tool_calls: [{ id: 'fake-call-1', type: 'function', function: { name: 'add', arguments: '{"a":2,"b":3}' } }] },
      finish_reason: hasToolResult ? 'stop' : 'tool_calls' }],
      usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 },
    });
  }
  if (request.method === 'POST' && url.pathname === '/v1/messages') {
    const hasToolResult = JSON.stringify(body).includes('tool_result');
    return json({
      id: hasToolResult ? 'fake-anthropic-final' : 'fake-anthropic-tool', type: 'message', role: 'assistant', model: 'test-model',
      content: hasToolResult ? [{ type: 'text', text: 'The sum is 5' }] : [{ type: 'tool_use', id: 'fake-call-1', name: 'add', input: { a: 2, b: 3 } }],
      stop_reason: hasToolResult ? 'end_turn' : 'tool_use', usage: { input_tokens: 35, output_tokens: 8 },
    });
  }
  return json({ error: 'not found' }, 404);
});

await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', resolve);
});
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Fake provider did not bind');
process.stdout.write(`Fake provider listening at http://127.0.0.1:${address.port}\n`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
