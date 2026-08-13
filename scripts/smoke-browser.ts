#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';

type CdpResponse = { id?: number; result?: Record<string, unknown>; error?: { message: string }; method?: string; params?: Record<string, unknown> };

class Cdp {
  private id = 0;
  private readonly pending = new Map<number, { resolve(value: Record<string, unknown>): void; reject(reason: Error): void }>();
  private readonly listeners = new Map<string, Array<(params: Record<string, unknown>) => void>>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as CdpResponse;
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result ?? {});
        return;
      }
      if (message.method) for (const listener of this.listeners.get(message.method) ?? []) listener(message.params ?? {});
    });
  }

  static async connect(url: string): Promise<Cdp> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolveOpen, reject) => {
      socket.addEventListener('open', () => resolveOpen(), { once: true });
      socket.addEventListener('error', () => reject(new Error('Could not connect to Chrome DevTools')), { once: true });
    });
    return new Cdp(socket);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = ++this.id;
    return new Promise((resolveSend, reject) => {
      this.pending.set(id, { resolve: resolveSend, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method: string, listener: (params: Record<string, unknown>) => void): void {
    const entries = this.listeners.get(method) ?? [];
    entries.push(listener);
    this.listeners.set(method, entries);
  }

  close(): void { this.socket.close(); }
}

async function startChrome(appUrl: string) {
  const profile = mkdtempSync(join(tmpdir(), 'mcp-workbench-chrome-'));
  const candidates = [process.env.CHROME_BIN, '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter((value): value is string => Boolean(value));
  const executable = candidates.find(existsSync);
  if (!executable) throw new Error('Chrome executable not found; set CHROME_BIN');
  const child = spawn(executable, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--remote-debugging-port=0',
    '--remote-allow-origins=*', `--user-data-dir=${profile}`, '--window-size=1440,1000', appUrl,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const browserWebSocket = await new Promise<string>((resolveSocket, reject) => {
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) resolveSocket(match[1]!);
    });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`Chrome exited ${code}: ${stderr}`)));
  });
  const endpoint = new URL(browserWebSocket);
  let pageWebSocket = '';
  try {
    const created = await (await fetch(`http://${endpoint.host}/json/new?${encodeURIComponent(appUrl)}`, { method: 'PUT' })).json() as { webSocketDebuggerUrl?: string };
    pageWebSocket = created.webSocketDebuggerUrl ?? '';
  } catch { /* Fall back to an existing page target. */ }
  for (let attempt = 0; attempt < 50 && !pageWebSocket; attempt += 1) {
    const targets = await (await fetch(`http://${endpoint.host}/json/list`)).json() as Array<{ type: string; url: string; webSocketDebuggerUrl: string }>;
    pageWebSocket = targets.find((target) => target.type === 'page' && target.url.startsWith(appUrl))?.webSocketDebuggerUrl
      ?? targets.find((target) => target.type === 'page')?.webSocketDebuggerUrl
      ?? '';
    if (pageWebSocket) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  if (!pageWebSocket) throw new Error('Chrome page target not found');
  return { child, profile, cdp: await Cdp.connect(pageWebSocket) };
}

