import {
  auth,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { generateRandomState } from 'oauth4webapi';
import { Agent, fetch as undiciFetch } from 'undici';
import { z } from 'zod';
import { environmentVariableNameSchema } from '../core/environment.js';
import { redact, registerProtocolSecretValue, registerSecretValue, unregisterProtocolSecretValue } from '../core/redaction.js';
import { assertResolvedSecretValue, secretReferenceSchema, type SecretResolver } from '../secrets/types.js';
import { createSafeLookup, validateHttpEndpoint } from './validation.js';

const oauthOptionsSchema = z.strictObject({
  id: z.string().min(1),
  serverUrl: z.string().url(),
  callbackUrl: z.string().url(),
  scopes: z.array(z.string().min(1)).default([]),
  timeoutMs: z.number().int().min(1).max(300_000).default(120_000),
  clientId: z.string().min(1).optional(),
  clientSecretEnv: environmentVariableNameSchema.optional(),
  clientSecret: secretReferenceSchema.optional(),
});

export type OAuthOptions = z.infer<typeof oauthOptionsSchema>;
export type OAuthTimelineEntry = {
  timestamp: string;
  type: 'discovery' | 'registration' | 'redirect' | 'token' | 'refresh' | 'denied' | 'error' | 'cancelled' | 'forgotten';
  message: string;
};
export type OAuthState = 'authorizing' | 'authorized' | 'denied' | 'failed' | 'timed_out' | 'cancelled';
export type OAuthStatus = {
  id: string;
  state: OAuthState;
  scopes: string[];
  expiresAt?: string;
  authorizationUrl?: string;
  timeline: OAuthTimelineEntry[];
};

type Session = {
  options: OAuthOptions;
  provider: MemoryOAuthProvider;
  state: OAuthState;
  timeline: OAuthTimelineEntry[];
  authorizationUrl?: string;
  expiresAt?: string;
  timer?: NodeJS.Timeout;
  completion: Promise<OAuthState>;
  resolveCompletion: (state: OAuthState) => void;
};

function timeline(session: Session, type: OAuthTimelineEntry['type'], message: string): void {
  session.timeline.push(redact({ timestamp: new Date().toISOString(), type, message }));
}

class MemoryOAuthProvider implements OAuthClientProvider {
  private information?: OAuthClientInformationMixed;
  private savedTokens?: OAuthTokens;
  private verifier?: string;
  private discovery?: OAuthDiscoveryState;
  readonly stateValue = generateRandomState();

  constructor(private readonly session: Session, information?: OAuthClientInformationMixed) {
    this.information = information;
    if (information && 'client_secret' in information) registerProtocolSecretValue(information.client_secret);
  }

  get redirectUrl(): string {
    return this.session.options.callbackUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'MCP Riksa',
      redirect_uris: [this.session.options.callbackUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: this.information && 'client_secret' in this.information ? 'client_secret_post' : 'none',
      scope: this.session.options.scopes.join(' '),
    };
  }

  state(): string {
    return this.stateValue;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.information;
  }

  saveClientInformation(information: OAuthClientInformationMixed): void {
    if (this.information && 'client_secret' in this.information) unregisterProtocolSecretValue(this.information.client_secret);
    registerProtocolSecretValue(information.client_secret);
    this.information = information;
    timeline(this.session, 'registration', 'Dynamic client registration completed');
  }

  tokens(): OAuthTokens | undefined {
    return this.savedTokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    const refresh = this.savedTokens !== undefined;
    if (this.savedTokens) {
      unregisterProtocolSecretValue(this.savedTokens.access_token);
      unregisterProtocolSecretValue(this.savedTokens.refresh_token);
      unregisterProtocolSecretValue(this.savedTokens.id_token);
    }
    registerProtocolSecretValue(tokens.access_token);
    registerProtocolSecretValue(tokens.refresh_token);
    registerProtocolSecretValue(tokens.id_token);
    this.savedTokens = tokens;
    this.session.expiresAt = tokens.expires_in === undefined
      ? undefined
      : new Date(Date.now() + tokens.expires_in * 1000).toISOString();
    timeline(this.session, refresh ? 'refresh' : 'token', refresh ? 'Access token refreshed in memory' : 'Access token stored in memory');
  }

  redirectToAuthorization(url: URL): void {
    this.session.authorizationUrl = url.toString();
    timeline(this.session, 'redirect', 'Authorization redirect prepared');
  }

  saveCodeVerifier(codeVerifier: string): void {
    unregisterProtocolSecretValue(this.verifier);
    registerProtocolSecretValue(codeVerifier);
    this.verifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.verifier) throw new Error('PKCE verifier is not available');
    return this.verifier;
  }

  saveDiscoveryState(discovery: OAuthDiscoveryState): void {
    this.discovery = discovery;
    timeline(this.session, 'discovery', 'Protected resource and authorization server metadata discovered');
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.discovery;
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'all' || scope === 'client') {
      if (this.information && 'client_secret' in this.information) unregisterProtocolSecretValue(this.information.client_secret);
      this.information = undefined;
    }
    if (scope === 'all' || scope === 'tokens') {
      unregisterProtocolSecretValue(this.savedTokens?.access_token);
      unregisterProtocolSecretValue(this.savedTokens?.refresh_token);
      unregisterProtocolSecretValue(this.savedTokens?.id_token);
      this.savedTokens = undefined;
    }
    if (scope === 'all' || scope === 'verifier') {
      unregisterProtocolSecretValue(this.verifier);
      this.verifier = undefined;
    }
    if (scope === 'all' || scope === 'discovery') this.discovery = undefined;
  }
}

