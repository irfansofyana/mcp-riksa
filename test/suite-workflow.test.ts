import { describe, expect, test } from 'vitest';
import {
  applyGeneratedSuiteReview,
  applySuiteDocumentSource,
  beginSuiteDocumentLoad,
  canAcceptGenerationResult,
  canRunSuiteDocument,
  completeSuiteDocumentLoad,
  createGeneratedSuiteDocument,
  createManualSuiteDocument,
  createSuiteCreationForm,
  createSuiteCreationSession,
  createSuiteDocument,
  creationReadinessIssues,
  creationSessionReducer,
  generationFingerprint,
  generationRequestGuard,
  isSuiteDocumentDirty,
  failSuiteDocumentLoad,
  markSuiteDocumentSaved,
  replaceSuiteDocumentDraft,
  suiteDocumentSaveSnapshot,
  suggestSuiteNameFromServerId,
  updateSuiteDocumentSource,
} from '../web/src/suite-workflow.js';
import type { SuiteGenerationDraft } from '../web/src/types.js';

const options = {
  servers: [
    { id: 'connected', connected: true },
    { id: 'offline', connected: false },
  ],
  providers: [
    { id: 'generator', models: { author: {} } },
    { id: 'target', models: { runtime: {} } },
  ],
  suiteNames: ['existing-suite'],
};

const generated: SuiteGenerationDraft = {
  suite: {
    version: 2,
    name: 'generated-suite',
    cases: [{
      id: 'agent', kind: 'agent', server: 'connected', provider: 'target', model: 'runtime',
      turns: [{ id: 'turn-1', user: 'Look up Ada', assertions: [] }],
      iterations: { count: 1, minPasses: 1 },
      limits: { maxTurns: 2, maxToolCalls: 1, timeoutMs: 5_000 }, assertions: [],
    }],
  },
  coverage: [{ tool: 'lookup', caseId: 'agent' }],
  exclusions: [],
};

describe('suite creation workflow', () => {
  test('suggests a filename-safe suite name from an arbitrary server ID', () => {
    expect(suggestSuiteNameFromServerId('  Customer API / Production  ')).toBe('customer-api-production-suite');
    expect(suggestSuiteNameFromServerId('***')).toBe('mcp-suite');
    expect(suggestSuiteNameFromServerId('9'.repeat(200)).length).toBeLessThanOrEqual(128);
  });

  test('reports visible field issues with mode-specific generation requirements', () => {
    const manual = createSuiteCreationForm({ serverId: 'connected', name: 'manual-suite' });
    expect(creationReadinessIssues(manual, options)).toEqual([]);
    expect(creationReadinessIssues({ ...manual, name: 'Existing-Suite' }, options)).toContainEqual({
      field: 'name', message: 'A saved suite already uses this name. Choose another.',
    });

    const generatedForm = { ...manual, mode: 'generated' as const };
    expect(creationReadinessIssues(generatedForm, options)).toEqual(expect.arrayContaining([
      { field: 'generatorProviderId', message: 'Choose a generator provider.' },
      { field: 'generatorModel', message: 'Choose a generator model.' },
      { field: 'targetProviderId', message: 'Choose a target provider.' },
      { field: 'targetModel', message: 'Choose a target model.' },
    ]));
    expect(creationReadinessIssues({ ...manual, serverId: 'offline' }, options)).toEqual([]);
    expect(creationReadinessIssues({ ...generatedForm, serverId: 'offline' }, options)).toContainEqual({
      field: 'serverId', message: 'Choose a connected MCP server for generation.',
    });
  });

  test('uses a stable generation fingerprint and invalidates review when form changes', () => {
    const form = createSuiteCreationForm({
      mode: 'generated', name: 'catalog', serverId: 'connected',
      generatorProviderId: 'generator', generatorModel: 'author', targetProviderId: 'target', targetModel: 'runtime',
    });
    expect(generationFingerprint(form)).toBe(generationFingerprint({ ...form }));
    expect(generationFingerprint({ ...form, targetModel: 'other' })).not.toBe(generationFingerprint(form));

    let state = creationSessionReducer(createSuiteCreationSession(form), { type: 'open' });
    const guard = generationRequestGuard(state, 'request-1');
    state = creationSessionReducer(state, { type: 'generationStarted', guard });
    state = creationSessionReducer(state, { type: 'generationSucceeded', guard, result: generated });
    expect(state.review?.result).toBe(generated);

    state = creationSessionReducer(state, { type: 'formChanged', changes: { name: 'catalog-next' } });
    expect(state.review).toBeUndefined();
    expect(state.activeRequest).toBeUndefined();
  });

  test('rejects late generation after close, reopen, or form change and consumes applied result', () => {
    const form = createSuiteCreationForm({ mode: 'generated', name: 'catalog', serverId: 'connected' });
    const opened = creationSessionReducer(createSuiteCreationSession(form), { type: 'open' });
    const lateGuard = generationRequestGuard(opened, 'request-1');
    const started = creationSessionReducer(opened, { type: 'generationStarted', guard: lateGuard });
    const reopened = creationSessionReducer(creationSessionReducer(started, { type: 'close' }), { type: 'open' });
    expect(canAcceptGenerationResult(reopened, lateGuard)).toBe(false);
    expect(creationSessionReducer(reopened, { type: 'generationSucceeded', guard: lateGuard, result: generated }).review).toBeUndefined();

    const currentGuard = generationRequestGuard(reopened, 'request-2');
    const changed = creationSessionReducer(
      creationSessionReducer(reopened, { type: 'generationStarted', guard: currentGuard }),
      { type: 'formChanged', changes: { authorInstructions: 'Use tenant demo.' } },
    );
    expect(canAcceptGenerationResult(changed, currentGuard)).toBe(false);

    const finalGuard = generationRequestGuard(changed, 'request-3');
    const reviewed = creationSessionReducer(
      creationSessionReducer(changed, { type: 'generationStarted', guard: finalGuard }),
      { type: 'generationSucceeded', guard: finalGuard, result: generated },
    );
    const applied = applyGeneratedSuiteReview(reviewed);
    expect(applied?.session.review).toBeUndefined();
    expect(applied?.session.activeRequest).toBeUndefined();
    expect(applied?.document.draft.version).toBe(2);
    expect(applied?.document.savedName).toBeUndefined();
  });
});

