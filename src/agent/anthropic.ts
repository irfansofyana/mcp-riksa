import { z } from 'zod';
import { Agent, fetch as undiciFetch } from 'undici';
import type { ProviderAdapter, ProviderMessage } from './types.js';
import { providerConfigSchema, resolveApiKey, resolveModel, resolveProviderHeaders } from './types.js';
import { createSafeLookup } from '../mcp/validation.js';

const contentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }).passthrough(),
  z.object({ type: z.literal('tool_use'), id: z.string(), name: z.string(), input: z.record(z.string(), z.unknown()) }).passthrough(),
]);
const responseSchema = z.object({
  content: z.array(contentSchema),
  stop_reason: z.string().nullable(),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).optional(),
}).passthrough();

function messages(input: ProviderMessage[]) {
  return input.map((message) => {
    if (message.role === 'user') return { role: 'user', content: message.content };
    if (message.role === 'assistant') {
      return {
        role: 'assistant',
        content: [
          ...(message.content ? [{ type: 'text', text: message.content }] : []),
          ...message.toolCalls.map((call) => ({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments })),
        ],
      };
    }
    return {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: message.toolCallId, content: message.content }],
    };
  });
}

export function createAnthropicAdapter(input: unknown): ProviderAdapter {
  const config = providerConfigSchema.parse(input);
  const dispatcher = new Agent({ connect: { lookup: createSafeLookup() } });
  const endpoint = `${config.baseUrl.replace(/\/$/, '')}/messages`;
  return {
    id: config.id,
    pricing: config.pricing,
    async complete(request) {
      const headers = {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        ...resolveProviderHeaders(config),
        ...(resolveApiKey(config) === undefined ? {} : { 'x-api-key': resolveApiKey(config)! }),
      };
      const response = await (undiciFetch as unknown as (
        input: string | URL,
        init: RequestInit & { dispatcher: Agent },
      ) => Promise<Response>)(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: resolveModel(config, request.model),
          max_tokens: 4096,
          messages: messages(request.messages),
          tools: request.tools.map((tool) => ({
            name: tool.name,
            ...(tool.description === undefined ? {} : { description: tool.description }),
            input_schema: tool.inputSchema,
          })),
        }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        dispatcher,
      });
      if (!response.ok) throw new Error(`Anthropic-compatible provider returned HTTP ${response.status}`);
      const raw: unknown = await response.json();
      const parsed = responseSchema.safeParse(raw);
      if (!parsed.success) throw new Error(`Malformed Anthropic-compatible response: ${parsed.error.message}`);
      const text = parsed.data.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
      const toolCalls = parsed.data.content
        .filter((block) => block.type === 'tool_use')
        .map((block) => ({ id: block.id, name: block.name, arguments: block.input }));
      const usage = parsed.data.usage;
      return {
        text,
        toolCalls,
        usage: usage === undefined
          ? { input: 0, output: 0, total: 0 }
          : { input: usage.input_tokens, output: usage.output_tokens, total: usage.input_tokens + usage.output_tokens },
        stopReason: toolCalls.length > 0 ? 'tool_calls' : (parsed.data.stop_reason ?? 'complete'),
        raw,
      };
    },
    async close() { await dispatcher.close(); },
  };
}
