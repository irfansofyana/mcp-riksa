#!/usr/bin/env node
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Command } from 'commander';
import type { RequestHandler } from 'express';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { createApp } from '../server/app.js';
import { WorkbenchRuntime } from '../server/runtime.js';
import { McpManager, serverConfigSchema, type ServerConfig } from '../mcp/manager.js';
import { providerConfigSchema, type ProviderConfig } from '../agent/types.js';
import { reportJson } from '../reporters/json.js';
import { reportHtml } from '../reporters/html.js';
import { reportJunit } from '../reporters/junit.js';
import { redact } from '../core/redaction.js';
import type { RunResult } from '../core/types.js';

const configurationSchema = z.strictObject({
  version: z.literal(1),
  servers: z.array(serverConfigSchema).default([]),
  providers: z.array(providerConfigSchema).default([]),
});

type WorkbenchConfiguration = { version: 1; servers: ServerConfig[]; providers: ProviderConfig[] };

function loadConfiguration(path?: string): WorkbenchConfiguration {
  if (!path) return { version: 1, servers: [], providers: [] };
  return configurationSchema.parse(parseYaml(readFileSync(resolve(path), 'utf8'))) as WorkbenchConfiguration;
}

function sampleConfiguration(): ServerConfig {
  const compiled = resolve('dist/examples/sample-mcp-server.js');
  if (existsSync(compiled)) {
    return { id: 'sample', name: 'Deterministic sample', transport: 'stdio', command: process.execPath, args: [compiled], envRefs: {} };
  }
  return {
    id: 'sample', name: 'Deterministic sample', transport: 'stdio', command: process.execPath,
    args: [resolve('node_modules/tsx/dist/cli.mjs'), resolve('examples/sample-mcp-server.ts')], envRefs: {},
  };
}

async function applyConfiguration(runtime: WorkbenchRuntime, config: WorkbenchConfiguration, overwrite = true): Promise<void> {
  for (const provider of config.providers) {
    if (overwrite) await runtime.addProvider(provider); else await runtime.seedProvider(provider);
  }
  for (const server of config.servers) {
    if (overwrite) await runtime.addServer(server); else await runtime.seedServer(server);
  }
}

