import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { Agent, fetch as undiciFetch } from 'undici';
import { z } from 'zod';
import { environmentVariableNameSchema } from '../core/environment.js';
import { findCaseInsensitiveDuplicateKey, httpHeaderNameSchema } from '../core/http.js';
import { redact, registerSecretValue } from '../core/redaction.js';
import { assertResolvedSecretValue, secretReferenceSchema, type SecretPurpose, type SecretResolver } from '../secrets/types.js';
import { createSecretResolutionLease } from '../secrets/lease.js';
import { createSafeLookup, validateHttpEndpoint } from './validation.js';

const baseConfig = { id: z.string().min(1), name: z.string().min(1) };

const stdioConfigSchema = z.strictObject({
  ...baseConfig,
  transport: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().min(1).optional(),
  envRefs: z.record(environmentVariableNameSchema, environmentVariableNameSchema).optional().default({}),
  env: z.record(environmentVariableNameSchema, secretReferenceSchema).optional().default({}),
});
const httpConfigSchema = z.strictObject({
  ...baseConfig,
  transport: z.literal('http'),
  url: z.string().min(1),
  headerEnv: z.record(httpHeaderNameSchema, environmentVariableNameSchema).optional().default({}),
  headers: z.record(httpHeaderNameSchema, secretReferenceSchema).optional().default({}),
  staticAuth: z.strictObject({
    header: httpHeaderNameSchema.default('Authorization'),
    scheme: z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/, 'Invalid authorization scheme').default('Bearer'),
    credential: secretReferenceSchema,
  }).optional(),
  allowUnsafeEndpoint: z.boolean().default(false),
  oauth: z.strictObject({
    scopes: z.array(z.string().min(1)).default([]),
    clientId: z.string().min(1).optional(),
    clientSecretEnv: environmentVariableNameSchema.optional(),
    clientSecret: secretReferenceSchema.optional(),
    timeoutMs: z.number().int().min(1).max(300_000).default(120_000),
  }).optional(),
});
export const serverConfigSchema = z.discriminatedUnion('transport', [stdioConfigSchema, httpConfigSchema]).superRefine((config, context) => {
  if (config.transport === 'stdio') {
    const duplicateTarget = findCaseInsensitiveDuplicateKey(config.envRefs, config.env);
    if (duplicateTarget !== undefined) {
      context.addIssue({ code: 'custom', path: ['env'], message: `Duplicate environment target: ${duplicateTarget}` });
    }
    return;
  }
  const duplicateHeader = findCaseInsensitiveDuplicateKey(config.headerEnv, config.headers);
  if (duplicateHeader !== undefined) {
    context.addIssue({ code: 'custom', path: ['headers'], message: `Duplicate HTTP header name: ${duplicateHeader}` });
  }
  if (config.oauth !== undefined && config.staticAuth !== undefined) {
    context.addIssue({ code: 'custom', message: 'OAuth and static authorization are mutually exclusive', path: ['staticAuth'] });
  }
  if (config.oauth !== undefined && config.oauth.clientSecret !== undefined && config.oauth.clientSecretEnv !== undefined) {
    context.addIssue({ code: 'custom', path: ['oauth', 'clientSecret'], message: 'clientSecret and clientSecretEnv are mutually exclusive' });
  }
  if (config.oauth !== undefined && config.oauth.clientId === undefined && (config.oauth.clientSecret !== undefined || config.oauth.clientSecretEnv !== undefined)) {
    context.addIssue({ code: 'custom', path: ['oauth', 'clientSecret'], message: 'oauth client secret requires clientId' });
  }
  if (config.staticAuth !== undefined) {
    const staticHeader = config.staticAuth.header.toLowerCase();
    const configuredHeaders = [...Object.keys(config.headerEnv), ...Object.keys(config.headers)];
    if (configuredHeaders.some((header) => header.toLowerCase() === staticHeader)) {
      context.addIssue({
        code: 'custom',
        message: `Static authorization header ${config.staticAuth.header} conflicts with configured headers`,
        path: ['staticAuth', 'header'],
      });
    }
  }
});
export type ServerConfig = z.infer<typeof serverConfigSchema>;
export type ServerConfigInput = z.input<typeof serverConfigSchema>;

