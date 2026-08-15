import { randomBytes } from 'node:crypto';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { z, ZodError } from 'zod';
import { providerConfigSchema } from '../agent/types.js';
import { redact } from '../core/redaction.js';
import { serverConfigSchema } from '../mcp/manager.js';
import { createSecretSchema, type SecretMetadata } from '../secrets/types.js';
import { SecretStoreError } from '../secrets/store.js';
import { WorkbenchError } from './errors.js';

export type ApiRuntime = {
  bootstrap(): Promise<unknown> | unknown;
  settings(): Promise<unknown> | unknown;
  listSecrets(): Promise<SecretMetadata[]> | SecretMetadata[];
  createSecret(value: z.infer<typeof createSecretSchema>): Promise<SecretMetadata> | SecretMetadata;
  replaceSecret(id: string, value: string): Promise<SecretMetadata> | SecretMetadata;
  deleteSecret(id: string, force: boolean): Promise<unknown> | unknown;
  vaultStatus(): Promise<unknown> | unknown;
  resetVault(force: boolean): Promise<unknown> | unknown;
  createProvider(value: z.infer<typeof providerConfigSchema>): Promise<unknown> | unknown;
  updateProvider(id: string, value: z.infer<typeof providerConfigSchema>): Promise<unknown> | unknown;
  deleteProvider(id: string, force: boolean): Promise<unknown> | unknown;
  testProvider(id: string): Promise<unknown> | unknown;
  createServer(value: z.infer<typeof serverConfigSchema>): Promise<unknown> | unknown;
  updateServer(id: string, value: z.infer<typeof serverConfigSchema>): Promise<unknown> | unknown;
  deleteServer(id: string, force: boolean): Promise<unknown> | unknown;
  connectServer(id: string): Promise<unknown> | unknown;
  inspectServer(id: string): Promise<unknown> | unknown;
  callTool(id: string, tool: string, args: Record<string, unknown>, options: { confirmDangerous: boolean }): Promise<unknown> | unknown;
  playground(value: unknown): Promise<unknown> | unknown;
  createConversation(value: { serverId: string; providerId: string; model: string; systemPrompt?: string }): Promise<unknown> | unknown;
  listConversations(): Promise<unknown> | unknown;
  getConversation(id: string): Promise<unknown | undefined> | unknown | undefined;
  deleteConversation(id: string): Promise<boolean> | boolean;
  streamPlayground(value: unknown, onUpdate: (update: unknown) => void, signal?: AbortSignal): Promise<unknown>;
  invokePlaygroundTool(id: string, tool: string, args: Record<string, unknown>, confirmDangerous: boolean): Promise<unknown> | unknown;
  saveSuite(source: string): Promise<unknown> | unknown;
  createSuite(source: string): Promise<unknown> | unknown;
  updateSuite(name: string, source: string): Promise<unknown> | unknown;
  deleteSuite(name: string): Promise<unknown> | unknown;
  listSuites(): Promise<unknown> | unknown;
  getSuite(name: string): Promise<unknown | undefined> | unknown | undefined;
  startSuite(name: string): Promise<unknown> | unknown;
  listRuns(): Promise<unknown> | unknown;
  getRun(id: string): Promise<unknown | undefined> | unknown | undefined;
  cancelRun(id: string): Promise<boolean> | boolean;
  compareRuns(runA: string, runB: string): Promise<unknown> | unknown;
  startConformance(value: { serverId: string; selection: { kind: 'suite'; suite: 'active' } | { kind: 'scenario'; scenario: string }; timeoutMs: number }): Promise<unknown> | unknown;
  listConformanceReports(serverId?: string): Promise<unknown> | unknown;
  getConformanceReport(id: string): Promise<unknown | undefined> | unknown | undefined;
  cancelConformance(id: string): Promise<boolean> | boolean;
  beginOAuth(id: string): Promise<unknown> | unknown;
  oauthCallback(parameters: Record<string, string>): Promise<unknown> | unknown;
  oauthStatus(id: string): Promise<unknown> | unknown;
  forgetOAuth(id: string): Promise<void> | void;
  close(): Promise<void> | void;
};

