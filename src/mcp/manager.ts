import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { Agent, fetch as undiciFetch } from 'undici';
import { z } from 'zod';
import { environmentVariableNameSchema } from '../core/environment.js';
import { redact, registerSecretValue } from '../core/redaction.js';
import { createSafeLookup, validateHttpEndpoint } from './validation.js';

const baseConfig = { id: z.string().min(1), name: z.string().min(1) };
const stdioConfigSchema = z.strictObject({
  ...baseConfig,
  transport: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().min(1).optional(),
  envRefs: z.record(z.string(), environmentVariableNameSchema).default({}),
});
const httpConfigSchema = z.strictObject({
  ...baseConfig,
  transport: z.literal('http'),
  url: z.string().min(1),
  headerEnv: z.record(z.string(), environmentVariableNameSchema).default({}),
  allowUnsafeEndpoint: z.boolean().default(false),
  oauth: z.strictObject({
    scopes: z.array(z.string().min(1)).default([]),
    clientId: z.string().min(1).optional(),
    clientSecretEnv: environmentVariableNameSchema.optional(),
    timeoutMs: z.number().int().min(1).max(300_000).default(120_000),
  }).optional(),
});
export const serverConfigSchema = z.discriminatedUnion('transport', [stdioConfigSchema, httpConfigSchema]);
export type ServerConfig = z.infer<typeof serverConfigSchema>;

type Connection = {
  client: Client;
  transport: Transport;
  config: ServerConfig;
  tools: Awaited<ReturnType<Client['listTools']>>['tools'];
  dispatcher?: Agent;
};

function resolveEnvironment(references: Record<string, string>): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [target, source] of Object.entries(references)) {
    const value = process.env[source];
    if (value === undefined) throw new Error(`Environment variable ${source} is not set`);
    registerSecretValue(value);
    resolved[target] = value;
  }
  return resolved;
}

export class McpManager {
  private readonly connections = new Map<string, Connection>();

  get connectionCount(): number {
    return this.connections.size;
  }

  isConnected(id: string): boolean {
    return this.connections.has(id);
  }

  async connect(input: unknown, oauthProvider?: OAuthClientProvider): Promise<ReturnType<McpManager['inspect']>> {
    const config = serverConfigSchema.parse(input);
    if (this.connections.has(config.id)) await this.disconnect(config.id);
    const client = new Client({ name: 'mcp-local-workbench', version: '0.1.0' }, { capabilities: {} });
    let transport: Transport;
    let dispatcher: Agent | undefined;
    if (config.transport === 'stdio') {
      transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
        ...(Object.keys(config.envRefs).length === 0 ? {} : { env: resolveEnvironment(config.envRefs) }),
        stderr: 'inherit',
      });
    } else {
      const url = await validateHttpEndpoint(config.url, config.allowUnsafeEndpoint);
      dispatcher = config.allowUnsafeEndpoint ? undefined : new Agent({ connect: { lookup: createSafeLookup() } });
      const guardedDispatcher = dispatcher;
      transport = new StreamableHTTPClientTransport(url, {
        ...(oauthProvider === undefined ? {} : { authProvider: oauthProvider }),
        requestInit: { headers: resolveEnvironment(config.headerEnv) },
        ...(dispatcher === undefined ? {} : {
          fetch: (input, init) => (undiciFetch as unknown as (
            target: string | URL,
            options: RequestInit & { dispatcher: Agent },
          ) => Promise<Response>)(input, { ...init, dispatcher: guardedDispatcher! }),
        }),
      });
    }
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      this.connections.set(config.id, {
        client,
        transport,
        config,
        tools,
        ...(config.transport === 'http' && dispatcher !== undefined ? { dispatcher } : {}),
      });
      return this.inspect(config.id);
    } catch (error) {
      await transport.close().catch(() => undefined);
      if (config.transport === 'http' && dispatcher !== undefined) await dispatcher.close().catch(() => undefined);
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
      await connection.dispatcher?.close();
    }
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.connections.keys()].map((id) => this.disconnect(id)));
  }

  private require(id: string): Connection {
    const connection = this.connections.get(id);
    if (!connection) throw new Error(`MCP server ${id} is not connected`);
    return connection;
  }
}
