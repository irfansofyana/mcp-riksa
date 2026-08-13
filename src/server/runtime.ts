import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createProviderAdapter } from '../agent/providers.js';
import { providerConfigSchema, type ProviderConfig } from '../agent/types.js';
import { runAgent } from '../agent/loop.js';
import { event } from '../core/events.js';
import { parseSuite } from '../core/suite.js';
import { runSuite } from '../core/runner.js';
import type { Observation, Suite } from '../core/types.js';
import { McpManager, serverConfigSchema, type ServerConfig } from '../mcp/manager.js';
import { OAuthCoordinator } from '../mcp/oauth.js';
import { validateHttpEndpoint } from '../mcp/validation.js';
import { ConfigurationRepository } from '../storage/configurations.js';
import { openDatabase, type WorkbenchDatabase } from '../storage/database.js';
import { RunRepository } from '../storage/runs.js';

type RuntimeOptions = {
  databasePath: string;
  suiteDirectory: string;
  callbackUrl: string;
};

type PlaygroundInput = {
  serverId?: string;
  providerId?: string;
  model?: string;
  prompt: string;
  limits?: { maxTurns: number; maxToolCalls: number; timeoutMs: number; maxCostUsd?: number };
};

export class WorkbenchRuntime {
  private readonly database: WorkbenchDatabase;
  private readonly runs: RunRepository;
  private readonly configurations: ConfigurationRepository;
  private readonly mcp = new McpManager();
  private readonly oauth = new OAuthCoordinator();
  private readonly providers = new Map<string, ProviderConfig>();
  private readonly servers = new Map<string, ServerConfig>();
  private readonly suites = new Map<string, { source: string; suite: Suite }>();
  private readonly activeRuns = new Map<string, AbortController>();
  private readonly activeRunTasks = new Map<string, Promise<void>>();

  constructor(private readonly options: RuntimeOptions) {
    mkdirSync(options.suiteDirectory, { recursive: true });
    this.database = openDatabase(options.databasePath);
    this.runs = new RunRepository(this.database);
    this.configurations = new ConfigurationRepository(this.database);
    this.runs.recoverInterrupted();
    for (const config of this.configurations.list<ProviderConfig>('provider')) {
      const parsed = providerConfigSchema.parse(config);
      this.providers.set(parsed.id, parsed);
    }
    for (const config of this.configurations.list<ServerConfig>('server')) {
      const parsed = serverConfigSchema.parse(config);
      this.servers.set(parsed.id, parsed);
    }
    for (const filename of readdirSync(options.suiteDirectory).filter((name) => name.endsWith('.yaml'))) {
      const source = readFileSync(join(options.suiteDirectory, filename), 'utf8');
      const suite = parseSuite(source);
      this.suites.set(suite.name, { source, suite });
    }
  }

  async bootstrap() {
    return {
      servers: [...this.servers.values()].map((config) => ({ ...config, connected: false })),
      providers: (await this.settings()).providers,
      suites: await this.listSuites(),
      runs: await this.listRuns(),
    };
  }

  async settings() {
    return {
      loopbackOnly: true,
      callbackUrl: this.options.callbackUrl,
      providers: [...this.providers.values()].map((config) => ({
        ...config,
        apiKeyConfigured: config.apiKeyEnv === undefined ? false : process.env[config.apiKeyEnv] !== undefined,
        headerStatus: Object.fromEntries(Object.entries(config.headerEnv).map(([header, environment]) => [header, { environment, configured: process.env[environment] !== undefined }])),
      })),
    };
  }

  async addProvider(input: ProviderConfig) {
    const config = providerConfigSchema.parse(input);
    await validateHttpEndpoint(config.baseUrl);
    this.configurations.upsert('provider', config.id, config);
    this.providers.set(config.id, config);
    return { id: config.id, name: config.name, type: config.type };
  }

  async testProvider(id: string) {
    const config = this.requireProvider(id);
    const adapter = createProviderAdapter(config);
    try {
      if (adapter.listModels) return { id, ok: true, models: await adapter.listModels() };
      const model = Object.keys(config.models)[0]!;
      await adapter.complete({ model, messages: [{ role: 'user', content: 'Reply with OK.' }], tools: [] });
      return { id, ok: true, models: Object.keys(config.models), discovery: 'not-supported' };
    } finally {
      await adapter.close?.();
    }
  }

  async addServer(input: ServerConfig) {
    const config = serverConfigSchema.parse(input);
    this.configurations.upsert('server', config.id, config);
    this.servers.set(config.id, config);
    return { id: config.id, name: config.name, transport: config.transport };
  }

  async connectServer(id: string) {
    const config = this.requireServer(id);
    let provider;
    try { provider = this.oauth.getProvider(id); } catch { provider = undefined; }
    return this.mcp.connect(config, provider);
  }

  async inspectServer(id: string) {
    return this.mcp.inspect(id);
  }

  async callTool(id: string, tool: string, args: Record<string, unknown>, options: { confirmDangerous: boolean }) {
    return this.mcp.call(id, tool, args, options);
  }

