import { existsSync, lstatSync, mkdirSync, realpathSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { DATA_DIRECTORY_ENVIRONMENT_VARIABLE, DEFAULT_DATA_DIRECTORY } from './data-dir.js';

export type ServeWorkspaceOptions = {
  workspace?: string;
  config?: string;
  suitesDir?: string;
  dataDir?: string;
};

export type ServeWorkspace = {
  mode: 'local' | 'repository';
  dataDirectory: string;
  suiteDirectory: string;
  configPath?: string;
  workspaceDirectory?: string;
};

function resolveFrom(cwd: string, value: string): string {
  return resolve(cwd, value);
}

function containsPath(parent: string, child: string): boolean {
  const candidate = relative(parent, child);
  return candidate === '' || (!candidate.startsWith('..') && !isAbsolute(candidate));
}

function assertRepositoryLayout(layout: Required<Pick<ServeWorkspace, 'dataDirectory' | 'suiteDirectory' | 'configPath' | 'workspaceDirectory'>>): void {
  if (!existsSync(layout.workspaceDirectory) || !statSync(layout.workspaceDirectory).isDirectory()) {
    throw new Error(`Workspace directory does not exist: ${layout.workspaceDirectory}`);
  }
  if (!existsSync(layout.configPath) || !statSync(layout.configPath).isFile()) {
    throw new Error(`Workspace configuration does not exist: ${layout.configPath}`);
  }
  if (lstatSync(layout.configPath).isSymbolicLink()) {
    throw new Error(`Workspace configuration cannot be a symbolic link: ${layout.configPath}`);
  }
  if (layout.dataDirectory === layout.workspaceDirectory) {
    throw new Error('Runtime data directory cannot be the workspace root');
  }
  if (containsPath(layout.dataDirectory, layout.suiteDirectory) || containsPath(layout.suiteDirectory, layout.dataDirectory)) {
    throw new Error('Runtime data directory and suite directory cannot overlap in repository mode');
  }
  if (containsPath(layout.dataDirectory, layout.configPath)) {
    throw new Error('Workspace configuration cannot be stored inside the runtime data directory');
  }
}

export function resolveServeWorkspace(
  options: ServeWorkspaceOptions,
  environment: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): ServeWorkspace {
  const configuredDataDirectory = options.dataDir?.trim() || environment[DATA_DIRECTORY_ENVIRONMENT_VARIABLE]?.trim();
  if (options.workspace?.trim()) {
    const workspaceDirectory = resolveFrom(cwd, options.workspace.trim());
    const configPath = options.config?.trim() ? resolveFrom(cwd, options.config.trim()) : join(workspaceDirectory, 'mcp-riksa.config.yaml');
    const suiteDirectory = options.suitesDir?.trim() ? resolveFrom(cwd, options.suitesDir.trim()) : join(workspaceDirectory, 'suites');
    const dataDirectory = configuredDataDirectory ? resolveFrom(cwd, configuredDataDirectory) : join(workspaceDirectory, DEFAULT_DATA_DIRECTORY);
    const layout = { mode: 'repository' as const, workspaceDirectory, configPath, suiteDirectory, dataDirectory };
    assertRepositoryLayout(layout);
    return layout;
  }

  const dataDirectory = resolveFrom(cwd, configuredDataDirectory || DEFAULT_DATA_DIRECTORY);
  return {
    mode: 'local',
    dataDirectory,
    suiteDirectory: options.suitesDir?.trim() ? resolveFrom(cwd, options.suitesDir.trim()) : join(dataDirectory, 'suites'),
    ...(options.config?.trim() ? { configPath: resolveFrom(cwd, options.config.trim()) } : {}),
  };
}

function containsYaml(directory: string): boolean {
  return existsSync(directory) && statSync(directory).isDirectory() && readdirSync(directory).some((name) => name.endsWith('.yaml'));
}

function canonicalCandidate(path: string): string {
  let ancestor = path;
  const missing: string[] = [];
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error(`Cannot resolve path: ${path}`);
    missing.unshift(basename(ancestor));
    ancestor = parent;
  }
  return resolve(realpathSync(ancestor), ...missing);
}