function validateCallback(input: string): void {
  const callback = new URL(input);
  const hostname = callback.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (callback.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(hostname)) {
    throw new Error('OAuth callback must be a strict loopback HTTP URL');
  }
}

async function staticClient(options: OAuthOptions, resolveSecret: SecretResolver): Promise<OAuthClientInformationMixed | undefined> {
  if (options.clientId === undefined) return undefined;
  const reference = options.clientSecret ?? (options.clientSecretEnv === undefined
    ? undefined
    : { source: 'env' as const, name: options.clientSecretEnv });
  const secret = reference === undefined ? undefined : await resolveSecret(reference, 'oauth-client-secret');
  return {
    client_id: options.clientId,
    ...(secret === undefined ? {} : { client_secret: secret }),
    token_endpoint_auth_method: secret === undefined ? 'none' : 'client_secret_post',
  };
}

export class OAuthCoordinator {
  private readonly sessions = new Map<string, Session>();
  private readonly dispatcher = new Agent({ connect: { lookup: createSafeLookup() } });

  constructor(private readonly resolveSecret: SecretResolver = async (reference) => {
    if (reference.source !== 'env') throw new Error(`Secret backend ${reference.source} is not available in this context`);
    const value = process.env[reference.name];
    if (value === undefined) throw new Error(`Environment variable ${reference.name} is not set`);
    assertResolvedSecretValue(value);
    registerSecretValue(value);
    return value;
  }) {}

  private readonly safeFetch = ((input: string | URL | Request, init?: RequestInit) => (
    undiciFetch as unknown as (
      target: string | URL | Request,
      options: RequestInit & { dispatcher: Agent },
    ) => Promise<Response>
  )(input, { ...init, dispatcher: this.dispatcher })) as typeof fetch;

