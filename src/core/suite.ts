import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { containsPotentialSecret } from './redaction.js';
import type { Suite } from './types.js';

const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const assertionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('tool_called'), tool: z.string().min(1) }),
  z.strictObject({ type: z.literal('tool_not_called'), tool: z.string().min(1) }),
  z.strictObject({ type: z.literal('tool_count'), tool: z.string().min(1).optional(), count: z.number().int().nonnegative() }),
  z.strictObject({ type: z.literal('tool_order'), tools: z.array(z.string().min(1)).min(1) }),
  z.strictObject({ type: z.literal('args'), tool: z.string().min(1), path: z.string().min(1).optional(), equals: jsonValueSchema }),
  z.strictObject({ type: z.literal('jsonpath'), path: z.string().min(1), equals: jsonValueSchema.optional(), exists: z.boolean().optional() })
    .refine((value) => value.equals !== undefined || value.exists !== undefined, 'jsonpath needs equals or exists'),
  z.strictObject({ type: z.literal('contains'), path: z.string().min(1).optional(), value: z.string() }),
  z.strictObject({ type: z.literal('regex'), path: z.string().min(1).optional(), pattern: z.string(), flags: z.string().regex(/^[dgimsuvy]*$/).optional() }),
  z.strictObject({ type: z.literal('duration'), maxMs: z.number().nonnegative() }),
  z.strictObject({ type: z.literal('tokens'), max: z.number().int().nonnegative() }),
  z.strictObject({ type: z.literal('cost'), maxUsd: z.number().nonnegative() }),
]);

const baseCase = {
  id: z.string().min(1),
  server: z.string().min(1),
  assertions: z.array(assertionSchema).default([]),
};

const directCaseSchema = z.strictObject({
  ...baseCase,
  kind: z.literal('direct'),
  call: z.strictObject({
    tool: z.string().min(1),
    arguments: z.record(z.string(), jsonValueSchema).default({}),
    dangerous: z.boolean().optional(),
  }),
});

const limitsSchema = z.strictObject({
  maxTurns: z.number().int().min(1).max(50).default(8),
  maxToolCalls: z.number().int().min(1).max(100).default(16),
  timeoutMs: z.number().int().min(1).max(300_000).default(60_000),
  maxCostUsd: z.number().nonnegative().max(1_000).optional(),
});

const agentCaseSchema = z.strictObject({
  ...baseCase,
  kind: z.literal('agent'),
  provider: z.string().min(1),
  model: z.string().min(1),
  prompt: z.string().min(1),
  limits: limitsSchema.default({ maxTurns: 8, maxToolCalls: 16, timeoutMs: 60_000 }),
});

const suiteSchema = z.strictObject({
  version: z.literal(1),
  name: z.string().min(1),
  description: z.string().optional(),
  cases: z.array(z.discriminatedUnion('kind', [directCaseSchema, agentCaseSchema])).min(1),
});

export function parseSuite(source: string): Suite {
  const input: unknown = parseYaml(source);
  if (containsPotentialSecret(input)) {
    throw new Error('Suite files cannot contain inline secrets; use environment references');
  }
  const suite = suiteSchema.parse(input) as Suite;
  const ids = suite.cases.map((entry) => entry.id);
  if (new Set(ids).size !== ids.length) throw new Error('Suite case IDs must be unique');
  return suite;
}

export { suiteSchema };
