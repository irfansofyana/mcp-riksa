import { z } from 'zod';
import { environmentVariableNameSchema } from '../core/environment.js';
import { findDuplicateHttpHeaderName, httpHeaderNameSchema } from '../core/http.js';
import { registerSecretValue } from '../core/redaction.js';
import { assertResolvedSecretValue, secretReferenceSchema, type SecretResolver } from '../secrets/types.js';

export const providerConfigSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(['openai-compatible', 'anthropic-compatible']),
  baseUrl: z.string().url().refine((value) => ['http:', 'https:'].includes(new URL(value).protocol), 'Provider base URL must use http or https'),
  models: z.record(z.string().min(1), z.strictObject({
    id: z.string().min(1),
    pricing: z.strictObject({
      inputPerMillion: z.number().nonnegative(),
      outputPerMillion: z.number().nonnegative(),
    }).default({ inputPerMillion: 0, outputPerMillion: 0 }),
  })).refine((models) => Object.keys(models).length > 0, 'At least one model alias is required'),
  apiKeyEnv: environmentVariableNameSchema.optional(),
  headerEnv: z.record(httpHeaderNameSchema, environmentVariableNameSchema).optional().default({}),
  apiKey: secretReferenceSchema.optional(),
  headers: z.record(httpHeaderNameSchema, secretReferenceSchema).optional().default({}),
}).superRefine((config, context) => {
  const duplicateHeader = findDuplicateHttpHeaderName(config.headerEnv, config.headers);
  if (duplicateHeader !== undefined) {
    context.addIssue({ code: 'custom', path: ['headers'], message: `Duplicate HTTP header name: ${duplicateHeader}` });
  }
  if (config.apiKey !== undefined || config.apiKeyEnv !== undefined) {
    const apiKeyHeader = config.type === 'anthropic-compatible' ? 'x-api-key' : 'authorization';
    const configuredHeaders = [...Object.keys(config.headerEnv), ...Object.keys(config.headers)];
    if (configuredHeaders.some((header) => header.toLowerCase() === apiKeyHeader)) {
      context.addIssue({
        code: 'custom',
        path: ['headers'],
        message: `${apiKeyHeader} conflicts with the provider API-key header`,
      });
    }
  }
});

export type ProviderConfig = z.infer<typeof providerConfigSchema>;
export type ProviderConfigInput = z.input<typeof providerConfigSchema>;
export type ProviderPricing = ProviderConfig['models'][string]['pricing'];

export type ProviderTool = { name: string; description?: string; inputSchema: Record<string, unknown> };
export type ProviderToolCall = { id: string; name: string; arguments: Record<string, unknown> };
export type ProviderMessage =
  | { role: 'system'; content: string }
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
  pricingFor(modelAlias: string): ProviderPricing;
  complete(request: ProviderRequest): Promise<ProviderResponse>;
  listModels?(): Promise<string[]>;
  close?(): Promise<void>;
};

export const resolveEnvironmentSecret: SecretResolver = async (reference) => {
  if (reference.source !== 'env') throw new Error(`Secret backend ${reference.source} is not available in this context`);
  const value = process.env[reference.name];
  if (value === undefined) throw new Error(`Environment variable ${reference.name} is not set`);
  assertResolvedSecretValue(value);
  registerSecretValue(value);
  return value;
};

export async function resolveProviderHeaders(config: ProviderConfig, resolveSecret: SecretResolver): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  for (const [header, environmentName] of Object.entries(config.headerEnv)) {
    headers[header] = await resolveSecret({ source: 'env', name: environmentName }, 'provider-header');
  }
  for (const [header, reference] of Object.entries(config.headers)) {
    headers[header] = await resolveSecret(reference, 'provider-header');
  }
  return headers;
}

export async function resolveApiKey(config: ProviderConfig, resolveSecret: SecretResolver): Promise<string | undefined> {
  if (config.apiKey !== undefined) return resolveSecret(config.apiKey, 'provider-api-key');
  if (config.apiKeyEnv !== undefined) return resolveSecret({ source: 'env', name: config.apiKeyEnv }, 'provider-api-key');
  return undefined;
}

export function resolveModel(config: ProviderConfig, alias: string): string {
  const model = Object.hasOwn(config.models, alias) ? config.models[alias] : undefined;
  if (!model) throw new Error(`Unknown model alias ${alias} for provider ${config.id}`);
  return model.id;
}

export function resolveModelPricing(config: ProviderConfig, alias: string): ProviderPricing {
  const model = Object.hasOwn(config.models, alias) ? config.models[alias] : undefined;
  if (!model) throw new Error(`Unknown model alias ${alias} for provider ${config.id}`);
  return model.pricing;
}
