import { randomBytes } from 'node:crypto';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { z, ZodError } from 'zod';
import { providerConfigSchema } from '../agent/types.js';
import { redact } from '../core/redaction.js';
import { serverConfigSchema } from '../mcp/manager.js';

export type ApiRuntime = {
  bootstrap(): Promise<unknown> | unknown;
  settings(): Promise<unknown> | unknown;
  addProvider(value: z.infer<typeof providerConfigSchema>): Promise<unknown> | unknown;
  testProvider(id: string): Promise<unknown> | unknown;
  addServer(value: z.infer<typeof serverConfigSchema>): Promise<unknown> | unknown;
  connectServer(id: string): Promise<unknown> | unknown;
  inspectServer(id: string): Promise<unknown> | unknown;
  callTool(id: string, tool: string, args: Record<string, unknown>, options: { confirmDangerous: boolean }): Promise<unknown> | unknown;
  playground(value: unknown): Promise<unknown> | unknown;
  createConversation(value: { serverId: string; providerId: string; model: string }): Promise<unknown> | unknown;
  listConversations(): Promise<unknown> | unknown;
  getConversation(id: string): Promise<unknown | undefined> | unknown | undefined;
  deleteConversation(id: string): Promise<boolean> | boolean;
  streamPlayground(value: unknown, onUpdate: (update: unknown) => void, signal?: AbortSignal): Promise<unknown>;
  saveSuite(source: string): Promise<unknown> | unknown;
  listSuites(): Promise<unknown> | unknown;
  startSuite(name: string): Promise<unknown> | unknown;
  listRuns(): Promise<unknown> | unknown;
  getRun(id: string): Promise<unknown | undefined> | unknown | undefined;
  cancelRun(id: string): Promise<boolean> | boolean;
  compareRuns(runA: string, runB: string): Promise<unknown> | unknown;
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
const suiteBodySchema = z.strictObject({ source: z.string().min(1) });
const playgroundSchema = z.strictObject({
  conversationId: z.string().min(1).optional(),
  serverId: z.string().min(1).optional(),
  providerId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  prompt: z.string().min(1),
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
});
const streamingPlaygroundSchema = playgroundSchema.extend({ conversationId: z.string().min(1) });

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

function send(response: Response, value: unknown, status = 200): void {
  response.status(status).json(redact(value));
}

function oauthCallbackHtml(value: unknown, ok: boolean): string {
  const payload = JSON.stringify(redact({ type: 'workbench:oauth', ok, value })).replaceAll('<', '\\u003c');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>OAuth ${ok ? 'connected' : 'failed'}</title><style>body{margin:0;background:#11110f;color:#eee2c8;font:16px system-ui;display:grid;place-items:center;min-height:100vh}.card{max-width:420px;padding:32px;border:1px solid #674323;background:#171512;text-align:center}b{color:${ok ? '#9ed39f' : '#ee958a'}}a{color:#f0a44f}</style></head><body><main class="card"><b>${ok ? 'Authorization complete' : 'Authorization failed'}</b><p>${ok ? 'Returning to MCP Local Workbench…' : 'Return to workbench for details.'}</p><a href="/#/servers">Back to workbench</a></main><script>const message=${payload};try{window.opener?.postMessage(message,location.origin);const channel=new BroadcastChannel('workbench-oauth');channel.postMessage(message);channel.close()}catch{}setTimeout(()=>window.close(),250)</script></body></html>`;
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
    if (!isLoopback(request.socket.remoteAddress)) {
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

  app.post('/api/providers', async (request, response) => {
    const config = providerConfigSchema.parse(request.body);
    send(response, await runtime.addProvider(config), 201);
  });
  app.post('/api/providers/:id/test', async (request, response) => send(response, await runtime.testProvider(request.params.id!)));

  app.post('/api/servers', async (request, response) => {
    const config = serverConfigSchema.parse(request.body);
    send(response, await runtime.addServer(config), 201);
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
  app.post('/api/suites', async (request, response) => send(response, await runtime.saveSuite(suiteBodySchema.parse(request.body).source), 201));
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
    const status = error instanceof ZodError ? 400 : 500;
    const message = error instanceof ZodError ? 'Request validation failed' : error instanceof Error ? error.message : 'Internal error';
    send(response, { error: message, ...(error instanceof ZodError ? { issues: error.issues } : {}) }, status);
  });

  return app;
}
