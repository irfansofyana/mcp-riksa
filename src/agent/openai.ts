import OpenAI from 'openai';
import { Agent, fetch as undiciFetch } from 'undici';
import { z } from 'zod';
import type { ProviderAdapter, ProviderMessage, ProviderTool } from './types.js';
import { providerConfigSchema, resolveApiKey, resolveModel, resolveProviderHeaders } from './types.js';
import { createSafeLookup } from '../mcp/validation.js';

const responseSchema = z.object({
  choices: z.array(z.object({
    message: z.object({
      content: z.string().nullable().optional(),
      tool_calls: z.array(z.object({
        id: z.string(),
        function: z.object({ name: z.string(), arguments: z.string() }),
      })).optional(),
    }),
    finish_reason: z.string().nullable(),
  })).min(1),
  usage: z.object({ prompt_tokens: z.number(), completion_tokens: z.number(), total_tokens: z.number() }).optional(),
}).passthrough();

function messages(input: ProviderMessage[]): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return input.map((message) => {
    if (message.role === 'user') return { role: 'user', content: message.content };
    if (message.role === 'tool') return { role: 'tool', content: message.content, tool_call_id: message.toolCallId };
    return {
      role: 'assistant',
      content: message.content || null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function' as const,
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      })),
    };
  });
}

function tools(input: ProviderTool[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return input.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      parameters: tool.inputSchema as OpenAI.FunctionParameters,
    },
  }));
}

export function createOpenAIAdapter(input: unknown): ProviderAdapter {
  const config = providerConfigSchema.parse(input);
  const dispatcher = new Agent({ connect: { lookup: createSafeLookup() } });
  const safeFetch = ((target: string | URL | Request, init?: RequestInit) => (
    undiciFetch as unknown as (input: string | URL | Request, options: RequestInit & { dispatcher: Agent }) => Promise<Response>
  )(target, { ...init, dispatcher })) as typeof fetch;
  const client = new OpenAI({
    baseURL: config.baseUrl,
    apiKey: resolveApiKey(config) ?? 'local-no-key',
    defaultHeaders: resolveProviderHeaders(config),
    fetch: safeFetch,
  });
  return {
    id: config.id,
    pricing: config.pricing,
    async complete(request) {
      const raw = await client.chat.completions.create(
        {
          model: resolveModel(config, request.model),
          messages: messages(request.messages),
          tools: tools(request.tools),
          ...(request.tools.length === 0 ? {} : { tool_choice: 'auto' as const }),
        },
        request.signal === undefined ? undefined : { signal: request.signal },
      );
      const parsed = responseSchema.safeParse(raw);
      if (!parsed.success) throw new Error(`Malformed OpenAI-compatible response: ${parsed.error.message}`);
      const choice = parsed.data.choices[0]!;
      const usage = parsed.data.usage;
      const toolCalls = (choice.message.tool_calls ?? []).map((call) => {
        let argumentsValue: unknown;
        try {
          argumentsValue = JSON.parse(call.function.arguments);
        } catch {
          throw new Error(`Malformed OpenAI-compatible tool arguments for ${call.function.name}`);
        }
        if (argumentsValue === null || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue)) {
          throw new Error(`Malformed OpenAI-compatible tool arguments for ${call.function.name}`);
        }
        return { id: call.id, name: call.function.name, arguments: argumentsValue as Record<string, unknown> };
      });
      return {
        text: choice.message.content ?? '',
        toolCalls,
        usage: usage === undefined
          ? { input: 0, output: 0, total: 0 }
          : { input: usage.prompt_tokens, output: usage.completion_tokens, total: usage.total_tokens },
        stopReason: toolCalls.length > 0 ? 'tool_calls' : (choice.finish_reason ?? 'complete'),
        raw,
      };
    },
    async listModels() {
      const page = await client.models.list();
      return page.data.map((model) => model.id);
    },
    async close() { await dispatcher.close(); },
  };
}
