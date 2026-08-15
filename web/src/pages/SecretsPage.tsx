import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { Button, Empty, Field, Input, Notice, Section, Select, Status } from '../components.js';
import type { SecretMetadata, SecretPurpose, VaultStatus } from '../types.js';

const purposeOptions: Array<{ value: SecretPurpose; label: string }> = [
  { value: 'provider-api-key', label: 'Model provider API key' },
  { value: 'provider-header', label: 'Model provider header' },
  { value: 'mcp-header', label: 'MCP HTTP header' },
  { value: 'oauth-client-secret', label: 'OAuth client secret' },
  { value: 'oauth-token', label: 'OAuth token' },
  { value: 'stdio-env', label: 'Stdio environment value' },
];

export function SecretsPage() {
  const [secrets, setSecrets] = useState<SecretMetadata[]>([]);
  const [vault, setVault] = useState<VaultStatus>();
  const [backend, setBackend] = useState<'vault' | 'session'>('vault');
  const [label, setLabel] = useState('');
  const [purpose, setPurpose] = useState<SecretPurpose>('provider-api-key');
  const [value, setValue] = useState('');
  const [replacementId, setReplacementId] = useState('');
  const [replacement, setReplacement] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    const [nextSecrets, nextVault] = await Promise.allSettled([api.secrets(), api.vaultStatus()]);
    if (nextVault.status === 'fulfilled') setVault(nextVault.value);
    if (nextSecrets.status === 'fulfilled') {
      setSecrets(nextSecrets.value);
      return;
    }
    setSecrets([]);
    throw nextSecrets.reason;
  }, []);

  useEffect(() => {
    void refresh().catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [refresh]);

  const act = async (operation: () => Promise<void>) => {
    setMessage('');
    setError('');
    try { await operation(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  return <div className="settings-layout secrets-page">
    <Section title="Encrypted MCP Riksa Vault" action={<Status value={vault?.state ?? 'checking'} />}>
      <div className="definition-list">
        <div><b>Automatic local encryption</b><span>A random key is stored separately at <code>{vault?.keyLocation ?? 'checking…'}</code>. No master passphrase.</span></div>
        <div><b>Honest boundary</b><span>Protects against accidental data-directory disclosure, not malware running as your OS user or disclosure of both files.</span></div>
        <div><b>Write-only values</b><span>Stored credentials cannot be revealed or copied back through MCP Riksa.</span></div>
      </div>
      {vault && (vault.state === 'missing-key' || vault.state === 'corrupt') ? <div className="vault-recovery">
        <Notice error>The vault cannot be decrypted. Resetting permanently removes its stored credentials.</Notice>
        <Button variant="danger" onClick={() => void act(async () => {
          if (!window.confirm('Reset the encrypted vault? Existing vault secrets cannot be recovered.')) return;
          await api.resetVault(true);
          await refresh();
          setMessage('Encrypted vault reset. A new key will be generated on the next persistent save.');
        })}>Reset vault</Button>
      </div> : null}
    </Section>

    <Section title="Stored Secrets" action={<span className="count">{secrets.length}</span>}>
      <div className="secret-list">{secrets.length === 0 ? <Empty>No saved secrets. Add one below or keep using environment references.</Empty> : secrets.map((secret) => <article className="secret-row" key={secret.id}>
        <div className="secret-details"><div><b>{secret.label}</b><Status value={secret.configured ? 'configured' : 'missing'} /></div><small>{secret.backend === 'encrypted-file' ? 'Encrypted vault' : 'Session only'} · {secret.purposes.map((entry) => purposeOptions.find((option) => option.value === entry)?.label ?? entry).join(', ')}</small><code>{secret.id}</code>{secret.lastUsedAt ? <small>Last used {new Date(secret.lastUsedAt).toLocaleString()}</small> : null}</div>
        <div className="config-actions">
          <Button onClick={() => { setReplacementId(secret.id); setReplacement(''); setMessage(''); setError(''); }}>Replace</Button>
          <Button variant="danger" onClick={() => void act(async () => {
            if (!window.confirm(`Delete ${secret.label}? Configurations using it will stop working.`)) return;
            await api.deleteSecret(secret.id, true);
            if (replacementId === secret.id) { setReplacementId(''); setReplacement(''); }
            await refresh();
            setMessage('Secret deleted.');
          })}>Delete</Button>
        </div>
        {replacementId === secret.id ? <form className="secret-replace" onSubmit={(event) => { event.preventDefault(); void act(async () => {
          await api.replaceSecret(secret.id, replacement);
          setReplacement('');
          setReplacementId('');
          await refresh();
          setMessage('Secret replaced securely.');
        }); }}>
          <Field label="Replacement value" hint="The existing value is never loaded into this field."><Input required minLength={4} type="password" autoComplete="new-password" value={replacement} onChange={(event) => setReplacement(event.target.value)} data-testid={`replace-secret-${secret.id}`} /></Field>
          <div className="form-actions"><Button type="submit" variant="primary">Replace securely</Button><Button type="button" onClick={() => { setReplacementId(''); setReplacement(''); }}>Cancel</Button></div>
        </form> : null}
      </article>)}</div>
    </Section>

    <Section title="Add Secret">
      <form className="form-grid" onSubmit={(event) => { event.preventDefault(); void act(async () => {
        await api.createSecret({ backend, label, purposes: [purpose], value });
        setValue('');
        setLabel('');
        await refresh();
        setMessage(backend === 'vault' ? 'Secret encrypted and saved.' : 'Session-only secret added.');
      }); }}>
        <Field label="Label" hint="A safe description, never the credential itself."><Input required maxLength={120} value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Company gateway API key" data-testid="secret-label" /></Field>
        <Field label="Storage"><Select value={backend} onChange={(event) => setBackend(event.target.value as 'vault' | 'session')} data-testid="secret-storage"><option value="vault">Encrypted MCP Riksa vault</option><option value="session">Session only</option></Select></Field>
        <Field label="Purpose"><Select value={purpose} onChange={(event) => setPurpose(event.target.value as SecretPurpose)} data-testid="secret-purpose">{purposeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</Select></Field>
        <Field label="Secret value" hint="Sent once to the loopback API and never returned."><Input required minLength={4} type="password" autoComplete="new-password" value={value} onChange={(event) => setValue(event.target.value)} data-testid="secret-value" /></Field>
        <div className="form-actions"><Button type="submit" variant="primary" data-testid="save-secret">Save securely</Button></div>
      </form>
      {message ? <Notice>{message}</Notice> : null}{error ? <Notice error>{error}</Notice> : null}
    </Section>
  </div>;
}
