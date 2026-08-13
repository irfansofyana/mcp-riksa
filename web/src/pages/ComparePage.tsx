import { useState } from 'react';
import { api } from '../api.js';
import { Button, Empty, Notice, Section, Select } from '../components.js';
import { signedDelta } from '../model.js';
import type { Run } from '../types.js';

const rows = [
  ['Pass rate', 'passRateDelta', '%'], ['Latency', 'latencyMsDelta', ' ms'], ['Tool calls', 'toolCallDelta', ''], ['Tokens', 'tokenDelta', ''], ['Cost', 'costUsdDelta', ' USD'],
] as const;

export function ComparePage({ runs }: { runs: Run[] }) {
  const [runA, setRunA] = useState(runs[1]?.id ?? runs[0]?.id ?? '');
  const [runB, setRunB] = useState(runs[0]?.id ?? '');
  const [comparison, setComparison] = useState<Record<string, number | string>>();
  const [error, setError] = useState('');
  return <div className="workspace-stack">
    <Section title="Compare two runs" action={<span className="hint">Run B minus run A</span>}>
      <div className="compare-selectors"><label><span>Baseline · Run A</span><Select value={runA} onChange={(event) => setRunA(event.target.value)} data-testid="compare-a"><option value="">Choose run</option>{runs.map((run) => <option key={run.id} value={run.id}>{run.suite} · {run.id.slice(0, 8)}</option>)}</Select></label><div className="compare-arrow">→</div><label><span>Candidate · Run B</span><Select value={runB} onChange={(event) => setRunB(event.target.value)} data-testid="compare-b"><option value="">Choose run</option>{runs.map((run) => <option key={run.id} value={run.id}>{run.suite} · {run.id.slice(0, 8)}</option>)}</Select></label></div>
      <Button variant="primary" disabled={!runA || !runB || runA === runB} data-testid="compare-runs" onClick={() => void (async () => { try { setError(''); setComparison(await api.compare(runA, runB)); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } })()}>Compare runs</Button>
      {error ? <Notice error>{error}</Notice> : null}
    </Section>
    <Section title="Regression ledger">
      {!comparison ? <Empty>Select two different runs to inspect pass-rate, latency, call, token, and cost movement.</Empty> : <div className="comparison-table"><div className="comparison-head"><span>Measure</span><span>Delta</span><span>Reading</span></div>{rows.map(([label, key, unit]) => { const value = Number(comparison[key] ?? 0); const favorable = key === 'passRateDelta' ? value >= 0 : value <= 0; return <div key={key}><b>{label}</b><code>{signedDelta(value, unit)}</code><span className={favorable ? 'positive' : 'negative'}>{value === 0 ? 'unchanged' : favorable ? 'favorable' : 'regression'}</span></div>; })}</div>}
    </Section>
  </div>;
}
