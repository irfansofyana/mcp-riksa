import { existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync, closeSync, fsyncSync } from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createProviderAdapter } from '../agent/providers.js';
import { conformanceStatus } from '../conformance/model.js';
import { OfficialConformanceRunner } from '../conformance/runner.js';
import { CONFORMANCE_RUNNER_VERSION, type ConformanceRunner, type ConformanceSelection } from '../conformance/types.js';
import { providerConfigSchema, type ProviderConfig, type ProviderMessage } from '../agent/types.js';
import { runAgent, type AgentUpdate } from '../agent/loop.js';
import { event } from '../core/events.js';
import { redact } from '../core/redaction.js';
import { parseSuite } from '../core/suite.js';
import { runSuite } from '../core/runner.js';
import type { Observation, Suite } from '../core/types.js';
import { McpManager, serverConfigSchema, type ServerConfig } from '../mcp/manager.js';
import { OAuthCoordinator } from '../mcp/oauth.js';
import { validateHttpEndpoint } from '../mcp/validation.js';
import { ConfigurationRepository } from '../storage/configurations.js';
import { ConformanceRepository } from '../storage/conformance.js';
import { ConversationRepository } from '../storage/conversations.js';
import { openDatabase, type WorkbenchDatabase } from '../storage/database.js';
import { RunRepository } from '../storage/runs.js';
import { WorkbenchError } from './errors.js';

type RuntimeOptions = {
  databasePath: string;
  suiteDirectory: string;
  callbackUrl: string;
  conformanceRunner?: ConformanceRunner;
};

type PlaygroundInput = {
  conversationId?: string;
  serverId?: string;
  providerId?: string;
  model?: string;
  prompt: string;
  systemPrompt?: string;
  limits?: { maxTurns: number; maxToolCalls: number; timeoutMs: number; maxCostUsd?: number };
};

export class WorkbenchRuntime {
  private readonly database: WorkbenchDatabase;
  private readonly runs: RunRepository;
  private readonly configurations: ConfigurationRepository;
  private readonly conversations: ConversationRepository;
  private readonly conformance: ConformanceRepository;
  private readonly conformanceRunner: ConformanceRunner;
  private readonly mcp = new McpManager();
  private readonly oauth = new OAuthCoordinator();
  private readonly providers = new Map<string, ProviderConfig>();
  private readonly servers = new Map<string, ServerConfig>();
  private readonly suites = new Map<string, { source: string; suite: Suite }>();
  private readonly activeRuns = new Map<string, AbortController>();
  private readonly activeRunTasks = new Map<string, Promise<void>>();
  private readonly activeConformance = new Map<string, AbortController>();
  private readonly activeConformanceTasks = new Map<string, Promise<void>>();
  private readonly activeConfigUses = new Map<string, number>();
  private readonly mutatingConfigs = new Set<string>();

  constructor(private readonly options: RuntimeOptions) {
    mkdirSync(options.suiteDirectory, { recursive: true });
    this.database = openDatabase(options.databasePath);
    this.runs = new RunRepository(this.database);
    this.configurations = new ConfigurationRepository(this.database);
    this.conversations = new ConversationRepository(this.database);
    this.conformance = new ConformanceRepository(this.database);
    this.conformanceRunner = options.conformanceRunner ?? new OfficialConformanceRunner();
    this.runs.recoverInterrupted();
    this.conformance.recoverInterrupted();
    for (const config of this.configurations.list<ProviderConfig>('provider')) {
      const parsed = providerConfigSchema.parse(config);
      this.providers.set(parsed.id, parsed);
    }
    for (const config of this.configurations.list<ServerConfig>('server')) {
      const parsed = serverConfigSchema.parse(config);
      this.servers.set(parsed.id, parsed);
    }
    const loadedNames = new Set<string>();
    for (const filename of readdirSync(options.suiteDirectory).filter((name) => name.endsWith('.yaml'))) {
      const path = join(options.suiteDirectory, filename);
      if (lstatSync(path).isSymbolicLink()) throw new Error(`Suite file ${filename} cannot be a symbolic link`);
      const source = readFileSync(path, 'utf8');
      const suite = parseSuite(source);
      if (filename !== `${suite.name}.yaml`) throw new Error(`Suite filename ${filename} must match YAML name ${suite.name}`);
      const folded = suite.name.toLocaleLowerCase('en-US');
      if (loadedNames.has(folded)) throw new Error(`Suite name ${suite.name} conflicts by letter case`);
      loadedNames.add(folded);
      this.suites.set(suite.name, { source, suite });
    }
  }

