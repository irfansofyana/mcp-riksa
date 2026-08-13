import { useCallback, useEffect, useState } from 'react';
import { initialize, api } from './api.js';
import { Notice } from './components.js';
import { normalizePage, pages, type Page } from './model.js';
import { ComparePage } from './pages/ComparePage.js';
import { PlaygroundPage } from './pages/PlaygroundPage.js';
import { RunsPage } from './pages/RunsPage.js';
import { ServersPage } from './pages/ServersPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { SuitesPage } from './pages/SuitesPage.js';
import type { Bootstrap } from './types.js';

export function App() {
  const [page, setPage] = useState<Page>(() => normalizePage(window.location.hash));
  const [data, setData] = useState<Bootstrap>();
  const [error, setError] = useState('');
  const [selectedRun, setSelectedRun] = useState<string>();

  const refresh = useCallback(async () => {
    try { setData(await api.refresh()); setError(''); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }, []);

  useEffect(() => {
    let active = true;
    void initialize().then((value) => { if (active) setData(value); }).catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); });
    const onHash = () => setPage(normalizePage(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => { active = false; window.removeEventListener('hashchange', onHash); };
  }, []);

  const navigate = (next: Page) => {
    window.location.hash = `/${next.toLowerCase()}`;
    setPage(next);
  };

  return <div className="app-shell">
    <header className="topbar">
      <a className="brand" href="#/servers"><span className="brand-mark">M</span><span>MCP Local Workbench</span></a>
      <div className="top-status"><span><i className="live-dot" /> Local mode</span><span>Sanitized before storage</span></div>
    </header>
    <aside className="nav-rail" aria-label="Primary navigation">
      <nav>{pages.map((entry) => <a key={entry} href={`#/${entry.toLowerCase()}`} className={page === entry ? 'active' : ''} aria-current={page === entry ? 'page' : undefined}><i />{entry}</a>)}</nav>
      <div className="rail-note"><b>Security boundary</b><span>Loopback · session token · Origin checked</span></div>
    </aside>
    <section className="main-area">
      <header className="page-heading"><div><h1>{page}</h1><p>{page === 'Servers' ? 'Connect, discover, authorize, and invoke.' : page === 'Playground' ? 'Observe every model and tool turn.' : page === 'Suites' ? 'Portable YAML regression cases.' : page === 'Runs' ? 'Inspect evidence, not summaries.' : page === 'Compare' ? 'Measure movement between runs.' : 'Model Providers and local security.'}</p></div><span className="version">v0.1.0</span></header>
      {error ? <Notice error>{error}</Notice> : null}
      {!data ? <div className="loading"><i />Opening the local workbench…</div> : <>
        {page === 'Servers' ? <ServersPage servers={data.servers} onRefresh={refresh} /> : null}
        {page === 'Playground' ? <PlaygroundPage servers={data.servers} providers={data.providers} onRefresh={refresh} /> : null}
        {page === 'Suites' ? <SuitesPage suites={data.suites} onRefresh={refresh} onRunStarted={(id) => { setSelectedRun(id); void refresh(); navigate('Runs'); }} /> : null}
        {page === 'Runs' ? <RunsPage runs={data.runs} {...(selectedRun === undefined ? {} : { initialId: selectedRun })} onRefresh={refresh} /> : null}
        {page === 'Compare' ? <ComparePage runs={data.runs} /> : null}
        {page === 'Settings' ? <SettingsPage providers={data.providers} onRefresh={refresh} /> : null}
      </>}
    </section>
    <footer className="statusbar"><span><i className="live-dot" /> Local API</span><span>OAuth: PKCE + DCR ready</span><span>No telemetry</span></footer>
  </div>;
}
