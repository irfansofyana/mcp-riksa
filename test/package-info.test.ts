import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { packageRoot, packageVersion } from '../src/core/package-info.js';

describe('package-info', () => {
  test('packageVersion reads the running package.json version rather than a hard-coded string', () => {
    const manifest = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string };
    expect(packageVersion()).toBe(manifest.version);
  });

  test('packageRoot resolves to the directory containing package.json', () => {
    expect(packageRoot()).toBe(resolve('.'));
  });
});
