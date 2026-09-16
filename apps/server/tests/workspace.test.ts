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
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
    // `tsconfig.json` is what `typecheck` runs and it has to cover everything,
    // or a test file is a file nothing checks — W0's exact finding. There is no
    // second emitting project any more: B1 replaced tsc's emit with an esbuild
    // bundle (`scripts/build.ts`), which is itself one of the files this glob
    // set has to keep covered.
    const tsconfig = readFileSync(resolve(PACKAGE, 'tsconfig.json'), 'utf8');
    for (const glob of ['src/**/*.ts', 'tests/**/*.ts', 'scripts/**/*.ts']) {
      expect(tsconfig).toContain(glob);
    }
  });

  it('declares exactly the four packages the bundle leaves external', () => {
    // `scripts/build.ts` marks `dependencies` external and inlines everything
    // else, so this list IS the deploy's `node_modules`. Exact, not a superset:
    // B0 asserted it from the start so that the phase which would break it has
    // to edit this line, and B1 is that phase — the Anthropic SDK and zod
    // arrived with the three model routes.
    const pkg = JSON.parse(readFileSync(resolve(PACKAGE, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies).sort()).toEqual([
      '@anthropic-ai/sdk',
      '@hono/node-server',
      'hono',
      'zod',
    ]);
  });

  it('ships no dictionary of its own, and counts the app modules B2 must remove', () => {
    // The original of this test asserted "no dictionary" through the
    // dependency list, on the premise that a server-side dictionary would
    // arrive as a package. `backend.md` B1 makes it arrive another way and says
    // so in as many words — "the dictionary comes with them, on purpose and
    // temporarily" — through `@/lib/server/dict` and `packages/ai`'s `@/lib/**`
    // mapping, which the esbuild bundle inlines. So the guard is re-aimed at
    // what B2 actually promises ("no `lib/dict/**` import remains in
    // apps/server") and made countable: the number below may only go DOWN.
    //
    // No dependency may be a dictionary or a database either. That half is
    // unchanged and is what stops a second copy arriving the old way.
    const pkg = JSON.parse(readFileSync(resolve(PACKAGE, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    for (const name of Object.keys(pkg.dependencies)) {
      expect(name, `${name} looks like a dictionary or a database`).not.toMatch(
        /sqlite|dexie|sql\.js|better-sqlite/i,
      );
    }

    const sources = sourceFiles(resolve(PACKAGE, 'src'));
    const reaching = sources
      .filter(([, source]) => /from '@\/lib\//.test(source))
      .map(([file]) => file);
    // The three model routes, and nothing else. `health.ts`, `table.ts`,
    // `app.ts`, `config.ts`, `cors.ts`, `log.ts`, `build-info.ts`, `index.ts`
    // and `smoke.ts` reach nothing in the app, which is what keeps B2's
    // deletion a deletion rather than an untangling.
    expect(reaching.sort()).toEqual(['routes/ask.ts', 'routes/examples.ts', 'routes/recall.ts']);
  });
});

/** Every `.ts` under a directory, walked rather than listed. */
function sourceFiles(dir: string, prefix = ''): [string, string][] {
  const out: [string, string][] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...sourceFiles(join(dir, entry.name), rel));
    else if (entry.name.endsWith('.ts')) out.push([rel, readFileSync(join(dir, entry.name), 'utf8')]);
  }
  return out;
}