const toolCallSchema = z.strictObject({
  tool: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).default({}),
  confirmDangerous: z.boolean().default(false),
});
const playgroundToolCallSchema = z.strictObject({
  arguments: z.record(z.string(), z.unknown()).default({}),
  confirmDangerous: z.boolean().default(false),
});
const suiteBodySchema = z.strictObject({ source: z.string().min(1) });
const playgroundSchema = z.strictObject({
  conversationId: z.string().min(1).optional(),
  serverId: z.string().min(1).optional(),
  providerId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  prompt: z.string().min(1),
  systemPrompt: z.string().max(100_000).optional(),
  limits: z.object({
    maxTurns: z.number().int().min(1).max(50),
    maxToolCalls: z.number().int().min(1).max(100),
    timeoutMs: z.number().int().min(1).max(300_000),
    maxCostUsd: z.number().nonnegative().optional(),
  }).optional(),
});
const conversationSchema = z.strictObject({
  serverId: z.string().min(1),
  providerId: z.string().min(1),
  model: z.string().min(1),
  systemPrompt: z.string().max(100_000).optional(),
});
const streamingPlaygroundSchema = playgroundSchema.extend({ conversationId: z.string().min(1) });
const conformanceSchema = z.strictObject({
  serverId: z.string().min(1),
  selection: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('suite'), suite: z.literal('active') }),
    z.strictObject({ kind: z.literal('scenario'), scenario: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/) }),
  ]),
  timeoutMs: z.number().int().min(5_000).max(600_000).default(120_000),
});
const replaceSecretSchema = z.strictObject({ value: z.string().min(4) });
const resetVaultSchema = z.strictObject({ confirm: z.literal('RESET'), force: z.boolean().default(false) });

