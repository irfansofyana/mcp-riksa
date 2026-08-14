import { event } from '../core/events.js';
import { REDACTED, redact } from '../core/redaction.js';
import type { Limits, NormalizedEvent, Observation, ToolCallObservation } from '../core/types.js';
import type { ProviderAdapter, ProviderMessage, ProviderTool } from './types.js';

type McpForAgent = {
  inspect(id: string): Promise<{ tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }> }>;
  call(id: string, tool: string, argumentsValue: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<unknown>;
};

export type AgentInput = {
  prompt: string;
  systemPrompt?: string;
  model: string;
  serverId: string;
  limits: Limits;
  history?: ProviderMessage[];
};

export type AgentUpdate =
  | { type: 'text_delta'; delta: string }
  | { type: 'model_turn'; turn: number; usage: { input: number; output: number; total: number }; tokens: { input: number; output: number; total: number }; costUsd: number; durationMs: number }
  | { type: 'tool_call'; turn: number; call: ToolCallObservation }
  | { type: 'stop'; reason: AgentResult['stopReason']; durationMs: number };

export type AgentResult = Observation & {
  output: string;
  transcript: ProviderMessage[];
  stopReason: 'complete' | 'cancelled' | 'max_turns' | 'max_tool_calls' | 'max_time' | 'max_cost';
};

function estimatedCost(adapter: ProviderAdapter, input: number, output: number): number {
  return (input * adapter.pricing.inputPerMillion + output * adapter.pricing.outputPerMillion) / 1_000_000;
}

export async function runAgent(
  input: AgentInput,
  dependencies: { provider: ProviderAdapter; mcp: McpForAgent },
  options: { signal?: AbortSignal; onUpdate?(update: AgentUpdate): void } = {},
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

  const emit = (update: AgentUpdate) => options.onUpdate?.(redact(update));
  const messages: ProviderMessage[] = [
    ...(input.systemPrompt?.trim() ? [{ role: 'system' as const, content: input.systemPrompt.trim() }] : []),
    ...(input.history ?? []),
    { role: 'user', content: input.prompt },
  ];
  const calls: ToolCallObservation[] = [];
  const events: NormalizedEvent[] = [];
  const tokens = { input: 0, output: 0, total: 0 };
  let costUsd = 0;
  let output = '';
  let streamedText = '';
  let individuallyRedactedText = '';
  const transcript: ProviderMessage[] = [];
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
      const turnStarted = Date.now();
      try {
        response = await dependencies.provider.complete({
          model: input.model,
          messages,
          tools,
          signal: controller.signal,
          ...(options.onUpdate === undefined ? {} : {
            onTextDelta: () => undefined,
          }),
        });
        if (controller.signal.aborted) {
          stopReason = timedOut ? 'max_time' : 'cancelled';
          break;
        }
        streamedText += response.text;
        individuallyRedactedText += redact(response.text);
      } catch (error) {
        if (!controller.signal.aborted) throw error;
        stopReason = timedOut ? 'max_time' : 'cancelled';
        break;
      }
      tokens.input += response.usage.input;
      tokens.output += response.usage.output;
      tokens.total += response.usage.total;
      costUsd += estimatedCost(dependencies.provider, response.usage.input, response.usage.output);
      const turnDurationMs = Date.now() - turnStarted;
      events.push(event(input.serverId, 'model_turn', { turn: turn + 1, response: response.raw, usage: response.usage }, turnDurationMs));
      output = response.text;
      emit({
        type: 'model_turn', turn: turn + 1, usage: response.usage, tokens: { ...tokens }, costUsd,
        durationMs: turnDurationMs,
      });

      if (input.limits.maxCostUsd !== undefined && costUsd > input.limits.maxCostUsd) {
        stopReason = 'max_cost';
        break;
      }
      if (response.toolCalls.length === 0) {
        transcript.push({ role: 'assistant', content: response.text, toolCalls: [] });
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

      const assistantMessage: ProviderMessage = { role: 'assistant', content: response.text, toolCalls: response.toolCalls };
      messages.push(assistantMessage);
      transcript.push(assistantMessage);
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
        emit({ type: 'tool_call', turn: turn + 1, call: observed });
        const toolMessage: ProviderMessage = { role: 'tool', toolCallId: toolCall.id, name: toolCall.name, content: JSON.stringify(result) };
        messages.push(toolMessage);
        transcript.push(toolMessage);
      }
    }
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onAbort);
    await dependencies.provider.close?.();
  }

  const redactedStream = redact(streamedText);
  const streamWasRedactedAcrossTurns = redactedStream !== individuallyRedactedText;
  let safeOutput = output;
  let safeTranscript = transcript;
  let safeEvents = events;
  if (streamWasRedactedAcrossTurns) {
    safeOutput = redactedStream;
    const lastAssistantIndex = transcript.findLastIndex((message) => message.role === 'assistant');
    safeTranscript = transcript.map((message, index) => message.role === 'assistant'
      ? { ...message, content: index === lastAssistantIndex ? redactedStream : '' }
      : message);
    safeEvents = events.map((entry) => entry.type === 'model_turn'
      ? {
        ...entry,
        data: {
          ...(entry.data !== null && typeof entry.data === 'object' ? entry.data : {}),
          response: REDACTED,
        },
      }
      : entry);
  }
  if (streamedText && stopReason !== 'cancelled' && stopReason !== 'max_time') {
    emit({ type: 'text_delta', delta: redactedStream });
  }
  safeEvents.push(event(input.serverId, 'stop', { reason: stopReason }));
  emit({ type: 'stop', reason: stopReason, durationMs: Date.now() - started });
  return redact({
    output: safeOutput,
    transcript: safeTranscript,
    toolCalls: calls,
    durationMs: Date.now() - started,
    tokens,
    costUsd,
    events: safeEvents,
    stopReason,
  });
}
