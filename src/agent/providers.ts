import type { ProviderAdapter } from './types.js';
import { providerConfigSchema } from './types.js';
import { createOpenAIAdapter } from './openai.js';
import { createAnthropicAdapter } from './anthropic.js';
import { resolveEnvironmentSecret } from './types.js';
import type { SecretResolver } from '../secrets/types.js';

export function createProviderAdapter(input: unknown, resolveSecret: SecretResolver = resolveEnvironmentSecret): ProviderAdapter {
  const config = providerConfigSchema.parse(input);
  return config.type === 'openai-compatible'
    ? createOpenAIAdapter(config, resolveSecret)
    : createAnthropicAdapter(config, resolveSecret);
}
