import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { Button, Empty, JsonView, Notice, Section, Status } from '../components.js';
import type { CaseResult, EventRecord, Run } from '../types.js';

type UserTurnTrace = { id: string; user: string };
type IterationTrace = { label: string; turns: UserTurnTrace[] };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function userTurns(value: unknown): UserTurnTrace[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw, index) => {
    const turn = record(raw);
    if (!turn || typeof turn.user !== 'string') return [];
    return [{ id: typeof turn.id === 'string' ? turn.id : `turn-${index + 1}`, user: turn.user }];
  });
}

function evaluationTrace(value: CaseResult): { threshold?: string; iterations: IterationTrace[] } {
  const evaluation = record(value.evaluation);
  const configured = record(evaluation?.iterations);
  const count = typeof configured?.count === 'number' ? configured.count : typeof evaluation?.count === 'number' ? evaluation.count : undefined;
  const minPasses = typeof configured?.minPasses === 'number' ? configured.minPasses : typeof evaluation?.minPasses === 'number' ? evaluation.minPasses : undefined;
  const threshold = count !== undefined && minPasses !== undefined ? `${minPasses} of ${count} iteration passes required` : undefined;
  const source = Array.isArray(value.iterations) ? value.iterations : Array.isArray(evaluation?.iterations) ? evaluation.iterations : [];
  const iterations = source.flatMap((raw, index) => {
    const iteration = record(raw);
    if (!iteration) return [];
    const observation = record(iteration.observation);
    const turns = userTurns(iteration.turns).length ? userTurns(iteration.turns) : userTurns(observation?.turns);
    const state = typeof iteration.status === 'string' ? iteration.status : typeof iteration.passed === 'boolean' ? iteration.passed ? 'passed' : 'failed' : 'recorded';
    return [{ label: `Iteration ${index + 1} · ${state}`, turns }];
  });
  if (iterations.length === 0) {
    const turns = userTurns(value.observation.turns);
    if (turns.length > 0) iterations.push({ label: 'User-turn trace', turns });
  }
  return { threshold, iterations };
}

function CaseDetail({ value }: { value: CaseResult }) {
  const expectedTools = value.assertions.flatMap((entry) => entry.assertion.type === 'tool_called' && typeof entry.assertion.tool === 'string' ? [entry.assertion.tool] : []);
  const actualTools = value.observation.toolCalls.map((call) => call.name);
  const events: EventRecord[] = value.observation.events;
  const evaluation = evaluationTrace(value);
  return <div className="case-detail">
    <div className="metric-strip">
      <div><span>Result</span><Status value={value.status} /></div><div><span>Latency</span><b>{value.observation.durationMs} ms</b></div><div><span>Tool calls</span><b>{actualTools.length}</b></div><div><span>Tokens</span><b>{value.observation.tokens.total}</b></div><div><span>Estimated cost</span><b>${value.observation.costUsd.toFixed(6)}</b></div>
    </div>
    <div className="expected-actual"><div><span>Expected tools</span><code>{expectedTools.join(' → ') || 'none specified'}</code></div><div><span>Actual tools</span><code>{actualTools.join(' → ') || 'none'}</code></div></div>
    {evaluation.threshold || evaluation.iterations.length > 0 ? <Section title="Iteration & user-turn trace" action={evaluation.threshold ? <span className="hint">{evaluation.threshold}</span> : undefined}>{evaluation.iterations.length === 0 ? <Empty>No iteration observations were recorded.</Empty> : <div className="assertion-list">{evaluation.iterations.map((iteration) => <div className="expected-actual" key={iteration.label}><div><span>{iteration.label}</span><code>{iteration.turns.length ? iteration.turns.map((turn) => `${turn.id}: ${turn.user}`).join('\n') : 'No user turns recorded'}</code></div></div>)}</div>}</Section> : null}
    <Section title="Model turns & MCP timeline" action={<span className="hint">latency waterfall</span>}>
      {events.length === 0 && value.observation.toolCalls.length === 0 ? <Empty>No normalized events were recorded.</Empty> : <div className="event-trace">
        {(events.length > 0 ? events : value.observation.toolCalls.map((call, index) => ({ id: `${index}`, caseId: value.id, type: 'tool_call', timestamp: '', durationMs: call.durationMs, data: call, sanitized: true as const }))).map((entry, index) => <article className="trace-event" key={entry.id}>
          <div className="trace-marker">{index + 1}</div><div><header><b>{entry.type.replaceAll('_', ' ')}</b><time>{entry.durationMs === undefined ? '' : `${entry.durationMs} ms`}</time></header><pre>{JSON.stringify(entry.data, null, 2)}</pre><div className="latency-bar"><i style={{ width: `${Math.min(100, ((entry.durationMs ?? 0) / Math.max(1, value.observation.durationMs)) * 100)}%` }} /></div></div>
        </article>)}
      </div>}
    </Section>
    <Section title="MCP arguments & results">
      {value.observation.toolCalls.length === 0 ? <Empty>No tools were called.</Empty> : value.observation.toolCalls.map((call, index) => <details className="call-detail" key={`${call.name}-${index}`} open><summary><b>{call.name}</b><span>{call.durationMs ?? 0} ms</span></summary><div className="argument-result"><JsonView value={call.arguments} label="Arguments (sanitized)" /><JsonView value={call.result} label="Result (sanitized)" /></div></details>)}
    </Section>
    <Section title="Assertion results">
      {value.assertions.length === 0 ? <Empty>No assertions were configured.</Empty> : <div className="assertion-list">{value.assertions.map((entry, index) => <div key={index} className={entry.passed ? 'assert-pass' : 'assert-fail'}><Status value={entry.passed ? 'pass' : 'fail'} /><span><b>{entry.message}</b><small>expected {JSON.stringify(entry.expected)} · actual {JSON.stringify(entry.actual)}</small></span></div>)}</div>}
    </Section>
    <JsonView value={{ observation: value.observation, assertions: value.assertions, ...(value.evaluation ? { evaluation: value.evaluation } : {}), ...(value.iterations ? { iterations: value.iterations } : {}) }} label="Sanitized raw case JSON" />
  </div>;
}