type Connection = {
  client: Client;
  transport: Transport;
  config: ServerConfig;
  tools: Awaited<ReturnType<Client['listTools']>>['tools'];
  dispatcher?: Agent;
  releaseSecrets(): void;
};

const resolveEnvironmentSecret: SecretResolver = async (reference) => {
  if (reference.source !== 'env') throw new Error(`Secret backend ${reference.source} is not available in this context`);
  const value = process.env[reference.name];
  if (value === undefined) throw new Error(`Environment variable ${reference.name} is not set`);
  assertResolvedSecretValue(value);
  registerSecretValue(value);
  return value;
};

export async function resolveReferenceMap(
  references: Record<string, z.infer<typeof secretReferenceSchema>>,
  purpose: SecretPurpose,
  resolveSecret: SecretResolver,
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};
  for (const [target, reference] of Object.entries(references)) {
    resolved[target] = await resolveSecret(reference, purpose);
  }
  return resolved;
}

async function resolveLegacyEnvironment(references: Record<string, string>, purpose: SecretPurpose, resolveSecret: SecretResolver): Promise<Record<string, string>> {
  return resolveReferenceMap(
    Object.fromEntries(Object.entries(references).map(([target, name]) => [target, { source: 'env' as const, name }])),
    purpose,
    resolveSecret,
  );
}

export async function resolveHttpHeaders(
  config: Extract<ServerConfig, { transport: 'http' }>,
  resolveSecret: SecretResolver,
): Promise<Record<string, string>> {
  const headers = {
    ...await resolveLegacyEnvironment(config.headerEnv, 'mcp-header', resolveSecret),
    ...await resolveReferenceMap(config.headers, 'mcp-header', resolveSecret),
  };
  if (config.staticAuth !== undefined) {
    if (Object.keys(headers).some((header) => header.toLowerCase() === config.staticAuth!.header.toLowerCase())) {
      throw new Error(`Static authorization header ${config.staticAuth.header} conflicts with configured headers`);
    }
    const credential = await resolveSecret(config.staticAuth.credential, 'mcp-header');
    headers[config.staticAuth.header] = `${config.staticAuth.scheme} ${credential}`;
  }
  return headers;
}

export class McpManager {
  private readonly connections = new Map<string, Connection>();
  private readonly connectionTasks = new Map<string, Promise<ReturnType<McpManager['inspect']>>>();
  private closing = false;

  constructor(private readonly resolveSecret: SecretResolver = resolveEnvironmentSecret) {}

  get connectionCount(): number {
    return this.connections.size;
  }

  isConnected(id: string): boolean {
    return this.connections.has(id);
  }

  async connect(input: unknown, oauthProvider?: OAuthClientProvider): Promise<ReturnType<McpManager['inspect']>> {
    const parsed = serverConfigSchema.parse(input);
    if (this.closing) throw new Error('MCP manager is closing');
    const previous = this.connectionTasks.get(parsed.id);
    if (previous) {
      await previous.catch(() => undefined);
      return this.connect(parsed, oauthProvider);
    }
    if (this.closing) throw new Error('MCP manager is closing');
    const task = this.connectNow(parsed, oauthProvider);
    this.connectionTasks.set(parsed.id, task);
    try {
      return await task;
    } finally {
      if (this.connectionTasks.get(parsed.id) === task) this.connectionTasks.delete(parsed.id);
    }
  }