  async bootstrap() {
    return {
      servers: [...this.servers.values()].map((config) => ({ ...config, connected: this.mcp.isConnected(config.id) })),
      providers: (await this.settings()).providers,
      suites: await this.listSuites(),
      runs: await this.listRuns(),
      conformanceReports: await this.listConformanceReports(),
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

  async seedProvider(input: ProviderConfig) {
    const config = providerConfigSchema.parse(input);
    if (!this.configurations.canSeed('provider', config.id)) return false;
    await validateHttpEndpoint(config.baseUrl);
    if (!this.configurations.seed('provider', config.id, config)) return false;
    this.providers.set(config.id, config);
    return true;
  }

  async createProvider(input: ProviderConfig) {
    const config = providerConfigSchema.parse(input);
    await validateHttpEndpoint(config.baseUrl);
    if (this.providers.has(config.id)) throw new WorkbenchError(`Model provider ${config.id} already exists`, 409);
    this.configurations.insert('provider', config.id, config);
    this.providers.set(config.id, config);
    return { id: config.id, name: config.name, type: config.type, models: config.models };
  }

  async updateProvider(id: string, input: ProviderConfig) {
    const config = providerConfigSchema.parse(input);
    if (config.id !== id) throw new WorkbenchError('Provider ID cannot be changed while editing', 400);
    this.requireProvider(id);
    return this.withConfigMutation(`provider:${id}`, async () => {
      await validateHttpEndpoint(config.baseUrl);
      const references = this.providerReferences(id);
      const removed = [...new Set(references.conversations.map((entry) => entry.model).concat(references.suiteModels))]
        .filter((alias) => !Object.hasOwn(config.models, alias));
      if (removed.length > 0) throw new WorkbenchError(`Cannot remove referenced model aliases: ${removed.join(', ')}`, 409, { references, removedModels: removed });
      if (!this.configurations.update('provider', id, config)) throw new WorkbenchError(`Model provider ${id} not found`, 404);
      this.providers.set(id, config);
      return { id, name: config.name, type: config.type, models: config.models };
    });
  }

  async deleteProvider(id: string, force = false) {
    this.requireProvider(id);
    return this.withConfigMutation(`provider:${id}`, async () => {
      const references = this.providerReferences(id);
      if (!force && (references.suites.length > 0 || references.conversations.length > 0)) {
        throw new WorkbenchError(`Model provider ${id} is still referenced`, 409, references);
      }
      this.configurations.delete('provider', id);
      this.providers.delete(id);
      return { id, deleted: true, references, forced: force };
    });
  }

  async testProvider(id: string) {
    const config = this.requireProvider(id);
    return this.withConfigUse([`provider:${id}`], async () => {
      const adapter = createProviderAdapter(config);
      try {
        if (adapter.listModels) return { id, ok: true, models: await adapter.listModels() };
        const model = Object.keys(config.models)[0]!;
        await adapter.complete({ model, messages: [{ role: 'user', content: 'Reply with OK.' }], tools: [] });
        return { id, ok: true, models: Object.keys(config.models), discovery: 'not-supported' };
      } finally {
        await adapter.close?.();
      }
    });
  }

  async addServer(input: ServerConfig) {
    const config = serverConfigSchema.parse(input);
    this.configurations.upsert('server', config.id, config);
    this.servers.set(config.id, config);
    return { id: config.id, name: config.name, transport: config.transport };
  }

  async seedServer(input: ServerConfig) {
    const config = serverConfigSchema.parse(input);
    if (!this.configurations.seed('server', config.id, config)) return false;
    this.servers.set(config.id, config);
    return true;
  }

  async createServer(input: ServerConfig) {
    const config = serverConfigSchema.parse(input);
    if (this.servers.has(config.id)) throw new WorkbenchError(`MCP server ${config.id} already exists`, 409);
    this.configurations.insert('server', config.id, config);
    this.servers.set(config.id, config);
    return { id: config.id, name: config.name, transport: config.transport };
  }

  async updateServer(id: string, input: ServerConfig) {
    const config = serverConfigSchema.parse(input);
    if (config.id !== id) throw new WorkbenchError('Server ID cannot be changed while editing', 400);
    this.requireServer(id);
    return this.withConfigMutation(`server:${id}`, async () => {
      await this.mcp.disconnect(id);
      this.oauth.forget(id);
      if (!this.configurations.update('server', id, config)) throw new WorkbenchError(`MCP server ${id} not found`, 404);
      this.servers.set(id, config);
      return { id, name: config.name, transport: config.transport, reconnectRequired: true };
    });
  }

  async deleteServer(id: string, force = false) {
    this.requireServer(id);
    return this.withConfigMutation(`server:${id}`, async () => {
      const references = this.serverReferences(id);
      if (!force && (references.suites.length > 0 || references.conversations.length > 0)) {
        throw new WorkbenchError(`MCP server ${id} is still referenced`, 409, references);
      }
      await this.mcp.disconnect(id);
      this.oauth.forget(id);
      this.configurations.delete('server', id);
      this.servers.delete(id);
      return { id, deleted: true, references, forced: force };
    });
  }

  async connectServer(id: string) {
    const config = this.requireServer(id);
    return this.withConfigUse([`server:${id}`], async () => {
      let provider;
      try { provider = this.oauth.getProvider(id); } catch { provider = undefined; }
      return this.mcp.connect(config, provider);
    });
  }

  async inspectServer(id: string) {
    this.requireServer(id);
    if (!this.mcp.isConnected(id)) throw new WorkbenchError(`MCP server ${id} is not connected`, 409);
    return this.withConfigUse([`server:${id}`], () => this.mcp.inspect(id));
  }

  async callTool(id: string, tool: string, args: Record<string, unknown>, options: { confirmDangerous: boolean }) {
    this.requireServer(id);
    if (!this.mcp.isConnected(id)) throw new WorkbenchError(`MCP server ${id} is not connected`, 409);
    return this.withConfigUse([`server:${id}`], () => this.mcp.call(id, tool, args, options));
  }

  async playground(input: PlaygroundInput) {
    const { serverId, providerId, model, config } = this.resolvePlayground(input);
    return this.withConfigUse([`server:${serverId}`, `provider:${providerId}`], () => runAgent({
      prompt: input.prompt,
      systemPrompt: input.systemPrompt,
      model,
      serverId,
      limits: input.limits ?? { maxTurns: 8, maxToolCalls: 16, timeoutMs: 60_000 },
    }, { provider: createProviderAdapter(config), mcp: this.mcp }));
  }

  async createConversation(input: { serverId: string; providerId: string; model: string; systemPrompt?: string }) {
    this.requireServer(input.serverId);
    const provider = this.requireProvider(input.providerId);
    if (!Object.hasOwn(provider.models, input.model)) throw new WorkbenchError(`Unknown model alias ${input.model} for provider ${input.providerId}`, 400);
    return this.conversations.create(input);
  }

  async listConversations() { return this.conversations.list(); }
  async getConversation(id: string) { return this.conversations.get(id); }
  async deleteConversation(id: string) { return this.conversations.delete(id); }

  async invokePlaygroundTool(conversationId: string, tool: string, args: Record<string, unknown>, confirmDangerous: boolean) {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) throw new WorkbenchError(`Playground conversation ${conversationId} not found`, 404);
    const prompt = `Execute ${tool}\n\nArguments:\n${JSON.stringify(redact(args), null, 2)}`;
    const result = await this.withConfigUse([`server:${conversation.serverId}`], () => this.directObservation(
      conversation.serverId, tool, args, confirmDangerous, new AbortController().signal,
    ));
    const assistantText = typeof result.output === 'string' ? result.output : JSON.stringify(result.output, null, 2);
    this.conversations.appendTurn(
      conversationId,
      { role: 'user', content: prompt },
      {
        role: 'assistant', content: assistantText, durationMs: result.durationMs, tokens: result.tokens,
        costUsd: result.costUsd, toolCalls: result.toolCalls, events: result.events, stopReason: 'direct_tool',
      },
    );
    return { conversationId, prompt, result, conversation: this.conversations.get(conversationId) };
  }

  async streamPlayground(input: PlaygroundInput & { conversationId: string }, onUpdate: (update: AgentUpdate) => void, signal?: AbortSignal) {
    const conversation = this.conversations.get(input.conversationId);
    if (!conversation) throw new Error(`Playground conversation ${input.conversationId} not found`);
    const resolved = this.resolvePlayground({
      ...input,
      serverId: conversation.serverId,
      providerId: conversation.providerId,
      model: conversation.model,
    });
    const providerHistory: ProviderMessage[] = conversation.messages.flatMap((message, index): ProviderMessage[] => {
      if (message.role === 'user') {
        const assistant = conversation.messages[index + 1];
        if (assistant?.role === 'assistant' && assistant.providerTranscript !== undefined && assistant.providerTranscript.length === 0) return [];
        return [{ role: 'user', content: message.content }];
      }
      if (message.providerTranscript !== undefined) return message.providerTranscript;
      return [{ role: 'assistant', content: message.content, toolCalls: [] }];
    });
    const result = await this.withConfigUse([`server:${resolved.serverId}`, `provider:${resolved.providerId}`], () => runAgent({
      prompt: input.prompt,
      systemPrompt: conversation.systemPrompt,
      model: resolved.model,
      serverId: resolved.serverId,
      limits: input.limits ?? { maxTurns: 8, maxToolCalls: 16, timeoutMs: 60_000 },
      history: providerHistory,
    }, { provider: createProviderAdapter(resolved.config), mcp: this.mcp }, { signal, onUpdate }));
    this.conversations.appendTurn(
      conversation.id,
      { role: 'user', content: input.prompt },
      {
        role: 'assistant', content: result.output, durationMs: result.durationMs, tokens: result.tokens,
        costUsd: result.costUsd, toolCalls: result.toolCalls, events: result.events, stopReason: result.stopReason,
        providerTranscript: result.transcript,
      },
    );
    return { conversationId: conversation.id, result, conversation: this.conversations.get(conversation.id) };
  }

  private suiteSource(source: string) {
    const suite = parseSuite(source);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(suite.name)) {
      throw new WorkbenchError('Suite name may contain only letters, numbers, dot, underscore, and hyphen', 400);
    }
    return { suite, normalized: source.endsWith('\n') ? source : `${source}\n` };
  }

