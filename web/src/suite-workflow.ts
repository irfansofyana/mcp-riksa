import {
  createSuiteDraft,
  parseSuiteDraft,
  serializeSuiteDraft,
  upgradeSuiteDraftToV2,
} from './model.js';
import type { SuiteDraft, SuiteDraftV2, SuiteGenerationDraft } from './types.js';

export type PendingEditorIssues = Record<string, string>;

export function updatePendingEditorIssues(
  current: PendingEditorIssues,
  editorId: string,
  message: string,
): PendingEditorIssues {
  if (!message && !(editorId in current)) return current;
  const next = { ...current };
  if (message) next[editorId] = message; else delete next[editorId];
  return next;
}

export type SuiteCreationMode = 'manual' | 'generated';

export type SuiteCreationForm = {
  mode: SuiteCreationMode;
  name: string;
  serverId: string;
  generatorProviderId: string;
  generatorModel: string;
  targetProviderId: string;
  targetModel: string;
  authorInstructions: string;
};

export type SuiteCreationField = keyof SuiteCreationForm;
export type SuiteCreationIssue = { field: SuiteCreationField; message: string };
export type SuiteCreationOptions = {
  servers: ReadonlyArray<{ id: string; connected?: boolean }>;
  providers: ReadonlyArray<{ id: string; models: Readonly<Record<string, unknown>> }>;
  suiteNames?: readonly string[];
};

const suiteNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function suggestSuiteNameFromServerId(serverId: string): string {
  const suffix = '-suite';
  const maximumStemLength = 128 - suffix.length;
  const stem = serverId.trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maximumStemLength)
    .replace(/-+$/g, '');
  return `${stem || 'mcp'}${suffix}`;
}

export const suggestSuiteName = suggestSuiteNameFromServerId;

export function createSuiteCreationForm(initial: Partial<SuiteCreationForm> = {}): SuiteCreationForm {
  const serverId = initial.serverId ?? '';
  return {
    mode: initial.mode ?? 'manual',
    name: initial.name ?? suggestSuiteNameFromServerId(serverId),
    serverId,
    generatorProviderId: initial.generatorProviderId ?? '',
    generatorModel: initial.generatorModel ?? '',
    targetProviderId: initial.targetProviderId ?? '',
    targetModel: initial.targetModel ?? '',
    authorInstructions: initial.authorInstructions ?? '',
  };
}

export function creationReadinessIssues(form: SuiteCreationForm, options: SuiteCreationOptions): SuiteCreationIssue[] {
  const issues: SuiteCreationIssue[] = [];
  const server = options.servers.find((entry) => entry.id === form.serverId);
  if (!form.name.trim()) issues.push({ field: 'name', message: 'Enter a suite name.' });
  else if (!suiteNamePattern.test(form.name.trim())) {
    issues.push({ field: 'name', message: 'Use 1–128 letters, numbers, dots, underscores, or hyphens; start with a letter or number.' });
  } else if (options.suiteNames?.some((name) => name.toLocaleLowerCase('en-US') === form.name.trim().toLocaleLowerCase('en-US'))) {
    issues.push({ field: 'name', message: 'A saved suite already uses this name. Choose another.' });
  }
  if (!form.serverId || !server) issues.push({ field: 'serverId', message: 'Choose an MCP server.' });

  if (form.mode === 'generated') {
    if (server && !server.connected) issues.push({ field: 'serverId', message: 'Choose a connected MCP server for generation.' });
    const generator = options.providers.find((entry) => entry.id === form.generatorProviderId);
    const target = options.providers.find((entry) => entry.id === form.targetProviderId);
    if (!form.generatorProviderId) issues.push({ field: 'generatorProviderId', message: 'Choose a generator provider.' });
    else if (!generator) issues.push({ field: 'generatorProviderId', message: 'Generator provider is unavailable.' });
    if (!form.generatorModel) issues.push({ field: 'generatorModel', message: 'Choose a generator model.' });
    else if (!generator || !Object.hasOwn(generator.models, form.generatorModel)) issues.push({ field: 'generatorModel', message: 'Generator model is unavailable.' });
    if (!form.targetProviderId) issues.push({ field: 'targetProviderId', message: 'Choose a target provider.' });
    else if (!target) issues.push({ field: 'targetProviderId', message: 'Target provider is unavailable.' });
    if (!form.targetModel) issues.push({ field: 'targetModel', message: 'Choose a target model.' });
    else if (!target || !Object.hasOwn(target.models, form.targetModel)) issues.push({ field: 'targetModel', message: 'Target model is unavailable.' });
  }
  return issues;
}

export const getCreationReadinessIssues = creationReadinessIssues;

