import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { Button, Empty, Field, Input, JsonView, Notice, RichToolResult, Section, Select, Status, Textarea } from '../components.js';
import { buildServerPayload, buildToolArguments, buildToolFields, initialToolValues, serverToForm, type ServerForm } from '../model.js';
import type { ConformanceReportSummary, ServerSummary, Tool } from '../types.js';

type OAuthStatus = { id?: string; state: string; scopes: string[]; timeline: unknown[]; authorizationUrl?: string; expiresAt?: string };

const initialForm = (): ServerForm => ({
  id: '', name: '', transport: 'stdio', command: 'node', args: '', cwd: '', envRefs: '',
  url: 'http://127.0.0.1:3000/mcp', headerEnv: '', allowUnsafeEndpoint: false,
  oauthEnabled: false, oauthScopes: '', oauthClientId: '', oauthClientSecretEnv: '', oauthTimeoutMs: '120000',
  staticAuthEnabled: false, staticAuthHeader: 'Authorization', staticAuthScheme: 'Bearer', staticAuthCredential: '',
});

export function ServersPage({ servers, conformanceReports, onRefresh, onConformanceStarted }: {
  servers: ServerSummary[]; conformanceReports: ConformanceReportSummary[]; onRefresh(): Promise<void>; onConformanceStarted(id: string): void;
}) {
  const [form, setForm] = useState(initialForm);
  const [editingId, setEditingId] = useState('');
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
  const selectedServer = servers.find((server) => server.id === selected);
  const latestConformance = conformanceReports.find((report) => report.serverId === selected);
  const toolFields = useMemo(() => buildToolFields(selectedTool?.inputSchema), [selectedTool]);

  useEffect(() => {
    setToolValues(initialToolValues(toolFields));
    setArgumentsText('{}');
    setRawArguments(false);
  }, [tool, inspection]);

  const change = <K extends keyof ServerForm>(key: K, value: ServerForm[K]) => setForm((current) => ({ ...current, [key]: value }));
  const resetForm = () => { setForm(initialForm()); setEditingId(''); };
  const clearInspection = () => { setInspection(undefined); setTool(''); setResult(undefined); setConfirmed(false); setToolValues({}); setArgumentsText('{}'); };
  const editServer = (server: ServerSummary) => { setForm(serverToForm(server)); setEditingId(server.id); setSelected(server.id); setMessage(''); setError(''); };
  const duplicateServer = (server: ServerSummary) => { const next = serverToForm(server); setForm({ ...next, id: `${server.id}-copy`, name: `${server.name} copy` }); setEditingId(''); setMessage('Duplicate loaded. Choose a unique server ID.'); };
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
      if (signal?.type === 'mcp-riksa:oauth' && signal.value?.id) setOauthSignal(signal.value.id);
    };
    const onMessage = (event: MessageEvent) => { if (event.origin === window.location.origin) receive(event.data); };
    window.addEventListener('message', onMessage);
    const channel = typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel('mcp-riksa-oauth');
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
      <div className="row-list server-config-list" data-testid="server-list">
        {servers.length === 0 ? <Empty>Register a stdio or Streamable HTTP server to begin.</Empty> : servers.map((server) => <div key={server.id} className={`config-list-item ${selected === server.id ? 'selected' : ''}`}>
          <button className="config-select" onClick={() => { setSelected(server.id); clearInspection(); }}><span><b>{server.name}</b><small>{server.transport} · {server.id}</small></span><Status value={server.connected ? 'connected' : 'saved'} /></button>
          <div className="config-actions compact"><Button onClick={() => editServer(server)}>Edit</Button><Button onClick={() => duplicateServer(server)}>Duplicate</Button><Button variant="danger" onClick={() => void act(async () => {
            try { await api.deleteServer(server.id); }
            catch (reason) {
              if (!(reason instanceof Error) || !reason.message.includes('referenced') || !window.confirm(`${reason.message}. Delete anyway? Saved suites and conversations will remain unresolved until this ID is restored.`)) throw reason;
              await api.deleteServer(server.id, true);
            }
            if (selected === server.id) { setSelected(''); clearInspection(); }
            if (editingId === server.id) resetForm();
            await onRefresh(); setMessage('MCP server deleted.');
          })}>Delete</Button></div>
        </div>)}
      </div>
      <div className="button-row">
        <Button variant="primary" disabled={!selected} data-testid="connect-server" onClick={() => void act(async () => { await api.connectServer(selected); await inspect(selected); await onRefresh(); setMessage('Connected and inspected.'); })}>Connect & inspect</Button>
        <Button disabled={!selected} onClick={() => void act(async () => inspect(selected))}>Inspect</Button>
        <Button disabled={selectedServer?.transport !== 'http'} title={selectedServer?.transport === 'stdio' ? 'Official conformance MVP does not support stdio' : undefined} onClick={() => void act(async () => {
          const report = await api.startConformance({ serverId: selected, selection: { kind: 'suite', suite: 'active' }, timeoutMs: 120_000 });
          onConformanceStarted(report.id);
        })}>Run conformance</Button>
      </div>
      {selectedServer ? <p className="hint">Conformance: {selectedServer.transport === 'stdio' ? 'unsupported for stdio' : latestConformance ? `latest ${latestConformance.status} · ${new Date(latestConformance.startedAt).toLocaleString()}` : 'not tested'}</p> : null}
    </Section>

    <div className="workspace-stack">
      <Section title={editingId ? `Edit server · ${editingId}` : 'Register server'} action={editingId ? <Status value="editing" /> : undefined}>
        <form className="form-grid" onSubmit={(event) => { event.preventDefault(); void act(async () => { const payload = buildServerPayload(form); if (editingId) await api.updateServer(editingId, payload); else await api.addServer(payload); setSelected(form.id); clearInspection(); await onRefresh(); setMessage(editingId ? 'Server updated. Reconnect to apply changes.' : 'Server created.'); resetForm(); }); }}>
          <Field label="Server ID" hint={editingId ? 'ID is immutable. Duplicate to create a new ID.' : 'Stable alias used by suites and conversations.'}><Input required disabled={Boolean(editingId)} value={form.id} onChange={(event) => change('id', event.target.value)} placeholder="sample" data-testid="server-id" /></Field>
          <Field label="Display name"><Input required value={form.name} onChange={(event) => change('name', event.target.value)} placeholder="Sample tools" data-testid="server-name" /></Field>
          <Field label="Transport"><Select value={form.transport} onChange={(event) => change('transport', event.target.value as ServerForm['transport'])}><option value="stdio">stdio</option><option value="http">Streamable HTTP</option></Select></Field>
          {form.transport === 'stdio' ? <>
            <Field label="Executable" hint="Spawned directly; no shell is used."><Input required value={form.command} onChange={(event) => change('command', event.target.value)} data-testid="server-command" /></Field>
            <Field label="Arguments" hint={'JSON string array preserves spaces, e.g. ["--prompt","hello world"].'}><Input value={form.args} onChange={(event) => change('args', event.target.value)} data-testid="server-args" placeholder={'["--flag","value"]'} /></Field>
            <Field label="Working directory"><Input value={form.cwd ?? ''} onChange={(event) => change('cwd', event.target.value)} /></Field>
            <Field label="Environment secret references" hint="NAME=env:ENV_NAME, NAME=vault:secret-id, or NAME=session:secret-id."><Input value={form.envRefs ?? ''} onChange={(event) => change('envRefs', event.target.value)} /></Field>
          </> : <>
            <Field label="Endpoint"><Input type="url" required value={form.url} onChange={(event) => change('url', event.target.value)} /></Field>
            <Field label="Header secret references" hint="Header=env:ENV_NAME, Header=vault:secret-id, or Header=session:secret-id."><Input value={form.headerEnv} onChange={(event) => change('headerEnv', event.target.value)} /></Field>
            <label className="check"><input type="checkbox" checked={form.staticAuthEnabled ?? false} disabled={form.oauthEnabled} onChange={(event) => change('staticAuthEnabled', event.target.checked)} /> Use static HTTP authorization</label>
            {form.staticAuthEnabled ? <>
              <Field label="Authorization header"><Input required value={form.staticAuthHeader ?? 'Authorization'} onChange={(event) => change('staticAuthHeader', event.target.value)} /></Field>
              <Field label="Authorization scheme" hint="Bearer, Basic, or a custom token scheme."><Input required value={form.staticAuthScheme ?? 'Bearer'} onChange={(event) => change('staticAuthScheme', event.target.value)} /></Field>
              <Field label="Credential reference" hint="env:ENV_NAME, vault:secret-id, or session:secret-id. The backend assembles the header."><Input required value={form.staticAuthCredential ?? ''} onChange={(event) => change('staticAuthCredential', event.target.value)} /></Field>
            </> : null}
            <label className="check"><input type="checkbox" checked={form.oauthEnabled ?? false} disabled={form.staticAuthEnabled} onChange={(event) => change('oauthEnabled', event.target.checked)} /> Enable interactive OAuth</label>
            {form.oauthEnabled ? <>
              <Field label="OAuth scopes" hint="Space-separated scopes for interactive OAuth."><Input value={form.oauthScopes} onChange={(event) => change('oauthScopes', event.target.value)} placeholder="mcp:read mcp:write" /></Field>
              <Field label="OAuth client ID" hint="Optional. Leave blank to use DCR when advertised."><Input value={form.oauthClientId} onChange={(event) => change('oauthClientId', event.target.value)} /></Field>
              <Field label="OAuth client-secret reference" hint="env:ENV_NAME, vault:secret-id, or session:secret-id."><Input value={form.oauthClientSecretEnv} onChange={(event) => change('oauthClientSecretEnv', event.target.value)} placeholder="env:MCP_OAUTH_CLIENT_SECRET" /></Field>
              <Field label="OAuth timeout (ms)"><Input type="number" min={1} max={300000} value={form.oauthTimeoutMs ?? '120000'} onChange={(event) => change('oauthTimeoutMs', event.target.value)} /></Field>
            </> : null}
            <label className="check"><input type="checkbox" checked={form.allowUnsafeEndpoint ?? false} onChange={(event) => change('allowUnsafeEndpoint', event.target.checked)} /> Allow endpoint addresses blocked by default safety policy</label>
          </>}
          <div className="form-actions"><Button variant="primary" type="submit" data-testid="save-server">{editingId ? 'Save changes' : 'Create server'}</Button>{editingId || form.id ? <Button type="button" onClick={resetForm}>Cancel</Button> : null}</div>
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
              <div className="tool-call-actions">{selectedTool.annotations?.destructiveHint === true ? <label className="check"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> Confirm destructive call</label> : <span className="hint">Confirmation required only when server explicitly marks tool destructive.</span>}<Button variant="primary" disabled={!tool || inspection.id !== selected || (selectedTool.annotations?.destructiveHint === true && !confirmed)} data-testid="invoke-tool" onClick={() => void act(async () => { if (inspection.id !== selected) throw new Error('Inspect selected server before invoking a tool'); const args = rawArguments ? JSON.parse(argumentsText) as Record<string, unknown> : buildToolArguments(toolFields, toolValues); const value = await api.callTool(selected, { tool, arguments: args, confirmDangerous: confirmed }); setResult(value); setMessage('Tool call completed.'); })}>Run {tool} ↗</Button></div>
              {result !== undefined ? <div className="tool-result-panel"><header><div><span className="eyebrow">Result</span><b>Tool completed</b></div><Status value="sanitized" /></header><RichToolResult value={result} /><JsonView value={result} label="Raw MCP response" defaultOpen={false} /></div> : null}
            </>}
          </div>
        </div>}
      </Section>

      {selectedServer?.transport === 'http' && selectedServer.oauth !== undefined ? <Section title="OAuth connection" action={<Status value={oauth?.state ?? 'not connected'} />}>
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
            if (value.authorizationUrl) window.open(value.authorizationUrl, 'mcp-riksa-oauth', 'popup,width=560,height=720');
          })}>{oauth?.state === 'authorized' ? 'Reconnect with OAuth' : 'Connect with OAuth'}</Button>
          <Button onClick={() => void act(async () => { setOauthServer(selected); await refreshOAuth(selected); })}>Check status</Button>
          <Button variant="danger" onClick={() => void act(async () => { await api.forgetOAuth(selected); setOauth(undefined); setOauthServer(''); setAuthorizationUrl(''); await onRefresh(); })}>Forget authorization</Button>
          {authorizationUrl ? <a className="inline-link" href={authorizationUrl} target="mcp-riksa-oauth">Open authorization window ↗</a> : null}
        </div>
        {oauth?.state === 'authorizing' ? <div className="oauth-waiting"><i /><span>Complete authorization in popup. This page updates automatically.</span></div> : null}
        {oauth ? <JsonView value={oauth.timeline} label="Sanitized OAuth timeline" /> : null}
      </Section> : null}
    </div>
  </div>;
}