  private suitePath(name: string) {
    return join(this.options.suiteDirectory, `${name}.yaml`);
  }

  private assertSuiteDestination(name: string, currentName?: string) {
    const folded = name.toLocaleLowerCase('en-US');
    const conflict = [...this.suites.keys()].find((entry) => entry !== currentName && entry.toLocaleLowerCase('en-US') === folded);
    if (conflict) throw new WorkbenchError(`Suite ${name} conflicts with existing suite ${conflict}`, 409);
    const path = this.suitePath(name);
    if (existsSync(path) && name !== currentName) throw new WorkbenchError(`Suite file ${name}.yaml already exists`, 409);
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new WorkbenchError(`Suite file ${name}.yaml cannot be a symbolic link`, 409);
  }

  private writeSuiteAtomic(name: string, source: string) {
    const destination = this.suitePath(name);
    const temporary = join(this.options.suiteDirectory, `.${name}.${randomUUID()}.tmp`);
    const descriptor = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(descriptor, source, 'utf8');
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    try { renameSync(temporary, destination); }
    catch (error) { if (existsSync(temporary)) unlinkSync(temporary); throw error; }
  }

  private persistSuite(source: string) {
    const { suite, normalized } = this.suiteSource(source);
    this.writeSuiteAtomic(suite.name, normalized);
    this.suites.set(suite.name, { source: normalized, suite });
    return { name: suite.name, cases: suite.cases.length };
  }

