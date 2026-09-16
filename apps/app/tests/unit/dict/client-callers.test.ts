/**
 * The `DictStore` cutover, enforced (docs/plans/core.md C4a).
 *
 * C4a's first acceptance criterion is a pair of greps, and `data.md` D6 — the
 * phase that deletes `app/api/dict/**` — is gated verbatim on them. With no CI,
 * a grep in a plan is a grep nobody runs, so it is a test (CLAUDE.md: "every
 * rule that wants enforcement becomes a unit test under `tests/unit/`").
 *
 * The state it locks in is **one** caller, not zero, and the difference is the
 * whole honest position of this phase: `lib/dict/http-store.ts` is a `DictStore`
 * over the HTTP routes, and it exists because until `data.md` D4 gives the
 * browser a `SqlRunner` over sqlite-wasm there is no `DictStore` a browser can
 * construct. Every consumer above the dictionary layer codes against the
 * interface now; one file behind it still fetches. **D6 is therefore not yet
 * unblocked**, and this test is where that fact is written down in a form that
 * changes when it stops being true.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const SKIP = new Set([
  'node_modules',
  'dist',
  'test-results',
  'playwright-report',
  // `tests/` is excluded from the WHOLE-APP walk deliberately: a spec that
  // routes `**/api/dict/**` or names the client in a scope assertion is not a
  // caller. The criterion is about production code.
  'tests',
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

/** The file with comments taken out: prose may name a route; code may not. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/**
 * **Two root lists, because the plan states two different greps.**
 *
 * `wholeApp` is criterion one's `.` — every production source file under
 * `apps/app`, `app/` and `vite-plugins/` included. It was `[components, lib,
 * src]`, which is what the review caught: `components/screens/today.tsx` and
 * `app/settings/settings-form.tsx` are real client components, and an import of
 * `lib/dict/client` added to either left this suite green while the criterion's
 * own grep reported two importers. `data.md` D6 is gated verbatim on this
 * evidence, so a blind spot here is a false "unblocked" rather than a missed nit.
 *
 * `routeScope` is criterion two's `components/ lib/`, kept narrow on purpose —
 * with `src/` added, which is stricter than the plan asks and costs nothing.
 */
//
// **Both lists reach outside `apps/app`, because production code now lives
// outside it.** Wave 0's deliverable 5 moved eleven modules to `packages/ai/`,
// and one of them — `retrieve.ts` — is the `DictStore` consumer this criterion
// is actually about. A walk rooted at the app alone would have stopped seeing
// it the day it moved, which is W0's own lesson (a file that leaves a scope is
// a file nothing checks) applied to the file that matters most here.
const sharedAi = resolve(appRoot, '..', '..', 'packages', 'ai');
const wholeApp = [appRoot, sharedAi];
const routeScope = [join(appRoot, 'components'), join(appRoot, 'lib'), join(appRoot, 'src'), sharedAi];

describe('the DictStore cutover', () => {
  it('nothing imports lib/dict/client except the store that replaces it', () => {
    const importers = wholeApp
      .flatMap(sources)
      // Relative (`./client`) as well as aliased (`@/lib/dict/client`): the
      // bridge sits next door to the client and imports it the short way.
      // Anchored on the dictionary's own path so `react-dom/client` is not a hit.
      .filter((path) =>
        /from ['"](?:\.{1,2}\/client|[^'"]*lib\/dict\/client)['"]/.test(code(path)),
      )
      .map((path) => relative(appRoot, path))
      .sort();
    // `http-store.ts` is the bridge; `client.ts` is what it bridges to.
    expect(importers).toEqual(['lib/dict/http-store.ts']);
  });

  it('nothing but the client and the store names an /api/dict route in code', () => {
    const callers = routeScope
      .flatMap(sources)
      .filter((path) => /['"`][^'"`]*\/api\/dict/.test(code(path)))
      .map((path) => relative(appRoot, path))
      .sort();
    expect(callers).toEqual(['lib/dict/client.ts']);
  });

  it('no component or store constructs a dictionary itself', () => {
    // C4 requires the sheets to take the store as an injected dependency, and
    // C4a makes `browser-store.ts` the one construction site — the single edit
    // `data.md` D4 has to make.
    const constructors = wholeApp
      .flatMap(sources)
      .filter((path) => /new HttpDictStore\(|new HttpDecompStore\(/.test(code(path)))
      .map((path) => relative(appRoot, path))
      .sort();
    expect(constructors).toEqual(['lib/dict/browser-store.ts']);
  });
});
