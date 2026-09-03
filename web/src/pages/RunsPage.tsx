import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { Button, Empty, JsonView, Notice, Section, Status } from '../components.js';
import { canCancelRun, formatRunElapsed, runProgressView, shouldPollRun } from '../run-progress.js';
import type { CaseResult, EventRecord, Run } from '../types.js';

type UserTurnTrace = { id: string; user: string };
type IterationTrace = { label: string; turns: UserTurnTrace[] };

export function expectedToolNames(assertions: CaseResult['assertions']): string[] {
  return assertions.flatMap((entry) => (entry.assertion.type === 'tool_called' || entry.assertion.type === 'tool') && typeof entry.assertion.tool === 'string' ? [entry.assertion.tool] : []);
}

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

function aggregateMetrics(value: CaseResult) {
  const observations = value.iterations?.flatMap((iteration) => {
    const observation = record(iteration.observation);
    if (!observation) return [];
    const tokens = record(observation.tokens);
    return [{
      durationMs: typeof observation.durationMs === 'number' ? observation.durationMs : 0,
      toolCalls: Array.isArray(observation.toolCalls) ? observation.toolCalls.length : 0,
      tokens: typeof tokens?.total === 'number' ? tokens.total : 0,
      costUsd: typeof observation.costUsd === 'number' ? observation.costUsd : 0,
    }];
  }) ?? [];
  return (observations.length > 0 ? observations : [{ durationMs: value.observation.durationMs, toolCalls: value.observation.toolCalls.length, tokens: value.observation.tokens.total, costUsd: value.observation.costUsd }])
    .reduce((total, observation) => ({ durationMs: total.durationMs + observation.durationMs, toolCalls: total.toolCalls + observation.toolCalls, tokens: total.tokens + observation.tokens, costUsd: total.costUsd + observation.costUsd }), { durationMs: 0, toolCalls: 0, tokens: 0, costUsd: 0 });
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
  const expectedTools = expectedToolNames(value.assertions);
  const actualTools = value.observation.toolCalls.map((call) => call.name);
  const events: EventRecord[] = value.observation.events;
  const metrics = aggregateMetrics(value);
  const evaluation = evaluationTrace(value);
  return <div className="case-detail">
    <div className="metric-strip">
      <div><span>Result</span><Status value={value.status} /></div><div><span>Latency</span><b>{metrics.durationMs} ms</b></div><div><span>Tool calls</span><b>{metrics.toolCalls}</b></div><div><span>Tokens</span><b>{metrics.tokens}</b></div><div><span>Estimated cost</span><b>${metrics.costUsd.toFixed(6)}</b></div>
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

function RunProgressPanel({ run, now }: { run: Run; now: number }) {
  const progress = runProgressView(run, now);
  const indeterminate = progress.total === 0;
  return <section className="run-progress" aria-labelledby="run-progress-title">
    <header><div><span className="execution-pulse" aria-hidden="true" /><b id="run-progress-title">Live execution</b></div><strong>{indeterminate ? 'Starting' : `${progress.percent}%`}</strong></header>
    <div className={`run-progress-track ${indeterminate ? 'indeterminate' : ''}`} role="progressbar" aria-label="Suite run progress" aria-valuemin={0} aria-valuemax={Math.max(1, progress.total)} aria-valuenow={progress.completed} aria-valuetext={indeterminate ? progress.activity : `${progress.completed} of ${progress.total} cases completed`}>
      <i style={{ width: indeterminate ? '35%' : `${progress.percent}%` }} />
    </div>
    <div className="run-progress-activity"><b aria-live="polite">{progress.activity}</b><span>Updates automatically · {formatRunElapsed(progress.elapsedMs)} elapsed</span></div>
    <div className="run-progress-metrics"><div><span>Completed</span><b>{progress.completed}/{progress.total || '—'}</b></div><div><span>Passed</span><b>{progress.passed}</b></div><div><span>Failed</span><b>{progress.failed}</b></div><div><span>Remaining</span><b>{progress.total ? progress.remaining : '—'}</b></div></div>
  </section>;
}

export function RunsPage({ runs, initialId, onRefresh }: { runs: Run[]; initialId?: string; onRefresh(): Promise<void> }) {
  const [selected, setSelected] = useState(initialId ?? runs[0]?.id ?? '');
  const [detail, setDetail] = useState<Run>();
  const [caseId, setCaseId] = useState('');
  const [error, setError] = useState('');
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [cancellingId, setCancellingId] = useState<string>();
  const [now, setNow] = useState(() => Date.now());
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  useEffect(() => {
    if (!selected) { setDetail(undefined); return; }
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setDetail(undefined);
    setCaseId('');
    setError('');
    setLoadingDetail(true);
    const load = async () => {
      try {
        const value = await api.run(selected);
        if (!active) return;
        setDetail(value);
        setCaseId((current) => current || value.cases[0]?.id || '');
        setError('');
        setLoadingDetail(false);
        if (shouldPollRun(value)) timer = setTimeout(() => void load(), 750);
        else void onRefresh();
      } catch (reason) {
        if (!active) return;
        setError(reason instanceof Error ? reason.message : String(reason));
        setLoadingDetail(false);
      }
    };
    void load();
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [selected]);

  useEffect(() => {
    if (!shouldPollRun(detail)) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [detail?.status]);

  useEffect(() => { if (initialId) setSelected(initialId); }, [initialId]);
  const selectedCase = useMemo(() => detail?.cases.find((entry) => entry.id === caseId) ?? detail?.cases[0], [detail, caseId]);

  const refresh = async () => {
    const requestedId = selected;
    if (!requestedId) return;
    try {
      await onRefresh();
      const value = await api.run(requestedId);
      if (selectedRef.current !== requestedId) return;
      setDetail(value);
      setError('');
    } catch (reason) {
      if (selectedRef.current === requestedId) setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const cancel = async () => {
    if (!canCancelRun(detail, selectedRef.current)) return;
    const requestedId = detail.id;
    setCancellingId(requestedId);
    try {
      await api.cancelRun(requestedId);
      const value = await api.run(requestedId);
      if (selectedRef.current !== requestedId) return;
      setDetail(value);
      setError('');
    } catch (reason) {
      if (selectedRef.current === requestedId) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setCancellingId((current) => current === requestedId ? undefined : current);
    }
  };

  return <div className="runs-layout">
    <Section title="Runs" className="runs-rail" action={<Button onClick={() => void refresh()}>Refresh</Button>}>
      <div className="row-list">{runs.length === 0 ? <Empty>Suite runs will appear here.</Empty> : runs.map((run) => { const progress = run.progress; return <button key={run.id} data-run-id={run.id} className={`row-button ${selected === run.id ? 'selected' : ''}`} onClick={() => { if (run.id === selected) return; setSelected(run.id); setDetail(undefined); setCaseId(''); }}><span><b>{run.suite}</b><small>{progress ? `${progress.completedCases}/${progress.totalCases} cases · live` : `${run.id.slice(0, 10)} · ${new Date(run.startedAt).toLocaleString()}`}</small></span><Status value={run.status} /></button>; })}</div>
    </Section>
    <main className="run-workspace">
      {!detail ? <Section title="Run detail"><Empty>{loadingDetail ? 'Loading run progress…' : 'Select a run to inspect its full trace.'}</Empty>{error ? <Notice error>{error}</Notice> : null}</Section> : <>
        <header className="run-heading"><div><h1>{detail.suite} <span>/ {detail.id.slice(0, 12)}</span></h1><p>{new Date(detail.startedAt).toLocaleString()} · {detail.progress?.totalCases ?? detail.summary.total} cases</p></div><div className="button-row"><Status value={detail.status} />{canCancelRun(detail, selected) ? <Button variant="danger" disabled={cancellingId === detail.id} onClick={() => void cancel()}>{cancellingId === detail.id ? 'Cancelling…' : 'Cancel'}</Button> : null}</div></header>
        {detail.status === 'running' ? <RunProgressPanel run={detail} now={now} /> : null}
        {detail.cases.length > 0 ? <div className="case-tabs">{detail.cases.map((entry) => <button key={entry.id} className={selectedCase?.id === entry.id ? 'selected' : ''} onClick={() => setCaseId(entry.id)}>{entry.id}<Status value={entry.status} /></button>)}</div> : null}
        {selectedCase ? <CaseDetail value={selectedCase} /> : detail.status === 'running' ? <Section title="Case evidence"><Empty>Results and traces appear when execution finishes.</Empty></Section> : <Section title="Summary"><div className="metric-strip"><div><span>Pass rate</span><b>{Math.round(detail.summary.passRate * 100)}%</b></div><div><span>Passed</span><b>{detail.summary.passed}</b></div><div><span>Failed</span><b>{detail.summary.failed}</b></div></div></Section>}
        {detail.status === 'running' ? null : <JsonView value={detail.events} label="Sanitized raw run events" />}
        {error ? <Notice error>{error}</Notice> : null}
      </>}
    </main>
  </div>;
}
