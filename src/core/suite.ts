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
  z.strictObject({
    type: z.literal('tool'),
    tool: z.string().min(1),
    occurrence: z.number().int().positive().optional(),
    arguments: z.strictObject({ path: z.string().min(1).optional(), equals: jsonValueSchema }).optional(),
    result: z.strictObject({ path: z.string().min(1).optional(), equals: jsonValueSchema.optional(), exists: z.boolean().optional() })
      .refine((value) => value.equals !== undefined || value.exists !== undefined, 'tool result needs equals or exists')
      .optional(),
    success: z.boolean().optional(),
  }),
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

const v1AgentCaseSchema = z.strictObject({
  ...baseCase,
  kind: z.literal('agent'),
  provider: z.string().min(1),
  model: z.string().min(1),
  prompt: z.string().min(1),
  limits: limitsSchema.default({ maxTurns: 8, maxToolCalls: 16, timeoutMs: 60_000 }),
});

const turnSchema = z.strictObject({
  id: z.string().min(1),
  user: z.string().min(1),
  assertions: z.array(assertionSchema),
});

const iterationsSchema = z.strictObject({
  count: z.number().int().positive(),
  minPasses: z.number().int().positive(),
}).refine((value) => value.minPasses <= value.count, 'iterations.minPasses must not exceed iterations.count');

const v2AgentCaseSchema = z.strictObject({
  ...baseCase,
  kind: z.literal('agent'),
  provider: z.string().min(1),
  model: z.string().min(1),
  turns: z.array(turnSchema).min(1),
  iterations: iterationsSchema.default({ count: 1, minPasses: 1 }),
  limits: limitsSchema.default({ maxTurns: 8, maxToolCalls: 16, timeoutMs: 60_000 }),
}).superRefine((entry, context) => {
  const ids = entry.turns.map((turn) => turn.id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: 'custom', path: ['turns'], message: 'Agent turn IDs must be unique' });
  }
});

const v1SuiteSchema = z.strictObject({
  version: z.literal(1),
  name: z.string().min(1),
  description: z.string().optional(),
  cases: z.array(z.discriminatedUnion('kind', [directCaseSchema, v1AgentCaseSchema])).min(1),
});

const v2SuiteSchema = z.strictObject({
  version: z.literal(2),
  name: z.string().min(1),
  description: z.string().optional(),
  cases: z.array(z.discriminatedUnion('kind', [directCaseSchema, v2AgentCaseSchema])).min(1),
});

const suiteSchema = z.discriminatedUnion('version', [v1SuiteSchema, v2SuiteSchema]);

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
