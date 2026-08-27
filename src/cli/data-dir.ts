import { resolve } from 'node:path';

export const DEFAULT_DATA_DIRECTORY = '.mcp-riksa';
export const DATA_DIRECTORY_ENVIRONMENT_VARIABLE = 'MCP_RIKSA_DATA_HOME';

export function resolveDataDirectory(explicit?: string, environment: NodeJS.ProcessEnv = process.env): string {
  const configured = explicit?.trim() || environment[DATA_DIRECTORY_ENVIRONMENT_VARIABLE]?.trim() || DEFAULT_DATA_DIRECTORY;
  return resolve(configured);
}

export const dataDirectoryOptionDescription = `runtime data directory (default: $${DATA_DIRECTORY_ENVIRONMENT_VARIABLE} or ${DEFAULT_DATA_DIRECTORY})`;

export function dataDirectoryStartupMessage(dataDirectory: string): string {
  return `MCP Riksa data: ${dataDirectory}`;
}
