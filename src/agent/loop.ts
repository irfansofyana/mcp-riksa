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

function estimatedCost(adapter: ProviderAdapter, model: string, input: number, output: number): number {
  const pricing = adapter.pricingFor(model);
  return (input * pricing.inputPerMillion + output * pricing.outputPerMillion) / 1_000_000;
}

function isAbortFailure(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted && (error === signal.reason || (error instanceof Error && error.name === 'AbortError'));
}

async function awaitWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export async function runAgent(
  input: AgentInput,
  dependencies: { provider: ProviderAdapter; mcp: McpForAgent },
  options: { signal?: AbortSignal; onUpdate?(update: AgentUpdate): void; closeProvider?: boolean } = {},
): Promise<AgentResult> {
  const started = Date.now();
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(options.signal?.reason ?? new Error('Cancelled'));
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  const timeout = setTimeout(() => {
    if (controller.signal.aborted) return;
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
    agentLoop: {
    let inspection;
    try {
      inspection = await awaitWithAbort(dependencies.mcp.inspect(input.serverId), controller.signal);
    } catch (error) {
      if (!isAbortFailure(error, controller.signal)) throw error;
      stopReason = timedOut ? 'max_time' : 'cancelled';
      break agentLoop;
    }
    const tools: ProviderTool[] = inspection.tools.map((tool) => ({
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      inputSchema: tool.inputSchema,
    }));

    turnLoop: for (let turn = 0; turn < input.limits.maxTurns; turn += 1) {
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
        if (!isAbortFailure(error, controller.signal)) throw error;
        stopReason = timedOut ? 'max_time' : 'cancelled';
        break;
      }
      tokens.input += response.usage.input;
      tokens.output += response.usage.output;
      tokens.total += response.usage.total;
      const turnCost = estimatedCost(dependencies.provider, input.model, response.usage.input, response.usage.output);
      costUsd += turnCost;
      const turnDurationMs = Date.now() - turnStarted;
      events.push(event(input.serverId, 'model_turn', { turn: turn + 1, response: response.raw, usage: response.usage }, turnDurationMs));
      output = response.text;
      emit({
        type: 'model_turn', turn: turn + 1, usage: response.usage, tokens: { ...tokens }, costUsd,
        durationMs: turnDurationMs,
      });

      if (response.toolCalls.length === 0) {
        transcript.push({ role: 'assistant', content: response.text, toolCalls: [] });
        stopReason = input.limits.maxCostUsd !== undefined && costUsd > input.limits.maxCostUsd ? 'max_cost' : 'complete';
        break;
      }
      if (input.limits.maxCostUsd !== undefined && costUsd > input.limits.maxCostUsd) {
        stopReason = 'max_cost';
        break;
      }
      if (calls.length + response.toolCalls.length > input.limits.maxToolCalls) {
        stopReason = 'max_tool_calls';
        break;
      }

      const assistantMessage: ProviderMessage = { role: 'assistant', content: response.text, toolCalls: response.toolCalls };
      messages.push(assistantMessage);
      const completedTurn: ProviderMessage[] = [assistantMessage];
      for (const toolCall of response.toolCalls) {
        const toolStarted = Date.now();
        let result;
        try {
          result = await dependencies.mcp.call(
            input.serverId,
            toolCall.name,
            toolCall.arguments,
            { signal: controller.signal },
          );
        } catch (error) {
          if (!isAbortFailure(error, controller.signal)) throw error;
          stopReason = timedOut ? 'max_time' : 'cancelled';
          break turnLoop;
        }
        if (controller.signal.aborted) {
          stopReason = timedOut ? 'max_time' : 'cancelled';
          break turnLoop;
        }
        const observed = {
          name: toolCall.name,
          arguments: redact(toolCall.arguments),
          result: redact(result),
          durationMs: Date.now() - toolStarted,
          outcome: result !== null && typeof result === 'object' && (result as { isError?: unknown }).isError === true ? 'error' as const : 'success' as const,
        };
        calls.push(observed);
        events.push(event(input.serverId, 'tool_call', observed, observed.durationMs));
        emit({ type: 'tool_call', turn: turn + 1, call: observed });
        const toolMessage: ProviderMessage = { role: 'tool', toolCallId: toolCall.id, name: toolCall.name, content: JSON.stringify(result) };
        messages.push(toolMessage);
        completedTurn.push(toolMessage);
      }
      transcript.push(...completedTurn);
      if (turn + 1 >= input.limits.maxTurns) {
        stopReason = 'max_turns';
        break;
      }
    }
    }
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onAbort);
    if (options.closeProvider !== false) await dependencies.provider.close?.();
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

export type ScriptedUserTurn = { id: string; user: string };

export type ConversationAgentResult = AgentResult & {
  turns: Array<{ id: string; user: string; observation: AgentResult }>;
};

function aggregateConversation(turns: ConversationAgentResult['turns'], started: number): ConversationAgentResult {
  const last = turns.at(-1)?.observation;
  return {
    output: last?.output ?? '',
    transcript: turns.flatMap((turn) => turn.observation.transcript),
    toolCalls: turns.flatMap((turn) => turn.observation.toolCalls),
    durationMs: Date.now() - started,
    tokens: turns.reduce((total, turn) => ({
      input: total.input + turn.observation.tokens.input,
      output: total.output + turn.observation.tokens.output,
      total: total.total + turn.observation.tokens.total,
    }), { input: 0, output: 0, total: 0 }),
    costUsd: turns.reduce((total, turn) => total + turn.observation.costUsd, 0),
    events: turns.flatMap((turn, index) => [
      event(turn.observation.events[0]?.caseId ?? 'conversation', 'user_turn', { id: turn.id, user: turn.user, index: index + 1 }),
      ...turn.observation.events.map((entry) => ({
        ...entry,
        userTurn: turn.id,
        ...(entry.type === 'model_turn' && entry.data !== null && typeof entry.data === 'object' && typeof (entry.data as { turn?: unknown }).turn === 'number'
          ? { modelTurn: (entry.data as { turn: number }).turn }
          : {}),
      })),
    ]),
    stopReason: last?.stopReason ?? 'complete',
    turns,
  };
}

export async function runScriptedConversation(
  input: Omit<AgentInput, 'prompt' | 'history'> & { turns: ScriptedUserTurn[] },
  dependencies: { provider: ProviderAdapter; mcp: McpForAgent },
  options: { signal?: AbortSignal; onUpdate?(update: AgentUpdate): void } = {},
): Promise<ConversationAgentResult> {
  const started = Date.now();
  const history: ProviderMessage[] = [];
  const turns: ConversationAgentResult['turns'] = [];
  let usedModelTurns = 0;
  let usedToolCalls = 0;
  let usedCostUsd = 0;
  let stopReason: AgentResult['stopReason'] = 'complete';

  try {
    for (const step of input.turns) {
      const elapsed = Date.now() - started;
      const maxTurns = input.limits.maxTurns - usedModelTurns;
      const maxToolCalls = input.limits.maxToolCalls - usedToolCalls;
      const timeoutMs = input.limits.timeoutMs - elapsed;
      if (maxTurns < 1) { stopReason = 'max_turns'; break; }
      if (maxToolCalls < 0) { stopReason = 'max_tool_calls'; break; }
      if (timeoutMs < 1) { stopReason = 'max_time'; break; }
      if (input.limits.maxCostUsd !== undefined && usedCostUsd > input.limits.maxCostUsd) { stopReason = 'max_cost'; break; }
      const remainingCostUsd = input.limits.maxCostUsd === undefined ? undefined : input.limits.maxCostUsd - usedCostUsd;
      const result = await runAgent({
        ...input,
        prompt: step.user,
        history,
        limits: { ...input.limits, maxTurns, maxToolCalls, timeoutMs, ...(remainingCostUsd === undefined ? {} : { maxCostUsd: remainingCostUsd }) },
      }, dependencies, { ...options, closeProvider: false });
      turns.push({ id: step.id, user: step.user, observation: result });
      history.push({ role: 'user', content: step.user }, ...result.transcript);
      usedModelTurns += result.events.filter((entry) => entry.type === 'model_turn').length;
      usedToolCalls += result.toolCalls.length;
      usedCostUsd += result.costUsd;
      stopReason = result.stopReason;
      if (stopReason !== 'complete') break;
    }
  } finally {
    await dependencies.provider.close?.();
  }

  return { ...aggregateConversation(turns, started), stopReason };
}