export function RunsPage({ runs, initialId, onRefresh }: { runs: Run[]; initialId?: string; onRefresh(): Promise<void> }) {
  const [selected, setSelected] = useState(initialId ?? runs[0]?.id ?? '');
  const [detail, setDetail] = useState<Run>();
  const [caseId, setCaseId] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!selected) return;
    let active = true;
    void api.run(selected).then((value) => { if (active) { setDetail(value); setCaseId((current) => current || value.cases[0]?.id || ''); } }).catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { active = false; };
  }, [selected]);

  useEffect(() => { if (initialId) setSelected(initialId); }, [initialId]);
  const selectedCase = useMemo(() => detail?.cases.find((entry) => entry.id === caseId) ?? detail?.cases[0], [detail, caseId]);

  const refresh = async () => {
    if (!selected) return;
    try {
      await onRefresh();
      setDetail(await api.run(selected));
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return <div className="runs-layout">
    <Section title="Runs" className="runs-rail" action={<Button onClick={() => void refresh()}>Refresh</Button>}>
      <div className="row-list">{runs.length === 0 ? <Empty>Suite runs will appear here.</Empty> : runs.map((run) => <button key={run.id} className={`row-button ${selected === run.id ? 'selected' : ''}`} onClick={() => { setSelected(run.id); setCaseId(''); }}><span><b>{run.suite}</b><small>{run.id.slice(0, 10)} · {new Date(run.startedAt).toLocaleString()}</small></span><Status value={run.status} /></button>)}</div>
    </Section>
    <main className="run-workspace">
      {!detail ? <Section title="Run detail"><Empty>Select a run to inspect its full trace.</Empty>{error ? <Notice error>{error}</Notice> : null}</Section> : <>
        <header className="run-heading"><div><h1>{detail.suite} <span>/ {detail.id.slice(0, 12)}</span></h1><p>{new Date(detail.startedAt).toLocaleString()} · {detail.cases.length} cases</p></div><div className="button-row"><Status value={detail.status} />{detail.status === 'running' ? <Button variant="danger" onClick={() => void api.cancelRun(detail.id)}>Cancel</Button> : null}</div></header>
        <div className="case-tabs">{detail.cases.map((entry) => <button key={entry.id} className={selectedCase?.id === entry.id ? 'selected' : ''} onClick={() => setCaseId(entry.id)}>{entry.id}<Status value={entry.status} /></button>)}</div>
        {selectedCase ? <CaseDetail value={selectedCase} /> : <Section title="Summary"><div className="metric-strip"><div><span>Pass rate</span><b>{Math.round(detail.summary.passRate * 100)}%</b></div><div><span>Passed</span><b>{detail.summary.passed}</b></div><div><span>Failed</span><b>{detail.summary.failed}</b></div></div></Section>}
        <JsonView value={detail.events} label="Sanitized raw run events" />
      </>}
    </main>
  </div>;
}