export function isSuiteCreationReady(form: SuiteCreationForm, options: SuiteCreationOptions): boolean {
  return creationReadinessIssues(form, options).length === 0;
}

export function generationFingerprint(form: SuiteCreationForm): string {
  return JSON.stringify({
    mode: form.mode,
    name: form.name.trim(),
    serverId: form.serverId,
    generatorProviderId: form.generatorProviderId,
    generatorModel: form.generatorModel,
    targetProviderId: form.targetProviderId,
    targetModel: form.targetModel,
    authorInstructions: form.authorInstructions.trim(),
  });
}

export type GenerationRequestGuard = {
  sessionId: number;
  requestId: string;
  fingerprint: string;
};

export type SuiteCreationReview = {
  fingerprint: string;
  result: SuiteGenerationDraft;
};

export type SuiteCreationSession = {
  open: boolean;
  sessionId: number;
  form: SuiteCreationForm;
  activeRequest?: GenerationRequestGuard;
  review?: SuiteCreationReview;
  requestError?: string;
};

export type SuiteCreationAction =
  | { type: 'open'; form?: SuiteCreationForm }
  | { type: 'close' }
  | { type: 'formChanged'; changes: Partial<SuiteCreationForm> }
  | { type: 'generationStarted'; guard: GenerationRequestGuard }
  | { type: 'generationSucceeded'; guard: GenerationRequestGuard; result: SuiteGenerationDraft }
  | { type: 'generationFailed'; guard: GenerationRequestGuard; message: string }
  | { type: 'generatedApplied' };

export function createSuiteCreationSession(form = createSuiteCreationForm()): SuiteCreationSession {
  return { open: false, sessionId: 0, form };
}

export function generationRequestGuard(state: SuiteCreationSession, requestId: string): GenerationRequestGuard {
  if (!state.open) throw new Error('Suite creation session is closed');
  return { sessionId: state.sessionId, requestId, fingerprint: generationFingerprint(state.form) };
}

export function canAcceptGenerationResult(state: SuiteCreationSession, guard: GenerationRequestGuard): boolean {
  const activeRequest = state.activeRequest;
  return state.open
    && state.sessionId === guard.sessionId
    && activeRequest !== undefined
    && activeRequest.requestId === guard.requestId
    && activeRequest.sessionId === guard.sessionId
    && activeRequest.fingerprint === guard.fingerprint
    && generationFingerprint(state.form) === guard.fingerprint;
}

export function creationSessionReducer(state: SuiteCreationSession, action: SuiteCreationAction): SuiteCreationSession {
  switch (action.type) {
    case 'open':
      return {
        open: true,
        sessionId: state.sessionId + 1,
        form: action.form ?? state.form,
      };
    case 'close':
      return { open: false, sessionId: state.sessionId + 1, form: state.form };
    case 'formChanged':
      return {
        ...state,
        form: { ...state.form, ...action.changes },
        activeRequest: undefined,
        review: undefined,
        requestError: undefined,
      };
    case 'generationStarted':
      if (!state.open || action.guard.sessionId !== state.sessionId || action.guard.fingerprint !== generationFingerprint(state.form)) return state;
      return { ...state, activeRequest: action.guard, review: undefined, requestError: undefined };
    case 'generationSucceeded':
      if (!canAcceptGenerationResult(state, action.guard)) return state;
      return {
        ...state,
        activeRequest: undefined,
        review: { fingerprint: action.guard.fingerprint, result: action.result },
        requestError: undefined,
      };
    case 'generationFailed':
      if (!canAcceptGenerationResult(state, action.guard)) return state;
      return { ...state, activeRequest: undefined, review: undefined, requestError: action.message };
    case 'generatedApplied':
      return { ...state, activeRequest: undefined, review: undefined, requestError: undefined };
  }
}

export type SuiteDocumentLoadGuard = { requestId: string; name: string };

type SuiteDocumentBaseline = {
  source: string;
  draftSource: string;
};

export type SuiteDocumentState = {
  draft: SuiteDraft;
  source: string;
  selectedName?: string;
  savedName?: string;
  baseline?: SuiteDocumentBaseline;
  loading?: SuiteDocumentLoadGuard;
  sourceError?: string;
  loadError?: string;
};

function unsavedSuiteDocument(draft: SuiteDraftV2): SuiteDocumentState {
  return { draft, source: serializeSuiteDraft(draft) };
}

export function createManualSuiteDocument(form: Pick<SuiteCreationForm, 'name' | 'serverId'>): SuiteDocumentState {
  return unsavedSuiteDocument(createSuiteDraft(form.name.trim(), form.serverId));
}

export function createGeneratedSuiteDocument(result: SuiteGenerationDraft): SuiteDocumentState {
  return unsavedSuiteDocument(upgradeSuiteDraftToV2(result.suite));
}