describe('suite document workflow', () => {
  test('creates manual and generated work as unsaved v2 documents', () => {
    const form = createSuiteCreationForm({ name: 'manual-suite', serverId: 'connected' });
    const manual = createManualSuiteDocument(form);
    const fromGeneration = createGeneratedSuiteDocument(generated);
    expect(manual.draft.version).toBe(2);
    expect(fromGeneration.draft.version).toBe(2);
    expect(manual.savedName).toBeUndefined();
    expect(fromGeneration.savedName).toBeUndefined();
    expect(isSuiteDocumentDirty(manual)).toBe(true);
    expect(isSuiteDocumentDirty(fromGeneration)).toBe(true);
    expect(canRunSuiteDocument(manual)).toBe(false);
  });

  test('tracks baseline/source dirtiness and only runs an unchanged saved document', () => {
    const source = `version: 2\nname: saved\ncases:\n  - id: direct\n    kind: direct\n    server: connected\n    call: { tool: lookup, arguments: {} }\n    assertions: []\n`;
    const document = createSuiteDocument(source, 'saved');
    expect(isSuiteDocumentDirty(document)).toBe(false);
    expect(canRunSuiteDocument(document)).toBe(true);
    const edited = updateSuiteDocumentSource(document, `${source}\n# local edit\n`);
    expect(isSuiteDocumentDirty(edited)).toBe(true);
    expect(canRunSuiteDocument(edited)).toBe(false);
  });

  test('preserves YAML source and prior parsed draft until parsing succeeds', () => {
    const source = `version: 2\nname: saved\ncases:\n  - id: direct\n    kind: direct\n    server: connected\n    call: { tool: lookup, arguments: {} }\n    assertions: []\n`;
    const document = createSuiteDocument(source, 'saved');
    const invalidSource = 'version: 2\nname: changed\ncases: nope\n';
    const invalid = applySuiteDocumentSource(updateSuiteDocumentSource(document, invalidSource));
    expect(invalid.source).toBe(invalidSource);
    expect(invalid.draft.name).toBe('saved');
    expect(invalid.sourceError).toMatch(/version: 1 or 2/i);

    const validSource = source.replace('name: saved', 'name: changed');
    const valid = applySuiteDocumentSource(updateSuiteDocumentSource(invalid, validSource));
    expect(valid.source).toBe(validSource);
    expect(valid.draft.name).toBe('changed');
    expect(valid.sourceError).toBeUndefined();
  });

  test('keeps edits made after a save snapshot dirty instead of overwriting them', () => {
    const source = `version: 2\nname: saved\ncases:\n  - id: direct\n    kind: direct\n    server: connected\n    call: { tool: lookup, arguments: {} }\n    assertions: []\n`;
    const original = createSuiteDocument(source, 'saved');
    const saveSource = original.source;
    const saveSnapshot = suiteDocumentSaveSnapshot(original);
    const editedDraft = { ...original.draft, description: 'Edited while saving' };
    const edited = replaceSuiteDocumentDraft(original, editedDraft);
    const completed = markSuiteDocumentSaved(edited, 'saved', saveSource, saveSnapshot);
    expect(completed.draft.description).toBe('Edited while saving');
    expect(completed.source).toContain('Edited while saving');
    expect(isSuiteDocumentDirty(completed)).toBe(true);
    expect(canRunSuiteDocument(completed)).toBe(false);
  });

  test('marks a semantic YAML save clean using the parsed saved snapshot', () => {
    const source = `version: 2\nname: saved\ncases:\n  - id: direct\n    kind: direct\n    server: connected\n    call: { tool: lookup, arguments: {} }\n    assertions: []\n`;
    const original = createSuiteDocument(source, 'saved');
    const yamlSource = source.replace('tool: lookup', 'tool: search');
    const editing = updateSuiteDocumentSource(original, yamlSource);
    const completed = markSuiteDocumentSaved(editing, 'saved', yamlSource, suiteDocumentSaveSnapshot(editing));
    expect(completed.source).toBe(yamlSource);
    expect(completed.draft.cases[0]).toMatchObject({ kind: 'direct', call: { tool: 'search' } });
    expect(isSuiteDocumentDirty(completed)).toBe(false);
    expect(canRunSuiteDocument(completed)).toBe(true);
  });

  test('rolls failed current loads back to the prior saved identity', () => {
    const source = `version: 2\nname: first\ncases:\n  - id: direct\n    kind: direct\n    server: connected\n    call: { tool: lookup, arguments: {} }\n    assertions: []\n`;
    const original = createSuiteDocument(source, 'first');
    const loading = beginSuiteDocumentLoad(original, 'second', 'load-2');
    const failed = failSuiteDocumentLoad(loading, { requestId: 'load-2', name: 'second' }, 'Could not load second');
    expect(failed.selectedName).toBe('first');
    expect(failed.savedName).toBe('first');
    expect(failed.loading).toBeUndefined();
    expect(failed.sourceError).toBeUndefined();
    expect(failed.loadError).toBe('Could not load second');
    expect(canRunSuiteDocument(failed)).toBe(true);
  });

  test('rolls parser failures during load back to the prior saved identity', () => {
    const source = `version: 2\nname: first\ncases:\n  - id: direct\n    kind: direct\n    server: connected\n    call: { tool: lookup, arguments: {} }\n    assertions: []\n`;
    const original = createSuiteDocument(source, 'first');
    const loading = beginSuiteDocumentLoad(original, 'second', 'load-2');
    const failed = completeSuiteDocumentLoad(loading, { requestId: 'load-2', name: 'second' }, {
      name: 'second', source: 'version: 2\nname: second\ncases: nope\n',
    });
    expect(failed.selectedName).toBe('first');
    expect(failed.savedName).toBe('first');
    expect(failed.loading).toBeUndefined();
    expect(failed.sourceError).toBeUndefined();
    expect(failed.loadError).toMatch(/version: 1 or 2/i);
    expect(canRunSuiteDocument(failed)).toBe(true);
  });

  test('only lets current load replace document state', () => {
    const original = createManualSuiteDocument(createSuiteCreationForm({ name: 'draft', serverId: 'connected' }));
    const first = beginSuiteDocumentLoad(original, 'first', 'load-1');
    const second = beginSuiteDocumentLoad(first, 'second', 'load-2');
    const stale = completeSuiteDocumentLoad(second, { requestId: 'load-1', name: 'first' }, {
      name: 'first',
      source: 'version: 2\nname: first\ncases: []\n',
    });
    expect(stale).toBe(second);

    const source = `version: 2\nname: second\ncases:\n  - id: direct\n    kind: direct\n    server: connected\n    call: { tool: lookup, arguments: {} }\n    assertions: []\n`;
    const loaded = completeSuiteDocumentLoad(second, { requestId: 'load-2', name: 'second' }, { name: 'second', source });
    expect(loaded.draft.name).toBe('second');
    expect(loaded.savedName).toBe('second');
    expect(canRunSuiteDocument(loaded)).toBe(true);
  });
});
