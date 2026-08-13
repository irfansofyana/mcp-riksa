import { useMemo, useState } from 'react';
import { api } from '../api.js';
import { Button, Empty, Field, Input, JsonView, Notice, Section, Select, Status, Textarea } from '../components.js';
import { buildSuiteFromPlayground } from '../model.js';
import type { EventRecord, ProviderSummary, ServerSummary } from '../types.js';

type PlaygroundResult = { output: string; toolCalls: unknown[]; events: EventRecord[]; tokens: { total: number }; costUsd: number; stopReason: string };

export function PlaygroundPage({ servers, providers, onRefresh }: { servers: ServerSummary[]; providers: ProviderSummary[]; onRefresh(): Promise<void> }) {
  const [server, setServer] = useState(servers[0]?.id ?? '');
  const [provider, setProvider] = useState(providers[0]?.id ?? '');
  const selectedProvider = providers.find((entry) => entry.id === provider);
  const aliases = useMemo(() => Object.keys(selectedProvider?.models ?? {}), [selectedProvider]);
  const [model, setModel] = useState('');
  const selectedModel = aliases.includes(model) ? model : aliases[0] ?? '';
  const [prompt, setPrompt] = useState('Add 2 and 3 using the available tool.');
  const [result, setResult] = useState<PlaygroundResult>();
  const [suiteName, setSuiteName] = useState('saved-playground');
  const [expected, setExpected] = useState('5');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const run = async () => {
    setError(''); setMessage('');
    try {
      setResult(await api.playground({ serverId: server, providerId: provider, model: selectedModel, prompt, limits: { maxTurns: 8, maxToolCalls: 16, timeoutMs: 60_000 } }));
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  return <div className="playground-layout">
    <Section title="Agent playground" action={<Status value={result?.stopReason ?? 'ready'} />}>
      <div className="form-grid compact">
        <Field label="MCP server"><Select value={server} onChange={(event) => setServer(event.target.value)} data-testid="playground-server"><option value="">Choose server</option>{servers.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</Select></Field>
        <Field label="Model provider"><Select value={provider} onChange={(event) => { setProvider(event.target.value); setModel(''); }} data-testid="playground-provider"><option value="">Choose provider</option>{providers.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</Select></Field>
        <Field label="Model alias"><Select value={selectedModel} onChange={(event) => setModel(event.target.value)} data-testid="playground-model"><option value="">Choose model</option>{aliases.map((alias) => <option key={alias}>{alias}</option>)}</Select></Field>
      </div>
      <Field label="Prompt"><Textarea rows={5} value={prompt} onChange={(event) => setPrompt(event.target.value)} data-testid="playground-prompt" /></Field>
      <div className="button-row"><Button variant="primary" disabled={!server || !provider || !selectedModel} onClick={() => void run()} data-testid="run-playground">Run agent</Button><span className="hint">8 turns · 16 calls · 60 s</span></div>
      {message ? <Notice>{message}</Notice> : null}{error ? <Notice error>{error}</Notice> : null}
    </Section>

    <Section title="Complete turn trace" action={result ? <span className="metrics">{result.tokens.total} tok · ${result.costUsd.toFixed(6)}</span> : undefined}>
      {!result ? <Empty>Run a prompt to reveal model turns, MCP calls, results, usage, and the stop boundary.</Empty> : <>
        <div className="answer"><span>Assistant</span><p>{result.output || 'No final text was produced.'}</p></div>
        <div className="event-trace">{result.events.map((entry, index) => <article className="trace-event" key={entry.id}>
          <div className="trace-marker">{index + 1}</div>
          <div><header><b>{entry.type.replaceAll('_', ' ')}</b><time>{entry.durationMs === undefined ? '' : `${entry.durationMs} ms`}</time></header><pre>{JSON.stringify(entry.data, null, 2)}</pre></div>
        </article>)}</div>
        <JsonView value={result} label="Sanitized playground trace" />
      </>}
    </Section>

    <Section title="Save as evaluation case">
      <div className="form-grid compact">
        <Field label="Suite name"><Input value={suiteName} onChange={(event) => setSuiteName(event.target.value)} data-testid="playground-suite-name" /></Field>
        <Field label="Expected text"><Input value={expected} onChange={(event) => setExpected(event.target.value)} /></Field>
      </div>
      <Button disabled={!result} onClick={() => void (async () => { try { await api.saveSuite(buildSuiteFromPlayground({ name: suiteName, server, provider, model: selectedModel, prompt, expectedText: expected })); await onRefresh(); setMessage('Interaction saved as a versioned YAML suite.'); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } })()} data-testid="save-playground-suite">Save YAML case</Button>
    </Section>
  </div>;
}
