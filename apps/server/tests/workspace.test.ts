/**
 * Is this package actually wired into the workspace's gates?
 *
 * `web.md` W0's review found the durable version of this failure: four files
 * left the app's TypeScript project and eslint scope during a move and were
 * typechecked and linted by nothing, while every gate stayed green. A new
 * package is the same shape — the workspace root's eslint config ignores
 * `apps/**`, and `pnpm test` ran one filter — so the wiring is asserted here
 * rather than remembered. There is no CI (`wave-zero.md` §10, ruling 13), so a
 * rule that wants enforcement is a unit test.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE = resolve(PACKAGE, '..', '..');

const read = (path: string): string => readFileSync(resolve(WORKSPACE, path), 'utf8');
const rootScripts = (): Record<string, string> =>
  (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts;

describe('apps/server in the workspace', () => {
  it('is covered by pnpm-workspace.yaml', () => {
    expect(read('pnpm-workspace.yaml')).toMatch(/^\s*-\s*'?apps\/\*'?\s*$/m);
  });

  it('is run by every root gate', () => {
    const scripts = rootScripts();
    for (const gate of ['lint', 'typecheck', 'test', 'build'] as const) {
      expect(scripts[gate], `root ${gate} must reach apps/server`).toMatch(/-F server /);
    }
  });

  it('brings its own eslint config, because the root config ignores apps/**', () => {
    expect(read('eslint.config.mjs')).toMatch(/'apps\/\*\*'/);
    expect(() => readFileSync(resolve(PACKAGE, 'eslint.config.mjs'), 'utf8')).not.toThrow();
  });

  it('declares the same Node floor as the workspace root', () => {
    const pkg = JSON.parse(readFileSync(resolve(PACKAGE, 'package.json'), 'utf8')) as {
      engines?: { node?: string };
    };
    const root = JSON.parse(read('package.json')) as { engines?: { node?: string } };
    expect(pkg.engines?.node).toBe(root.engines?.node);
  });

  it('typechecks its tests and its build scripts, not only src/', () => {
    // tsconfig.build.json emits src/ alone; tsconfig.json is what `typecheck`
    // runs and it has to cover everything, or a test file is a file nothing
    // checks — W0's exact finding.
    const tsconfig = readFileSync(resolve(PACKAGE, 'tsconfig.json'), 'utf8');
    for (const glob of ['src/**/*.ts', 'tests/**/*.ts', 'scripts/**/*.ts']) {
      expect(tsconfig).toContain(glob);
    }
  });

  it('ships no dictionary — B2 removes the server-side copy and B1 must not add a second', () => {
    // Asserted from B0 so that the phase which would break it has to edit this
    // line. `backend.md` B2: "no `lib/dict/**` import remains in apps/server".
    const pkg = JSON.parse(readFileSync(resolve(PACKAGE, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['@hono/node-server', 'hono']);
  });
});
