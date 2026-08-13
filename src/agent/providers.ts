import type { ProviderAdapter } from './types.js';
import { providerConfigSchema } from './types.js';
import { createOpenAIAdapter } from './openai.js';
import { createAnthropicAdapter } from './anthropic.js';

export function createProviderAdapter(input: unknown): ProviderAdapter {
  const config = providerConfigSchema.parse(input);
  return config.type === 'openai-compatible'
    ? createOpenAIAdapter(config)
    : createAnthropicAdapter(config);
}