export function prepareServeWorkspace(workspace: ServeWorkspace): ServeWorkspace {
  if (workspace.mode === 'local') {
    mkdirSync(workspace.dataDirectory, { recursive: true });
    mkdirSync(workspace.suiteDirectory, { recursive: true });
    return workspace;
  }
  if (existsSync(workspace.dataDirectory) && lstatSync(workspace.dataDirectory).isSymbolicLink()) {
    throw new Error(`Runtime data directory cannot be a symbolic link: ${workspace.dataDirectory}`);
  }
  if (existsSync(workspace.suiteDirectory) && lstatSync(workspace.suiteDirectory).isSymbolicLink()) {
    throw new Error(`Suite directory cannot be a symbolic link: ${workspace.suiteDirectory}`);
  }

  const candidate = {
    ...workspace,
    workspaceDirectory: realpathSync(workspace.workspaceDirectory!),
    configPath: realpathSync(workspace.configPath!),
    suiteDirectory: canonicalCandidate(workspace.suiteDirectory),
    dataDirectory: canonicalCandidate(workspace.dataDirectory),
  };
  if (containsPath(candidate.dataDirectory, candidate.suiteDirectory) || containsPath(candidate.suiteDirectory, candidate.dataDirectory)) {
    throw new Error('Runtime data directory and suite directory cannot overlap in repository mode');
  }
  if (containsPath(candidate.dataDirectory, candidate.configPath)) {
    throw new Error('Workspace configuration cannot be stored inside the runtime data directory');
  }
  if (containsPath(workspace.workspaceDirectory!, workspace.configPath!)
    && !containsPath(candidate.workspaceDirectory, candidate.configPath)) {
    throw new Error('Workspace configuration cannot escape through a symbolic-link parent');
  }
  if (containsPath(workspace.workspaceDirectory!, workspace.suiteDirectory)
    && !containsPath(candidate.workspaceDirectory, candidate.suiteDirectory)) {
    throw new Error('Suite directory cannot escape the workspace through a symbolic-link parent');
  }
  if (containsPath(workspace.workspaceDirectory!, workspace.dataDirectory)
    && !containsPath(candidate.workspaceDirectory, candidate.dataDirectory)) {
    throw new Error('Runtime data directory cannot escape the workspace through a symbolic-link parent');
  }

  mkdirSync(candidate.dataDirectory, { recursive: true });
  mkdirSync(candidate.suiteDirectory, { recursive: true });
  return {
    ...candidate,
    dataDirectory: realpathSync(candidate.dataDirectory),
    suiteDirectory: realpathSync(candidate.suiteDirectory),
  };
}

export function httpServerOrigin(host: string, port: number): string {
  return `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
}

export function loopbackCallbackUrl(host: string, port: number): string {
  const callbackHost = host === '::1' || host === '::' ? '::1'
    : host === 'localhost' ? 'localhost'
      : '127.0.0.1';
  return `${httpServerOrigin(callbackHost, port)}/api/oauth/callback`;
}

export function serveWorkspaceStartupMessages(workspace: ServeWorkspace): string[] {
  const legacySuiteDirectory = join(workspace.dataDirectory, 'suites');
  const legacySuitesNeedMigration = workspace.mode === 'repository'
    && legacySuiteDirectory !== workspace.suiteDirectory
    && !containsYaml(workspace.suiteDirectory)
    && containsYaml(legacySuiteDirectory);
  return [
    `MCP Riksa mode: ${workspace.mode}`,
    ...(workspace.configPath ? [`MCP Riksa config: ${workspace.configPath}${workspace.mode === 'repository' ? ' (authoritative, read-only)' : ' (seed)'}`] : []),
    `MCP Riksa suites: ${workspace.suiteDirectory}`,
    `MCP Riksa data: ${workspace.dataDirectory}`,
    ...(workspace.mode === 'repository' ? ['MCP Riksa OAuth: process memory only'] : []),
    ...(legacySuitesNeedMigration ? [`MCP Riksa migration: suites exist in ${legacySuiteDirectory}; review and copy them into ${workspace.suiteDirectory}`] : []),
  ];
}
