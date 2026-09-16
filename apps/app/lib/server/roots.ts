/**
 * Where "the root" is, now that there are two of them (docs/plans/web.md W0).
 *
 * Before the workspace move every path in this repo counted `..` from its own
 * module and landed on the one root there was. There are now two, they mean
 * different things, and counting `..` gets both wrong on the next move:
 *
 * - **the app root** (`apps/app/`) holds `package.json`, `public/`, `app/`,
 *   `node_modules/.bin` — everything that used to be "the repo root" for a
 *   script, a spec or the route inventory;
 * - **the workspace root** holds `pnpm-workspace.yaml`, `data/`, `docs/`. It is
 *   where the generated dictionary lives, because three deployables read it
 *   (docs/plans/wave-zero.md §1).
 *
 * Both walk up for a marker instead of counting, so a future move of either tree
 * does not silently relocate anything. Node-only: every caller is a script, a
 * test, or the server-side dictionary loader.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function findUp(marker: string, from: string): string | undefined {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(resolve(dir, marker))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** The directory of a module, for passing as `from`. */
export function dirOf(importMetaUrl: string): string {
  return dirname(fileURLToPath(importMetaUrl));
}

/**
 * The nearest ancestor holding a `package.json` — `apps/app/` for anything
 * inside it. Throws rather than guessing: a wrong root is a silent wrong answer.
 */
export function appRoot(from: string = process.cwd()): string {
  const found = findUp('package.json', from);
  if (!found) throw new Error(`no package.json above ${from}`);
  return found;
}

/**
 * The workspace root — the directory holding `pnpm-workspace.yaml`.
 *
 * Falls back to `from` when there is no workspace above it, so that a tree
 * extracted on its own (a Capacitor copy, a vendored checkout) still resolves
 * to something rather than throwing. `TANGRAM_DATA_DIR` overrides this
 * everywhere it matters and is the authoritative mechanism; see `dataDir()`.
 */
export function workspaceRoot(from: string = process.cwd()): string {
  return findUp('pnpm-workspace.yaml', from) ?? resolve(from);
}

/**
 * The directory `pnpm data` writes to and everything Node-side reads from.
 *
 * **It lived in `lib/dict/load.ts` until `data.md` D6 deleted that file**, and
 * it is the half of it that was never about JSON: `CLAUDE.md` calls it the
 * reader of the pair that decides where `data/` is, and the pairing is with
 * `scripts/build-data.ts`, not with the 35 MB parse. It moves here rather than
 * dying with the loader, and here is where the other root resolvers already are.
 *
 * `TANGRAM_DATA_DIR` is the **authoritative** mechanism and the root `data`,
 * `data:ensure`, `data:verify`, `dict:copy` and `build` scripts set it to the
 * absolute workspace-root `data/`. The default below is the safety net for
 * everything they do not wrap — `pnpm -F app dev`, `pnpm preview`, vitest, the
 * Playwright web server — all of which run with cwd `apps/app/`. It must **not**
 * be `<cwd>/data`: that would read `apps/app/data`, and `scripts/build-data.ts`'s
 * matching default would write there too, so the two agree with each other in
 * the wrong place while every test still passes (docs/plans/web.md W0).
 * `tests/unit/workspace.test.ts` is the guard.
 */
export function dataDir(): string {
  const configured = process.env.TANGRAM_DATA_DIR;
  // Resolved against the workspace root rather than the cwd, because there are
  // now two cwds in routine use — the root scripts run at the workspace root,
  // everything under `pnpm -F app` runs at `apps/app/`. An absolute value is
  // unaffected (`resolve` returns it unchanged); a relative one would otherwise
  // mean two different directories to the writer and the reader.
  return configured ? resolve(workspaceRoot(), configured) : resolve(workspaceRoot(), 'data');
}