export function applyGeneratedSuiteReview(state: SuiteCreationSession): {
  session: SuiteCreationSession;
  document: SuiteDocumentState;
} | undefined {
  if (!state.review || state.review.fingerprint !== generationFingerprint(state.form)) return undefined;
  return {
    session: creationSessionReducer(state, { type: 'generatedApplied' }),
    document: createGeneratedSuiteDocument(state.review.result),
  };
}

export function createSuiteDocument(source: string, savedName?: string): SuiteDocumentState {
  const draft = parseSuiteDraft(source);
  if (!savedName) return { draft, source };
  return {
    draft,
    source,
    selectedName: savedName,
    savedName,
    baseline: { source, draftSource: serializeSuiteDraft(draft) },
  };
}

export function updateSuiteDocumentSource(state: SuiteDocumentState, source: string): SuiteDocumentState {
  return { ...state, source, sourceError: undefined, loadError: undefined };
}

export function applySuiteDocumentSource(state: SuiteDocumentState): SuiteDocumentState {
  try {
    return { ...state, draft: parseSuiteDraft(state.source), sourceError: undefined };
  } catch (error) {
    return { ...state, sourceError: error instanceof Error ? error.message : String(error) };
  }
}

export function replaceSuiteDocumentDraft(state: SuiteDocumentState, draft: SuiteDraft): SuiteDocumentState {
  return { ...state, draft, source: serializeSuiteDraft(draft), sourceError: undefined, loadError: undefined };
}

export function suiteDocumentSourceDirty(state: SuiteDocumentState): boolean {
  return state.baseline === undefined || state.source !== state.baseline.source;
}

export function suiteDocumentDraftDirty(state: SuiteDocumentState): boolean {
  return state.baseline === undefined || serializeSuiteDraft(state.draft) !== state.baseline.draftSource;
}

export function isSuiteDocumentDirty(state: SuiteDocumentState): boolean {
  return suiteDocumentSourceDirty(state) || suiteDocumentDraftDirty(state);
}

export function canRunSuiteDocument(state: SuiteDocumentState): boolean {
  return state.loading === undefined
    && state.sourceError === undefined
    && state.savedName !== undefined
    && state.selectedName === state.savedName
    && !isSuiteDocumentDirty(state);
}

export function beginSuiteDocumentLoad(state: SuiteDocumentState, name: string, requestId: string): SuiteDocumentState {
  return {
    ...state,
    selectedName: name,
    loading: { requestId, name },
    sourceError: undefined,
    loadError: undefined,
  };
}

export function failSuiteDocumentLoad(state: SuiteDocumentState, guard: SuiteDocumentLoadGuard, message: string): SuiteDocumentState {
  if (state.loading?.requestId !== guard.requestId || state.loading.name !== guard.name || state.selectedName !== guard.name) return state;
  return { ...state, selectedName: state.savedName, loading: undefined, sourceError: undefined, loadError: message };
}

export function completeSuiteDocumentLoad(
  state: SuiteDocumentState,
  guard: SuiteDocumentLoadGuard,
  detail: { name: string; source: string },
): SuiteDocumentState {
  if (state.loading?.requestId !== guard.requestId || state.loading.name !== guard.name || state.selectedName !== guard.name || detail.name !== guard.name) return state;
  try {
    const draft = parseSuiteDraft(detail.source);
    return {
      draft,
      source: detail.source,
      selectedName: detail.name,
      savedName: detail.name,
      baseline: { source: detail.source, draftSource: serializeSuiteDraft(draft) },
    };
  } catch (error) {
    return failSuiteDocumentLoad(state, guard, error instanceof Error ? error.message : String(error));
  }
}

export type SuiteDocumentSaveSnapshot = { source: string; draftSource: string };

export function suiteDocumentSaveSnapshot(state: SuiteDocumentState): SuiteDocumentSaveSnapshot {
  return { source: state.source, draftSource: serializeSuiteDraft(state.draft) };
}

export function markSuiteDocumentSaved(
  state: SuiteDocumentState,
  name: string,
  source = state.source,
  snapshot = suiteDocumentSaveSnapshot(state),
): SuiteDocumentState {
  const parsed = parseSuiteDraft(source);
  const draftSource = serializeSuiteDraft(parsed);
  const changedAfterSnapshot = state.source !== snapshot.source || serializeSuiteDraft(state.draft) !== snapshot.draftSource;
  if (changedAfterSnapshot) {
    return {
      ...state,
      selectedName: name,
      savedName: name,
      baseline: { source, draftSource },
      sourceError: undefined,
      loadError: undefined,
    };
  }
  return {
    draft: parsed,
    source,
    selectedName: name,
    savedName: name,
    baseline: { source, draftSource },
  };
}
