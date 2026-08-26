import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { Button, Empty, Field, Input, Notice, Section, Select, Textarea } from '../components.js';
import {
  createAgentSuiteCase,
  createAgentSuiteCaseV2,
  createDirectSuiteCase,
  createSuiteAssertion,
  createSuiteDraft,
  duplicateSuiteCase,
  duplicateSuiteDraft,
  parseSuiteDraft,
  serializeSuiteDraft,
} from '../model.js';
import type {
  DirectSuiteCase,
  JsonValue,
  ProviderSummary,
  ServerSummary,
  SuiteAssertion,
  SuiteCase,
  AgentSuiteCaseV2,
  AgentSuiteTurn,
  SuiteDraft,
  Tool,
} from '../types.js';

const assertionTypes: Array<{ value: SuiteAssertion['type']; label: string }> = [
  { value: 'tool_called', label: 'Tool called' },
  { value: 'tool_not_called', label: 'Tool not called' },
  { value: 'tool_count', label: 'Tool call count' },
  { value: 'tool_order', label: 'Tool order' },
  { value: 'args', label: 'Tool arguments' },
  { value: 'tool', label: 'Tool invocation' },
  { value: 'jsonpath', label: 'JSONPath result' },
  { value: 'contains', label: 'Output contains' },
  { value: 'regex', label: 'Output regex' },
  { value: 'duration', label: 'Duration budget' },
  { value: 'tokens', label: 'Token budget' },
  { value: 'cost', label: 'Cost budget' },
];
function parseJson(value: string): JsonValue {
  return JSON.parse(value) as JsonValue;
}

function nextCaseId(kind: SuiteCase['kind'], cases: SuiteCase[]): string {
  const base = `${kind}-case`;
  const taken = new Set(cases.map((entry) => entry.id));
  if (!taken.has(base)) return base;
  let sequence = 2;
  while (taken.has(`${base}-${sequence}`)) sequence += 1;
  return `${base}-${sequence}`;
}

function ToolInput({ value, tools, onChange, id }: { value: string; tools: Tool[]; onChange(value: string): void; id: string }) {
  return <><Input list={id} value={value} onChange={(event) => onChange(event.target.value)} placeholder="tool_name" /><datalist id={id}>{tools.map((tool) => <option key={tool.name} value={tool.name}>{tool.description}</option>)}</datalist></>;
}

function isV2AgentCase(value: SuiteCase): value is AgentSuiteCaseV2 {
  return value.kind === 'agent' && 'turns' in value;
}

function nextTurnId(turns: AgentSuiteTurn[]): string {
  const taken = new Set(turns.map((turn) => turn.id));
  let sequence = 1;
  while (taken.has(`turn-${sequence}`)) sequence += 1;
  return `turn-${sequence}`;
}

