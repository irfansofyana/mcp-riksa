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

export type TraceEvent = {
  id: string;
  caseId: string;
  type: string;
  timestamp?: string;
  durationMs?: number;
  data?: unknown;
  sanitized?: true;
  [key: string]: unknown;
};

export type TraceRow = {
  id: string;
  kind: 'model' | 'tool' | 'agent' | 'event';
  name: string;
  timestamp: string;
  durationMs: number;
  offsetPct: number;
  widthPct: number;
  data: unknown;
};

export type RichContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string }
  | { type: 'resource_link'; uri: string; name?: string; mimeType?: string; description?: string }
  | { type: 'resource'; uri?: string; mimeType?: string; text?: string; blob?: string }
  | { type: 'structured'; value: unknown }
  | { type: 'unsupported'; originalType: string; value: unknown };

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function normalizeMcpContent(result: unknown): RichContentBlock[] {
  const root = objectValue(result);
  if (!root) return [{ type: 'structured', value: result }];
  const blocks: RichContentBlock[] = [];
  const content = Array.isArray(root.content) ? root.content : [];
  for (const raw of content) {
    const block = objectValue(raw);
    const type = typeof block?.type === 'string' ? block.type : 'unknown';
    if (type === 'text' && typeof block?.text === 'string') {
      blocks.push({ type: 'text', text: block.text });
      continue;
    }
    if (type === 'image' && typeof block?.data === 'string' && typeof block.mimeType === 'string') {
      if (/^image\/(?:png|jpe?g|gif|webp)$/i.test(block.mimeType)) blocks.push({ type: 'image', mimeType: block.mimeType, data: block.data });
      else blocks.push({ type: 'unsupported', originalType: type, value: raw });
      continue;
    }
    if (type === 'resource_link' && typeof block?.uri === 'string') {
      blocks.push({
        type: 'resource_link', uri: block.uri,
        ...(typeof block.name === 'string' ? { name: block.name } : {}),
        ...(typeof block.mimeType === 'string' ? { mimeType: block.mimeType } : {}),
        ...(typeof block.description === 'string' ? { description: block.description } : {}),
      });
      continue;
    }
    if (type === 'resource') {
      const resource = objectValue(block?.resource);
      if (resource) {
        blocks.push({
          type: 'resource',
          ...(typeof resource.uri === 'string' ? { uri: resource.uri } : {}),
          ...(typeof resource.mimeType === 'string' ? { mimeType: resource.mimeType } : {}),
          ...(typeof resource.text === 'string' ? { text: resource.text } : {}),
          ...(typeof resource.blob === 'string' ? { blob: resource.blob } : {}),
        });
        continue;
      }
    }
    blocks.push({ type: 'unsupported', originalType: type, value: raw });
  }
  if (root.structuredContent !== undefined) blocks.push({ type: 'structured', value: root.structuredContent });
  if (blocks.length === 0) blocks.push({ type: 'structured', value: result });
  return blocks;
}

function traceTiming(events: TraceEvent[], fallbackDurationMs: number) {
  const timed = events.map((entry) => {
    const end = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN;
    const durationMs = Math.max(0, entry.durationMs ?? 0);
    const safeEnd = Number.isFinite(end) ? end : 0;
    return { entry, end: safeEnd, start: safeEnd - durationMs, durationMs };
  });
  const finite = timed.filter((entry) => entry.end > 0);
  const traceEnd = finite.length ? Math.max(...finite.map((entry) => entry.end)) : fallbackDurationMs;
  const observedStart = finite.length ? Math.min(...finite.map((entry) => entry.start)) : 0;
  const traceStart = fallbackDurationMs > 0 ? Math.min(observedStart, traceEnd - fallbackDurationMs) : observedStart;
  return { timed, traceStart, total: Math.max(1, traceEnd - traceStart, fallbackDurationMs) };
}

export function traceWindowMs(events: TraceEvent[], fallbackDurationMs = 0): number {
  return events.length === 0 ? fallbackDurationMs : traceTiming(events, fallbackDurationMs).total;
}

export function buildTraceRows(events: TraceEvent[], fallbackDurationMs = 0): TraceRow[] {
  if (events.length === 0) return [];
  const { timed, traceStart, total } = traceTiming(events, fallbackDurationMs);
  /* Events are timestamped at completion, so subtract duration to place each span. */
  return timed.map(({ entry, start, durationMs }) => {
    const data = objectValue(entry.data);
    const kind: TraceRow['kind'] = entry.type === 'model_turn' ? 'model' : entry.type === 'tool_call' ? 'tool' : entry.type === 'stop' ? 'agent' : 'event';
    const name = kind === 'model'
      ? `Model turn ${typeof data?.turn === 'number' ? data.turn : ''}`.trim()
      : kind === 'tool'
        ? String(data?.name ?? data?.tool ?? 'MCP tool')
        : kind === 'agent'
          ? `Agent ${String(data?.reason ?? 'stop')}`
          : entry.type.replaceAll('_', ' ');
    return {
      id: entry.id,
      kind,
      name,
      timestamp: entry.timestamp ?? '',
      durationMs,
      offsetPct: Math.max(0, Math.min(100, ((start - traceStart) / total) * 100)),
      widthPct: Math.max(durationMs > 0 ? 1.5 : .6, Math.min(100, (durationMs / total) * 100)),
      data: entry.data,
    };
  });
}

export function groupTrace(events: TraceEvent[]): Record<string, TraceEvent[]> {
  const groups: Record<string, TraceEvent[]> = {};
  for (const event of events) (groups[event.caseId] ??= []).push(event);
  return groups;
}

export type ToolField = {
  key: string;
  path: string[];
  label: string;
  kind: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'json';
  required: boolean;
  description?: string;
  enumValues?: unknown[];
  defaultValue?: unknown;
  format?: string;
  minimum?: number;
  maximum?: number;
};