export async function runBrowserSmoke(options: { appUrl: string; providerUrl: string; outputDirectory: string }) {
  const { child, profile, cdp } = await startChrome(options.appUrl);
  const consoleErrors: string[] = [];
  const steps: string[] = [];
  const recordConsoleError = (value: unknown) => {
    const serialized = JSON.stringify(value);
    if (serialized.includes('WebSocket closed without opened') && (serialized.includes('/@vite/client') || serialized.includes('[vite]'))) return;
    consoleErrors.push(serialized);
  };
  cdp.on('Runtime.consoleAPICalled', (params) => {
    if (params.type === 'error') recordConsoleError(params.args ?? []);
  });
  cdp.on('Runtime.exceptionThrown', (params) => recordConsoleError(params.exceptionDetails ?? params));
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

  const evaluate = async <T>(expression: string): Promise<T> => {
    const response = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (response.exceptionDetails) throw new Error(`Browser evaluation failed: ${JSON.stringify(response.exceptionDetails)}`);
    return (response.result as { value?: T } | undefined)?.value as T;
  };
  const wait = async (expression: string, description: string, timeoutMs = 15_000) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (await evaluate<boolean>(`Boolean(${expression})`)) return;
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    const diagnostic = await evaluate<{ hash: string; text: string }>(`({hash:location.hash,text:(document.body.textContent||'').slice(0,4000)})`);
    throw new Error(`Timed out waiting for ${description}; hash=${diagnostic.hash}; body=${diagnostic.text}`);
  };
  const navigate = async (page: string) => {
    await evaluate(`location.hash=${JSON.stringify(`/${page}`)}`);
    await wait(`document.querySelector('.page-heading h1')?.textContent === ${JSON.stringify(page[0]!.toUpperCase() + page.slice(1))}`, `${page} page`);
  };
  const setValue = async (testId: string, value: string) => {
    await wait(`document.querySelector('[data-testid=${JSON.stringify(testId)}]')`, `control ${testId}`);
    await evaluate(`(() => { const el=document.querySelector('[data-testid=${JSON.stringify(testId)}]'); if(!el) throw new Error('missing ${testId}'); const proto=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:el instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(value)}); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  };
  const click = async (testId: string) => {
    await wait(`document.querySelector('[data-testid=${JSON.stringify(testId)}]')`, `control ${testId}`);
    await evaluate(`document.querySelector('[data-testid=${JSON.stringify(testId)}]')?.click()`);
  };
  const clickText = (selector: string, text: string) => evaluate(`([...document.querySelectorAll(${JSON.stringify(selector)})].find((el)=>el.textContent?.includes(${JSON.stringify(text)})))?.click()`);
  const waitText = (text: string, timeoutMs?: number) => wait(`document.body.textContent?.includes(${JSON.stringify(text)})`, `text ${text}`, timeoutMs);

  try {
    await wait(`document.querySelector('.app-shell')`, 'application shell');
    await navigate('settings');
    await setValue('provider-id', 'local');
    await setValue('provider-name', 'Local fake');
    await setValue('provider-url', options.providerUrl);
    await setValue('provider-model', 'test-model');
    await clickText('button', 'Add model');
    await setValue('provider-model-alias-1', 'quality');
    await setValue('provider-model-1', 'test-model');
    await click('save-provider');
    await waitText('Model provider created.');
    await clickText('.provider-card button', 'Edit');
    await setValue('provider-name', 'Local fake updated');
    await click('save-provider');
    await waitText('Model provider updated.');
    mkdirSync(options.outputDirectory, { recursive: true });
    const providersScreenshot = join(options.outputDirectory, 'model-providers.png');
    const providersCapture = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(providersScreenshot, Buffer.from(String(providersCapture.data), 'base64'));
    steps.push('provider-added');

    await navigate('servers');
    await setValue('server-id', 'sample');
    await setValue('server-name', 'Sample MCP');
    await setValue('server-command', process.execPath);
    await setValue('server-args', `${resolve('node_modules/tsx/dist/cli.mjs')} ${resolve('examples/sample-mcp-server.ts')}`);
    await click('save-server');
    await waitText('Server created.');
    await clickText('.config-list-item button', 'Edit');
    await setValue('server-name', 'Sample MCP updated');
    await click('save-server');
    await waitText('Server updated. Reconnect to apply changes.');
    steps.push('server-added');
    await click('connect-server');
    await waitText('Connected and inspected.', 20_000);
    await waitText('dangerous_reset');
    steps.push('server-inspected');

    await setValue('tool-field-a', '2');
    await setValue('tool-field-b', '3');
    await click('invoke-tool');
    await waitText('"sum": 5');
    steps.push('tool-invoked');
    const serverScreenshot = join(options.outputDirectory, 'stdio-server.png');
    const serverCapture = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(serverScreenshot, Buffer.from(String(serverCapture.data), 'base64'));

    await navigate('playground');
    await setValue('playground-server', 'sample');
    await setValue('playground-provider', 'local');
    await setValue('playground-model', 'default');
    await click('run-playground');
    await waitText('The sum is 5', 20_000);
    await wait(`document.querySelector('.chat-message.assistant .markdown-body strong')?.textContent === 'sum is 5'`, 'rendered assistant Markdown');
    steps.push('playground-complete');
    const playgroundScreenshot = join(options.outputDirectory, 'playground.png');
    const playgroundCapture = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(playgroundScreenshot, Buffer.from(String(playgroundCapture.data), 'base64'));
    await clickText('.playground-view-tabs button', 'trace');
    await wait(`document.querySelectorAll('.trace-span').length >= 3`, 'persisted observability trace');
    const playgroundTraceScreenshot = join(options.outputDirectory, 'playground-trace.png');
    const traceCapture = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(playgroundTraceScreenshot, Buffer.from(String(traceCapture.data), 'base64'));
    await setValue('playground-suite-name', 'smoke-agent');
    await click('save-playground-suite');
    await waitText('Interaction saved as a versioned YAML suite.');
    steps.push('suite-saved');

    const runAndInspect = async (step: string) => {
      await navigate('suites');
      await clickText('button', 'smoke-agent');
      await click('run-suite');
      await wait(`document.querySelector('.page-heading h1')?.textContent === 'Runs'`, 'Runs page after suite start');
      for (let attempt = 0; attempt < 80; attempt += 1) {
        await clickText('button', 'Refresh');
        await new Promise((resolveWait) => setTimeout(resolveWait, 150));
        const ready = await evaluate<boolean>(`document.body.textContent?.includes('Model turns & MCP timeline') && document.body.textContent?.includes('passed')`);
        if (ready) { steps.push(step); return; }
      }
      throw new Error('Suite run did not become inspectable');
    };
    await runAndInspect('first-run-inspected');
    await runAndInspect('second-run-inspected');

    const desktopScreenshot = join(options.outputDirectory, 'desktop.png');
    const desktop = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(desktopScreenshot, Buffer.from(String(desktop.data), 'base64'));

    await navigate('compare');
    await click('compare-runs');
    await waitText('Regression ledger');
    await waitText('unchanged');
    steps.push('runs-compared');

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await navigate('runs');
    await wait(`document.documentElement.scrollWidth <= window.innerWidth + 1`, 'mobile layout without horizontal overflow');
    const mobileScreenshot = join(options.outputDirectory, 'mobile.png');
    const mobile = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(mobileScreenshot, Buffer.from(String(mobile.data), 'base64'));
    steps.push('mobile-checked');
    return { steps, consoleErrors, providersScreenshot, serverScreenshot, playgroundScreenshot, playgroundTraceScreenshot, desktopScreenshot, mobileScreenshot };
  } finally {
    cdp.close();
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
    }
    rmSync(profile, { recursive: true, force: true });
  }
}
