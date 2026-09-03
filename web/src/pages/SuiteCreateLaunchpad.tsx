import { useEffect, useMemo, useReducer, useRef } from 'react';
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
  suggestSuiteNameFromServerId,
  type SuiteCreationField,
  type SuiteCreationForm,
  type SuiteDocumentState,
} from '../suite-workflow.js';
import type { ProviderSummary, ServerSummary, SuiteGenerationRequest } from '../types.js';

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
      const request: SuiteGenerationRequest = {
        serverId: snapshot.serverId,
        generatorProviderId: snapshot.generatorProviderId,
        generatorModel: snapshot.generatorModel,
        targetProviderId: snapshot.targetProviderId,
        targetModel: snapshot.targetModel,
        name: snapshot.name.trim(),
        ...(snapshot.authorInstructions.trim() ? { authorInstructions: snapshot.authorInstructions.trim() } : {}),
      };
      const result = await api.generateSuiteDraft(request, controller.signal);
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
            <span className="status pass">Recommended</span><b>Generate with AI</b><small>Inspect tool metadata, draft safe coverage, then review every included and excluded tool.</small>
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
                updateForm({ serverId, ...(form.name === suggestSuiteNameFromServerId(form.serverId) ? { name: suggestSuiteNameFromServerId(serverId) } : {}) });
              }} data-testid="generation-server">
                <option value="">Choose MCP server</option>
                {servers.map((server) => <option key={server.id} value={server.id}>{server.name} · {server.connected ? 'connected' : 'not connected'}</option>)}
              </Select>
              {fieldIssues('serverId')}
            </Field>
          </div>

          {form.mode === 'generated' ? <>
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
            <Field label="Safe fixture and domain guidance" hint="Optional: known IDs, forbidden actions, realistic values, and domain constraints."><Textarea rows={4} maxLength={20000} value={form.authorInstructions} onChange={(event) => updateForm({ authorInstructions: event.target.value })} placeholder="Use tenant demo-acme. Never send messages or modify production records." data-testid="generation-instructions" /></Field>
            <div className="generation-guardrail"><p><b>Draft boundary.</b> Generator inspects metadata only and never invokes MCP tools. Explicitly destructive tools are excluded. Uncertain tools need a reason. Running accepted cases can still cause side effects—inspect every prompt and assertion.</p></div>
          </> : <p className="manual-route-copy">Blank suite includes one direct case in current format. Nothing is saved or run until explicit actions in composer.</p>}
        </div>

        <footer className="launchpad-actions">
          <div className="creation-readiness" role="status" aria-live="polite">
            {issues.length ? <><b>Not ready</b><span>{issues.map((issue) => issue.message).join(' ')}</span>{serverIssue ? <a href="#/servers">Open server connections</a> : null}{providerIssue ? <a href="#/settings">Open provider settings</a> : null}</> : <><b>Ready</b><span>{form.mode === 'generated' ? 'Generate review draft.' : 'Open unsaved manual draft.'}</span></>}
          </div>
          <Button variant="primary" disabled={issues.length > 0} data-testid={form.mode === 'generated' ? 'generate-suite-draft' : 'create-manual-suite'} onClick={() => form.mode === 'generated' ? void generate() : createManual()}>{form.mode === 'generated' ? 'Generate draft' : 'Create manual draft'}</Button>
        </footer>
      </> : null}

      {generationBusy ? <div className="launchpad-generating" role="status" aria-live="polite"><i /><span><b>Generating draft</b><small>Inspecting metadata and assembling review ledger. No tools are invoked.</small></span></div> : null}

      {review ? <div className="launchpad-review" data-testid="suite-generation-review">
        <header><div><span className="eyebrow">Review generated draft</span><h3 ref={reviewHeadingRef} tabIndex={-1}>{review.coverage.length} generated · {review.exclusions.length} excluded</h3></div>{review.usage ? <span className="metrics">{review.usage.input} input · {review.usage.output} output · {review.usage.total} total tokens</span> : <span className="metrics">Usage unavailable</span>}</header>
        <div className="generation-ledger"><section><h4>Generated cases</h4>{review.coverage.length === 0 ? <Empty>No generated cases.</Empty> : review.coverage.map((entry) => <div className="generation-ledger-row" key={`${entry.tool}-${entry.caseId}`}><span className="status pass">generated</span><code>{entry.tool}</code><small>{entry.caseId}</small></div>)}</section><section><h4>Excluded tools</h4>{review.exclusions.length === 0 ? <Empty>No exclusions.</Empty> : review.exclusions.map((entry) => <div className="generation-ledger-row exclusion" key={`${entry.tool}-${entry.reason}`}><span className={`status ${entry.category === 'destructive' ? 'fail' : ''}`}>{entry.category}</span><code>{entry.tool}</code><small>{entry.reason}</small></div>)}</section></div>
        <div className="generation-guardrail"><p><b>Review boundary.</b> Generated cases remain unsaved and unexecuted. Inspect accepted content in composer before saving or running.</p></div>
        <footer><div className="button-row"><Button data-testid="generation-start-over" onClick={() => dispatch({ type: 'open', form: defaults })}>Start over</Button><Button disabled={generationBusy} onClick={() => void generate()}>Regenerate</Button></div><Button variant="primary" data-testid="apply-generated-suite" onClick={useGenerated}>Use generated cases</Button></footer>
      </div> : null}

      {session.requestError ? <div className="notice error" role="alert" aria-live="assertive"><b>Generation failed.</b> {session.requestError}</div> : null}
    </div>
  </dialog>;
}
