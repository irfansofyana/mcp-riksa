import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { ServersPage } from '../web/src/pages/ServersPage.js';
import { SettingsPage } from '../web/src/pages/SettingsPage.js';
import type { ProviderSummary, ServerSummary, WorkspaceSummary } from '../web/src/types.js';

const workspace: WorkspaceSummary = {
  configPath: '/repo/mcp-riksa.config.yaml',
  suiteDirectory: '/repo/suites',
  configReadOnly: true,
};

const server: ServerSummary = {
  id: 'notion',
  name: 'Notion MCP',
  source: 'repository',
  transport: 'http',
  url: 'https://mcp.notion.com/mcp',
  headerEnv: {},
  headers: {},
  allowUnsafeEndpoint: false,
  oauth: { scopes: [], timeoutMs: 120_000 },
};

const provider: ProviderSummary = {
  id: 'openai',
  name: 'OpenAI',
  source: 'repository',
  type: 'openai-compatible',
  baseUrl: 'https://api.openai.com/v1',
  models: { default: { id: 'gpt-4o-mini', pricing: { inputPerMillion: 0, outputPerMillion: 0 } } },
  headerEnv: {},
  headers: {},
};

const refresh = async () => undefined;

describe('repository workspace UI', () => {
  test('keeps operational server actions but removes repository configuration mutations', () => {
    const html = renderToStaticMarkup(createElement(ServersPage, {
      servers: [server],
      conformanceReports: [],
      workspace,
      onRefresh: refresh,
      onConformanceStarted: () => undefined,
    }));
    expect(html).toContain('Repository configuration');
    expect(html).toContain('repository config');
    expect(html).toContain('Connect &amp; inspect');
    expect(html).toContain('Connect with OAuth');
    expect(html).not.toContain('Create server');
    expect(html).not.toContain('>Edit<');
    expect(html).not.toContain('>Delete<');
  });

  test('keeps provider testing but removes repository configuration mutations', () => {
    const html = renderToStaticMarkup(createElement(SettingsPage, { providers: [provider], workspace, onRefresh: refresh }));
    expect(html).toContain('Repository configuration');
    expect(html).toContain('repository config');
    expect(html).toContain('>Test<');
    expect(html).not.toContain('Create provider');
    expect(html).not.toContain('>Edit<');
    expect(html).not.toContain('>Delete<');
  });
});
