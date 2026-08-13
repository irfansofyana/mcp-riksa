import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { Button, Empty, Field, Input, JsonView, Notice, RichToolResult, Section, Select, Status, Textarea } from '../components.js';
import { buildServerPayload, buildToolArguments, buildToolFields, initialToolValues, type ServerForm } from '../model.js';
import type { ServerSummary, Tool } from '../types.js';

type OAuthStatus = { id?: string; state: string; scopes: string[]; timeline: unknown[]; authorizationUrl?: string; expiresAt?: string };

const initialForm: ServerForm = {
  id: '', name: '', transport: 'stdio', command: 'node', args: '', url: 'http://127.0.0.1:3000/mcp', headerEnv: '',
  oauthScopes: '', oauthClientId: '', oauthClientSecretEnv: '',
};

export function ServersPage({ servers, onRefresh }: { servers: ServerSummary[]; onRefresh(): Promise<void> }) {
  const [form, setForm] = useState(initialForm);
  const [selected, setSelected] = useState(servers[0]?.id ?? '');
  const [inspection, setInspection] = useState<{ id: string; identity: unknown; capabilities: unknown; tools: Tool[] }>();
  const [tool, setTool] = useState('');
  const [argumentsText, setArgumentsText] = useState('{}');
  const [toolValues, setToolValues] = useState<Record<string, string | boolean>>({});
  const [rawArguments, setRawArguments] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [result, setResult] = useState<unknown>();
  const [oauth, setOauth] = useState<OAuthStatus>();
  const [authorizationUrl, setAuthorizationUrl] = useState('');
  const [oauthServer, setOauthServer] = useState('');
  const [oauthSignal, setOauthSignal] = useState('');
  const oauthCompleting = useRef(false);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const selectedTool = inspection?.tools.find((entry) => entry.name === tool);
  const toolFields = useMemo(() => buildToolFields(selectedTool?.inputSchema), [selectedTool]);

  useEffect(() => {
    setToolValues(initialToolValues(toolFields));
    setArgumentsText('{}');
    setRawArguments(false);
  }, [tool, inspection]);

  const change = <K extends keyof ServerForm>(key: K, value: ServerForm[K]) => setForm((current) => ({ ...current, [key]: value }));
  const act = async (operation: () => Promise<void>) => {
    setError(''); setMessage('');
    try { await operation(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const inspect = async (id: string) => {
    const value = await api.inspectServer(id);
    setInspection(value);
    setTool(value.tools[0]?.name ?? '');
    setSelected(id);
  };

  const finishOAuth = async (id: string, value: OAuthStatus) => {
    setOauth(value);
    if (value.state !== 'authorized' || oauthCompleting.current) return;
    oauthCompleting.current = true;
    try {
      setAuthorizationUrl('');
      await api.connectServer(id);
      if (selectedRef.current === id) await inspect(id);
      await onRefresh();
      if (selectedRef.current === id) setMessage('OAuth connected. Server reconnected and ready.');
    } finally {
      oauthCompleting.current = false;
    }
  };

  const refreshOAuth = async (id = selectedRef.current) => {
    const value = await api.oauthStatus(id);
    await finishOAuth(id, value);
    return value;
  };

  useEffect(() => {
    const receive = (payload: unknown) => {
      const signal = payload as { type?: string; value?: { id?: string } } | undefined;
      if (signal?.type === 'workbench:oauth' && signal.value?.id) setOauthSignal(signal.value.id);
    };
    const onMessage = (event: MessageEvent) => { if (event.origin === window.location.origin) receive(event.data); };
    window.addEventListener('message', onMessage);
    const channel = typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel('workbench-oauth');
    if (channel) channel.onmessage = (event) => receive(event.data);
    return () => { window.removeEventListener('message', onMessage); channel?.close(); };
  }, []);

  useEffect(() => {
    setOauth(undefined);
    if (selected) void api.oauthStatus(selected).then(setOauth).catch(() => undefined);
  }, [selected]);

  useEffect(() => {
    if (!oauthSignal) return;
    void act(async () => { await refreshOAuth(oauthSignal); setOauthSignal(''); });
  }, [oauthSignal]);

  useEffect(() => {
    if (oauth?.state !== 'authorizing' || !oauthServer) return;
    const timer = window.setInterval(() => void api.oauthStatus(oauthServer)
      .then((value) => finishOAuth(oauthServer, value))
      .catch(() => undefined), 1200);
    return () => window.clearInterval(timer);
  }, [oauth?.state, oauthServer]);

  return <div className="page-grid servers-page">
    <Section title="MCP servers" className="rail-section" action={<span className="count">{servers.length}</span>}>
      <div className="row-list" data-testid="server-list">
        {servers.length === 0 ? <Empty>Register a stdio or Streamable HTTP server to begin.</Empty> : servers.map((server) =>
          <button key={server.id} className={`row-button ${selected === server.id ? 'selected' : ''}`} onClick={() => { setSelected(server.id); setInspection(undefined); setTool(''); setResult(undefined); setConfirmed(false); setToolValues({}); setArgumentsText('{}'); }}>
            <span><b>{server.name}</b><small>{server.transport} · {server.id}</small></span><Status value={server.connected ? 'connected' : 'saved'} />
          </button>)}
      </div>
      <div className="button-row">
        <Button variant="primary" disabled={!selected} data-testid="connect-server" onClick={() => void act(async () => { await api.connectServer(selected); await inspect(selected); await onRefresh(); setMessage('Connected and inspected.'); })}>Connect & inspect</Button>
        <Button disabled={!selected} onClick={() => void act(async () => inspect(selected))}>Inspect</Button>
      </div>
    </Section>

    <div className="workspace-stack">
      <Section title="Register server">
        <form className="form-grid" onSubmit={(event) => { event.preventDefault(); void act(async () => { await api.addServer(buildServerPayload(form)); setSelected(form.id); setForm(initialForm); await onRefresh(); setMessage('Server saved.'); }); }}>
          <Field label="Alias"><Input required value={form.id} onChange={(event) => change('id', event.target.value)} placeholder="sample" data-testid="server-id" /></Field>
          <Field label="Display name"><Input required value={form.name} onChange={(event) => change('name', event.target.value)} placeholder="Sample tools" data-testid="server-name" /></Field>
          <Field label="Transport"><Select value={form.transport} onChange={(event) => change('transport', event.target.value as ServerForm['transport'])}><option value="stdio">stdio</option><option value="http">Streamable HTTP</option></Select></Field>
          {form.transport === 'stdio' ? <>
            <Field label="Executable" hint="Spawned directly; no shell is used."><Input required value={form.command} onChange={(event) => change('command', event.target.value)} data-testid="server-command" /></Field>
            <Field label="Arguments" hint="Space-separated argument vector."><Input value={form.args} onChange={(event) => change('args', event.target.value)} data-testid="server-args" /></Field>
          </> : <>
            <Field label="Endpoint"><Input type="url" required value={form.url} onChange={(event) => change('url', event.target.value)} /></Field>
            <Field label="Header env references" hint="Header=ENV_NAME, never a value."><Input value={form.headerEnv} onChange={(event) => change('headerEnv', event.target.value)} /></Field>
            <Field label="OAuth scopes" hint="Space-separated scopes for interactive OAuth."><Input value={form.oauthScopes} onChange={(event) => change('oauthScopes', event.target.value)} placeholder="mcp:read mcp:write" /></Field>
            <Field label="OAuth client ID" hint="Optional. Leave blank to use DCR when advertised."><Input value={form.oauthClientId} onChange={(event) => change('oauthClientId', event.target.value)} /></Field>
            <Field label="OAuth client-secret env" hint="Environment variable name only."><Input value={form.oauthClientSecretEnv} onChange={(event) => change('oauthClientSecretEnv', event.target.value)} placeholder="MCP_OAUTH_CLIENT_SECRET" /></Field>
          </>}
          <div className="form-actions"><Button variant="primary" type="submit" data-testid="save-server">Save server</Button></div>
        </form>
        {message ? <Notice>{message}</Notice> : null}{error ? <Notice error>{error}</Notice> : null}
      </Section>

      {inspection ? <Section title="Identity & capabilities" action={<Status value="sanitized" />}>
        <div className="split-inspection"><JsonView value={inspection.identity} label="Server identity" /><JsonView value={inspection.capabilities} label="Capabilities" /></div>
      </Section> : null}

      <Section title="Tools & direct invocation" action={<span className="count">{inspection?.tools.length ?? 0} tools</span>}>
        {!inspection ? <Empty>Connect and inspect a server to load its tool schemas.</Empty> : <div className="tool-workspace inspector-tool-workspace">
          <div className="row-list tool-list">{inspection.tools.map((entry) => <button key={entry.name} onClick={() => { setTool(entry.name); setResult(undefined); }} className={`row-button ${tool === entry.name ? 'selected' : ''}`}><span><b>{entry.name}</b><small>{entry.description ?? 'No description'}</small></span>{entry.annotations?.destructiveHint ? <Status value="dangerous" /> : null}</button>)}</div>
          <div className="tool-invocation-panel">
            {!selectedTool ? <Empty>Select a tool to inspect its input schema.</Empty> : <>
              <header className="tool-detail-heading"><div><span className="eyebrow">Tool</span><h3>{selectedTool.name}</h3><p>{selectedTool.description ?? 'No description provided by server.'}</p></div>{selectedTool.annotations?.destructiveHint ? <Status value="dangerous" /> : <Status value="ready" />}</header>
              <div className="argument-mode" role="tablist"><button className={!rawArguments ? 'selected' : ''} onClick={() => setRawArguments(false)}>Form</button><button className={rawArguments ? 'selected' : ''} onClick={() => setRawArguments(true)}>Raw JSON</button></div>
              {rawArguments ? <Field label="JSON arguments"><Textarea rows={10} value={argumentsText} onChange={(event) => setArgumentsText(event.target.value)} data-testid="tool-arguments" /></Field> : <div className="schema-form">
                {toolFields.length === 0 ? <div className="no-arguments"><i>✓</i><span><b>No arguments required</b><small>This tool accepts an empty input object.</small></span></div> : toolFields.map((field) => <div className="schema-field" key={field.key}>
                  <label><span>{field.label}{field.required ? <em>required</em> : <small>optional</small>}</span><code>{field.key} · {field.kind}</code></label>
                  {field.description ? <p>{field.description}</p> : null}
                  {field.enumValues ? <Select value={String(toolValues[field.key] ?? '')} onChange={(event) => setToolValues((current) => ({ ...current, [field.key]: event.target.value }))} data-testid={`tool-field-${field.key}`}><option value="">Choose value</option>{field.enumValues.map((value, index) => <option key={index} value={`enum:${index}`}>{value === null ? 'null' : typeof value === 'string' ? value : JSON.stringify(value)}</option>)}</Select> : field.kind === 'boolean' ? <Select value={String(toolValues[field.key] ?? '')} required={field.required} onChange={(event) => setToolValues((current) => ({ ...current, [field.key]: event.target.value }))} data-testid={`tool-field-${field.key}`}><option value="">Use server default</option><option value="true">True</option><option value="false">False</option></Select> : field.kind === 'array' || field.kind === 'object' || field.kind === 'json' ? <Textarea rows={4} value={String(toolValues[field.key] ?? '')} onChange={(event) => setToolValues((current) => ({ ...current, [field.key]: event.target.value }))} placeholder={field.kind === 'array' ? '[]' : '{}'} data-testid={`tool-field-${field.key}`} /> : <Input type={field.kind === 'number' || field.kind === 'integer' ? 'number' : field.format === 'date-time' ? 'datetime-local' : 'text'} required={field.required} min={field.minimum} max={field.maximum} step={field.kind === 'integer' ? 1 : field.kind === 'number' ? 'any' : undefined} value={String(toolValues[field.key] ?? '')} onChange={(event) => setToolValues((current) => ({ ...current, [field.key]: event.target.value }))} data-testid={`tool-field-${field.key}`} />}
                </div>)}
              </div>}
              <details className="schema-source"><summary>Input schema</summary><pre>{JSON.stringify(selectedTool.inputSchema ?? {}, null, 2)}</pre></details>
              <div className="tool-call-actions"><label className="check"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> Confirm destructive call</label><Button variant="primary" disabled={!tool || inspection.id !== selected} data-testid="invoke-tool" onClick={() => void act(async () => { if (inspection.id !== selected) throw new Error('Inspect selected server before invoking a tool'); const args = rawArguments ? JSON.parse(argumentsText) as Record<string, unknown> : buildToolArguments(toolFields, toolValues); const value = await api.callTool(selected, { tool, arguments: args, confirmDangerous: confirmed }); setResult(value); setMessage('Tool call completed.'); })}>Run {tool} ↗</Button></div>
              {result !== undefined ? <div className="tool-result-panel"><header><div><span className="eyebrow">Result</span><b>Tool completed</b></div><Status value="sanitized" /></header><RichToolResult value={result} /><JsonView value={result} label="Raw MCP response" defaultOpen={false} /></div> : null}
            </>}
          </div>
        </div>}
      </Section>

      {servers.find((server) => server.id === selected)?.transport === 'http' ? <Section title="OAuth connection" action={<Status value={oauth?.state ?? 'not connected'} />}>
        <div className="oauth-summary">
          <div><span className="eyebrow">Secure handoff</span><b>{oauth?.state === 'authorized' ? 'Authorization active' : oauth?.state === 'authorizing' ? 'Waiting for provider' : 'Connect account'}</b><p>Authorization Code + PKCE. Callback returns here, refreshes status, and reconnects server automatically.</p></div>
          {oauth?.scopes?.length ? <div className="scope-list">{oauth.scopes.map((scope) => <code key={scope}>{scope}</code>)}</div> : null}
        </div>
        <div className="button-row">
          <Button variant="primary" onClick={() => void act(async () => {
            const value = await api.beginOAuth(selected);
            setOauthServer(selected);
            setOauth(value);
            setAuthorizationUrl(value.authorizationUrl ?? '');
            if (value.authorizationUrl) window.open(value.authorizationUrl, 'workbench-oauth', 'popup,width=560,height=720');
          })}>{oauth?.state === 'authorized' ? 'Reconnect with OAuth' : 'Connect with OAuth'}</Button>
          <Button onClick={() => void act(async () => { setOauthServer(selected); await refreshOAuth(selected); })}>Check status</Button>
          <Button variant="danger" onClick={() => void act(async () => { await api.forgetOAuth(selected); setOauth(undefined); setOauthServer(''); setAuthorizationUrl(''); await onRefresh(); })}>Forget authorization</Button>
          {authorizationUrl ? <a className="inline-link" href={authorizationUrl} target="workbench-oauth">Open authorization window ↗</a> : null}
        </div>
        {oauth?.state === 'authorizing' ? <div className="oauth-waiting"><i /><span>Complete authorization in popup. This page updates automatically.</span></div> : null}
        {oauth ? <JsonView value={oauth.timeline} label="Sanitized OAuth timeline" /> : null}
      </Section> : null}
    </div>
  </div>;
}
