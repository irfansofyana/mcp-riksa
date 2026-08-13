import { useState } from 'react';
import { api } from '../api.js';
import { Button, Empty, Field, Input, Notice, Section, Select, Status } from '../components.js';
import { buildProviderPayload, type ProviderForm } from '../model.js';
import type { ProviderSummary } from '../types.js';

const initial: ProviderForm = {
  id: '', name: '', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:4000/v1', alias: 'default', model: '',
  apiKeyEnv: 'WORKBENCH_PROVIDER_API_KEY', headerEnv: '', inputPrice: '0', outputPrice: '0',
};

export function SettingsPage({ providers, onRefresh }: { providers: ProviderSummary[]; onRefresh(): Promise<void> }) {
  const [form, setForm] = useState(initial);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const change = <K extends keyof ProviderForm>(key: K, value: ProviderForm[K]) => setForm((current) => ({ ...current, [key]: value }));
  const act = async (operation: () => Promise<void>) => { setMessage(''); setError(''); try { await operation(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } };

  return <div className="settings-layout">
    <Section title="Model Providers" action={<span className="count">{providers.length}</span>}>
      <p className="section-copy">Configure compatibility, aliases, optional model discovery, environment-referenced headers, and local pricing. Resolved values never enter this screen, YAML, SQLite, logs, or exports.</p>
      <div className="provider-list">{providers.length === 0 ? <Empty>Add an OpenAI-compatible or Anthropic-compatible private endpoint.</Empty> : providers.map((provider) => <div className="provider-row" key={provider.id}><div><b>{provider.name}</b><small>{provider.type} · {provider.baseUrl}</small><code>{Object.entries(provider.models).map(([alias, model]) => `${alias} → ${model}`).join(', ')}</code></div><div><Status value={provider.apiKeyConfigured ? 'env ready' : 'no key'} /><Button onClick={() => void act(async () => { const value = await api.testProvider(provider.id); setMessage(`Connection passed. ${value.models.length} model(s) available.`); })}>Test connection</Button></div></div>)}</div>
    </Section>
    <Section title="Add or replace provider">
      <form className="form-grid" onSubmit={(event) => { event.preventDefault(); void act(async () => { await api.addProvider(buildProviderPayload(form)); await onRefresh(); setMessage('Model provider saved.'); }); }}>
        <Field label="Alias"><Input required value={form.id} onChange={(event) => change('id', event.target.value)} data-testid="provider-id" placeholder="local-openai" /></Field>
        <Field label="Display name"><Input required value={form.name} onChange={(event) => change('name', event.target.value)} data-testid="provider-name" /></Field>
        <Field label="Compatibility"><Select value={form.type} onChange={(event) => change('type', event.target.value as ProviderForm['type'])}><option value="openai-compatible">OpenAI-compatible</option><option value="anthropic-compatible">Anthropic-compatible</option></Select></Field>
        <Field label="Base URL"><Input required type="url" value={form.baseUrl} onChange={(event) => change('baseUrl', event.target.value)} data-testid="provider-url" /></Field>
        <Field label="Model alias"><Input required value={form.alias} onChange={(event) => change('alias', event.target.value)} /></Field>
        <Field label="Provider model"><Input required value={form.model} onChange={(event) => change('model', event.target.value)} data-testid="provider-model" /></Field>
        <Field label="API key env" hint="Environment variable name only."><Input value={form.apiKeyEnv} onChange={(event) => change('apiKeyEnv', event.target.value)} /></Field>
        <Field label="Custom header env" hint="Header=ENV_NAME"><Input value={form.headerEnv} onChange={(event) => change('headerEnv', event.target.value)} /></Field>
        <Field label="Input $ / 1M tokens"><Input inputMode="decimal" value={form.inputPrice} onChange={(event) => change('inputPrice', event.target.value)} /></Field>
        <Field label="Output $ / 1M tokens"><Input inputMode="decimal" value={form.outputPrice} onChange={(event) => change('outputPrice', event.target.value)} /></Field>
        <div className="form-actions"><Button variant="primary" type="submit" data-testid="save-provider">Save provider</Button></div>
      </form>
      {message ? <Notice>{message}</Notice> : null}{error ? <Notice error>{error}</Notice> : null}
    </Section>
    <Section title="Security posture"><div className="definition-list"><div><b>Loopback service</b><span>Bound to 127.0.0.1 unless external access is explicitly enabled.</span></div><div><b>Credential references</b><span>Configuration stores environment variable names, never their values.</span></div><div><b>OAuth</b><span>Authorization Code + PKCE, protected-resource and authorization-server metadata, DCR or static clients, refresh, and forget are supported when advertised.</span></div></div></Section>
  </div>;
}
