import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { api } from '../api.js';
import { Button, Empty, Field, Input, Select, Textarea } from '../components.js';
import {
  applyGeneratedSuiteReview,
  createManualSuiteDocument,
  createSuiteCreationForm,
  createSuiteCreationSession,
  creationReadinessIssues,
  creationSessionReducer,
  generationRequestGuard,
  suiteGenerationRequest,
  suggestSuiteNameFromServerId,
  type SuiteCreationField,
  type SuiteCreationForm,
  type SuiteDocumentState,
} from '../suite-workflow.js';
import type { ProviderSummary, ServerSummary, Tool } from '../types.js';

export function SuiteCreateLaunchpad({ open, servers, providers, suiteNames, onClose, onCreate }: {
  open: boolean;
  servers: ServerSummary[];
  providers: ProviderSummary[];
  suiteNames: string[];
  onClose(): void;
  onCreate(document: SuiteDocumentState, mode: 'manual' | 'generated'): boolean;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const reviewHeadingRef = useRef<HTMLHeadingElement>(null);
  const generationAbortRef = useRef<AbortController | undefined>(undefined);
  const requestSequence = useRef(0);
  const [toolCatalog, setToolCatalog] = useState<{ serverId: string; loading: boolean; tools: Tool[]; error?: string }>({ serverId: '', loading: false, tools: [] });
  const defaults = useMemo(() => {
    const serverId = servers.find((server) => server.connected)?.id ?? servers[0]?.id ?? '';
    const provider = providers[0];
    const model = Object.keys(provider?.models ?? {})[0] ?? '';
    return createSuiteCreationForm({
      mode: 'generated',
      serverId,
      generatorProviderId: provider?.id ?? '',
      generatorModel: model,
      targetProviderId: provider?.id ?? '',
      targetModel: model,
    });
  }, [servers, providers]);
  const [session, dispatch] = useReducer(creationSessionReducer, createSuiteCreationSession(defaults));
  const form = session.form;
  const generationProvider = providers.find((entry) => entry.id === form.generatorProviderId);
  const targetProvider = providers.find((entry) => entry.id === form.targetProviderId);
  const issues = creationReadinessIssues(form, { servers, providers, suiteNames });
  const issueFor = (field: SuiteCreationField) => issues.filter((issue) => issue.field === field);
  const generationBusy = session.activeRequest !== undefined;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open) {
      dispatch({ type: 'open', form: defaults });
      if (!dialog.open) {
        if (typeof dialog.showModal === 'function') dialog.showModal();
        else dialog.setAttribute('open', '');
      }
    } else {
      generationAbortRef.current?.abort();
      generationAbortRef.current = undefined;
      dispatch({ type: 'close' });
      if (dialog.open) {
        if (typeof dialog.close === 'function') dialog.close();
        else dialog.removeAttribute('open');
      }
    }
  }, [open, defaults]);

  useEffect(() => {
    if (session.review) reviewHeadingRef.current?.focus();
  }, [session.review]);

  useEffect(() => {
    const server = servers.find((entry) => entry.id === form.serverId);
    if (!open || form.mode !== 'generated' || !server?.connected) {
      setToolCatalog({ serverId: form.serverId, loading: false, tools: [] });
      return;
    }
    let active = true;
    setToolCatalog({ serverId: form.serverId, loading: true, tools: [] });
    void api.inspectServer(form.serverId).then((inspection) => {
      if (active) setToolCatalog({ serverId: form.serverId, loading: false, tools: inspection.tools });
    }).catch((reason) => {
      if (active) setToolCatalog({ serverId: form.serverId, loading: false, tools: [], error: reason instanceof Error ? reason.message : String(reason) });
    });
    return () => { active = false; };
  }, [open, form.mode, form.serverId, servers]);

  useEffect(() => () => generationAbortRef.current?.abort(), []);

  const close = () => {
    generationAbortRef.current?.abort();
    generationAbortRef.current = undefined;
    dispatch({ type: 'close' });
    onClose();
  };

  const updateForm = (changes: Partial<SuiteCreationForm>) => {
    generationAbortRef.current?.abort();
    generationAbortRef.current = undefined;
    dispatch({ type: 'formChanged', changes });
  };

  const generate = async () => {
    if (generationBusy || issues.length > 0) return;
    const guard = generationRequestGuard(session, `suite-generation-${++requestSequence.current}`);
    const snapshot = form;
    const controller = new AbortController();
    generationAbortRef.current?.abort();
    generationAbortRef.current = controller;
    dispatch({ type: 'generationStarted', guard });
    try {
      const result = await api.generateSuiteDraft(suiteGenerationRequest(snapshot), controller.signal);
      dispatch({ type: 'generationSucceeded', guard, result });
    } catch (reason) {
      if (!controller.signal.aborted) dispatch({ type: 'generationFailed', guard, message: reason instanceof Error ? reason.message : String(reason) });
    } finally {
      if (generationAbortRef.current === controller) generationAbortRef.current = undefined;
    }
  };

  const createManual = () => {
    if (issues.length > 0 || generationBusy) return;
    if (onCreate(createManualSuiteDocument(form), 'manual')) close();
  };

  const useGenerated = () => {
    const applied = applyGeneratedSuiteReview(session);
    if (!applied) return;
    if (!onCreate(applied.document, 'generated')) return;
    dispatch({ type: 'generatedApplied' });
    close();
  };

  const fieldIssues = (field: SuiteCreationField) => issueFor(field).map((issue) => <small className="creation-field-error" key={issue.message}>{issue.message}</small>);
  const providerIssue = issues.some((issue) => ['generatorProviderId', 'generatorModel', 'targetProviderId', 'targetModel'].includes(issue.field));
  const serverIssue = issues.some((issue) => issue.field === 'serverId');
  const review = session.review?.result;
  const currentTools = toolCatalog.serverId === form.serverId ? toolCatalog.tools : [];
  const safeTools = currentTools.filter((tool) => tool.annotations?.destructiveHint !== true);
  const destructiveTools = currentTools.filter((tool) => tool.annotations?.destructiveHint === true);
  const selectedToolNames = new Set(form.selectedTools);
  const toolPicker = <fieldset className="generation-tool-picker" aria-invalid={issueFor('selectedTools').length > 0}>
    <legend>{form.generationGoal === 'selected-tools' ? 'Tools to cover' : 'Allowed tools (optional)'}</legend>
    <small>{form.generationGoal === 'selected-tools' ? 'Generator covers each selected tool or explains why it cannot.' : 'No selection lets AI choose from every safe tool.'}</small>
    {toolCatalog.loading ? <p className="empty">Loading tool metadata…</p> : toolCatalog.error ? <div className="notice error" role="alert">Could not inspect tools: {toolCatalog.error}</div> : <>
      <div className="generation-tool-list">
        {safeTools.map((tool) => <label key={tool.name} className="generation-tool-option"><input type="checkbox" data-testid={`generation-tool-${tool.name}`} checked={selectedToolNames.has(tool.name)} onChange={() => updateForm({ selectedTools: selectedToolNames.has(tool.name) ? form.selectedTools.filter((name) => name !== tool.name) : [...form.selectedTools, tool.name] })} /><span><code>{tool.name}</code>{tool.description ? <small>{tool.description}</small> : null}</span></label>)}
        {safeTools.length === 0 ? <Empty>No non-destructive tools available.</Empty> : null}
      </div>
      {destructiveTools.length ? <details className="generation-destructive-tools"><summary>{destructiveTools.length} destructive tool{destructiveTools.length === 1 ? '' : 's'} always excluded</summary>{destructiveTools.map((tool) => <code key={tool.name}>{tool.name}</code>)}</details> : null}
    </>}
    {fieldIssues('selectedTools')}
  </fieldset>;

  return <dialog
    ref={dialogRef}
    className="suite-launchpad"
    data-testid="suite-generator"
    aria-labelledby="suite-launchpad-title"
    aria-describedby="suite-launchpad-description"
    aria-busy={generationBusy}
    onCancel={(event) => { event.preventDefault(); close(); }}
  >
    <div className="suite-launchpad-shell">
      <header className="launchpad-header">
        <div><span className="eyebrow">Suite workshop</span><h2 id="suite-launchpad-title">Create suite</h2><p id="suite-launchpad-description">Choose an authoring route. Both open an unsaved current-format draft.</p></div>
        <Button aria-label="Close suite creation" onClick={close}>Close</Button>
      </header>

      <div className="suite-boundary-strip" aria-label="Suite lifecycle"><b>Draft</b><span>→</span><b className={review ? 'active' : ''}>Review</b><span>→</span><b>Save</b><span>→</span><b>Run</b></div>

      {!review && !generationBusy ? <>
        <div className="creation-routes" role="group" aria-label="Suite creation route">
          <button type="button" autoFocus className={`creation-route ${form.mode === 'generated' ? 'selected' : ''}`} aria-pressed={form.mode === 'generated'} data-testid="suite-route-ai" onClick={() => updateForm({ mode: 'generated' })}>
            <span className="status pass">Recommended</span><b>Generate with AI</b><small>Author requested scenarios or explicit tool coverage, then review the draft.</small>
          </button>
          <button type="button" className={`creation-route ${form.mode === 'manual' ? 'selected' : ''}`} aria-pressed={form.mode === 'manual'} data-testid="suite-route-manual" onClick={() => updateForm({ mode: 'manual' })}>
            <span className="status">Manual</span><b>Build manually</b><small>Open a blank current-format suite and compose cases yourself.</small>
          </button>
        </div>

        <div className="launchpad-form">
          <div className="form-grid">
            <Field label="Suite name" hint="1–128 letters, numbers, dots, underscores, or hyphens; start with a letter or number.">
              <Input value={form.name} aria-invalid={issueFor('name').length > 0} onChange={(event) => updateForm({ name: event.target.value })} data-testid="generation-name" />
              {fieldIssues('name')}
            </Field>
            <Field label="MCP server" hint={form.mode === 'generated' ? 'Must be connected so AI author can inspect tool metadata.' : 'Cases begin with this server selected.'}>
              <Select value={form.serverId} aria-invalid={issueFor('serverId').length > 0} onChange={(event) => {
                const serverId = event.target.value;
                updateForm({ serverId, selectedTools: [], ...(form.name === suggestSuiteNameFromServerId(form.serverId) ? { name: suggestSuiteNameFromServerId(serverId) } : {}) });
              }} data-testid="generation-server">
                <option value="">Choose MCP server</option>
                {servers.map((server) => <option key={server.id} value={server.id}>{server.name} · {server.connected ? 'connected' : 'not connected'}</option>)}
              </Select>
              {fieldIssues('serverId')}
            </Field>
          </div>

          {form.mode === 'generated' ? <>
            <section className="generation-scope-section">
              <header><span className="eyebrow">Generation goal</span><b>Choose what AI should author</b></header>
              <div className="generation-goals" role="group" aria-label="Generation goal">
                <button type="button" className={`creation-route ${form.generationGoal === 'scenarios' ? 'selected' : ''}`} aria-pressed={form.generationGoal === 'scenarios'} onClick={() => updateForm({ generationGoal: 'scenarios' })} data-testid="generation-goal-scenarios"><b>Specific scenarios</b><small>Describe workflows. AI chooses relevant expected tools.</small></button>
                <button type="button" className={`creation-route ${form.generationGoal === 'selected-tools' ? 'selected' : ''}`} aria-pressed={form.generationGoal === 'selected-tools'} onClick={() => updateForm({ generationGoal: 'selected-tools' })} data-testid="generation-goal-selected"><b>Selected tool coverage</b><small>Cover only tools you select; uncertain ones require a reason.</small></button>
                <button type="button" className={`creation-route ${form.generationGoal === 'all-safe-tools' ? 'selected' : ''}`} aria-pressed={form.generationGoal === 'all-safe-tools'} onClick={() => updateForm({ generationGoal: 'all-safe-tools' })} data-testid="generation-goal-all"><b>All safe tools</b><small>Classify every non-destructive tool as generated or excluded.</small></button>
              </div>
            </section>
            <div className="author-model-grid">
              <section><header><span className="eyebrow">AI author</span><b>Writes draft cases</b></header>
                <Field label="Provider"><Select value={form.generatorProviderId} aria-invalid={issueFor('generatorProviderId').length > 0} onChange={(event) => { const provider = providers.find((entry) => entry.id === event.target.value); updateForm({ generatorProviderId: event.target.value, generatorModel: Object.keys(provider?.models ?? {})[0] ?? '' }); }} data-testid="generation-provider"><option value="">Choose provider</option>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name} · {provider.id}</option>)}</Select>{fieldIssues('generatorProviderId')}</Field>
                <Field label="Model"><Select value={form.generatorModel} aria-invalid={issueFor('generatorModel').length > 0} onChange={(event) => updateForm({ generatorModel: event.target.value })}><option value="">Choose model</option>{Object.keys(generationProvider?.models ?? {}).map((model) => <option key={model} value={model}>{model}</option>)}</Select>{fieldIssues('generatorModel')}</Field>
              </section>
              <section><header><span className="eyebrow">Model to test</span><b>Runs accepted cases later</b></header>
                <Field label="Provider"><Select value={form.targetProviderId} aria-invalid={issueFor('targetProviderId').length > 0} onChange={(event) => { const provider = providers.find((entry) => entry.id === event.target.value); updateForm({ targetProviderId: event.target.value, targetModel: Object.keys(provider?.models ?? {})[0] ?? '' }); }}><option value="">Choose provider</option>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name} · {provider.id}</option>)}</Select>{fieldIssues('targetProviderId')}</Field>
                <Field label="Model"><Select value={form.targetModel} aria-invalid={issueFor('targetModel').length > 0} onChange={(event) => updateForm({ targetModel: event.target.value })}><option value="">Choose model</option>{Object.keys(targetProvider?.models ?? {}).map((model) => <option key={model} value={model}>{model}</option>)}</Select>{fieldIssues('targetModel')}</Field>
              </section>
            </div>
            {form.generationGoal === 'scenarios' ? <>
              <div className="scenario-controls">
                <Field label="Number of scenarios" hint="1–8 focused cases."><Input type="number" min={1} max={8} value={form.scenarioCount} aria-invalid={issueFor('scenarioCount').length > 0} onChange={(event) => updateForm({ scenarioCount: Number(event.target.value) })} data-testid="generation-case-count" />{fieldIssues('scenarioCount')}</Field>
                <Field label="Scenario description" hint="Required. Describe workflows, outcomes, fixtures, and forbidden actions."><Textarea rows={5} maxLength={20000} value={form.authorInstructions} aria-invalid={issueFor('authorInstructions').length > 0} onChange={(event) => updateForm({ authorInstructions: event.target.value })} placeholder="Create a workflow that finds customer Ada, reads her open orders, and summarizes them without modifying records." data-testid="generation-instructions" />{fieldIssues('authorInstructions')}</Field>
              </div>
              {toolPicker}
            </> : form.generationGoal === 'selected-tools' ? <>
              {toolPicker}
              <Field label="Safe fixture and domain guidance" hint="Optional: known IDs, realistic values, and domain constraints."><Textarea rows={4} maxLength={20000} value={form.authorInstructions} onChange={(event) => updateForm({ authorInstructions: event.target.value })} placeholder="Use tenant demo-acme. Never modify production records." data-testid="generation-instructions" /></Field>
            </> : <Field label="Safe fixture and domain guidance" hint="Optional: every safe tool remains in scope regardless of this guidance."><Textarea rows={4} maxLength={20000} value={form.authorInstructions} onChange={(event) => updateForm({ authorInstructions: event.target.value })} placeholder="Use tenant demo-acme. Never modify production records." data-testid="generation-instructions" /></Field>}
            <div className="generation-guardrail"><p><b>Draft boundary.</b> Generator inspects metadata only and never invokes MCP tools. Explicitly destructive tools are excluded. Running accepted cases can still cause side effects—inspect every prompt and assertion.</p></div>
          </> : <p className="manual-route-copy">Blank suite includes one direct case in current format. Nothing is saved or run until explicit actions in composer.</p>}
        </div>

        <footer className="launchpad-actions">
          <div className="creation-readiness" role="status" aria-live="polite">
            {issues.length ? <><b>Not ready</b><span>{issues.map((issue) => issue.message).join(' ')}</span>{serverIssue ? <a href="#/servers">Open server connections</a> : null}{providerIssue ? <a href="#/settings">Open provider settings</a> : null}</> : <><b>Ready</b><span>{form.mode === 'generated' ? 'Generate review draft.' : 'Open unsaved manual draft.'}</span></>}
          </div>
          <Button variant="primary" disabled={issues.length > 0} data-testid={form.mode === 'generated' ? 'generate-suite-draft' : 'create-manual-suite'} onClick={() => form.mode === 'generated' ? void generate() : createManual()}>{form.mode === 'generated' ? 'Generate draft' : 'Create manual draft'}</Button>
        </footer>
      </> : null}

      {generationBusy ? <div className="launchpad-generating" role="status" aria-live="polite"><i /><span><b>Generating draft</b><small>Inspecting metadata and authoring requested cases. No tools are invoked.</small></span></div> : null}

      {review ? <div className="launchpad-review" data-testid="suite-generation-review">
        <header><div><span className="eyebrow">Review generated draft</span><h3 ref={reviewHeadingRef} tabIndex={-1}>{review.suite.cases.length} case{review.suite.cases.length === 1 ? '' : 's'} · {review.coverage.length} expected tool call{review.coverage.length === 1 ? '' : 's'} · {review.exclusions.length} excluded</h3></div>{review.usage ? <span className="metrics">{review.usage.input} input · {review.usage.output} output · {review.usage.total} total tokens</span> : <span className="metrics">Usage unavailable</span>}</header>
        <div className="generation-ledger"><section><h4>Expected tool calls</h4>{review.coverage.length === 0 ? <Empty>No expected tool calls.</Empty> : review.coverage.map((entry) => <div className="generation-ledger-row" key={`${entry.tool}-${entry.caseId}`}><span className="status pass">generated</span><code>{entry.tool}</code><small>{entry.caseId}</small></div>)}</section><section><h4>Excluded tools</h4>{review.exclusions.length === 0 ? <Empty>No exclusions.</Empty> : review.exclusions.map((entry) => <div className="generation-ledger-row exclusion" key={`${entry.tool}-${entry.reason}`}><span className={`status ${entry.category === 'destructive' ? 'fail' : ''}`}>{entry.category}</span><code>{entry.tool}</code><small>{entry.reason}</small></div>)}</section></div>
        <div className="generation-guardrail"><p><b>Review boundary.</b> Generated cases remain unsaved and unexecuted. Inspect accepted content in composer before saving or running.</p></div>
        <footer><div className="button-row"><Button data-testid="generation-start-over" onClick={() => dispatch({ type: 'open', form: defaults })}>Start over</Button><Button disabled={generationBusy} onClick={() => void generate()}>Regenerate</Button></div><Button variant="primary" data-testid="apply-generated-suite" onClick={useGenerated}>Use generated cases</Button></footer>
      </div> : null}

      {session.requestError ? <div className="notice error" role="alert" aria-live="assertive"><b>Generation failed.</b> {session.requestError}</div> : null}
    </div>
  </dialog>;
}
