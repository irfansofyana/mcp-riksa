import { redact } from '../core/redaction.js';
import type { RunResult } from '../core/types.js';

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function aggregateMetrics(entry: RunResult['cases'][number]) {
  return (entry.iterations?.map((iteration) => iteration.observation) ?? [entry.observation]).reduce((total, observation) => ({
    durationMs: total.durationMs + observation.durationMs,
    toolCalls: total.toolCalls + observation.toolCalls.length,
    tokens: total.tokens + observation.tokens.total,
    costUsd: total.costUsd + observation.costUsd,
  }), { durationMs: 0, toolCalls: 0, tokens: 0, costUsd: 0 });
}

export function reportHtml(input: RunResult): string {
  const run = redact(input);
  const caseRows = run.cases.map((entry) => {
    const metrics = aggregateMetrics(entry);
    return `
    <section class="case ${entry.status}">
      <header><h2>${escapeHtml(entry.id)}</h2><strong>${escapeHtml(entry.status.toUpperCase())}</strong></header>
      <dl><dt>Duration</dt><dd>${metrics.durationMs} ms</dd><dt>Tool calls</dt><dd>${metrics.toolCalls}</dd><dt>Tokens</dt><dd>${metrics.tokens}</dd><dt>Cost</dt><dd>$${metrics.costUsd.toFixed(6)}</dd></dl>
      ${entry.evaluation ? `<p><b>Iterations</b> ${entry.evaluation.passed}/${entry.evaluation.count} passed · threshold ${entry.evaluation.minPasses} · ${Math.round(entry.evaluation.passRate * 100)}%</p><ol>${entry.iterations?.map((iteration) => `<li class="${iteration.status === 'passed' ? 'pass' : 'fail'}">Iteration ${iteration.index}: ${iteration.status.toUpperCase()}</li>`).join('') ?? ''}</ol>` : ''}
      <h3>Assertions</h3>
      <ul>${entry.assertions.map((assertion) => `<li class="${assertion.passed ? 'pass' : 'fail'}"><b>${escapeHtml(assertion.passed ? 'PASS' : 'FAIL')}</b> ${escapeHtml(assertion.message)} <code>${escapeHtml(JSON.stringify({ expected: assertion.expected, actual: assertion.actual }))}</code></li>`).join('')}</ul>
      ${entry.error ? `<p class="error">${escapeHtml(entry.error)}</p>` : ''}
      <details><summary>Sanitized result</summary><pre>${escapeHtml(JSON.stringify(entry.observation, null, 2))}</pre></details>
    </section>`;
  }).join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(run.suite)} — MCP Riksa</title>
<style>
:root{color-scheme:dark;--bg:#11110f;--panel:#1b1814;--text:#eee2c8;--muted:#a99a84;--line:#4b3825;--accent:#d68735;--pass:#67a36b;--fail:#b94f43}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 ui-sans-serif,system-ui,sans-serif}main{max-width:1100px;margin:auto;padding:32px}h1,h2,h3{margin:0 0 12px;font-weight:600}header{display:flex;justify-content:space-between;gap:24px;align-items:center}.summary{display:grid;grid-template-columns:repeat(4,1fr);border-block:1px solid var(--line);margin:24px 0}.summary div{padding:14px;border-right:1px solid var(--line)}.summary b,dt{color:var(--muted);font:11px ui-monospace,monospace;text-transform:uppercase;letter-spacing:.08em}.case{padding:20px 0;border-bottom:1px solid var(--line)}.case strong,.pass{color:var(--pass)}.case.failed strong,.fail,.error{color:var(--fail)}dl{display:flex;gap:24px;margin:14px 0}dd{margin:0}ul{padding:0;list-style:none}li{padding:7px 0}code,pre{font:12px/1.5 ui-monospace,monospace}pre{overflow:auto;padding:16px;background:var(--panel);border-left:2px solid var(--accent)}@media(max-width:640px){main{padding:18px}.summary{grid-template-columns:1fr 1fr}dl{display:grid;grid-template-columns:auto 1fr}}
</style></head><body><main>
<header><div><h1>MCP Riksa</h1><p>${escapeHtml(run.suite)} · ${escapeHtml(run.id)}</p></div><strong>${escapeHtml(run.status.toUpperCase())}</strong></header>
<section class="summary"><div><b>Cases</b><p>${run.summary.total}</p></div><div><b>Passed</b><p>${run.summary.passed}</p></div><div><b>Failed</b><p>${run.summary.failed}</p></div><div><b>Pass rate</b><p>${Math.round(run.summary.passRate * 100)}%</p></div></section>
${caseRows}
</main></body></html>`;
}
