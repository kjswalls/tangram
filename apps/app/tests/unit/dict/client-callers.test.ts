/**
 * The cutover, finished and enforced (docs/plans/core.md C4a, data.md D6).
 *
 * C4a's acceptance criterion was a pair of greps and this file was where they
 * became a test, because with no CI a grep in a plan is a grep nobody runs
 * (CLAUDE.md: "every rule that wants enforcement becomes a unit test under
 * `tests/unit/`"). What it locked in then was **one** caller, not zero:
 * `lib/dict/http-store.ts` was a `DictStore` over the HTTP routes, and it
 * existed because until `data.md` D4 there was no `DictStore` a browser could
 * construct.
 *
 * **D6 is the phase that made it zero**, and the same greps are now its
 * acceptance criteria 1 and 2:
 *
 *  1. no dictionary route is named anywhere in this app's TypeScript;
 *  2. no module outside `scripts/`, `tests/`, `lib/server/`,
 *     `lib/dict/runners/node.ts` — and `vite-plugins/**`, which D6 does not list
 *     and which is the build itself — imports `node:fs`.
 *
 * Both are asserted below, over **every** `.ts`/`.tsx` file under `apps/app`
 * rather than a hand-picked list of directories — the narrow version of this
 * walk is what an earlier review caught, because `components/screens/today.tsx`
 * and `app/settings/settings-form.tsx` were outside it.
 *
 * **Two scope notes, both deliberate and both recorded in HANDOFF.md's D6
 * section.**
 *
 * *Comments count.* D6's criterion 1 is a plain `grep`, so a stale comment
 * naming a deleted route fails it. That is the right reading: a comment
 * pointing at a route that does not exist is how the next session learns
 * something false. Two comments in files D6 itself wrote failed it and were
 * corrected rather than exempted.
 *
 * *The walk stops at `apps/app`.* D6 wrote its grep as `.` at a time when the
 * repository was one deployable. It is now three, and **the literal grep across
 * the workspace still returns hits** — this list is exhaustive, so a reader
 * running the criterion as written can check it off rather than conclude the
 * phase is unfinished:
 *
 *  - `packages/ai/schemas.ts` — a **frozen** surface, citing the deletion in its
 *    header;
 *  - `apps/server`, asserting that asking the server for one of those paths is a
 *    404 rather than a 401, which `wave-zero.md` §10a requires and which cannot
 *    be written without the string;
 *  - `scripts/smoke.ts`, explaining in the past tense which deleted case used to
 *    supply `SMOKE_ENTRY`;
 *  - `CLAUDE.md` and `HANDOFF.md`, which are prose and are not `.ts` anyway.
 *
 * Widening this walk past `apps/app` would therefore fail on files that are
 * correct. The substance of the criterion — **the app** names no dictionary
 * route — is what is enforced here.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = relative(
  resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'),
  fileURLToPath(import.meta.url),
);
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const SKIP = new Set([
  'node_modules',
  'dist',
  'test-results',
  'playwright-report',
  '.cache',
  // `cap sync` copies the whole Vite build into these, minified bundle and all.
  'ios',
  'android',
]);

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

/** Every `.ts`/`.tsx` file in the app, this file excepted. */
function appSources(): string[] {
  return sources(appRoot)
    .map((path) => relative(appRoot, path))
    .filter((path) => path !== here)
    .sort();
}

function read(path: string): string {
  return readFileSync(resolve(appRoot, path), 'utf8');
}

describe('the DictStore cutover, finished', () => {
  it('names no dictionary route anywhere — criterion 1', () => {
    // The literal is assembled rather than written, so that this assertion is
    // not itself the thing it is looking for in some future wider walk.
    const needle = `api/${'dict'}`;
    const offenders = appSources().filter((path) => read(path).includes(needle));
    expect(offenders).toEqual([]);
  });

  it('has no HTTP dictionary left to import — criterion 1', () => {
    const gone = ['lib/dict/client.ts', 'lib/dict/http-store.ts', 'lib/dict/index.ts', 'lib/dict/load.ts'];
    const importers = appSources().filter((path) => {
      const source = read(path);
      return gone.some((module) => {
        const bare = module.replace(/^lib\/dict\//, '').replace(/\.ts$/, '');
        return (
          source.includes(`@/${module.replace(/\.ts$/, '')}`) ||
          new RegExp(`from ['"]\\.{1,2}/${bare}['"]`).test(source)
        );
      });
    });
    expect(importers).toEqual([]);
  });

  it('keeps node:fs to the places D6 names — criterion 2', () => {
    // D6 names four: `scripts/`, `tests/`, `lib/server/` and
    // `lib/dict/runners/node.ts`. `scripts/` is outside this walk, and the tree
    // needs one more that the criterion does not list — `vite-plugins/**`, which
    // is the build itself and runs in Node by definition. Nothing else, and a
    // build config that starts reading the disk is a deliberate edit here rather
    // than a silent exemption.
    //
    // (`lib/dict/runners/node.ts` does not in fact import `node:fs` — it imports
    // `node:sqlite`. It stays on the list because D6 puts it there and because a
    // runner reading a file is exactly what it would be for.)
    const allowed = /^(tests\/|lib\/server\/|vite-plugins\/|lib\/dict\/runners\/node\.ts$)/;
    const offenders = appSources()
      .filter((path) => !allowed.test(path))
      .filter((path) => /from ['"]node:fs(\/promises)?['"]/.test(read(path)));
    expect(offenders).toEqual([]);
  });

  it('constructs the dictionary in exactly one place the app ships', () => {
    // C4 requires the sheets to take the store as an injected dependency, and
    // C4a makes `browser-store.ts` the one construction site — the single edit
    // D6 finally made, from the HTTP bridge to the OPFS store.
    //
    // `wasm-store.ts` declares the factory and `dict-wasm-harness.tsx` is D4's
    // dev-only `/dict-wasm` page, which is outside `<Root>` and absent from a
    // production build (`src/routes.tsx`'s `devOnlyStandalone`). Anything else
    // in this list is a component that built its own dictionary.
    const constructors = appSources()
      .filter((path) => !path.startsWith('tests/'))
      .filter((path) => /(?<!function )createWasmDictStore\(|new JsonDecompStore\(/.test(read(path)));
    expect(constructors).toEqual([
      'components/gallery/dict-wasm-harness.tsx',
      'lib/dict/browser-store.ts',
    ]);
  });
});