function AssertionEditor({ assertion, index, tools, types, onChange, onRemove, onError, scope }: {
  assertion: SuiteAssertion;
  index: number;
  tools: Tool[];
  types: Array<{ value: SuiteAssertion['type']; label: string }>;
  onChange(value: SuiteAssertion): void;
  onRemove(): void;
  onError(message: string): void;
  scope?: string;
}) {
  const toolInput = (value: string, change: (value: string) => void) => <ToolInput id={`assertion-tool-${scope ?? 'case'}-${index}-${assertion.type}`} value={value} tools={tools} onChange={change} />;
  const jsonBlur = (value: string, change: (value: JsonValue) => void) => {
    try { change(parseJson(value)); onError(''); } catch { onError('Expected value must be valid JSON.'); }
  };

  return <div className="assertion-card">
    <header><span><b>{index + 1}</b> Check</span><Button variant="danger" onClick={onRemove}>Remove</Button></header>
    <div className="assertion-fields">
      <Field label="Assertion"><Select value={assertion.type} onChange={(event) => onChange(createSuiteAssertion(event.target.value as SuiteAssertion['type']))}>{types.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}</Select></Field>
      {assertion.type === 'tool_called' || assertion.type === 'tool_not_called' ? <Field label="Tool">{toolInput(assertion.tool, (tool) => onChange({ ...assertion, tool }))}</Field> : null}
      {assertion.type === 'tool_count' ? <><Field label="Tool (optional)">{toolInput(assertion.tool ?? '', (tool) => onChange({ ...assertion, ...(tool ? { tool } : { tool: undefined }) }))}</Field><Field label="Expected count"><Input type="number" min="0" value={assertion.count} onChange={(event) => onChange({ ...assertion, count: Number(event.target.value) })} /></Field></> : null}
      {assertion.type === 'tool_order' ? <Field label="Tools in order" hint="Comma-separated tool names"><Input value={assertion.tools.join(', ')} onChange={(event) => onChange({ ...assertion, tools: event.target.value.split(',').map((entry) => entry.trim()).filter(Boolean) })} /></Field> : null}
      {assertion.type === 'args' ? <><Field label="Tool">{toolInput(assertion.tool, (tool) => onChange({ ...assertion, tool }))}</Field><Field label="Argument path (optional)"><Input value={assertion.path ?? ''} placeholder="$.customer.id" onChange={(event) => onChange({ ...assertion, ...(event.target.value ? { path: event.target.value } : { path: undefined }) })} /></Field><Field label="Expected JSON"><Input defaultValue={JSON.stringify(assertion.equals)} onBlur={(event) => jsonBlur(event.target.value, (equals) => onChange({ ...assertion, equals }))} /></Field></> : null}
      {assertion.type === 'jsonpath' ? <><Field label="JSONPath"><Input value={assertion.path} onChange={(event) => onChange({ ...assertion, path: event.target.value })} /></Field><Field label="Check"><Select value={assertion.equals === undefined ? 'exists' : 'equals'} onChange={(event) => onChange(event.target.value === 'exists' ? { type: 'jsonpath', path: assertion.path, exists: true } : { type: 'jsonpath', path: assertion.path, equals: null })}><option value="exists">Path exists</option><option value="equals">Equals value</option></Select></Field>{assertion.equals !== undefined ? <Field label="Expected JSON"><Input defaultValue={JSON.stringify(assertion.equals)} onBlur={(event) => jsonBlur(event.target.value, (equals) => onChange({ type: 'jsonpath', path: assertion.path, equals }))} /></Field> : null}</> : null}
      {assertion.type === 'contains' ? <><Field label="Output path (optional)"><Input value={assertion.path ?? ''} placeholder="$.content" onChange={(event) => onChange({ ...assertion, ...(event.target.value ? { path: event.target.value } : { path: undefined }) })} /></Field><Field label="Expected text"><Input value={assertion.value} onChange={(event) => onChange({ ...assertion, value: event.target.value })} /></Field></> : null}
      {assertion.type === 'regex' ? <><Field label="Output path (optional)"><Input value={assertion.path ?? ''} placeholder="$.content" onChange={(event) => onChange({ ...assertion, ...(event.target.value ? { path: event.target.value } : { path: undefined }) })} /></Field><Field label="Pattern"><Input value={assertion.pattern} onChange={(event) => onChange({ ...assertion, pattern: event.target.value })} /></Field><Field label="Flags"><Input value={assertion.flags ?? ''} placeholder="i" onChange={(event) => onChange({ ...assertion, ...(event.target.value ? { flags: event.target.value } : { flags: undefined }) })} /></Field></> : null}
      {assertion.type === 'duration' ? <Field label="Maximum milliseconds"><Input type="number" min="0" value={assertion.maxMs} onChange={(event) => onChange({ ...assertion, maxMs: Number(event.target.value) })} /></Field> : null}
      {assertion.type === 'tokens' ? <Field label="Maximum tokens"><Input type="number" min="0" value={assertion.max} onChange={(event) => onChange({ ...assertion, max: Number(event.target.value) })} /></Field> : null}
      {assertion.type === 'cost' ? <Field label="Maximum USD"><Input type="number" min="0" step="0.001" value={assertion.maxUsd} onChange={(event) => onChange({ ...assertion, maxUsd: Number(event.target.value) })} /></Field> : null}
      {assertion.type === 'tool' ? <><Field label="Tool">{toolInput(assertion.tool, (tool) => onChange({ ...assertion, tool }))}</Field><Field label="Occurrence" hint="Optional, 1-based"><Input type="number" min="1" value={assertion.occurrence ?? ''} onChange={(event) => onChange({ ...assertion, ...(event.target.value ? { occurrence: Number(event.target.value) } : { occurrence: undefined }) })} /></Field><Field label="Arguments"><Select value={assertion.arguments ? 'equals' : 'none'} onChange={(event) => onChange(event.target.value === 'equals' ? { ...assertion, arguments: assertion.arguments ?? { equals: null } } : { ...assertion, arguments: undefined })}><option value="none">Do not check</option><option value="equals">Check JSON value</option></Select></Field>{assertion.arguments ? <><Field label="Argument path (optional)"><Input value={assertion.arguments.path ?? ''} placeholder="$.customer.id" onChange={(event) => onChange({ ...assertion, arguments: { ...assertion.arguments!, ...(event.target.value ? { path: event.target.value } : { path: undefined }) } })} /></Field><Field label="Expected arguments JSON"><Input defaultValue={JSON.stringify(assertion.arguments.equals)} onBlur={(event) => jsonBlur(event.target.value, (equals) => onChange({ ...assertion, arguments: { ...assertion.arguments!, equals } }))} /></Field></> : null}<Field label="Result"><Select value={!assertion.result ? 'none' : assertion.result.equals === undefined ? 'exists' : 'equals'} onChange={(event) => onChange(event.target.value === 'none' ? { ...assertion, result: undefined } : event.target.value === 'exists' ? { ...assertion, result: { exists: true } } : { ...assertion, result: { equals: null } })}><option value="none">Do not check</option><option value="exists">Path exists</option><option value="equals">Check JSON value</option></Select></Field>{assertion.result ? <><Field label="Result path (optional)"><Input value={assertion.result.path ?? ''} placeholder="$.content" onChange={(event) => onChange({ ...assertion, result: { ...assertion.result!, ...(event.target.value ? { path: event.target.value } : { path: undefined }) } })} /></Field>{assertion.result.equals !== undefined ? <Field label="Expected result JSON"><Input defaultValue={JSON.stringify(assertion.result.equals)} onBlur={(event) => jsonBlur(event.target.value, (equals) => onChange({ ...assertion, result: { ...assertion.result!, equals } }))} /></Field> : null}</> : null}<Field label="Success"><Select value={assertion.success === undefined ? 'any' : String(assertion.success)} onChange={(event) => onChange({ ...assertion, ...(event.target.value === 'any' ? { success: undefined } : { success: event.target.value === 'true' }) })}><option value="any">Any outcome</option><option value="true">Must succeed</option><option value="false">Must fail</option></Select></Field></> : null}
    </div>
  </div>;
}

