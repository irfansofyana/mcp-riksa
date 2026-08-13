import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { OAuthCoordinator } from '../src/mcp/oauth.js';
import { redact } from '../src/core/redaction.js';

type FakeState = {
  registrations: number;
  refreshes: number;
  challenges: Map<string, string>;
};

let server: ReturnType<typeof createServer>;
let baseUrl: string;
let fake: FakeState;

function json(response: ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

async function form(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

beforeEach(async () => {
  process.env.OAUTH_CLIENT_SECRET = 'pre-registered-secret';
  fake = { registrations: 0, refreshes: 0, challenges: new Map() };
  server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', baseUrl || 'http://127.0.0.1');
    if (url.pathname === '/.well-known/oauth-protected-resource/mcp' || url.pathname === '/.well-known/oauth-protected-resource') {
      return json(response, { resource: `${baseUrl}/mcp`, authorization_servers: [baseUrl], scopes_supported: ['mcp:read', 'mcp:write'] });
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return json(response, {
        issuer: baseUrl,
        authorization_endpoint: `${baseUrl}/authorize`,
        token_endpoint: `${baseUrl}/token`,
        registration_endpoint: `${baseUrl}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
        scopes_supported: ['mcp:read', 'mcp:write'],
      });
    }
    if (url.pathname === '/register') {
      fake.registrations += 1;
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const metadata = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { redirect_uris: string[] };
      return json(response, {
        client_id: 'dynamic-client', client_secret: 'dynamic-secret', redirect_uris: metadata.redirect_uris,
        token_endpoint_auth_method: 'client_secret_post',
      }, 201);
    }
    if (url.pathname === '/authorize') {
      const state = url.searchParams.get('state')!;
      const challenge = url.searchParams.get('code_challenge')!;
      const redirectUri = url.searchParams.get('redirect_uri')!;
      const code = `code-${fake.challenges.size + 1}`;
      fake.challenges.set(code, challenge);
      response.writeHead(302, { location: `${redirectUri}?code=${code}&state=${state}` });
      return response.end();
    }
    if (url.pathname === '/token') {
      const params = await form(request);
      if (params.get('grant_type') === 'refresh_token') {
        fake.refreshes += 1;
        return json(response, { access_token: `refreshed-access-${fake.refreshes}`, refresh_token: 'refresh-secret', token_type: 'Bearer', expires_in: 60, scope: 'mcp:read mcp:write' });
      }
      const code = params.get('code')!;
      const verifier = params.get('code_verifier')!;
      const expected = createHash('sha256').update(verifier).digest('base64url');
      if (expected !== fake.challenges.get(code)) return json(response, { error: 'invalid_grant' }, 400);
      return json(response, { access_token: 'raw-access-secret', refresh_token: 'refresh-secret', token_type: 'Bearer', expires_in: 1, scope: 'mcp:read mcp:write' });
    }
    return json(response, { error: 'not found' }, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('OAuth fake failed to bind');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  delete process.env.OAUTH_CLIENT_SECRET;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

function options(overrides: Record<string, unknown> = {}) {
  return {
    id: 'server-oauth',
    serverUrl: `${baseUrl}/mcp`,
    callbackUrl: 'http://127.0.0.1:4317/api/oauth/callback',
    scopes: ['mcp:read', 'mcp:write'],
    timeoutMs: 1000,
    ...overrides,
  };
}

async function authorize(coordinator: OAuthCoordinator, id = 'server-oauth') {
  const status = coordinator.status(id);
  const response = await fetch(status.authorizationUrl!, { redirect: 'manual' });
  const redirect = new URL(response.headers.get('location')!);
  await coordinator.callback(id, Object.fromEntries(redirect.searchParams));
}

describe('OAuth Authorization Code + PKCE lifecycle', () => {
  test('discovers metadata, dynamically registers, validates PKCE, and exposes only sanitized status', async () => {
    const coordinator = new OAuthCoordinator();
    const started = await coordinator.begin(options());
    const authorization = new URL(started.authorizationUrl!);

    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorization.searchParams.get('state')).toBeTruthy();
    expect(fake.registrations).toBe(1);

    await authorize(coordinator);
    const status = coordinator.status('server-oauth');
    expect(status).toMatchObject({ state: 'authorized', scopes: ['mcp:read', 'mcp:write'] });
    expect(status.expiresAt).toBeTruthy();
    expect(JSON.stringify(status)).not.toMatch(/raw-access-secret|refresh-secret|dynamic-secret|code-1/);
    expect(JSON.stringify(redact({ reflected: 'raw-access-secret refresh-secret dynamic-secret' }))).not.toMatch(/raw-access-secret|refresh-secret|dynamic-secret/);
    expect(status.timeline.map((entry) => entry.type)).toEqual(expect.arrayContaining(['discovery', 'registration', 'redirect', 'token']));
  });

  test('uses a pre-registered static client instead of DCR', async () => {
    const coordinator = new OAuthCoordinator();
    await coordinator.begin(options({ clientId: 'static-client', clientSecretEnv: 'OAUTH_CLIENT_SECRET' }));
    await authorize(coordinator);
    expect(fake.registrations).toBe(0);
    expect(coordinator.status('server-oauth').state).toBe('authorized');
  });

  test('handles authorization denial without storing credentials', async () => {
    const coordinator = new OAuthCoordinator();
    const started = await coordinator.begin(options());
    const state = new URL(started.authorizationUrl!).searchParams.get('state')!;
    await expect(coordinator.callback('server-oauth', { error: 'access_denied', state })).rejects.toThrow(/denied/i);
    expect(coordinator.status('server-oauth').state).toBe('denied');
    expect(coordinator.getProvider('server-oauth').tokens()).toBeUndefined();
  });

  test('rejects a callback state mismatch', async () => {
    const coordinator = new OAuthCoordinator();
    await coordinator.begin(options());
    await expect(coordinator.callback('server-oauth', { code: 'stolen-code', state: 'wrong-state' })).rejects.toThrow(/state/i);
    expect(coordinator.status('server-oauth').state).toBe('failed');
  });

  test('resolves a callback by state without placing a server identifier in the redirect URI', async () => {
    const coordinator = new OAuthCoordinator();
    const started = await coordinator.begin(options());
    const authorization = new URL(started.authorizationUrl!);
    expect(authorization.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:4317/api/oauth/callback');
    const response = await fetch(started.authorizationUrl!, { redirect: 'manual' });
    const redirect = new URL(response.headers.get('location')!);
    await coordinator.callbackByState(Object.fromEntries(redirect.searchParams));
    expect(coordinator.status('server-oauth').state).toBe('authorized');
  });

  test('supports callback timeout and explicit cancellation', async () => {
    const timed = new OAuthCoordinator();
    await timed.begin(options({ timeoutMs: 20 }));
    await expect(timed.wait('server-oauth')).rejects.toThrow(/timed out/i);
    expect(timed.status('server-oauth').state).toBe('timed_out');

    const cancelled = new OAuthCoordinator();
    await cancelled.begin(options({ id: 'cancelled' }));
    cancelled.cancel('cancelled');
    await expect(cancelled.wait('cancelled')).rejects.toThrow(/cancelled/i);
    expect(cancelled.status('cancelled').state).toBe('cancelled');
  });

  test('tracks expiry, refreshes tokens, and forgets all authorization material', async () => {
    const coordinator = new OAuthCoordinator();
    await coordinator.begin(options());
    await authorize(coordinator);
    const firstExpiry = coordinator.status('server-oauth').expiresAt;

    await coordinator.refresh('server-oauth');
    expect(fake.refreshes).toBe(1);
    expect(coordinator.status('server-oauth').expiresAt).not.toBe(firstExpiry);

    coordinator.forget('server-oauth');
    expect(() => coordinator.status('server-oauth')).toThrow(/not found/i);
    expect(() => coordinator.getProvider('server-oauth')).toThrow(/not found/i);
  });
});
