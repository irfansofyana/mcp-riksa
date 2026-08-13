import { redact } from '../core/redaction.js';
import type { RunResult } from '../core/types.js';

function xml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function reportJunit(input: RunResult): string {
  const run = redact(input);
  const time = Math.max(0, Date.parse(run.completedAt) - Date.parse(run.startedAt)) / 1000;
  const cases = run.cases.map((entry) => {
    const failures = entry.assertions.filter((assertion) => !assertion.passed);
    const failure = entry.error ?? failures.map((assertion) => `${assertion.message}: expected ${JSON.stringify(assertion.expected)}, actual ${JSON.stringify(assertion.actual)}`).join('\n');
    return `  <testcase name="${xml(entry.id)}" classname="${xml(run.suite)}" time="${(entry.observation.durationMs / 1000).toFixed(3)}">${failure ? `\n    <failure message="${xml(entry.error ?? `${failures.length} assertion(s) failed`)}">${xml(failure)}</failure>\n  ` : ''}</testcase>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="${xml(run.suite)}" tests="${run.summary.total}" failures="${run.summary.failed}" errors="0" time="${time.toFixed(3)}">
${cases}
</testsuite>\n`;
}
