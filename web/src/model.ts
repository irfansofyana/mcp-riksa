import { stringify } from 'yaml';

export const pages = ['Servers', 'Playground', 'Suites', 'Runs', 'Compare', 'Settings'] as const;
export type Page = typeof pages[number];

export function normalizePage(hash: string): Page {
  const requested = hash.replace(/^#\/?/, '').toLowerCase();
  return pages.find((page) => page.toLowerCase() === requested) ?? 'Servers';
}

function envMap(input: string): Record<string, string> {
  return Object.fromEntries(
    input.split(/[\n,]/).map((line) => line.trim()).filter(Boolean).map((line) => {
      const separator = line.indexOf('=');
      if (separator < 1 || separator === line.length - 1) throw new Error(`Expected NAME=ENV_VAR, received ${line}`);
      return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
    }),
  );
}

export type ServerForm = {
  id: string; name: string; transport: 'stdio' | 'http'; command: string; args: string; url: string; headerEnv: string;
  oauthScopes?: string; oauthClientId?: string; oauthClientSecretEnv?: string;
};

export function buildServerPayload(form: ServerForm) {
  if (form.transport === 'stdio') {
    return {
      id: form.id.trim(), name: form.name.trim(), transport: 'stdio' as const,
      command: form.command.trim(), args: form.args.trim() ? form.args.trim().split(/\s+/) : [], envRefs: {},
    };
  }
  return {
    id: form.id.trim(), name: form.name.trim(), transport: 'http' as const,
    url: form.url.trim(), headerEnv: envMap(form.headerEnv), allowUnsafeEndpoint: false,
    oauth: {
      scopes: (form.oauthScopes ?? '').split(/[\s,]+/).map((scope) => scope.trim()).filter(Boolean),
      timeoutMs: 120_000,
      ...((form.oauthClientId ?? '').trim() ? { clientId: form.oauthClientId!.trim() } : {}),
      ...((form.oauthClientSecretEnv ?? '').trim() ? { clientSecretEnv: form.oauthClientSecretEnv!.trim() } : {}),
    },
  };
}

export type ProviderForm = {
  id: string; name: string; type: 'openai-compatible' | 'anthropic-compatible'; baseUrl: string;
  alias: string; model: string; apiKeyEnv: string; headerEnv: string; inputPrice: string; outputPrice: string;
};

export function buildProviderPayload(form: ProviderForm) {
  return {
    id: form.id.trim(), name: form.name.trim(), type: form.type, baseUrl: form.baseUrl.trim(),
    models: { [form.alias.trim()]: form.model.trim() },
    ...(form.apiKeyEnv.trim() ? { apiKeyEnv: form.apiKeyEnv.trim() } : {}),
    headerEnv: envMap(form.headerEnv),
    pricing: {
      inputPerMillion: Number(form.inputPrice || 0),
      outputPerMillion: Number(form.outputPrice || 0),
    },
  };
}

export type TraceEvent = { id: string; caseId: string; type: string; [key: string]: unknown };

export function groupTrace(events: TraceEvent[]): Record<string, TraceEvent[]> {
  const groups: Record<string, TraceEvent[]> = {};
  for (const event of events) (groups[event.caseId] ??= []).push(event);
  return groups;
}

export function buildSuiteFromPlayground(input: {
  name: string; server: string; provider: string; model: string; prompt: string; expectedText: string;
}): string {
  return stringify({
    version: 1,
    name: input.name,
    cases: [{
      id: 'saved-playground-case', kind: 'agent', server: input.server, provider: input.provider,
      model: input.model, prompt: input.prompt,
      limits: { maxTurns: 8, maxToolCalls: 16, timeoutMs: 60_000 },
      assertions: [{ type: 'contains', value: input.expectedText }],
    }],
  });
}

export function signedDelta(value: number, unit = ''): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}${unit}`;
}
