import { EncryptedFileSecretBackend } from '../../src/secrets/encrypted-file.js';
import { SecretStore } from '../../src/secrets/store.js';

const [dataDirectory, configDirectory, writer = 'writer', countText = '5'] = process.argv.slice(2);
if (!dataDirectory || !configDirectory) throw new Error('Expected data and config directories');
const store = new SecretStore({ vaultBackend: new EncryptedFileSecretBackend({ dataDirectory, configDirectory }) });
for (let index = 0; index < Number(countText); index += 1) {
  await store.create({
    backend: 'vault',
    label: `${writer}-${index}`,
    purposes: ['mcp-header'],
    value: `${writer}-secret-${index}`,
  });
}
await store.close();