function isLoopback(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.replace(/^::ffff:/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === 'localhost';
}

function originIsLoopback(value: string | undefined): boolean {
  if (!value) return false;
  try {
    return isLoopback(new URL(value).hostname);
  } catch {
    return false;
  }
}

function hostIsLoopback(value: string | undefined): boolean {
  if (!value) return false;
  try { return isLoopback(new URL(`http://${value}`).hostname); }
  catch { return false; }
}

function send(response: Response, value: unknown, status = 200): void {
  response.status(status).json(redact(value));
}

function sendSecret(response: Response, value: unknown, status = 200): void {
  response.set('cache-control', 'no-store');
  send(response, value, status);
}

function oauthCallbackHtml(value: unknown, ok: boolean): string {
  const payload = JSON.stringify(redact({ type: 'mcp-riksa:oauth', ok, value })).replaceAll('<', '\\u003c');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>OAuth ${ok ? 'connected' : 'failed'} — MCP Riksa</title><style>body{margin:0;background:#11110f;color:#eee2c8;font:16px system-ui;display:grid;place-items:center;min-height:100vh}.card{max-width:420px;padding:32px;border:1px solid #674323;background:#171512;text-align:center}b{color:${ok ? '#9ed39f' : '#ee958a'}}a{color:#f0a44f}</style></head><body><main class="card"><b>${ok ? 'Authorization complete' : 'Authorization failed'}</b><p>${ok ? 'Returning to MCP Riksa…' : 'Return to MCP Riksa for details.'}</p><a href="/#/servers">Back to MCP Riksa</a></main><script>const message=${payload};try{window.opener?.postMessage(message,location.origin);const channel=new BroadcastChannel('mcp-riksa-oauth');channel.postMessage(message);channel.close()}catch{}setTimeout(()=>window.close(),250)</script></body></html>`;
}

function writeStream(response: Response, eventName: string, value: unknown): void {
  if (response.writableEnded || response.destroyed) return;
  response.write(`event: ${eventName}\ndata: ${JSON.stringify(redact(value))}\n\n`);
}

export function createApp(runtime: ApiRuntime, options: { sessionToken?: string; staticDirectory?: string } = {}): Express {
  const app = express();
  const sessionToken = options.sessionToken ?? randomBytes(32).toString('base64url');
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb', strict: true }));

  app.use('/api', (request, response, next) => {
    if (!isLoopback(request.socket.remoteAddress) || !hostIsLoopback(request.get('host'))) {
      return send(response, { error: 'API is available only from loopback' }, 403);
    }
    const mutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method);
    if (mutating) {
      if (!originIsLoopback(request.get('origin'))) return send(response, { error: 'Mutating requests require a loopback Origin' }, 403);
      if (request.get('x-workbench-session') !== sessionToken) return send(response, { error: 'Invalid workbench session token' }, 403);
    }
    next();
  });

  app.get('/api/session', (_request, response) => send(response, { sessionToken, loopbackOnly: true }));
  app.get('/api/bootstrap', async (_request, response) => send(response, await runtime.bootstrap()));
  app.get('/api/settings', async (_request, response) => send(response, await runtime.settings()));

  app.get('/api/secrets', async (_request, response) => sendSecret(response, await runtime.listSecrets()));
  app.post('/api/secrets', async (request, response) => sendSecret(response, await runtime.createSecret(createSecretSchema.parse(request.body)), 201));
  app.put('/api/secrets/:id/value', async (request, response) => {
    const { value } = replaceSecretSchema.parse(request.body);
    sendSecret(response, await runtime.replaceSecret(request.params.id!, value));
  });
  app.delete('/api/secrets/:id', async (request, response) => {
    const { force } = z.object({ force: z.enum(['true', 'false']).default('false') }).parse(request.query);
    sendSecret(response, await runtime.deleteSecret(request.params.id!, force === 'true'));
  });
  app.get('/api/secrets/vault/status', async (_request, response) => sendSecret(response, await runtime.vaultStatus()));
  app.post('/api/secrets/vault/reset', async (request, response) => {
    const { force } = resetVaultSchema.parse(request.body);
    sendSecret(response, await runtime.resetVault(force));
  });

  app.post('/api/providers', async (request, response) => {
    const config = providerConfigSchema.parse(request.body);
    send(response, await runtime.createProvider(config), 201);
  });
  app.put('/api/providers/:id', async (request, response) => send(response, await runtime.updateProvider(request.params.id!, providerConfigSchema.parse(request.body))));
  app.delete('/api/providers/:id', async (request, response) => {
    const { force } = z.object({ force: z.enum(['true', 'false']).default('false') }).parse(request.query);
    send(response, await runtime.deleteProvider(request.params.id!, force === 'true'));
  });
  app.post('/api/providers/:id/test', async (request, response) => send(response, await runtime.testProvider(request.params.id!)));

  app.post('/api/servers', async (request, response) => {
    const config = serverConfigSchema.parse(request.body);
    send(response, await runtime.createServer(config), 201);
  });
  app.put('/api/servers/:id', async (request, response) => send(response, await runtime.updateServer(request.params.id!, serverConfigSchema.parse(request.body))));
  app.delete('/api/servers/:id', async (request, response) => {
    const { force } = z.object({ force: z.enum(['true', 'false']).default('false') }).parse(request.query);
    send(response, await runtime.deleteServer(request.params.id!, force === 'true'));
  });
  app.post('/api/servers/:id/connect', async (request, response) => send(response, await runtime.connectServer(request.params.id!)));
  app.get('/api/servers/:id', async (request, response) => send(response, await runtime.inspectServer(request.params.id!)));
  app.post('/api/servers/:id/call', async (request, response) => {
    const input = toolCallSchema.parse(request.body);
    send(response, await runtime.callTool(request.params.id!, input.tool, input.arguments, { confirmDangerous: input.confirmDangerous }));
  });

  app.post('/api/playground', async (request, response) => send(response, await runtime.playground(playgroundSchema.parse(request.body))));
  app.get('/api/playground/conversations', async (_request, response) => send(response, await runtime.listConversations()));
  app.post('/api/playground/conversations', async (request, response) => send(response, await runtime.createConversation(conversationSchema.parse(request.body)), 201));
  app.get('/api/playground/conversations/:id', async (request, response) => {
    const conversation = await runtime.getConversation(request.params.id!);
    if (conversation === undefined) return send(response, { error: 'Conversation not found' }, 404);
    send(response, conversation);
  });
  app.delete('/api/playground/conversations/:id', async (request, response) => {
    const deleted = await runtime.deleteConversation(request.params.id!);
    send(response, { id: request.params.id, deleted }, deleted ? 200 : 404);
  });
  app.post('/api/playground/conversations/:id/tools/:tool', async (request, response) => {
    const input = playgroundToolCallSchema.parse(request.body);
    send(response, await runtime.invokePlaygroundTool(request.params.id!, request.params.tool!, input.arguments, input.confirmDangerous));
  });
  app.post('/api/playground/stream', async (request, response) => {
    const input = streamingPlaygroundSchema.parse(request.body);
    const controller = new AbortController();
    response.status(200);
    response.set({
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    response.flushHeaders();
    response.on('close', () => { if (!response.writableEnded) controller.abort(new Error('Playground client disconnected')); });
    try {
      const result = await runtime.streamPlayground(input, (update) => writeStream(response, 'update', update), controller.signal);
      writeStream(response, 'done', result);
    } catch (error) {
      writeStream(response, 'error', { error: error instanceof Error ? error.message : 'Playground stream failed' });
    } finally {
      if (!response.writableEnded && !response.destroyed) response.end();
    }
  });
  app.get('/api/suites', async (_request, response) => send(response, await runtime.listSuites()));
  app.post('/api/suites', async (request, response) => send(response, await runtime.createSuite(suiteBodySchema.parse(request.body).source), 201));
  app.get('/api/suites/:name', async (request, response) => {
    const suite = await runtime.getSuite(request.params.name!);
    if (suite === undefined) return send(response, { error: 'Suite not found' }, 404);
    send(response, suite);
  });
  app.put('/api/suites/:name', async (request, response) => send(response, await runtime.updateSuite(request.params.name!, suiteBodySchema.parse(request.body).source)));
  app.delete('/api/suites/:name', async (request, response) => send(response, await runtime.deleteSuite(request.params.name!)));
  app.post('/api/suites/:name/run', async (request, response) => send(response, await runtime.startSuite(request.params.name!), 202));

  app.get('/api/runs', async (_request, response) => send(response, await runtime.listRuns()));
  app.get('/api/runs/:id', async (request, response) => {
    const run = await runtime.getRun(request.params.id!);
    if (run === undefined) return send(response, { error: 'Run not found' }, 404);
    send(response, run);
  });
  app.post('/api/runs/:id/cancel', async (request, response) => {
    const cancelled = await runtime.cancelRun(request.params.id!);
    send(response, { id: request.params.id, cancelled }, cancelled ? 202 : 404);
  });
  app.get('/api/compare', async (request, response) => {
    const query = z.object({ runA: z.string().min(1), runB: z.string().min(1) }).parse(request.query);
    send(response, await runtime.compareRuns(query.runA, query.runB));
  });

  app.get('/api/conformance', async (request, response) => {
    const query = z.object({ serverId: z.string().min(1).optional() }).parse(request.query);
    send(response, await runtime.listConformanceReports(query.serverId));
  });
  app.post('/api/conformance', async (request, response) => send(response, await runtime.startConformance(conformanceSchema.parse(request.body)), 202));
  app.get('/api/conformance/:id', async (request, response) => {
    const report = await runtime.getConformanceReport(request.params.id!);
    if (report === undefined) return send(response, { error: 'Conformance report not found' }, 404);
    send(response, report);
  });
  app.post('/api/conformance/:id/cancel', async (request, response) => {
    const cancelled = await runtime.cancelConformance(request.params.id!);
    send(response, { id: request.params.id, cancelled }, cancelled ? 202 : 404);
  });

  app.post('/api/servers/:id/oauth/begin', async (request, response) => send(response, await runtime.beginOAuth(request.params.id!)));
  app.get('/api/servers/:id/oauth', async (request, response) => send(response, await runtime.oauthStatus(request.params.id!)));
  app.post('/api/servers/:id/oauth/forget', async (request, response) => {
    await runtime.forgetOAuth(request.params.id!);
    response.status(204).end();
  });
  app.get('/api/oauth/callback', async (request, response, next) => {
    const browser = (request.get('accept') ?? '').includes('text/html');
    try {
      const query = z.object({
        code: z.string().optional(),
        state: z.string().optional(),
        error: z.string().optional(),
        error_description: z.string().optional(),
      }).parse(request.query);
      const value = await runtime.oauthCallback(Object.fromEntries(Object.entries(query).filter((entry): entry is [string, string] => entry[1] !== undefined)));
      if (!browser) return send(response, value);
      response.set('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'");
      response.status(200).type('html').send(oauthCallbackHtml(value, true));
    } catch (error) {
      if (!browser) return next(error);
      response.set('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'");
      response.status(400).type('html').send(oauthCallbackHtml({ error: error instanceof Error ? error.message : 'OAuth callback failed' }, false));
    }
  });

  if (options.staticDirectory) {
    app.use(express.static(options.staticDirectory, { index: false, dotfiles: 'deny' }));
    app.get('*path', (_request, response) => response.sendFile('index.html', { root: options.staticDirectory }));
  }

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const status = error instanceof ZodError
      ? 400
      : error instanceof WorkbenchError
        ? error.status
        : error instanceof SecretStoreError
          ? secretErrorStatus(error)
          : 500;
    const message = error instanceof ZodError ? 'Request validation failed' : error instanceof Error ? error.message : 'Internal error';
    send(response, {
      error: message,
      ...(error instanceof ZodError ? { issues: error.issues } : {}),
      ...(error instanceof WorkbenchError && error.details !== undefined ? { details: error.details } : {}),
    }, status);
  });

  return app;
}

function secretErrorStatus(error: SecretStoreError): number {
  if (error.code === 'SECRET_NOT_FOUND') return 404;
  if (error.code === 'SECRET_PURPOSE_DENIED') return 403;
  if (error.code === 'SECRET_VAULT_MISSING_KEY' || error.code === 'SECRET_VAULT_CORRUPT' || error.code === 'SECRET_VAULT_INSECURE_PERMISSIONS') return 409;
  return 400;
}