  async saveSuite(source: string) {
    return this.persistSuite(source);
  }

  async createSuite(source: string) {
    const { suite } = this.suiteSource(source);
    this.assertSuiteDestination(suite.name);
    return this.persistSuite(source);
  }

  async updateSuite(name: string, source: string) {
    if (basename(name) !== name || !this.suites.has(name)) throw new WorkbenchError(`Suite ${name} not found`, 404);
    const { suite } = this.suiteSource(source);
    this.assertSuiteDestination(suite.name, name);
    const renamed = suite.name !== name;
    const oldPath = this.suitePath(name);
    const normalized = source.endsWith('\n') ? source : `${source}\n`;
    this.writeSuiteAtomic(suite.name, normalized);
    if (renamed) {
      try { unlinkSync(oldPath); }
      catch (error) { unlinkSync(this.suitePath(suite.name)); throw error; }
      this.suites.delete(name);
    }
    this.suites.set(suite.name, { source: normalized, suite });
    return { name: suite.name, cases: suite.cases.length, previousName: name, renamed };
  }

  async deleteSuite(name: string) {
    if (basename(name) !== name || !this.suites.has(name)) throw new WorkbenchError(`Suite ${name} not found`, 404);
    unlinkSync(join(this.options.suiteDirectory, `${name}.yaml`));
    this.suites.delete(name);
    return { name, deleted: true };
  }

