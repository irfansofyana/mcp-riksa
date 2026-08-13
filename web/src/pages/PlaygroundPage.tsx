import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { Button, Empty, Field, Input, JsonView, Notice, Select, Status, Textarea } from '../components.js';
import { buildSuiteFromPlayground } from '../model.js';
import type { AgentUpdate, ConversationDetail, ConversationSummary, PlaygroundResult, ProviderSummary, ServerSummary } from '../types.js';

const limits = { maxTurns: 8, maxToolCalls: 16, timeoutMs: 60_000 };

function compact(value: number) {
  return new Intl.NumberFormat(undefined, { notation: value >= 10_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value);
}

function elapsed(value: number) {
  return value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(1)} s`;
}

export function PlaygroundPage({ servers, providers, onRefresh }: { servers: ServerSummary[]; providers: ProviderSummary[]; onRefresh(): Promise<void> }) {
  const [server, setServer] = useState(servers[0]?.id ?? '');
  const [provider, setProvider] = useState(providers[0]?.id ?? '');
  const selectedProvider = providers.find((entry) => entry.id === provider);
  const aliases = useMemo(() => Object.keys(selectedProvider?.models ?? {}), [selectedProvider]);
  const [model, setModel] = useState('');
  const selectedModel = aliases.includes(model) ? model : aliases[0] ?? '';
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversation, setConversation] = useState<ConversationDetail>();
  const [prompt, setPrompt] = useState('Add 2 and 3 using the available tool.');
  const [draft, setDraft] = useState('');
  const [pendingPrompt, setPendingPrompt] = useState('');
  const [updates, setUpdates] = useState<AgentUpdate[]>([]);
  const [result, setResult] = useState<PlaygroundResult>();
  const [running, setRunning] = useState(false);
  const [suiteName, setSuiteName] = useState('saved-playground');
  const [expected, setExpected] = useState('5');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | undefined>(undefined);
  const transcriptRef = useRef<HTMLDivElement>(null);

  const loadList = async (selectFirst = false) => {
    const list = await api.conversations();
    setConversations(list);
    if (selectFirst && list[0]) await openConversation(list[0].id);
  };

  const openConversation = async (id: string) => {
    abortRef.current?.abort();
    const value = await api.conversation(id);
    setConversation(value);
    setServer(value.serverId);
    setProvider(value.providerId);
    setModel(value.model);
    setResult(undefined);
    setUpdates([]);
    setDraft('');
  };

  useEffect(() => {
    void loadList(true).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    return () => abortRef.current?.abort();
  }, []);
  useEffect(() => { transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: 'smooth' }); }, [conversation?.messages.length, draft, running]);

  const createConversation = async () => {
    if (!server || !provider || !selectedModel) throw new Error('Choose server, provider, and model first');
    const value = await api.createConversation({ serverId: server, providerId: provider, model: selectedModel });
    setConversation(value);
    setResult(undefined);
    setUpdates([]);
    setDraft('');
    await loadList();
    return value;
  };

  const run = async () => {
    const text = prompt.trim();
    if (!text || running) return;
    setError(''); setMessage(''); setDraft(''); setUpdates([]); setPendingPrompt(text); setRunning(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      let target = conversation;
      const configurationChanged = target && (target.serverId !== server || target.providerId !== provider || target.model !== selectedModel);
      if (!target || configurationChanged) target = await createConversation();
      setPrompt('');
      const completed = await api.streamPlayground({
        conversationId: target.id,
        prompt: text,
        limits,
      }, (update) => {
        setUpdates((current) => [...current, update]);
        if (update.type === 'text_delta') setDraft((current) => current + update.delta);
      }, controller.signal);
      if (controller.signal.aborted || abortRef.current !== controller) return;
      setConversation(completed.conversation);
      setResult(completed.result);
      setDraft('');
      setPendingPrompt('');
      await loadList();
    } catch (reason) {
      if ((reason as { name?: string }).name !== 'AbortError') setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      abortRef.current = undefined;
      setRunning(false);
    }
  };

  const lastMetrics = [...updates].reverse().find((update) => update.type === 'model_turn');
  const liveTools = updates.filter((update): update is Extract<AgentUpdate, { type: 'tool_call' }> => update.type === 'tool_call');
  const liveMetrics = running && lastMetrics?.type === 'model_turn' ? lastMetrics : undefined;
  const totals = conversation?.totals ?? { tokens: { input: 0, output: 0, total: 0 }, costUsd: 0, toolCalls: 0, durationMs: 0 };
  const lastUserPrompt = [...(conversation?.messages ?? [])].reverse().find((entry) => entry.role === 'user')?.content ?? pendingPrompt;

  return <div className="playground-shell">
    <aside className="conversation-rail">
      <div className="conversation-rail-head"><div><span className="eyebrow">Sessions</span><b>Conversations</b></div><Button aria-label="New conversation" disabled={running || !server || !provider || !selectedModel} onClick={() => void createConversation().catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))}>＋</Button></div>
      <div className="conversation-list">
        {conversations.length === 0 ? <Empty>No conversations yet.</Empty> : conversations.map((entry) => <button key={entry.id} disabled={running} className={`conversation-item ${conversation?.id === entry.id ? 'selected' : ''}`} onClick={() => void openConversation(entry.id)}>
          <span>{entry.title}</span><small>{entry.messageCount} msgs · {compact(entry.totals.tokens.total)} tok</small>
        </button>)}
      </div>
      {conversation ? <Button variant="danger" disabled={running} className="delete-conversation" onClick={() => void (async () => { await api.deleteConversation(conversation.id); setConversation(undefined); setResult(undefined); await loadList(true); })()}>Delete conversation</Button> : null}
    </aside>

    <main className="chat-workspace">
      <header className="chat-toolbar">
        <div className="chat-context">
          <Field label="MCP server"><Select value={server} disabled={running} onChange={(event) => setServer(event.target.value)} data-testid="playground-server"><option value="">Choose server</option>{servers.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</Select></Field>
          <Field label="Provider"><Select value={provider} disabled={running} onChange={(event) => { setProvider(event.target.value); setModel(''); }} data-testid="playground-provider"><option value="">Choose provider</option>{providers.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</Select></Field>
          <Field label="Model"><Select value={selectedModel} disabled={running} onChange={(event) => setModel(event.target.value)} data-testid="playground-model"><option value="">Choose model</option>{aliases.map((alias) => <option key={alias}>{alias}</option>)}</Select></Field>
        </div>
        <Status value={running ? 'streaming' : result?.stopReason ?? 'ready'} />
      </header>

      <div className="conversation-stats" aria-label="Conversation statistics">
        <div><span>Total tokens</span><b>{compact(totals.tokens.total + (liveMetrics?.tokens.total ?? 0))}</b><small>{totals.tokens.input} in / {totals.tokens.output} out</small></div>
        <div><span>Estimated cost</span><b>${(totals.costUsd + (liveMetrics?.costUsd ?? 0)).toFixed(5)}</b><small>local pricing</small></div>
        <div><span>Tool calls</span><b>{totals.toolCalls + (running ? liveTools.length : 0)}</b><small>{running ? liveTools.at(-1)?.call.name ?? 'waiting' : 'persisted total'}</small></div>
        <div><span>Agent time</span><b>{elapsed(totals.durationMs + (liveMetrics?.durationMs ?? 0))}</b><small>{conversation?.messageCount ?? 0} persisted msgs</small></div>
      </div>

      <div className="chat-transcript" ref={transcriptRef} aria-live="polite">
        {!conversation?.messages.length && !running ? <div className="chat-empty"><span className="chat-glyph">⌁</span><h2>Start a tool-aware conversation</h2><p>Responses stream live. Every message, tool call, token, cost, and trace stays local.</p></div> : null}
        {conversation?.messages.map((entry) => <article key={entry.id} className={`chat-message ${entry.role}`}>
          <div className="message-avatar">{entry.role === 'user' ? 'YOU' : 'AI'}</div>
          <div className="message-body"><header><b>{entry.role === 'user' ? 'You' : 'Workbench agent'}</b><time>{new Date(entry.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></header><p>{entry.content || 'No text response.'}</p>
            {entry.role === 'assistant' && entry.tokens ? <div className="message-meta"><span>{entry.tokens.total} tokens</span><span>${(entry.costUsd ?? 0).toFixed(6)}</span><span>{elapsed(entry.durationMs ?? 0)}</span><span>{entry.toolCalls?.length ?? 0} tools</span></div> : null}
            {entry.events?.length ? <JsonView value={entry.events} label="Turn trace" defaultOpen={false} /> : null}
          </div>
        </article>)}
        {running ? <>
          <article className="chat-message user pending"><div className="message-avatar">YOU</div><div className="message-body"><header><b>You</b><Status value="sent" /></header><p>{pendingPrompt}</p></div></article>
          <article className="chat-message assistant streaming"><div className="message-avatar">AI</div><div className="message-body"><header><b>Workbench agent</b><span className="stream-indicator"><i /> streaming</span></header><p>{draft || <span className="typing"><i /><i /><i /></span>}</p>{liveTools.length ? <div className="live-tools">{liveTools.map((entry, index) => <span key={`${entry.call.name}-${index}`}>↳ {entry.call.name} <small>{entry.call.durationMs} ms</small></span>)}</div> : null}</div></article>
        </> : null}
      </div>

      <div className="composer-wrap">
        {error ? <Notice error>{error}</Notice> : null}{message ? <Notice>{message}</Notice> : null}
        <div className="chat-composer">
          <Textarea rows={3} value={prompt} disabled={running} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void run(); } }} placeholder="Ask agent to inspect or use connected MCP tools…" data-testid="playground-prompt" />
          <div className="composer-actions"><span>Enter to send · Shift+Enter for newline</span>{running ? <Button variant="danger" onClick={() => abortRef.current?.abort()}>Stop</Button> : <Button variant="primary" disabled={!server || !provider || !selectedModel || !prompt.trim()} onClick={() => void run()} data-testid="run-playground">Send ↗</Button>}</div>
        </div>
      </div>
    </main>

    <aside className="playground-inspector">
      <div className="inspector-block"><span className="eyebrow">Live activity</span><h3>Agent trace</h3>{updates.length === 0 ? <p>Model turns and tool calls appear here while response streams.</p> : <div className="activity-list">{updates.filter((entry) => entry.type !== 'text_delta').map((entry, index) => <div key={index}><i /><span><b>{entry.type.replaceAll('_', ' ')}</b><small>{entry.type === 'tool_call' ? entry.call.name : entry.type === 'model_turn' ? `${entry.usage.total} tok · ${elapsed(entry.durationMs)}` : entry.reason}</small></span></div>)}</div>}</div>
      <div className="inspector-block save-case"><span className="eyebrow">Regression seed</span><h3>Save last turn</h3><Field label="Suite name"><Input value={suiteName} onChange={(event) => setSuiteName(event.target.value)} data-testid="playground-suite-name" /></Field><Field label="Expected text"><Input value={expected} onChange={(event) => setExpected(event.target.value)} /></Field><Button disabled={!result || !lastUserPrompt} onClick={() => void (async () => { try { await api.saveSuite(buildSuiteFromPlayground({ name: suiteName, server, provider, model: selectedModel, prompt: lastUserPrompt, expectedText: expected })); await onRefresh(); setMessage('Interaction saved as a versioned YAML suite.'); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } })()} data-testid="save-playground-suite">Save YAML case</Button></div>
      {result ? <JsonView value={result} label="Latest sanitized result" defaultOpen={false} /> : null}
    </aside>
  </div>;
}
