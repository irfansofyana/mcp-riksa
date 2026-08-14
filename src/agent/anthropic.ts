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

async function* readSse(response: Response): AsyncGenerator<Record<string, unknown>> {
  if (!response.body) throw new Error('Anthropic-compatible streaming response has no body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
      if (data && data !== '[DONE]') yield JSON.parse(data) as Record<string, unknown>;
    }
    if (done) break;
  }
}

function messages(input: ProviderMessage[]) {
  return input.filter((message) => message.role !== 'system').map((message) => {
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
      if (request.onTextDelta) {
        const streamingResponse = await (undiciFetch as unknown as (
          input: string | URL,
          init: RequestInit & { dispatcher: Agent },
        ) => Promise<Response>)(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: resolveModel(config, request.model),
            max_tokens: 4096,
            ...(request.messages.find((message) => message.role === 'system')?.content ? { system: request.messages.find((message) => message.role === 'system')!.content } : {}),
            messages: messages(request.messages),
            tools: request.tools.map((tool) => ({
              name: tool.name,
              ...(tool.description === undefined ? {} : { description: tool.description }),
              input_schema: tool.inputSchema,
            })),
            stream: true,
          }),
          ...(request.signal === undefined ? {} : { signal: request.signal }),
          dispatcher,
        });
        if (!streamingResponse.ok) throw new Error(`Anthropic-compatible provider returned HTTP ${streamingResponse.status}`);
        let text = '';
        let stopReason = 'complete';
        let inputTokens = 0;
        let outputTokens = 0;
        const pendingCalls = new Map<number, { id: string; name: string; argumentsText: string }>();
        for await (const payload of readSse(streamingResponse)) {
          const type = String(payload.type ?? '');
          if (type === 'message_start') {
            const message = payload.message as { usage?: { input_tokens?: number } } | undefined;
            inputTokens = message?.usage?.input_tokens ?? inputTokens;
          } else if (type === 'content_block_start') {
            const index = Number(payload.index ?? 0);
            const block = payload.content_block as { type?: string; id?: string; name?: string } | undefined;
            if (block?.type === 'tool_use') pendingCalls.set(index, { id: block.id ?? '', name: block.name ?? '', argumentsText: '' });
          } else if (type === 'content_block_delta') {
            const index = Number(payload.index ?? 0);
            const delta = payload.delta as { type?: string; text?: string; partial_json?: string } | undefined;
            if (delta?.type === 'text_delta' && delta.text) {
              text += delta.text;
              request.onTextDelta(delta.text);
            } else if (delta?.type === 'input_json_delta') {
              const call = pendingCalls.get(index);
              if (call) call.argumentsText += delta.partial_json ?? '';
            }
          } else if (type === 'message_delta') {
            const delta = payload.delta as { stop_reason?: string } | undefined;
            const usage = payload.usage as { output_tokens?: number } | undefined;
            stopReason = delta?.stop_reason ?? stopReason;
            outputTokens = usage?.output_tokens ?? outputTokens;
          } else if (type === 'error') {
            const error = payload.error as { message?: string } | undefined;
            throw new Error(`Anthropic-compatible stream failed: ${error?.message ?? 'unknown error'}`);
          }
        }
        const toolCalls = [...pendingCalls.values()].map((call) => {
          let input: unknown;
          try { input = JSON.parse(call.argumentsText || '{}'); }
          catch { throw new Error(`Malformed Anthropic-compatible tool arguments for ${call.name}`); }
          if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error(`Malformed Anthropic-compatible tool arguments for ${call.name}`);
          return { id: call.id, name: call.name, arguments: input as Record<string, unknown> };
        });
        const usage = { input: inputTokens, output: outputTokens, total: inputTokens + outputTokens };
        return {
          text,
          toolCalls,
          usage,
          stopReason: toolCalls.length > 0 ? 'tool_calls' : stopReason,
          raw: { streamed: true, text, toolCalls, usage, stopReason },
        };
      }
      const response = await (undiciFetch as unknown as (
        input: string | URL,
        init: RequestInit & { dispatcher: Agent },
      ) => Promise<Response>)(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: resolveModel(config, request.model),
          max_tokens: 4096,
          ...(request.messages.find((message) => message.role === 'system')?.content ? { system: request.messages.find((message) => message.role === 'system')!.content } : {}),
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
