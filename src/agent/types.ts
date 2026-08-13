import { z } from 'zod';
import { environmentVariableNameSchema } from '../core/environment.js';
import { registerSecretValue } from '../core/redaction.js';

export const providerConfigSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(['openai-compatible', 'anthropic-compatible']),
  baseUrl: z.string().url().refine((value) => ['http:', 'https:'].includes(new URL(value).protocol), 'Provider base URL must use http or https'),
  models: z.record(z.string().min(1), z.string().min(1)).refine((models) => Object.keys(models).length > 0, 'At least one model alias is required'),
  apiKeyEnv: environmentVariableNameSchema.optional(),
  headerEnv: z.record(z.string(), environmentVariableNameSchema).default({}),
  pricing: z.strictObject({
    inputPerMillion: z.number().nonnegative(),
    outputPerMillion: z.number().nonnegative(),
  }).default({ inputPerMillion: 0, outputPerMillion: 0 }),
});

export type ProviderConfig = z.infer<typeof providerConfigSchema>;
export type ProviderPricing = ProviderConfig['pricing'];

export type ProviderTool = { name: string; description?: string; inputSchema: Record<string, unknown> };
export type ProviderToolCall = { id: string; name: string; arguments: Record<string, unknown> };
export type ProviderMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls: ProviderToolCall[] }
  | { role: 'tool'; content: string; toolCallId: string; name: string };

export type ProviderRequest = {
  model: string;
  messages: ProviderMessage[];
  tools: ProviderTool[];
  signal?: AbortSignal;
  onTextDelta?(delta: string): void;
};

export type ProviderResponse = {
  text: string;
  toolCalls: ProviderToolCall[];
  usage: { input: number; output: number; total: number };
  stopReason: string;
  raw: unknown;
};

export type ProviderAdapter = {
  id: string;
  pricing: ProviderPricing;
  complete(request: ProviderRequest): Promise<ProviderResponse>;
  listModels?(): Promise<string[]>;
  close?(): Promise<void>;
};

export function resolveProviderHeaders(config: ProviderConfig): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [header, environmentName] of Object.entries(config.headerEnv)) {
    const value = process.env[environmentName];
    if (value === undefined) throw new Error(`Environment variable ${environmentName} is not set`);
    registerSecretValue(value);
    headers[header] = value;
  }
  return headers;
}

export function resolveApiKey(config: ProviderConfig): string | undefined {
  if (config.apiKeyEnv === undefined) return undefined;
  const value = process.env[config.apiKeyEnv];
  if (value === undefined) throw new Error(`Environment variable ${config.apiKeyEnv} is not set`);
  registerSecretValue(value);
  return value;
}

export function resolveModel(config: ProviderConfig, alias: string): string {
  const model = Object.hasOwn(config.models, alias) ? config.models[alias] : undefined;
  if (!model) throw new Error(`Unknown model alias ${alias} for provider ${config.id}`);
  return model;
}
