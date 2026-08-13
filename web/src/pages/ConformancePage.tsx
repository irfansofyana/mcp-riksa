import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { Button, Empty, Field, Input, JsonView, Notice, Section, Select, Status } from '../components.js';
import type { ConformanceReport, ConformanceReportSummary, ServerSummary } from '../types.js';

export function ConformancePage({ reports, servers, initialId, onRefresh }: {
  reports: ConformanceReportSummary[]; servers: ServerSummary[]; initialId?: string; onRefresh(): Promise<void>;
}) {
  const httpServers = servers.filter((server) => server.transport === 'http');
  const [serverId, setServerId] = useState(httpServers[0]?.id ?? '');
  const [mode, setMode] = useState<'suite' | 'scenario'>('suite');
  const [scenario, setScenario] = useState('server-initialize');
  const [timeoutMs, setTimeoutMs] = useState('120000');
  const [selectedId, setSelectedId] = useState(initialId ?? reports[0]?.id ?? '');
  const [selected, setSelected] = useState<ConformanceReport>();
  const [error, setError] = useState('');
  const running = reports.some((report) => report.status === 'running');
  const grouped = useMemo(() => Object.entries((selected?.checks ?? []).reduce<Record<string, ConformanceReport['checks']>>((groups, check) => {
    (groups[check.scenario] ??= []).push(check);
    return groups;
  }, {})), [selected]);

  useEffect(() => { if (initialId) setSelectedId(initialId); }, [initialId]);
  useEffect(() => {
    if (!selectedId) { setSelected(undefined); return; }
    let active = true;
    void api.conformanceReport(selectedId).then((value) => { if (active) setSelected(value); }).catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { active = false; };
  }, [selectedId, reports.find((report) => report.id === selectedId)?.status]);
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => void onRefresh(), 1200);
    return () => window.clearInterval(timer);
  }, [running, onRefresh]);

  const start = async () => {
    setError('');
    try {
      const value = await api.startConformance({
        serverId,
        selection: mode === 'suite' ? { kind: 'suite', suite: 'active' } : { kind: 'scenario', scenario: scenario.trim() },
        timeoutMs: Number(timeoutMs),
      });
      setSelectedId(value.id);
      await onRefresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  return <div className="page-grid conformance-page">
    <div className="workspace-stack">
      <Section title="Official runner" action={<Status value="HTTP only" />}>
        <p className="section-copy">Runs pinned <code>@modelcontextprotocol/conformance@0.1.10</code> against loopback Streamable HTTP endpoints. Stdio and authenticated endpoints are unsupported in this MVP.</p>
        <div className="form-grid compact">
          <Field label="Server"><Select value={serverId} onChange={(event) => setServerId(event.target.value)}>{httpServers.map((server) => <option key={server.id} value={server.id}>{server.name}</option>)}</Select></Field>
          <Field label="Coverage"><Select value={mode} onChange={(event) => setMode(event.target.value as 'suite' | 'scenario')}><option value="suite">Active suite</option><option value="scenario">Individual scenario</option></Select></Field>
          <Field label="Timeout (ms)"><Input type="number" min={5000} max={600000} value={timeoutMs} onChange={(event) => setTimeoutMs(event.target.value)} /></Field>
          {mode === 'scenario' ? <Field label="Scenario"><Input value={scenario} onChange={(event) => setScenario(event.target.value)} /></Field> : null}
        </div>
        <div className="button-row"><Button variant="primary" disabled={!serverId || (mode === 'scenario' && !scenario.trim())} onClick={() => void start()}>Run official checks</Button></div>
        {error ? <Notice error>{error}</Notice> : null}
        <p className="hint">Result means tested scenarios passed. It is not universal MCP certification. Dated requirements sets are unavailable in pinned runner release.</p>
      </Section>
      <Section title="History" action={<span className="count">{reports.length}</span>}>
        <div className="row-list">{reports.length === 0 ? <Empty>No conformance reports yet.</Empty> : reports.map((report) => <button key={report.id} className={`row-button ${report.id === selectedId ? 'selected' : ''}`} onClick={() => setSelectedId(report.id)}><span><b>{servers.find((server) => server.id === report.serverId)?.name ?? report.serverId}</b><small>{report.selection.kind === 'suite' ? 'active suite' : report.selection.scenario} · {new Date(report.startedAt).toLocaleString()}</small></span><Status value={report.status} /></button>)}</div>
      </Section>
    </div>

    <div className="workspace-stack">
      {!selected ? <Section title="Report"><Empty>Select historical report or start check run.</Empty></Section> : <>
        <Section title="Report" action={<Status value={selected.status} />}>
          <div className="metrics"><span>{selected.summary.passed} passed</span><span>{selected.summary.failed} failed</span><span>{selected.summary.warnings} warnings</span><span>{selected.summary.skipped} skipped</span><span>{selected.summary.harnessErrors} harness errors</span></div>
          <p>{selected.status === 'passed' ? 'All tested scenarios passed.' : 'Review scenario checks and harness diagnostics below.'}</p>
          <p className="hint">Runner {selected.runnerVersion} · {selected.endpoint}</p>
          {selected.status === 'running' ? <Button variant="danger" onClick={() => void api.cancelConformance(selected.id).then(onRefresh)}>Cancel</Button> : null}
          {selected.diagnostic ? <Notice error>{selected.diagnostic}</Notice> : null}
        </Section>
        {grouped.map(([scenarioName, checks]) => <Section key={scenarioName} title={scenarioName} action={<span className="count">{checks?.length ?? 0} checks</span>}>
          <div className="row-list">{checks?.map((check) => <details key={`${check.sequence}-${check.id}`} className="trace-card"><summary><span><b>{check.name}</b><small>{check.description}</small></span><Status value={check.status} /></summary><div className="trace-detail">{check.error ? <Notice error>{check.error}</Notice> : null}{check.specReferences.length ? <div className="scope-list">{check.specReferences.map((reference) => reference.url ? <a key={reference.id} className="inline-link" href={reference.url} target="_blank" rel="noreferrer">{reference.id} ↗</a> : <code key={reference.id}>{reference.id}</code>)}</div> : null}{check.details !== undefined ? <JsonView value={check.details} label="Sanitized details" /> : null}</div></details>)}</div>
        </Section>)}
        {selected.rawReport !== undefined ? <Section title="Raw sanitized report"><JsonView value={selected.rawReport} label="Official runner output" defaultOpen={false} /></Section> : null}
      </>}
    </div>
  </div>;
}