  async begin(input: unknown): Promise<OAuthStatus> {
    const options = oauthOptionsSchema.parse(input);
    await validateHttpEndpoint(options.serverUrl);
    validateCallback(options.callbackUrl);
    this.forget(options.id, false);

    let resolveCompletion!: (state: OAuthState) => void;
    const completion = new Promise<OAuthState>((resolve) => { resolveCompletion = resolve; });
    const session: Session = {
      options,
      provider: undefined as unknown as MemoryOAuthProvider,
      state: 'authorizing' as const,
      timeline: [],
      completion,
      resolveCompletion,
    };
    session.provider = new MemoryOAuthProvider(session, await staticClient(options, this.resolveSecret));
    this.sessions.set(options.id, session);

    try {
      const outcome = await auth(session.provider, {
        serverUrl: options.serverUrl,
        fetchFn: this.safeFetch,
        ...(options.scopes.length === 0 ? {} : { scope: options.scopes.join(' ') }),
      });
      if (outcome !== 'REDIRECT' || session.authorizationUrl === undefined) {
        throw new Error('OAuth server did not start an interactive authorization flow');
      }
      session.timer = setTimeout(() => {
        if (session.state !== 'authorizing') return;
        session.state = 'timed_out';
        session.authorizationUrl = undefined;
        timeline(session, 'error', 'OAuth callback timed out');
        session.provider.invalidateCredentials?.('all');
        session.resolveCompletion(session.state);
      }, options.timeoutMs);
      return this.status(options.id);
    } catch (error) {
      this.fail(session, 'failed', error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async callback(id: string, parameters: Record<string, string>): Promise<OAuthStatus> {
    const session = this.require(id);
    if (session.state !== 'authorizing') throw new Error(`OAuth session is ${session.state}`);
    if (!parameters.state || parameters.state !== session.provider.stateValue) {
      this.fail(session, 'failed', 'OAuth callback state mismatch');
      throw new Error('OAuth callback state mismatch');
    }
    if (parameters.error) {
      this.fail(session, 'denied', 'Authorization was denied');
      throw new Error(`OAuth authorization denied: ${parameters.error}`);
    }
    if (!parameters.code) {
      this.fail(session, 'failed', 'OAuth callback did not include an authorization code');
      throw new Error('OAuth callback did not include an authorization code');
    }
    try {
      await auth(session.provider, { serverUrl: session.options.serverUrl, authorizationCode: parameters.code, fetchFn: this.safeFetch });
      if (session.timer) clearTimeout(session.timer);
      session.state = 'authorized';
      session.authorizationUrl = undefined;
      session.resolveCompletion(session.state);
      return this.status(id);
    } catch (error) {
      this.fail(session, 'failed', error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async callbackByState(parameters: Record<string, string>): Promise<OAuthStatus> {
    if (!parameters.state) throw new Error('OAuth callback did not include state');
    const matches = [...this.sessions.entries()].filter(([, session]) => (
      session.state === 'authorizing' && session.provider.stateValue === parameters.state
    ));
    if (matches.length !== 1) throw new Error('OAuth callback state is unknown or expired');
    return this.callback(matches[0]![0], parameters);
  }

  async refresh(id: string): Promise<OAuthStatus> {
    const session = this.require(id);
    if (session.state !== 'authorized') throw new Error('OAuth session is not authorized');
    await auth(session.provider, { serverUrl: session.options.serverUrl, fetchFn: this.safeFetch });
    return this.status(id);
  }

  async wait(id: string): Promise<OAuthStatus> {
    const session = this.require(id);
    const state = await session.completion;
    if (state !== 'authorized') throw new Error(`OAuth authorization ${state === 'timed_out' ? 'timed out' : state}`);
    return this.status(id);
  }

  cancel(id: string): void {
    const session = this.require(id);
    if (session.state !== 'authorizing') return;
    this.fail(session, 'cancelled', 'OAuth authorization cancelled');
  }

  forget(id: string, record = true): void {
    const session = this.sessions.get(id);
    if (!session) return;
    if (session.timer) clearTimeout(session.timer);
    session.provider.invalidateCredentials?.('all');
    if (record) timeline(session, 'forgotten', 'Authorization material forgotten');
    if (session.state === 'authorizing') session.resolveCompletion('cancelled');
    this.sessions.delete(id);
  }

  isUsingCredentials(id: string): boolean {
    const state = this.sessions.get(id)?.state;
    return state === 'authorizing' || state === 'authorized';
  }

  status(id: string): OAuthStatus {
    const session = this.require(id);
    const scopes = session.provider.tokens()?.scope?.split(/\s+/).filter(Boolean) ?? [];
    return redact({
      id,
      state: session.state,
      scopes,
      ...(session.expiresAt === undefined ? {} : { expiresAt: session.expiresAt }),
      ...(session.state !== 'authorizing' || session.authorizationUrl === undefined ? {} : { authorizationUrl: session.authorizationUrl }),
      timeline: session.timeline,
    });
  }

  getProvider(id: string): OAuthClientProvider {
    return this.require(id).provider;
  }

  async close(): Promise<void> {
    for (const id of [...this.sessions.keys()]) this.forget(id, false);
    await this.dispatcher.close();
  }

  private require(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`OAuth session ${id} not found`);
    return session;
  }

  private fail(session: Session, state: Extract<OAuthState, 'denied' | 'failed' | 'cancelled'>, message: string): void {
    if (session.timer) clearTimeout(session.timer);
    session.state = state;
    session.authorizationUrl = undefined;
    timeline(session, state === 'denied' ? 'denied' : state === 'cancelled' ? 'cancelled' : 'error', message);
    session.provider.invalidateCredentials?.('all');
    session.resolveCompletion(state);
  }
}
