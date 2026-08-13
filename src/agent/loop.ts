import { event } from '../core/events.js';
import { redact } from '../core/redaction.js';
import type { Limits, NormalizedEvent, Observation, ToolCallObservation } from '../core/types.js';
import type { ProviderAdapter, ProviderMessage, ProviderTool } from './types.js';

type McpForAgent = {
  inspect(id: string): Promise<{ tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }> }>;
  call(id: string, tool: string, argumentsValue: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<unknown>;
};

export type AgentInput = {
  prompt: string;
  model: string;
  serverId: string;
  limits: Limits;
};

export type AgentResult = Observation & {
  output: string;
  stopReason: 'complete' | 'cancelled' | 'max_turns' | 'max_tool_calls' | 'max_time' | 'max_cost';
};

function estimatedCost(adapter: ProviderAdapter, input: number, output: number): number {
  return (input * adapter.pricing.inputPerMillion + output * adapter.pricing.outputPerMillion) / 1_000_000;
}

export async function runAgent(
  input: AgentInput,
  dependencies: { provider: ProviderAdapter; mcp: McpForAgent },
  options: { signal?: AbortSignal } = {},
): Promise<AgentResult> {
  const started = Date.now();
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(options.signal?.reason ?? new Error('Cancelled'));
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('Maximum elapsed time reached'));
  }, input.limits.timeoutMs);

  const messages: ProviderMessage[] = [{ role: 'user', content: input.prompt }];
  const calls: ToolCallObservation[] = [];
  const events: NormalizedEvent[] = [];
  const tokens = { input: 0, output: 0, total: 0 };
  let costUsd = 0;
  let output = '';
  let stopReason: AgentResult['stopReason'] = 'max_turns';

  try {
    const inspection = await dependencies.mcp.inspect(input.serverId);
    const tools: ProviderTool[] = inspection.tools.map((tool) => ({
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      inputSchema: tool.inputSchema,
    }));

    for (let turn = 0; turn < input.limits.maxTurns; turn += 1) {
      if (controller.signal.aborted) {
        stopReason = timedOut ? 'max_time' : 'cancelled';
        break;
      }
      let response;
      try {
        response = await dependencies.provider.complete({
          model: input.model,
          messages,
          tools,
          signal: controller.signal,
        });
      } catch (error) {
        if (!controller.signal.aborted) throw error;
        stopReason = timedOut ? 'max_time' : 'cancelled';
        break;
      }
      tokens.input += response.usage.input;
      tokens.output += response.usage.output;
      tokens.total += response.usage.total;
      costUsd += estimatedCost(dependencies.provider, response.usage.input, response.usage.output);
      events.push(event(input.serverId, 'model_turn', { turn: turn + 1, response: response.raw, usage: response.usage }));
      output = response.text;

      if (input.limits.maxCostUsd !== undefined && costUsd > input.limits.maxCostUsd) {
        stopReason = 'max_cost';
        break;
      }
      if (response.toolCalls.length === 0) {
        stopReason = 'complete';
        break;
      }
      if (turn + 1 >= input.limits.maxTurns) {
        stopReason = 'max_turns';
        break;
      }
      if (calls.length + response.toolCalls.length > input.limits.maxToolCalls) {
        stopReason = 'max_tool_calls';
        break;
      }

      messages.push({ role: 'assistant', content: response.text, toolCalls: response.toolCalls });
      for (const toolCall of response.toolCalls) {
        const toolStarted = Date.now();
        const result = await dependencies.mcp.call(
          input.serverId,
          toolCall.name,
          toolCall.arguments,
          { signal: controller.signal },
        );
        const observed = {
          name: toolCall.name,
          arguments: redact(toolCall.arguments),
          result: redact(result),
          durationMs: Date.now() - toolStarted,
        };
        calls.push(observed);
        events.push(event(input.serverId, 'tool_call', observed, observed.durationMs));
        messages.push({ role: 'tool', toolCallId: toolCall.id, name: toolCall.name, content: JSON.stringify(result) });
      }
    }
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onAbort);
    await dependencies.provider.close?.();
  }

  events.push(event(input.serverId, 'stop', { reason: stopReason }));
  return redact({
    output,
    toolCalls: calls,
    durationMs: Date.now() - started,
    tokens,
    costUsd,
    events,
    stopReason,
  });
}
