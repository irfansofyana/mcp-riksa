import { useState } from 'react';
import { api } from '../api.js';
import { Button, Empty, Field, Input, Notice, Section, Select, Status } from '../components.js';
import { buildProviderPayload, providerToForm, type ProviderForm } from '../model.js';
import type { ProviderSummary } from '../types.js';

const initial = (): ProviderForm => ({
  id: '', name: '', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:4000/v1',
  models: [{ alias: 'default', model: '' }], apiKeyEnv: 'MCP_RIKSA_PROVIDER_API_KEY',
  headerEnv: '', inputPrice: '0', outputPrice: '0',
});

export function SettingsPage({ providers, onRefresh }: { providers: ProviderSummary[]; onRefresh(): Promise<void> }) {
  const [form, setForm] = useState(initial);
  const [editingId, setEditingId] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const change = <K extends keyof ProviderForm>(key: K, value: ProviderForm[K]) => setForm((current) => ({ ...current, [key]: value }));
  const act = async (operation: () => Promise<void>) => { setMessage(''); setError(''); try { await operation(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } };
  const reset = () => { setForm(initial()); setEditingId(''); };
  const edit = (provider: ProviderSummary) => { setForm(providerToForm(provider)); setEditingId(provider.id); setMessage(''); setError(''); };
  const duplicate = (provider: ProviderSummary) => { const next = providerToForm(provider); setForm({ ...next, id: `${provider.id}-copy`, name: `${provider.name} copy` }); setEditingId(''); setMessage('Duplicate loaded. Choose a unique provider ID.'); };
  const changeModel = (index: number, key: 'alias' | 'model', value: string) => setForm((current) => ({
    ...current, models: current.models.map((entry, entryIndex) => entryIndex === index ? { ...entry, [key]: value } : entry),
  }));

  return <div className="settings-layout">
    <Section title="Model Providers" action={<span className="count">{providers.length}</span>}>
      <p className="section-copy">One provider can expose many model aliases. Suites and conversations select an alias; provider-specific model IDs stay centralized here.</p>
      <div className="provider-list">{providers.length === 0 ? <Empty>Add an OpenAI-compatible or Anthropic-compatible private endpoint.</Empty> : providers.map((provider) => <div className="provider-row provider-card" key={provider.id}>
        <div><div className="provider-title"><b>{provider.name}</b><Status value={provider.apiKeyConfigured ? 'env ready' : 'no key'} /></div><small>{provider.type} · {provider.baseUrl}</small><div className="model-chips">{Object.entries(provider.models).map(([alias, model]) => <span key={alias}><b>{alias}</b><code>{model}</code></span>)}</div></div>
        <div className="config-actions"><Button onClick={() => void act(async () => { const value = await api.testProvider(provider.id); setMessage(`Connection passed. ${value.models.length} model(s) available.`); })}>Test</Button><Button onClick={() => edit(provider)}>Edit</Button><Button onClick={() => duplicate(provider)}>Duplicate</Button><Button variant="danger" onClick={() => void act(async () => {
          try { await api.deleteProvider(provider.id); }
          catch (reason) {
            if (!(reason instanceof Error) || !reason.message.includes('referenced') || !window.confirm(`${reason.message}. Delete anyway? Saved suites and conversations will remain unresolved until this ID is restored.`)) throw reason;
            await api.deleteProvider(provider.id, true);
          }
          if (editingId === provider.id) reset();
          await onRefresh(); setMessage('Model provider deleted.');
        })}>Delete</Button></div>
      </div>)}</div>
    </Section>

    <Section title={editingId ? `Edit provider · ${editingId}` : 'Add model provider'} action={editingId ? <Status value="editing" /> : undefined}>
      <form className="form-grid" onSubmit={(event) => { event.preventDefault(); void act(async () => {
        const payload = buildProviderPayload(form);
        if (editingId) await api.updateProvider(editingId, payload); else await api.addProvider(payload);
        await onRefresh(); setMessage(editingId ? 'Model provider updated.' : 'Model provider created.'); reset();
      }); }}>
        <Field label="Provider ID" hint={editingId ? 'ID is immutable. Duplicate to create a new ID.' : 'Stable alias used by suites and conversations.'}><Input required disabled={Boolean(editingId)} value={form.id} onChange={(event) => change('id', event.target.value)} data-testid="provider-id" placeholder="company-gateway" /></Field>
        <Field label="Display name"><Input required value={form.name} onChange={(event) => change('name', event.target.value)} data-testid="provider-name" /></Field>
        <Field label="Compatibility"><Select value={form.type} onChange={(event) => change('type', event.target.value as ProviderForm['type'])}><option value="openai-compatible">OpenAI-compatible</option><option value="anthropic-compatible">Anthropic-compatible</option></Select></Field>
        <Field label="Base URL"><Input required type="url" value={form.baseUrl} onChange={(event) => change('baseUrl', event.target.value)} data-testid="provider-url" /></Field>

        <div className="model-editor">
          <header><div><span className="eyebrow">Model catalog</span><b>{form.models.length} configured</b></div><Button type="button" onClick={() => change('models', [...form.models, { alias: '', model: '' }])}>＋ Add model</Button></header>
          <div className="model-rows">{form.models.map((entry, index) => <div className="model-row" key={index}>
            <Field label="Workbench alias"><Input required value={entry.alias} onChange={(event) => changeModel(index, 'alias', event.target.value)} placeholder="fast" data-testid={`provider-model-alias-${index}`} /></Field>
            <span className="model-arrow">→</span>
            <Field label="Provider model ID"><Input required value={entry.model} onChange={(event) => changeModel(index, 'model', event.target.value)} placeholder="gpt-5-mini" data-testid={index === 0 ? 'provider-model' : `provider-model-${index}`} /></Field>
            <Button type="button" variant="danger" disabled={form.models.length === 1} onClick={() => change('models', form.models.filter((_, entryIndex) => entryIndex !== index))}>Remove</Button>
          </div>)}</div>
        </div>

        <Field label="API key env" hint="Environment variable name only."><Input value={form.apiKeyEnv} onChange={(event) => change('apiKeyEnv', event.target.value)} /></Field>
        <Field label="Custom header env" hint="One Header=ENV_NAME per line."><Input value={form.headerEnv} onChange={(event) => change('headerEnv', event.target.value)} /></Field>
        <Field label="Input $ / 1M tokens"><Input inputMode="decimal" value={form.inputPrice} onChange={(event) => change('inputPrice', event.target.value)} /></Field>
        <Field label="Output $ / 1M tokens"><Input inputMode="decimal" value={form.outputPrice} onChange={(event) => change('outputPrice', event.target.value)} /></Field>
        <div className="form-actions"><Button variant="primary" type="submit" data-testid="save-provider">{editingId ? 'Save changes' : 'Create provider'}</Button>{editingId || form.id ? <Button type="button" onClick={reset}>Cancel</Button> : null}</div>
      </form>
      {message ? <Notice>{message}</Notice> : null}{error ? <Notice error>{error}</Notice> : null}
    </Section>
    <Section title="Security posture"><div className="definition-list"><div><b>Loopback service</b><span>Bound to 127.0.0.1 unless external access is explicitly enabled.</span></div><div><b>Credential references</b><span>Configuration stores environment variable names, never their values.</span></div><div><b>Deletion safety</b><span>Referenced configurations require explicit force confirmation. Historical suites, conversations, and runs remain local.</span></div></div></Section>
  </div>;
}