  private async connectNow(input: unknown, oauthProvider?: OAuthClientProvider): Promise<ReturnType<McpManager['inspect']>> {
    const config = serverConfigSchema.parse(input);
    if (oauthProvider !== undefined && config.transport === 'http' && config.staticAuth !== undefined) {
      throw new Error('OAuth and static authorization are mutually exclusive');
    }
    if (this.connections.has(config.id)) await this.disconnect(config.id);
    const client = new Client({ name: 'mcp-riksa', version: '0.1.0' }, { capabilities: {} });
    let transport: Transport | undefined;
    let dispatcher: Agent | undefined;
    const secretLease = createSecretResolutionLease(this.resolveSecret);
    try {
      if (config.transport === 'stdio') {
      const hasInjectedSecrets = Object.keys(config.envRefs).length > 0 || Object.keys(config.env).length > 0;
      const stdioTransport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
        ...(hasInjectedSecrets ? { env: {
          ...await resolveLegacyEnvironment(config.envRefs, 'stdio-env', secretLease.resolve),
          ...await resolveReferenceMap(config.env, 'stdio-env', secretLease.resolve),
        } } : {}),
        stderr: hasInjectedSecrets ? 'ignore' : 'inherit',
      });
      transport = stdioTransport;
    } else {
      const url = await validateHttpEndpoint(config.url, config.allowUnsafeEndpoint);
      dispatcher = config.allowUnsafeEndpoint ? undefined : new Agent({ connect: { lookup: createSafeLookup() } });
      const guardedDispatcher = dispatcher;
      transport = new StreamableHTTPClientTransport(url, {
        ...(oauthProvider === undefined ? {} : { authProvider: oauthProvider }),
        requestInit: { headers: await resolveHttpHeaders(config, secretLease.resolve) },
        ...(dispatcher === undefined ? {} : {
          fetch: (input, init) => (undiciFetch as unknown as (
            target: string | URL,
            options: RequestInit & { dispatcher: Agent },
          ) => Promise<Response>)(input, { ...init, dispatcher: guardedDispatcher! }),
        }),
      });
      }
      if (!transport) throw new Error('MCP transport was not initialized');
      await client.connect(transport);
      const { tools } = await client.listTools();
      this.connections.set(config.id, {
        client,
        transport,
        config,
        tools,
        releaseSecrets: secretLease.release,
        ...(config.transport === 'http' && dispatcher !== undefined ? { dispatcher } : {}),
      });
      return this.inspect(config.id);
    } catch (error) {
      await transport?.close().catch(() => undefined);
      if (config.transport === 'http' && dispatcher !== undefined) await dispatcher.close().catch(() => undefined);
      if (error instanceof Error) {
        error.message = redact(error.message);
        if (error.stack !== undefined) error.stack = redact(error.stack);
      }
      secretLease.release();
      throw error;
    }
  }

  async inspect(id: string) {
    const connection = this.require(id);
    const { tools } = await connection.client.listTools();
    connection.tools = tools;
    return redact({
      id,
      name: connection.config.name,
      transport: connection.config.transport,
      identity: connection.client.getServerVersion(),
      capabilities: connection.client.getServerCapabilities(),
      instructions: connection.client.getInstructions(),
      tools,
    });
  }

  async call(
    id: string,
    tool: string,
    argumentsValue: Record<string, unknown>,
    options: { confirmDangerous?: boolean; signal?: AbortSignal } = {},
  ) {
    const connection = this.require(id);
    const definition = connection.tools.find((entry) => entry.name === tool);
    if (!definition) throw new Error(`Tool ${tool} was not discovered on server ${id}`);
    const explicitlyDestructive = definition.annotations?.destructiveHint === true;
    if (explicitlyDestructive && options.confirmDangerous !== true) {
      throw new Error(`Tool ${tool} requires explicit dangerous-call confirmation`);
    }
    const response = await connection.client.callTool(
      { name: tool, arguments: argumentsValue },
      undefined,
      options.signal === undefined ? undefined : { signal: options.signal },
    );
    return redact(response);
  }

  async disconnect(id: string): Promise<void> {
    const connection = this.connections.get(id);
    if (!connection) return;
    this.connections.delete(id);
    try {
      await connection.client.close();
    } finally {
      try {
        await connection.dispatcher?.close();
      } finally {
        connection.releaseSecrets();
      }
    }
  }

  async closeAll(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.connectionTasks.values()]);
    await Promise.all([...this.connections.keys()].map((id) => this.disconnect(id)));
  }

  private require(id: string): Connection {
    const connection = this.connections.get(id);
    if (!connection) throw new Error(`MCP server ${id} is not connected`);
    return connection;
  }
}