async function waitForRun(runtime: WorkbenchRuntime, id: string): Promise<RunResult> {
  while (true) {
    const run = await runtime.getRun(id);
    if (run && run.status !== 'running') return run as RunResult;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
}

const program = new Command()
  .name('mcp-workbench')
  .description('Local-first MCP evaluation workbench')
  .version('0.1.0');

program.command('inspect')
  .description('Inspect an MCP server and print its identity, capabilities and tool schemas')
  .option('--sample', 'inspect the deterministic sample stdio server')
  .option('--config <path>', 'workbench YAML configuration')
  .option('--server <id>', 'server alias from configuration')
  .option('--json', 'emit JSON')
  .action(async (options: { sample?: boolean; config?: string; server?: string; json?: boolean }) => {
    const config = loadConfiguration(options.config);
    const selected = options.sample ? sampleConfiguration() : config.servers.find((entry) => entry.id === options.server);
    if (!selected) throw new Error('Choose --sample or provide --config and --server');
    const manager = new McpManager();
    try {
      const inspection = await manager.connect(selected);
      process.stdout.write(options.json ? `${JSON.stringify(inspection, null, 2)}\n` : `${selected.name}: ${inspection.tools.length} tools\n`);
    } finally {
      await manager.closeAll();
    }
  });

program.command('run')
  .description('Run a portable YAML suite headlessly')
  .argument('<suite>', 'suite YAML path')
  .option('--config <path>', 'workbench YAML configuration')
  .option('--sample', 'register the deterministic sample stdio server')
  .option('--data-dir <path>', 'runtime data directory', '.workbench/cli')
  .option('--output <path>', 'report output directory', 'reports')
  .action(async (suitePath: string, options: { config?: string; sample?: boolean; dataDir: string; output: string }) => {
    const dataDirectory = resolve(options.dataDir);
    mkdirSync(dataDirectory, { recursive: true });
    const runtime = new WorkbenchRuntime({
      databasePath: join(dataDirectory, 'workbench.db'),
      suiteDirectory: join(dataDirectory, 'suites'),
      callbackUrl: 'http://127.0.0.1:4317/api/oauth/callback',
    });
    try {
      const config = loadConfiguration(options.config);
      if (options.sample) config.servers.push(sampleConfiguration());
      await applyConfiguration(runtime, config);
      for (const server of config.servers) await runtime.connectServer(server.id);
      const source = readFileSync(resolve(suitePath), 'utf8');
      const saved = await runtime.saveSuite(source);
      const started = await runtime.startSuite(saved.name);
      const run = await waitForRun(runtime, started.id);
      const output = resolve(options.output);
      mkdirSync(output, { recursive: true });
      writeFileSync(join(output, 'run.json'), reportJson(run), { mode: 0o600 });
      writeFileSync(join(output, 'run.html'), reportHtml(run), { mode: 0o600 });
      writeFileSync(join(output, 'junit.xml'), reportJunit(run), { mode: 0o600 });
      process.stdout.write(reportJson(run));
      if (run.status !== 'passed') process.exitCode = 1;
    } finally {
      await runtime.close();
    }
  });

program.command('serve')
  .description('Start the loopback browser workbench')
  .option('--host <host>', 'bind host', '127.0.0.1')
  .option('--port <port>', 'bind port', (value) => Number.parseInt(value, 10), 4317)
  .option('--data-dir <path>', 'runtime data directory', '.workbench')
  .option('--config <path>', 'workbench YAML configuration')
  .option('--allow-external', 'explicitly permit a non-loopback bind')
  .option('--dev', 'serve the Vite development UI')
  .action(async (options: { host: string; port: number; dataDir: string; config?: string; allowExternal?: boolean; dev?: boolean }) => {
    const loopback = ['127.0.0.1', 'localhost', '::1'].includes(options.host);
    if (!loopback && !options.allowExternal) throw new Error('External bind requires --allow-external');
    const dataDirectory = resolve(options.dataDir);
    mkdirSync(dataDirectory, { recursive: true });
    const runtime = new WorkbenchRuntime({
      databasePath: join(dataDirectory, 'workbench.db'),
      suiteDirectory: join(dataDirectory, 'suites'),
      callbackUrl: `http://127.0.0.1:${options.port}/api/oauth/callback`,
    });
    await applyConfiguration(runtime, loadConfiguration(options.config), false);
    const staticDirectory = options.dev ? undefined : resolve('dist/web');
    const app = createApp(runtime, { ...(staticDirectory === undefined ? {} : { staticDirectory }) });
    let vite: { middlewares: RequestHandler; close(): Promise<void> } | undefined;
    if (options.dev) {
      const viteModule = await import('vite');
      vite = await viteModule.createServer({ root: resolve('web'), server: { middlewareMode: true }, appType: 'spa' });
      app.use(vite.middlewares);
    }
    const server = createServer(app);
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(options.port, options.host, resolveListen);
    });
    const address = server.address();
    const port = address && typeof address !== 'string' ? address.port : options.port;
    process.stdout.write(`MCP Local Workbench listening at http://${options.host}:${port}\n`);
    const shutdown = async () => {
      const serverClose = new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
      const results = await Promise.allSettled([serverClose, vite?.close(), runtime.close()]);
      const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failure) throw failure.reason;
    };
    const stop = () => {
      void shutdown().then(
        () => process.exit(0),
        (error: unknown) => {
          process.stderr.write(`${redact(error instanceof Error ? error.message : String(error))}\n`);
          process.exit(1);
        },
      );
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${redact(message)}\n`);
  process.exitCode = 1;
});