  async playground(input: PlaygroundInput) {
    const serverId = input.serverId ?? [...this.servers.keys()][0];
    const providerId = input.providerId ?? [...this.providers.keys()][0];
    if (!serverId || !providerId) throw new Error('Playground requires a connected server and model provider');
    const config = this.requireProvider(providerId);
    return runAgent({
      prompt: input.prompt,
      model: input.model ?? Object.keys(config.models)[0]!,
      serverId,
      limits: input.limits ?? { maxTurns: 8, maxToolCalls: 16, timeoutMs: 60_000 },
    }, { provider: createProviderAdapter(config), mcp: this.mcp });
  }

  async saveSuite(source: string) {
    const suite = parseSuite(source);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(suite.name)) {
      throw new Error('Suite name may contain only letters, numbers, dot, underscore, and hyphen');
    }
    const normalized = source.endsWith('\n') ? source : `${source}\n`;
    writeFileSync(join(this.options.suiteDirectory, `${suite.name}.yaml`), normalized, { encoding: 'utf8', mode: 0o600 });
    this.suites.set(suite.name, { source: normalized, suite });
    return { name: suite.name, cases: suite.cases.length };
  }

  async listSuites() {
    return [...this.suites.keys()].sort();
  }

  async startSuite(name: string) {
    const stored = this.suites.get(basename(name));
    if (!stored || stored.suite.name !== name) throw new Error(`Suite ${name} not found`);
    const id = randomUUID();
    const startedAt = new Date().toISOString();
    const controller = new AbortController();
    this.activeRuns.set(id, controller);
    this.runs.start(id, name, startedAt);
    const task = runSuite(stored.suite, {
      direct: (entry, signal) => this.directObservation(entry.server, entry.call.tool, entry.call.arguments, entry.call.dangerous ?? false, signal),
      agent: (entry) => runAgent({ prompt: entry.prompt, model: entry.model, serverId: entry.server, limits: entry.limits }, {
        provider: createProviderAdapter(this.requireProvider(entry.provider)), mcp: this.mcp,
      }, { signal: controller.signal }),
    }, { signal: controller.signal, id })
      .then((result) => this.runs.complete(result))
      .catch((error: unknown) => this.runs.fail(id, error))
      .finally(() => {
        this.activeRuns.delete(id);
        this.activeRunTasks.delete(id);
      });
    this.activeRunTasks.set(id, task);
    return { id, suite: name, status: 'running' as const, startedAt };
  }

  async listRuns() { return this.runs.list(); }
  async getRun(id: string) { return this.runs.get(id); }
  async compareRuns(runA: string, runB: string) { return this.runs.compare(runA, runB); }

  async cancelRun(id: string) {
    const controller = this.activeRuns.get(id);
    if (!controller) return false;
    controller.abort(new Error('Cancelled by user'));
    return true;
  }

  async beginOAuth(id: string) {
    const config = this.requireServer(id);
    if (config.transport !== 'http') throw new Error('OAuth is available only for Streamable HTTP servers');
    return this.oauth.begin({
      id,
      serverUrl: config.url,
      callbackUrl: this.options.callbackUrl,
      scopes: config.oauth?.scopes ?? [],
      timeoutMs: config.oauth?.timeoutMs ?? 120_000,
      ...(config.oauth?.clientId === undefined ? {} : { clientId: config.oauth.clientId }),
      ...(config.oauth?.clientSecretEnv === undefined ? {} : { clientSecretEnv: config.oauth.clientSecretEnv }),
    });
  }

  async oauthCallback(parameters: Record<string, string>) { return this.oauth.callbackByState(parameters); }
  async oauthStatus(id: string) { return this.oauth.status(id); }
  async forgetOAuth(id: string) { this.oauth.forget(id); }

  async close(): Promise<void> {
    for (const controller of this.activeRuns.values()) controller.abort(new Error('Runtime closing'));
    await Promise.allSettled([...this.activeRunTasks.values()]);
    const cleanups = await Promise.allSettled([this.mcp.closeAll(), this.oauth.close()]);
    this.database.close();
    const failure = cleanups.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure) throw failure.reason;
  }

  private async directObservation(server: string, tool: string, args: Record<string, unknown>, dangerous: boolean, signal: AbortSignal): Promise<Observation> {
    const started = Date.now();
    const response = await this.mcp.call(server, tool, args, { confirmDangerous: dangerous, signal });
    const output = 'structuredContent' in response && response.structuredContent !== undefined ? response.structuredContent : response.content;
    const durationMs = Date.now() - started;
    return {
      output,
      toolCalls: [{ name: tool, arguments: args, result: response, durationMs }],
      durationMs,
      tokens: { input: 0, output: 0, total: 0 },
      costUsd: 0,
      events: [event(server, 'tool_call', { tool, arguments: args, result: response }, durationMs)],
    };
  }

  private requireProvider(id: string): ProviderConfig {
    const config = this.providers.get(id);
    if (!config) throw new Error(`Model provider ${id} not found`);
    return config;
  }

  private requireServer(id: string): ServerConfig {
    const config = this.servers.get(id);
    if (!config) throw new Error(`MCP server ${id} not found`);
    return config;
  }
}
