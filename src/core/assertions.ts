import { isDeepStrictEqual } from 'node:util';
import type { Assertion, AssertionResult, Observation } from './types.js';

export function jsonPath(value: unknown, path: string): unknown {
  if (path === '$') return value;
  if (!path.startsWith('$')) return undefined;
  const tokens: Array<string | number> = [];
  const tokenPattern = /\.([A-Za-z_$][\w$-]*)|\[(\d+)\]|\[['"]([^'"]+)['"]\]/g;
  let match: RegExpExecArray | null;
  let consumed = 1;
  while ((match = tokenPattern.exec(path)) !== null) {
    if (match.index !== consumed) return undefined;
    const key = match[1] ?? match[3];
    tokens.push(key === undefined ? Number(match[2]) : key);
    consumed = tokenPattern.lastIndex;
  }
  if (consumed !== path.length) return undefined;

  let current: unknown = value;
  for (const token of tokens) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string | number, unknown>)[token];
  }
  return current;
}

function result(
  assertion: Assertion,
  passed: boolean,
  expected: unknown,
  actual: unknown,
  message: string,
): AssertionResult {
  return { assertion, passed, message, expected, actual };
}

function evaluate(assertion: Assertion, observation: Observation): AssertionResult {
  const names = observation.toolCalls.map((call) => call.name);
  switch (assertion.type) {
    case 'tool_called':
      return result(assertion, names.includes(assertion.tool), assertion.tool, names, `Expected ${assertion.tool} to be called`);
    case 'tool_not_called':
      return result(assertion, !names.includes(assertion.tool), assertion.tool, names, `Expected ${assertion.tool} not to be called`);
    case 'tool_count': {
      const actual = assertion.tool === undefined ? names.length : names.filter((name) => name === assertion.tool).length;
      return result(assertion, actual === assertion.count, assertion.count, actual, 'Tool call count');
    }
    case 'tool_order': {
      let cursor = 0;
      for (const name of names) if (name === assertion.tools[cursor]) cursor += 1;
      return result(assertion, cursor === assertion.tools.length, assertion.tools, names, 'Tool call order');
    }
    case 'args': {
      const call = observation.toolCalls.find((entry) => entry.name === assertion.tool);
      const actual = assertion.path === undefined ? call?.arguments : jsonPath(call?.arguments, assertion.path);
      return result(assertion, isDeepStrictEqual(actual, assertion.equals), assertion.equals, actual, 'Tool arguments');
    }
    case 'jsonpath': {
      const actual = jsonPath(observation.output, assertion.path);
      const expected = assertion.equals ?? assertion.exists;
      const passed = assertion.equals !== undefined
        ? isDeepStrictEqual(actual, assertion.equals)
        : (actual !== undefined) === assertion.exists;
      return result(assertion, passed, expected, actual, `JSONPath ${assertion.path}`);
    }
    case 'contains': {
      const target = assertion.path === undefined ? observation.output : jsonPath(observation.output, assertion.path);
      const actual = typeof target === 'string' ? target : JSON.stringify(target);
      return result(assertion, actual?.includes(assertion.value) ?? false, assertion.value, actual, 'Contains text');
    }
    case 'regex': {
      const target = assertion.path === undefined ? observation.output : jsonPath(observation.output, assertion.path);
      const actual = typeof target === 'string' ? target : JSON.stringify(target);
      let passed = false;
      try {
        passed = new RegExp(assertion.pattern, assertion.flags).test(actual ?? '');
      } catch {
        passed = false;
      }
      return result(assertion, passed, assertion.pattern, actual, 'Regular expression');
    }
    case 'duration':
      return result(assertion, observation.durationMs <= assertion.maxMs, assertion.maxMs, observation.durationMs, 'Maximum duration (ms)');
    case 'tokens':
      return result(assertion, observation.tokens.total <= assertion.max, assertion.max, observation.tokens.total, 'Maximum tokens');
    case 'cost':
      return result(assertion, observation.costUsd <= assertion.maxUsd, assertion.maxUsd, observation.costUsd, 'Maximum estimated cost (USD)');
  }
}

export function evaluateAssertions(assertions: Assertion[], observation: Observation): AssertionResult[] {
  return assertions.map((assertion) => evaluate(assertion, observation));
}