  async listSuites() {
    return [...this.suites.keys()].sort();
  }

  async getSuite(name: string) {
    const stored = this.suites.get(basename(name));
    if (!stored || stored.suite.name !== name) return undefined;
    return { name, source: stored.source, suite: stored.suite };
  }

  async startSuite(name: string) {
    const stored = this.suites.get(basename(name));
    if (!stored || stored.suite.name !== name) throw new Error(`Suite ${name} not found`);
    const id = randomUUID();
    const startedAt = new Date().toISOString();
    const controller = new AbortController();
    this.activeRuns.set(id, controller);
    const configKeys = [...new Set(stored.suite.cases.flatMap((entry) => [
      `server:${entry.server}`,
      ...(entry.kind === 'agent' ? [`provider:${entry.provider}`] : []),
    ]))];
    this.beginConfigUse(configKeys);
    try { this.runs.start(id, name, startedAt); } catch (error) {
      this.endConfigUse(configKeys);
      this.activeRuns.delete(id);
      throw error;
    }
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
        this.endConfigUse(configKeys);
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

  async startConformance(input: { serverId: string; selection: ConformanceSelection; timeoutMs: number }) {
    const config = this.requireServer(input.serverId);
    if (config.transport !== 'http') throw new WorkbenchError('Official conformance MVP supports Streamable HTTP servers only; stdio is unsupported', 400);
    if (Object.keys(config.headerEnv).length > 0 || config.oauth) {
      throw new WorkbenchError('Pinned official conformance runner does not support workbench header or OAuth injection', 400);
    }
    const endpoint = await validateHttpEndpoint(config.url, false);
    const hostname = endpoint.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '::1') {
      throw new WorkbenchError('Conformance execution is restricted to loopback MCP endpoints', 400);
    }
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      throw new WorkbenchError('Conformance endpoints cannot contain credentials, query parameters, or fragments', 400);
    }
    const id = randomUUID();
    const startedAt = new Date().toISOString();
    const controller = new AbortController();
    const configKeys = [`server:${input.serverId}`];
    this.beginConfigUse(configKeys);
    try {
      this.conformance.start({ id, serverId: input.serverId, endpoint: endpoint.href, selection: input.selection, startedAt, runnerVersion: CONFORMANCE_RUNNER_VERSION });
    } catch (error) {
      this.endConfigUse(configKeys);
      throw error;
    }
    this.activeConformance.set(id, controller);
    const task = Promise.resolve()
      .then(() => controller.signal.aborted
        ? { checks: [], rawReport: {}, exitCode: null, timedOut: false, cancelled: true }
        : this.conformanceRunner.run({ endpoint: endpoint.href, selection: input.selection, timeoutMs: input.timeoutMs }, controller.signal))
      .then((execution) => this.conformance.complete(id, {
        status: conformanceStatus(execution), completedAt: new Date().toISOString(), checks: execution.checks,
        rawReport: execution.rawReport, ...(execution.diagnostic ? { diagnostic: execution.diagnostic } : {}),
      }))
      .catch((error: unknown) => this.conformance.complete(id, {
        status: controller.signal.aborted ? 'cancelled' : 'harness_error', completedAt: new Date().toISOString(), checks: [], rawReport: {},
        diagnostic: redact(error instanceof Error ? error.message : String(error)),
      }))
      .finally(() => {
        this.activeConformance.delete(id);
        this.activeConformanceTasks.delete(id);
        this.endConfigUse(configKeys);
      });
    this.activeConformanceTasks.set(id, task);
    return { id, serverId: input.serverId, status: 'running' as const, startedAt, runnerVersion: CONFORMANCE_RUNNER_VERSION };
  }

  async listConformanceReports(serverId?: string) { return this.conformance.list(serverId); }
  async getConformanceReport(id: string) { return this.conformance.get(id); }
  async cancelConformance(id: string) {
    const controller = this.activeConformance.get(id);
    if (!controller) return false;
    controller.abort(new Error('Cancelled by user'));
    return true;
  }

  async beginOAuth(id: string) {
    const config = this.requireServer(id);
    if (config.transport !== 'http') throw new WorkbenchError('OAuth is available only for Streamable HTTP servers', 400);
    return this.withConfigUse([`server:${id}`], () => this.oauth.begin({
      id,
      serverUrl: config.url,
      callbackUrl: this.options.callbackUrl,
      scopes: config.oauth?.scopes ?? [],
      timeoutMs: config.oauth?.timeoutMs ?? 120_000,
      ...(config.oauth?.clientId === undefined ? {} : { clientId: config.oauth.clientId }),
      ...(config.oauth?.clientSecretEnv === undefined ? {} : { clientSecretEnv: config.oauth.clientSecretEnv }),
    }));
  }

  async oauthCallback(parameters: Record<string, string>) { return this.oauth.callbackByState(parameters); }
  async oauthStatus(id: string) {
    this.requireServer(id);
    try { return this.oauth.status(id); } catch { throw new WorkbenchError(`OAuth session for ${id} not found`, 404); }
  }
  async forgetOAuth(id: string) {
    this.requireServer(id);
    return this.withConfigMutation(`server:${id}`, async () => {
      try { await this.mcp.disconnect(id); } finally { this.oauth.forget(id); }
    });
  }

  async close(): Promise<void> {
    for (const controller of this.activeRuns.values()) controller.abort(new Error('Runtime closing'));
    for (const controller of this.activeConformance.values()) controller.abort(new Error('Runtime closing'));
    await Promise.allSettled([...this.activeRunTasks.values(), ...this.activeConformanceTasks.values()]);
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

  private resolvePlayground(input: PlaygroundInput) {
    const serverId = input.serverId ?? [...this.servers.keys()][0];
    const providerId = input.providerId ?? [...this.providers.keys()][0];
    if (!serverId || !providerId) throw new Error('Playground requires a connected server and model provider');
    const config = this.requireProvider(providerId);
    const model = input.model ?? Object.keys(config.models)[0]!;
    if (!Object.hasOwn(config.models, model)) throw new WorkbenchError(`Unknown model alias ${model} for provider ${providerId}`, 400);
    return { serverId, providerId, model, config };
  }

  private serverReferences(id: string) {
    return {
      suites: [...this.suites.values()].filter(({ suite }) => suite.cases.some((entry) => entry.server === id)).map(({ suite }) => suite.name),
      conversations: this.conversations.referencesServer(id),
    };
  }

  private providerReferences(id: string) {
    const suites = [...this.suites.values()].filter(({ suite }) => suite.cases.some((entry) => entry.kind === 'agent' && entry.provider === id));
    return {
      suites: suites.map(({ suite }) => suite.name),
      suiteModels: suites.flatMap(({ suite }) => suite.cases.flatMap((entry) => entry.kind === 'agent' && entry.provider === id ? [entry.model] : [])),
      conversations: this.conversations.referencesProvider(id),
    };
  }

  private beginConfigUse(keys: string[]): void {
    const blocked = keys.find((key) => this.mutatingConfigs.has(key));
    if (blocked) throw new WorkbenchError(`Configuration ${blocked.replace(':', ' ')} is being changed`, 409);
    for (const key of keys) this.activeConfigUses.set(key, (this.activeConfigUses.get(key) ?? 0) + 1);
  }

  private endConfigUse(keys: string[]): void {
    for (const key of keys) {
      const next = (this.activeConfigUses.get(key) ?? 1) - 1;
      if (next <= 0) this.activeConfigUses.delete(key); else this.activeConfigUses.set(key, next);
    }
  }

  private async withConfigUse<T>(keys: string[], operation: () => Promise<T>): Promise<T> {
    this.beginConfigUse(keys);
    try { return await operation(); } finally { this.endConfigUse(keys); }
  }

  private async withConfigMutation<T>(key: string, operation: () => Promise<T>): Promise<T> {
    if (this.mutatingConfigs.has(key) || (this.activeConfigUses.get(key) ?? 0) > 0) throw new WorkbenchError('Configuration is currently in use', 409);
    this.mutatingConfigs.add(key);
    try { return await operation(); } finally { this.mutatingConfigs.delete(key); }
  }

  private requireProvider(id: string): ProviderConfig {
    const config = this.providers.get(id);
    if (!config) throw new WorkbenchError(`Model provider ${id} not found`, 404);
    return config;
  }

  private requireServer(id: string): ServerConfig {
    const config = this.servers.get(id);
    if (!config) throw new WorkbenchError(`MCP server ${id} not found`, 404);
    return config;
  }
}