type JsonSchema = Record<string, unknown>;

function schemaType(schema: JsonSchema): ToolField['kind'] {
  const raw = Array.isArray(schema.type) ? schema.type.find((entry) => entry !== 'null') : schema.type;
  if (raw === 'string' || raw === 'number' || raw === 'integer' || raw === 'boolean' || raw === 'array' || raw === 'object') return raw;
  return Array.isArray(schema.enum) ? 'string' : 'json';
}

export function buildToolFields(schema: Record<string, unknown> | undefined): ToolField[] {
  const output: ToolField[] = [];
  const walk = (current: JsonSchema, path: string[], required: boolean) => {
    const kind = schemaType(current);
    const name = path.at(-1) ?? 'arguments';
    output.push({
      key: path.length === 0 ? '$' : path.join('.'),
      path,
      label: typeof current.title === 'string' ? current.title : name.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()),
      kind,
      required,
      ...(typeof current.description === 'string' ? { description: current.description } : {}),
      ...(Array.isArray(current.enum) ? { enumValues: current.enum } : {}),
      ...(current.default !== undefined ? { defaultValue: current.default } : {}),
      ...(typeof current.format === 'string' ? { format: current.format } : {}),
      ...(typeof current.minimum === 'number' ? { minimum: current.minimum } : {}),
      ...(typeof current.maximum === 'number' ? { maximum: current.maximum } : {}),
    });
  };
  const root = schema ?? { type: 'object', properties: {} };
  const properties = objectValue(root.properties);
  const required = new Set(Array.isArray(root.required) ? root.required.filter((entry): entry is string => typeof entry === 'string') : []);
  if (properties) {
    for (const [name, child] of Object.entries(properties)) walk(objectValue(child) ?? {}, [name], required.has(name));
  } else if (Object.keys(root).length > 0) walk(root, [], true);
  return output;
}

export function initialToolValues(fields: ToolField[]): Record<string, string | boolean> {
  return Object.fromEntries(fields.map((field) => {
    const value = field.defaultValue;
    if (field.enumValues && value !== undefined) {
      const index = field.enumValues.findIndex((entry) => Object.is(entry, value));
      return [field.key, index < 0 ? '' : `enum:${index}`];
    }
    if (field.kind === 'boolean') return [field.key, typeof value === 'boolean' ? String(value) : ''];
    if ((field.kind === 'array' || field.kind === 'object' || field.kind === 'json') && value !== undefined) return [field.key, JSON.stringify(value, null, 2)];
    return [field.key, value === undefined ? '' : String(value)];
  }));
}

function setPath(target: Record<string, unknown>, path: string[], value: unknown): void {
  let current = target;
  path.forEach((segment, index) => {
    if (index === path.length - 1) current[segment] = value;
    else {
      const child = objectValue(current[segment]) ?? {};
      current[segment] = child;
      current = child;
    }
  });
}

export function buildToolArguments(fields: ToolField[], values: Record<string, string | boolean>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const field of fields) {
    let raw = values[field.key];
    const empty = raw === undefined || raw === '';
    if (empty && field.defaultValue !== undefined) {
      const enumIndex = field.enumValues?.findIndex((entry) => Object.is(entry, field.defaultValue)) ?? -1;
      raw = enumIndex >= 0
        ? `enum:${enumIndex}`
        : field.kind === 'boolean'
          ? String(field.defaultValue)
          : field.kind === 'array' || field.kind === 'object' || field.kind === 'json'
            ? JSON.stringify(field.defaultValue)
            : String(field.defaultValue);
    }
    if ((raw === undefined || raw === '') && field.required) throw new Error(`${field.label} is required`);
    if (raw === undefined || raw === '') continue;
    let value: unknown;
    if (field.enumValues) {
      const match = typeof raw === 'string' ? raw.match(/^enum:(\d+)$/) : undefined;
      const selected = match ? field.enumValues[Number(match[1])] : undefined;
      if (selected === undefined && !(match && field.enumValues[Number(match[1])] === null)) throw new Error(`${field.label} must use one of the available values`);
      value = selected;
    } else if (field.kind === 'boolean') value = typeof raw === 'boolean' ? raw : raw === 'true';
    else if (field.kind === 'number' || field.kind === 'integer') {
      const numeric = Number(raw);
      if (!Number.isFinite(numeric) || (field.kind === 'integer' && !Number.isInteger(numeric))) throw new Error(`${field.label} must be ${field.kind}`);
      if (field.minimum !== undefined && numeric < field.minimum) throw new Error(`${field.label} must be at least ${field.minimum}`);
      if (field.maximum !== undefined && numeric > field.maximum) throw new Error(`${field.label} must be at most ${field.maximum}`);
      value = numeric;
    } else if (field.kind === 'array' || field.kind === 'object' || field.kind === 'json') {
      try { value = typeof raw === 'string' ? JSON.parse(raw) : raw; }
      catch { throw new Error(`${field.label} must contain valid JSON`); }
      if (field.kind === 'array' && !Array.isArray(value)) throw new Error(`${field.label} must be an array`);
      if (field.kind === 'object' && !objectValue(value)) throw new Error(`${field.label} must be an object`);
    } else if (field.format === 'date-time') {
      const date = new Date(String(raw));
      if (Number.isNaN(date.getTime())) throw new Error(`${field.label} must be a valid date-time`);
      value = date.toISOString();
    } else value = String(raw);
    if (field.path.length === 0) {
      const root = objectValue(value);
      if (!root) throw new Error(`${field.label} must be an object`);
      Object.assign(output, root);
    } else setPath(output, field.path, value);
  }
  return output;
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
