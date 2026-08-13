import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Button, Empty, Field, Input, JsonView, Notice, Section, Select, Status, Textarea } from '../components.js';
import { buildServerPayload, type ServerForm } from '../model.js';
import type { ServerSummary, Tool } from '../types.js';

type OAuthStatus = { id?: string; state: string; scopes: string[]; timeline: unknown[]; authorizationUrl?: string; expiresAt?: string };

const initialForm: ServerForm = {
  id: '', name: '', transport: 'stdio', command: 'node', args: '', url: 'http://127.0.0.1:3000/mcp', headerEnv: '',
  oauthScopes: '', oauthClientId: '', oauthClientSecretEnv: '',
};

export function ServersPage({ servers, onRefresh }: { servers: ServerSummary[]; onRefresh(): Promise<void> }) {
  const [form, setForm] = useState(initialForm);
  const [selected, setSelected] = useState(servers[0]?.id ?? '');
  const [inspection, setInspection] = useState<{ identity: unknown; capabilities: unknown; tools: Tool[] }>();
  const [tool, setTool] = useState('');
  const [argumentsText, setArgumentsText] = useState('{}');
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
          <button key={server.id} className={`row-button ${selected === server.id ? 'selected' : ''}`} onClick={() => setSelected(server.id)}>
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
        {!inspection ? <Empty>Connect and inspect a server to load its tool schemas.</Empty> : <div className="tool-workspace">
          <div className="row-list tool-list">{inspection.tools.map((entry) => <button key={entry.name} onClick={() => { setTool(entry.name); setArgumentsText('{}'); }} className={`row-button ${tool === entry.name ? 'selected' : ''}`}><span><b>{entry.name}</b><small>{entry.description ?? 'No description'}</small></span>{entry.annotations?.destructiveHint ? <Status value="dangerous" /> : null}</button>)}</div>
          <div>
            <Field label="JSON arguments"><Textarea rows={7} value={argumentsText} onChange={(event) => setArgumentsText(event.target.value)} data-testid="tool-arguments" /></Field>
            <label className="check"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> Confirm a dangerous call when required</label>
            <Button variant="primary" disabled={!tool} data-testid="invoke-tool" onClick={() => void act(async () => { const value = await api.callTool(selected, { tool, arguments: JSON.parse(argumentsText), confirmDangerous: confirmed }); setResult(value); setMessage('Tool call completed.'); })}>Invoke {tool || 'tool'}</Button>
            {result !== undefined ? <JsonView value={result} label="Sanitized result" /> : null}
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
