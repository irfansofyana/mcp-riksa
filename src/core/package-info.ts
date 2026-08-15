import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Walk up from a module's own directory until a package.json is found.
// A fixed relative depth would differ between the TypeScript source tree
// (src/**) and the compiled tree (dist/src/**), and resolving against
// process.cwd() would break once mcp-riksa is installed globally or run
// via npx from another working directory.
function findPackageRoot(startDirectory: string): string {
  let current = startDirectory;
  while (true) {
    if (existsSync(join(current, 'package.json'))) return current;
    const parent = dirname(current);
    if (parent === current) throw new Error(`Could not locate package.json above ${startDirectory}`);
    current = parent;
  }
}

let cachedVersion: string | undefined;
let cachedRoot: string | undefined;

/**
 * The running package's own root directory, located by walking up from
 * this module's own directory until a package.json is found. A fixed
 * relative depth would differ between the TypeScript source tree (src/**)
 * and the compiled tree (dist/src/**), and resolving against
 * process.cwd() would break once mcp-riksa is installed globally or run
 * via npx from another working directory.
 */
export function packageRoot(): string {
  if (cachedRoot !== undefined) return cachedRoot;
  cachedRoot = findPackageRoot(dirname(fileURLToPath(import.meta.url)));
  return cachedRoot;
}

/**
 * The running package's own version, read from its package.json rather
 * than hard-coded, so `npm version` (which only bumps package.json) keeps
 * `mcp-riksa --version` and the MCP client identity in sync automatically.
 */
export function packageVersion(): string {
  if (cachedVersion !== undefined) return cachedVersion;
  const root = packageRoot();
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: unknown };
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new Error(`package.json at ${root} is missing a valid "version" field`);
  }
  cachedVersion = manifest.version;
  return cachedVersion;
}