export function SuitesPage({ suites, servers, providers, onRefresh, onRunStarted }: {
  suites: string[];
  servers: ServerSummary[];
  providers: ProviderSummary[];
  onRefresh(): Promise<void>;
  onRunStarted(id: string): void;
}) {
  const defaultServer = servers[0]?.id ?? '';
  const initial = useMemo(() => createSuiteDraft('direct-regression', defaultServer), [defaultServer]);
  const [selected, setSelected] = useState(suites[0] ?? '');
  const [draft, setDraft] = useState<SuiteDraft>(initial);
  const [source, setSource] = useState(() => serializeSuiteDraft(initial));
  const [activeCaseId, setActiveCaseId] = useState(initial.cases[0].id);
  const [view, setView] = useState<'builder' | 'yaml'>('builder');
  const [tools, setTools] = useState<Tool[]>([]);
  const [loading, setLoading] = useState(Boolean(suites[0]));
  const [busy, setBusy] = useState(false);
  const [loadedSuiteName, setLoadedSuiteName] = useState('');
  const loadEpoch = useRef(0);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const activeCase = draft.cases.find((entry) => entry.id === activeCaseId) ?? draft.cases[0];
  const selectedProvider = activeCase?.kind === 'agent' ? providers.find((entry) => entry.id === activeCase.provider) : undefined;

  useEffect(() => {
    if (!selected) { setLoadedSuiteName(''); return; }
    const epoch = ++loadEpoch.current;
    setLoading(true); setLoadedSuiteName('');
    void api.suite(selected).then((detail) => {
      if (epoch !== loadEpoch.current) return;
      setDraft(detail.suite);
      setSource(detail.source);
      setActiveCaseId(detail.suite.cases[0]?.id ?? '');
      setLoadedSuiteName(detail.name);
      setError('');
    }).catch((reason) => { if (epoch === loadEpoch.current) setError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (epoch === loadEpoch.current) setLoading(false); });
  }, [selected]);

  useEffect(() => {
    if (!activeCase?.server) { setTools([]); return; }
    let active = true;
    void api.inspectServer(activeCase.server).then((detail) => { if (active) setTools(detail.tools); }).catch(() => { if (active) setTools([]); });
    return () => { active = false; };
  }, [activeCase?.server]);

  const applyDraft = (next: SuiteDraft) => {
    setDraft(next);
    setSource(serializeSuiteDraft(next));
  };

  const replaceCase = (nextCase: SuiteCase) => applyDraft({ ...draft, cases: draft.cases.map((entry) => entry.id === activeCase?.id ? nextCase : entry) });

  const act = async (operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setMessage(''); setError('');
    try { await operation(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const startNew = () => {
    const next = createSuiteDraft('new-suite', defaultServer);
    loadEpoch.current += 1; setSelected(''); setLoadedSuiteName(''); setDraft(next); setSource(serializeSuiteDraft(next)); setActiveCaseId(next.cases[0].id); setView('builder'); setMessage('New suite draft. Nothing is written until Save.'); setError('');
  };

  const duplicateSuite = () => {
    const next = duplicateSuiteDraft(draft, suites);
    loadEpoch.current += 1; setSelected(''); setLoadedSuiteName(''); setDraft(next); setSource(serializeSuiteDraft(next)); setActiveCaseId(next.cases[0]?.id ?? ''); setView('builder'); setMessage(`Duplicate draft ${next.name}. Save to create it.`); setError('');
  };

  const deleteSuite = () => {
    if (!selected || loadedSuiteName !== selected || busy || !window.confirm(`Delete suite ${selected}? Historical runs remain available.`)) return;
    void act(async () => {
      const deleted = selected;
      await api.deleteSuite(deleted);
      await onRefresh();
      const remaining = suites.filter((name) => name !== deleted);
      if (remaining[0]) setSelected(remaining[0]);
      else startNew();
      setMessage(`Suite ${deleted} deleted. Historical runs were preserved.`);
    });
  };

  const addCase = (kind: SuiteCase['kind']) => {
    const id = nextCaseId(kind, draft.cases);
    const provider = providers[0];
    const nextCase = kind === 'direct'
      ? createDirectSuiteCase(id, defaultServer)
      : draft.version === 2
        ? createAgentSuiteCaseV2(id, defaultServer, provider?.id ?? '', Object.keys(provider?.models ?? {})[0] ?? '')
        : createAgentSuiteCase(id, defaultServer, provider?.id ?? '', Object.keys(provider?.models ?? {})[0] ?? '');
    applyDraft({ ...draft, cases: [...draft.cases, nextCase] });
    setActiveCaseId(id);
  };

  const moveCase = (offset: -1 | 1) => {
    if (!activeCase) return;
    const index = draft.cases.findIndex((entry) => entry.id === activeCase.id);
    const target = index + offset;
    if (target < 0 || target >= draft.cases.length) return;
    const cases = [...draft.cases];
    [cases[index], cases[target]] = [cases[target]!, cases[index]!];
    applyDraft({ ...draft, cases });
  };

  const duplicateCase = () => {
    if (!activeCase) return;
    const copy = duplicateSuiteCase(activeCase, draft.cases.map((entry) => entry.id));
    const index = draft.cases.findIndex((entry) => entry.id === activeCase.id);
    const cases = [...draft.cases];
    cases.splice(index + 1, 0, copy);
    applyDraft({ ...draft, cases }); setActiveCaseId(copy.id);
  };

  const removeCase = () => {
    if (!activeCase || draft.cases.length === 1) return;
    const index = draft.cases.findIndex((entry) => entry.id === activeCase.id);
    const cases = draft.cases.filter((entry) => entry.id !== activeCase.id);
    applyDraft({ ...draft, cases }); setActiveCaseId(cases[Math.min(index, cases.length - 1)]!.id);
  };

  const convertToV2 = () => {
    if (draft.version === 2) return;
    const cases = draft.cases.map((entry) => {
      if (entry.kind !== 'agent' || !('prompt' in entry)) return entry;
      const { prompt, ...agent } = entry;
      return { ...agent, turns: [{ id: 'turn-1', user: prompt, assertions: [] }], iterations: { count: 1, minPasses: 1 } };
    });
    applyDraft({ version: 2, name: draft.name, ...(draft.description !== undefined ? { description: draft.description } : {}), cases });
    setMessage('Converted to Version 2. Version 1 prompt moved into first user turn; conversion cannot downgrade this draft.');
  };

  const switchView = (next: 'builder' | 'yaml') => {
    if (next === 'builder' && view === 'yaml') {
      try {
        const parsed = parseSuiteDraft(source);
        setDraft(parsed); setActiveCaseId(parsed.cases[0]?.id ?? ''); setError('');
      } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); return; }
    }
    setView(next);
  };

  const save = () => act(async () => {
    const saveSource = view === 'yaml' ? source : serializeSuiteDraft(draft);
    const parsed = parseSuiteDraft(saveSource);
    if (selected && loadedSuiteName !== selected) throw new Error('Wait for selected suite to finish loading');
    const saved = selected ? await api.updateSuite(selected, saveSource) : await api.saveSuite(saveSource);
    setDraft(parsed); setSource(saveSource); setSelected(saved.name); await onRefresh();
    setMessage(`${selected ? 'Updated' : 'Created'} ${saved.name} with ${saved.cases} case(s). YAML remains ready for git and CI.`);
  });

  const renderCaseEditor = () => {
    if (!activeCase) return <Empty>Add a direct or agent case to begin.</Empty>;
    const availableAssertionTypes = assertionTypes;
    const updateAssertions = (assertions: SuiteAssertion[]) => replaceCase({ ...activeCase, assertions } as SuiteCase);
    const updateV2Turns = (turns: AgentSuiteTurn[]) => {
      if (isV2AgentCase(activeCase)) replaceCase({ ...activeCase, turns });
    };
    return <div className="case-composer">
      <header className="case-composer-head"><div><span className="eyebrow">{activeCase.kind} case</span><h3>{activeCase.id || 'Untitled case'}</h3></div><div className="config-actions compact"><Button onClick={() => moveCase(-1)} aria-label="Move case up">↑</Button><Button onClick={() => moveCase(1)} aria-label="Move case down">↓</Button><Button onClick={duplicateCase}>Duplicate</Button><Button variant="danger" disabled={draft.cases.length === 1} onClick={removeCase}>Remove</Button></div></header>
      <div className="case-section"><span className="eyebrow">Scenario</span><div className="form-grid">
        <Field label="Case ID" hint="Stable unique ID used in reports"><Input value={activeCase.id} onChange={(event) => { const previous = activeCase.id; const nextId = event.target.value; if (draft.cases.some((entry) => entry.id !== previous && entry.id === nextId)) { setError(`Case ID ${nextId} already exists.`); return; } const next = { ...activeCase, id: nextId } as SuiteCase; applyDraft({ ...draft, cases: draft.cases.map((entry) => entry.id === previous ? next : entry) }); setActiveCaseId(nextId); setError(''); }} /></Field>
        <Field label="MCP server"><Select value={activeCase.server} onChange={(event) => replaceCase({ ...activeCase, server: event.target.value } as SuiteCase)}><option value="">Choose server</option>{servers.map((server) => <option key={server.id} value={server.id}>{server.name} · {server.id}</option>)}</Select></Field>
      </div></div>
      {activeCase.kind === 'direct' ? <div className="case-section"><span className="eyebrow">Direct invocation</span><div className="form-grid">
        <Field label="Tool" hint={tools.length ? `${tools.length} discovered tools` : 'Type a tool name or connect server to discover'}><ToolInput id={`case-tool-${activeCase.id}`} value={activeCase.call.tool} tools={tools} onChange={(tool) => replaceCase({ ...activeCase, call: { ...activeCase.call, tool } })} /></Field>
        <label className="check suite-danger"><input type="checkbox" checked={activeCase.call.dangerous ?? false} onChange={(event) => replaceCase({ ...activeCase, call: { ...activeCase.call, dangerous: event.target.checked || undefined } })} />Confirm destructive tool when running</label>
        <Field label="Arguments JSON" hint="Portable JSON object passed to tool"><Textarea key={`${draft.name}-${activeCase.id}-${activeCase.call.tool}`} rows={8} defaultValue={JSON.stringify(activeCase.call.arguments, null, 2)} onBlur={(event) => { try { const value = JSON.parse(event.target.value) as DirectSuiteCase['call']['arguments']; if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); replaceCase({ ...activeCase, call: { ...activeCase.call, arguments: value } }); setError(''); } catch { setError('Tool arguments must be a valid JSON object.'); } }} /></Field>
      </div></div> : <div className="case-section"><span className="eyebrow">Agent scenario</span><div className="form-grid">
        <Field label="Provider"><Select value={activeCase.provider} onChange={(event) => { const provider = providers.find((entry) => entry.id === event.target.value); replaceCase({ ...activeCase, provider: event.target.value, model: Object.keys(provider?.models ?? {})[0] ?? '' }); }}><option value="">Choose provider</option>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name} · {provider.id}</option>)}</Select></Field>
        <Field label="Model alias"><Select value={activeCase.model} onChange={(event) => replaceCase({ ...activeCase, model: event.target.value })}><option value="">Choose model</option>{Object.keys(selectedProvider?.models ?? {}).map((model) => <option key={model} value={model}>{model}</option>)}</Select></Field>
        {isV2AgentCase(activeCase) ? <><Field label="Iteration count"><Input type="number" min="1" value={activeCase.iterations.count} onChange={(event) => replaceCase({ ...activeCase, iterations: { ...activeCase.iterations, count: Number(event.target.value), minPasses: Math.min(activeCase.iterations.minPasses, Number(event.target.value)) } })} /></Field><Field label="Minimum passes"><Input type="number" min="1" max={activeCase.iterations.count} value={activeCase.iterations.minPasses} onChange={(event) => replaceCase({ ...activeCase, iterations: { ...activeCase.iterations, minPasses: Math.min(Number(event.target.value), activeCase.iterations.count) } })} /></Field></> : <Field label="User prompt" hint="One scenario turn; save playground interactions for richer seeds"><Textarea rows={7} value={activeCase.prompt} onChange={(event) => replaceCase({ ...activeCase, prompt: event.target.value })} /></Field>}
      </div>{isV2AgentCase(activeCase) ? <div className="case-section assertions-editor"><header><div><span className="eyebrow">Scripted conversation</span><h3>{activeCase.turns.length} user turns</h3></div><Button onClick={() => updateV2Turns([...activeCase.turns, { id: nextTurnId(activeCase.turns), user: '', assertions: [] }])}>+ User turn</Button></header>{activeCase.turns.map((turn, turnIndex) => <div className="assertion-card" key={turn.id}><header><span><b>{turnIndex + 1}</b> User turn</span><div className="config-actions compact"><Button onClick={() => { if (turnIndex === 0) return; const turns = [...activeCase.turns]; [turns[turnIndex - 1], turns[turnIndex]] = [turns[turnIndex]!, turns[turnIndex - 1]!]; updateV2Turns(turns); }}>↑</Button><Button onClick={() => { if (turnIndex === activeCase.turns.length - 1) return; const turns = [...activeCase.turns]; [turns[turnIndex], turns[turnIndex + 1]] = [turns[turnIndex + 1]!, turns[turnIndex]!]; updateV2Turns(turns); }}>↓</Button><Button variant="danger" disabled={activeCase.turns.length === 1} onClick={() => updateV2Turns(activeCase.turns.filter((_turn, index) => index !== turnIndex))}>Remove</Button></div></header><div className="assertion-fields"><Field label="Turn ID"><Input value={turn.id} onChange={(event) => { const id = event.target.value; if (activeCase.turns.some((entry, index) => index !== turnIndex && entry.id === id)) { setError(`Turn ID ${id} already exists.`); return; } updateV2Turns(activeCase.turns.map((entry, index) => index === turnIndex ? { ...entry, id } : entry)); setError(''); }} /></Field><Field label="User message"><Textarea rows={4} value={turn.user} onChange={(event) => updateV2Turns(activeCase.turns.map((entry, index) => index === turnIndex ? { ...entry, user: event.target.value } : entry))} /></Field></div><div className="case-section assertions-editor"><header><div><span className="eyebrow">Turn assertions</span><h3>{turn.assertions.length} checks</h3></div><Select aria-label={`Add assertion to ${turn.id}`} value="" onChange={(event) => { if (!event.target.value) return; updateV2Turns(activeCase.turns.map((entry, index) => index === turnIndex ? { ...entry, assertions: [...entry.assertions, createSuiteAssertion(event.target.value as SuiteAssertion['type'])] } : entry)); event.target.value = ''; }}><option value="">+ Add check</option>{assertionTypes.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}</Select></header>{turn.assertions.length === 0 ? <Empty>No turn checks yet.</Empty> : turn.assertions.map((assertion, assertionIndex) => <AssertionEditor key={`${turn.id}-${assertionIndex}-${assertion.type}`} assertion={assertion} index={assertionIndex} scope={turn.id} tools={tools} types={assertionTypes} onError={setError} onChange={(value) => updateV2Turns(activeCase.turns.map((entry, index) => index === turnIndex ? { ...entry, assertions: entry.assertions.map((current, currentIndex) => currentIndex === assertionIndex ? value : current) } : entry))} onRemove={() => updateV2Turns(activeCase.turns.map((entry, index) => index === turnIndex ? { ...entry, assertions: entry.assertions.filter((_current, currentIndex) => currentIndex !== assertionIndex) } : entry))} />)}</div></div>)}</div> : null}<div className="form-grid compact suite-limits">
        <Field label={isV2AgentCase(activeCase) ? 'Max model turns' : 'Max turns'}><Input type="number" min="1" max="50" value={activeCase.limits.maxTurns} onChange={(event) => replaceCase({ ...activeCase, limits: { ...activeCase.limits, maxTurns: Number(event.target.value) } })} /></Field>
        <Field label="Max tool calls"><Input type="number" min="1" max="100" value={activeCase.limits.maxToolCalls} onChange={(event) => replaceCase({ ...activeCase, limits: { ...activeCase.limits, maxToolCalls: Number(event.target.value) } })} /></Field>
        <Field label="Timeout ms"><Input type="number" min="1" max="300000" value={activeCase.limits.timeoutMs} onChange={(event) => replaceCase({ ...activeCase, limits: { ...activeCase.limits, timeoutMs: Number(event.target.value) } })} /></Field>
        <Field label="Max cost USD" hint="Optional"><Input type="number" min="0" step="0.001" value={activeCase.limits.maxCostUsd ?? ''} onChange={(event) => replaceCase({ ...activeCase, limits: { ...activeCase.limits, ...(event.target.value ? { maxCostUsd: Number(event.target.value) } : { maxCostUsd: undefined }) } })} /></Field>
      </div></div>}
      <div className="case-section assertions-editor"><header><div><span className="eyebrow">Expected behavior</span><h3>{activeCase.assertions.length} checks</h3></div><Select aria-label="Add assertion" value="" onChange={(event) => { if (!event.target.value) return; updateAssertions([...activeCase.assertions, createSuiteAssertion(event.target.value as SuiteAssertion['type'])]); event.target.value = ''; }}><option value="">+ Add check</option>{availableAssertionTypes.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}</Select></header>
        {activeCase.assertions.length === 0 ? <Empty>No checks yet. Add expected tools, output checks, or execution budgets.</Empty> : activeCase.assertions.map((assertion, index) => <AssertionEditor key={`${draft.name}-${activeCase.id}-${index}-${assertion.type}`} assertion={assertion} index={index} tools={tools} types={availableAssertionTypes} onError={setError} onChange={(value) => updateAssertions(activeCase.assertions.map((entry, assertionIndex) => assertionIndex === index ? value : entry))} onRemove={() => updateAssertions(activeCase.assertions.filter((_entry, assertionIndex) => assertionIndex !== index))} />)}
      </div>
    </div>;
  };

  return <div className="suite-studio">
    <Section title="Suite library" className="suite-library" action={<span className="count">{suites.length}</span>}>
      <Button variant="primary" className="new-suite" onClick={startNew}>+ New suite</Button>
      <div className="row-list">{suites.length === 0 ? <Empty>No saved suites yet.</Empty> : suites.map((suite) => <button key={suite} disabled={busy} className={`row-button ${selected === suite ? 'selected' : ''}`} onClick={() => { setSelected(suite); setMessage(''); setError(''); }}><span><b>{suite}</b><small>portable YAML · editable</small></span></button>)}</div>
      <div className="suite-library-actions"><Button variant="primary" disabled={!selected || loadedSuiteName !== selected || busy} data-testid="run-suite" onClick={() => void act(async () => { const run = await api.runSuite(selected); onRunStarted(run.id); setMessage(`Run ${run.id.slice(0, 8)} started.`); })}>Run selected</Button><div className="config-actions compact"><Button disabled={!selected || loadedSuiteName !== selected || busy} onClick={duplicateSuite}>Duplicate</Button><Button variant="danger" disabled={!selected || loadedSuiteName !== selected || busy} onClick={deleteSuite}>Delete</Button></div><small>{selected ? `Saved suite: ${selected}` : 'Unsaved draft'}</small></div>
    </Section>

    <Section title="Suite composer" className="suite-workspace" action={<div className="suite-view-tabs"><button className={view === 'builder' ? 'selected' : ''} onClick={() => switchView('builder')}>Builder</button><button className={view === 'yaml' ? 'selected' : ''} onClick={() => switchView('yaml')}>YAML</button></div>}>
      {loading ? <div className="loading"><i />Loading suite…</div> : <>
        <div className="suite-meta"><Field label="Suite name" hint="Filename-safe ID used by CLI and reports"><Input value={draft.name} onChange={(event) => applyDraft({ ...draft, name: event.target.value })} data-testid="suite-name" /></Field><Field label="Description" hint="Optional intent for reviewers"><Input value={draft.description ?? ''} onChange={(event) => applyDraft({ ...draft, description: event.target.value })} /></Field><Field label="Suite version" hint={draft.version === 2 ? 'Version 2 cannot be downgraded in builder.' : 'Version 2 supports scripted multi-turn agents.'}><Select value={draft.version} onChange={(event) => { if (event.target.value === '2') convertToV2(); }}><option value="1" disabled={draft.version === 2}>Version 1</option><option value="2">Version 2</option></Select></Field></div>
        {view === 'yaml' ? <div className="yaml-workspace"><div className="yaml-note"><span>Canonical artifact</span><b>Version {draft.version} YAML</b><small>Edit directly, commit it, or run with <code>mcp-riksa run</code>.</small></div><Field label="Suite source"><Textarea className="code-editor" rows={28} value={source} onChange={(event) => setSource(event.target.value)} spellCheck={false} data-testid="suite-source" /></Field></div> : <div className="suite-builder">
          <aside className="case-rail"><header><div><span className="eyebrow">Cases</span><b>{draft.cases.length} scenarios</b></div><div><Button onClick={() => addCase('direct')}>+ Direct</Button><Button onClick={() => addCase('agent')}>+ Agent</Button></div></header><div className="case-list">{draft.cases.map((entry, index) => <button key={`${entry.id}-${index}`} className={entry.id === activeCase?.id ? 'selected' : ''} onClick={() => setActiveCaseId(entry.id)}><span>{String(index + 1).padStart(2, '0')}</span><div><b>{entry.id || 'Untitled case'}</b><small>{entry.kind} · {entry.server || 'no server'} · {entry.assertions.length} checks</small></div></button>)}</div></aside>
          {renderCaseEditor()}
        </div>}
        <footer className="suite-savebar"><div><span className="eyebrow">Portable by default</span><small>Visual edits serialize to strict YAML. Inline secrets still rejected.</small></div><div className="button-row"><Button onClick={() => switchView(view === 'builder' ? 'yaml' : 'builder')}>{view === 'builder' ? 'Preview YAML' : 'Back to builder'}</Button><Button variant="primary" disabled={busy || loading} data-testid="save-suite" onClick={() => void save()}>{busy ? 'Saving…' : selected ? 'Save changes' : 'Create suite'}</Button></div></footer>
        {message ? <Notice>{message}</Notice> : null}{error ? <Notice error>{error}</Notice> : null}
      </>}
    </Section>
  </div>;
}
