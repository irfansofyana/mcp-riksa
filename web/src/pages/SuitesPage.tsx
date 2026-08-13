import { useState } from 'react';
import { api } from '../api.js';
import { Button, Empty, Field, Notice, Section, Textarea } from '../components.js';

const starter = `version: 1
name: direct-regression
cases:
  - id: adds
    kind: direct
    server: sample
    call:
      tool: add
      arguments: { a: 2, b: 3 }
    assertions:
      - type: jsonpath
        path: $.sum
        equals: 5
`;

export function SuitesPage({ suites, onRefresh, onRunStarted }: { suites: string[]; onRefresh(): Promise<void>; onRunStarted(id: string): void }) {
  const [selected, setSelected] = useState(suites[0] ?? '');
  const [source, setSource] = useState(starter);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const act = async (operation: () => Promise<void>) => {
    setMessage(''); setError('');
    try { await operation(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  return <div className="page-grid suites-page">
    <Section title="Suites" className="rail-section" action={<span className="count">{suites.length}</span>}>
      <div className="row-list">{suites.length === 0 ? <Empty>Save a portable YAML suite to run it locally or in CI.</Empty> : suites.map((suite) => <button key={suite} className={`row-button ${selected === suite ? 'selected' : ''}`} onClick={() => setSelected(suite)}><span><b>{suite}</b><small>version 1 YAML</small></span></button>)}</div>
      <Button variant="primary" disabled={!selected} data-testid="run-suite" onClick={() => void act(async () => { const run = await api.runSuite(selected); onRunStarted(run.id); setMessage(`Run ${run.id.slice(0, 8)} started.`); })}>Run selected suite</Button>
    </Section>
    <div className="workspace-stack">
      <Section title="Portable YAML editor" action={<span className="hint">Strict schema · inline secrets rejected</span>}>
        <Field label="Suite source"><Textarea className="code-editor" rows={24} value={source} onChange={(event) => setSource(event.target.value)} spellCheck={false} data-testid="suite-source" /></Field>
        <div className="button-row"><Button variant="primary" data-testid="save-suite" onClick={() => void act(async () => { const saved = await api.saveSuite(source); setSelected(saved.name); await onRefresh(); setMessage(`Saved ${saved.name} with ${saved.cases} case(s).`); })}>Save suite</Button></div>
        {message ? <Notice>{message}</Notice> : null}{error ? <Notice error>{error}</Notice> : null}
      </Section>
      <Section title="Portable by design">
        <div className="definition-list"><div><b>Direct cases</b><span>Invoke one MCP tool with explicit JSON arguments.</span></div><div><b>Agent cases</b><span>Reference provider and model aliases; credentials remain environment-only.</span></div><div><b>Assertions</b><span>Tools, arguments, JSONPath, content, duration, tokens, and cost.</span></div></div>
      </Section>
    </div>
  </div>;
}
