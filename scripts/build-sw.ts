/**
 * Writes `public/sw.js` (and `dist/sw.js`) from `scripts/sw.template.js`,
 * stamping the worker's cache name with a hash of the build's own output
 * (docs/plans/web.md W3; PLAN.md §3.6).
 *
 * **Why the cache name is stamped at all.** It was a hand-bumped literal
 * (`tangram-v2`), and `activate` deletes every cache that is not the current
 * one. On a routine build the name did not change, so nothing was ever purged
 * and every past deploy's hashed chunks stayed in the cache forever. The chunks
 * are content-addressed, so what was kept was never *wrong* — only unbounded,
 * which is a storage bill the learner pays and a quota the browser eventually
 * enforces by evicting the whole origin.
 *
 * **Why a hash rather than a build id.** Next wrote `.next/BUILD_ID` on every
 * build and this script read it; a Vite build has no equivalent (STACK §2.2),
 * and between `web.md` W1 and this phase the fallback meant every build was
 * stamped `dev` and `activate` purged nothing. What replaces it is better than
 * what it replaces: `BUILD_ID` changed on every build, so a rebuild with
 * identical output purged a cache for nothing, while this changes **exactly
 * when the served bytes change**.
 *
 * **The stamp has two halves and the second one is the one a builder will
 * skip.** Vite's build manifest covers only what goes through the module
 * graph. Files in `public/` are copied to the dist root verbatim, keep their
 * authored names and gain no content hash, so they appear in no manifest. Hash
 * the manifest alone and editing `offline.html` leaves the stamp unchanged,
 * `activate` purges nothing, and the stale precached offline page is served
 * forever. `.next/BUILD_ID` did not have that hole, so this is the one place
 * the replacement could be worse than the thing it replaces — hence
 * `stampInputs` below, and hence the unit test that touches `offline.html`
 * and watches the stamp move.
 *
 * **What is deliberately NOT in the stamp**, all under `public/`:
 *
 * - `sw.js` itself — this script's own output; hashing it is circular.
 * - `dict-*.sqlite` and `dict-*.sqlite.br` — 43 MB and 17 MB. The worker
 *   **denies** them by rule (`sw.template.js`), so they are not bytes it ever
 *   serves, and hashing 43 MB on every build would buy nothing.
 * - `dict-manifest.json` — same reason: the worker does not serve it. It is
 *   fetched fresh on every load by design, because it is the pointer at the
 *   artifact's filename.
 *
 * `decomp.json` **is** in, because the worker's runtime cache does serve it.
 *
 * **Run it AFTER `vite build`.** It reads `dist/.vite/manifest.json`, so the
 * order in the app's `build` script is `dict:copy && vite build && sw`, and
 * this writes into `dist/` as well as `public/` because `build.emptyOutDir` is
 * on and Vite has already copied `public/` by then. With no build to read the
 * worker is stamped `dev` and says so, which is what a bare `pnpm sw` and
 * `pnpm dev` get; `pnpm dev` never registers a worker anyway
 * (`components/pwa/register-sw.tsx`).
 *
 * The template is deliberately *not* under `public/`: a file served at
 * `/sw.template.js` is a second, placeholder-stamped worker one URL away from
 * the real one.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { dirOf, workspaceRoot } from '../apps/app/lib/server/roots';

// This script lives at the WORKSPACE root and every path below is the APP's, so
// the two roots have to be named separately. Found by marker rather than by
// counting `..`, which is what silently survives the next move (W0).
const appDir = resolve(workspaceRoot(dirOf(import.meta.url)), 'apps/app');

export const TEMPLATE_PATH = resolve(dirOf(import.meta.url), 'sw.template.js');
export const PUBLIC_DIR = resolve(appDir, 'public');
export const DIST_DIR = resolve(appDir, 'dist');
export const OUTPUT_PATH = resolve(PUBLIC_DIR, 'sw.js');

/**
 * Vite's build manifest, relative to `dist/`.
 *
 * A literal, and the honest statement is that this is Vite's **default** path
 * for `build.manifest: true` rather than something read back off the installed
 * Vite — there is no export to read it from. `build.manifest` also accepts a
 * string, which moves the file, and this would then silently fall back to the
 * `dev` stamp with only a warning. So the coupling is asserted instead:
 * `tests/unit/pwa/build-sw.test.ts` reads `vite.config.ts` and fails if
 * `manifest` is anything but `true`. (An earlier version of this comment
 * claimed the path *was* read off Vite, which is worse than silence.)
 */
export const VITE_MANIFEST = '.vite/manifest.json';

/** What the template carries where the build's stamp belongs. */
export const BUILD_ID_PLACEHOLDER = '__TANGRAM_BUILD_ID__';

/** …and where the precache list belongs. */
export const PRECACHE_PLACEHOLDER = '__TANGRAM_PRECACHE__';

/** The stamp used when there is no build to read (a bare `pnpm sw`, `pnpm dev`). */
export const DEV_BUILD_ID = 'dev';

/**
 * Where Vite puts its content-hashed output, relative to `dist/`.
 *
 * Read off the build config rather than written down twice: the worker's
 * cache-first rule keys on this exact prefix, and the two silently diverging is
 * what W1 shipped.
 */
export const ASSETS_DIR = 'assets';

/** Output files the stamp must ignore. See the header for why each one. */
export function isStampExcluded(relativePath: string): boolean {
  return (
    relativePath === 'sw.js' ||
    relativePath.startsWith(`${ASSETS_DIR}/`) ||
    relativePath.startsWith('.vite/') ||
    /^dict-.+\.sqlite(\.br(\.json)?)?$/.test(relativePath) ||
    relativePath === 'dict-manifest.json'
  );
}

export interface StampInput {
  /** Repo-relative-ish label, stable across machines. */
  label: string;
  sha256: string;
}

function walk(dir: string, base: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const full = resolve(dir, name);
    if (statSync(full).isDirectory()) walk(full, base, out);
    else out.push(relative(base, full).split('\\').join('/'));
  }
  return out;
}

/**
 * Every byte the stamp is computed over, sorted and labelled.
 *
 * Returned rather than folded straight into a digest so that the unit test can
 * assert *what is in it* — "the `.sqlite` is not one of the inputs" is a
 * statement about this list, and checking it through the resulting hash would
 * only prove that two hashes differ.
 */
export function stampInputs(distDir: string = DIST_DIR): StampInput[] {
  const inputs: StampInput[] = [];
  const manifestPath = resolve(distDir, VITE_MANIFEST);
  if (!existsSync(manifestPath)) return inputs;

  inputs.push({
    label: VITE_MANIFEST,
    sha256: createHash('sha256').update(readFileSync(manifestPath)).digest('hex'),
  });
  for (const relativePath of walk(distDir, distDir)) {
    if (isStampExcluded(relativePath)) continue;
    inputs.push({
      label: relativePath,
      sha256: createHash('sha256')
        .update(readFileSync(resolve(distDir, relativePath)))
        .digest('hex'),
    });
  }
  return inputs.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
}

/**
 * The stamp: 16 hex characters of a digest over the input list.
 *
 * The *labels* are hashed alongside the bytes, so renaming a public file
 * changes the stamp even when its content does not — a rename changes which
 * URLs the worker can serve, which is exactly what the cache name is about.
 */
export function computeStamp(inputs: readonly StampInput[]): string {
  const digest = createHash('sha256');
  for (const input of inputs) digest.update(`${input.label} ${input.sha256}\n`);
  return digest.digest('hex').slice(0, 16);
}

/**
 * What the worker precaches: the one document, the offline page, and the entry
 * chunk and stylesheet read out of the build manifest.
 *
 * It used to be the seven nav routes. Under the SPA fallback there is **one**
 * document, so precaching seven URLs precached seven copies of it; and a
 * cached document references `assets/<hash>.js` that a new deployment no longer
 * serves, which is why navigations stay network-first. Reading the entry out of
 * the manifest is what makes the offline fallback actually render rather than
 * come up blank — `core.md` C7's collapse to three tabs then costs this phase
 * nothing, because there is no per-route list left to re-derive.
 */
export function precacheList(distDir: string = DIST_DIR): string[] {
  const shell = ['/', '/offline.html'];
  const manifestPath = resolve(distDir, VITE_MANIFEST);
  if (!existsSync(manifestPath)) return shell;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<
    string,
    { file?: string; css?: string[]; isEntry?: boolean }
  >;
  const assets = new Set<string>();
  for (const chunk of Object.values(manifest)) {
    if (!chunk.isEntry) continue;
    if (chunk.file) assets.add(`/${chunk.file}`);
    for (const css of chunk.css ?? []) assets.add(`/${css}`);
  }
  return [...shell, ...[...assets].sort()];
}

/**
 * The stamp as a cache name may carry it.
 *
 * A cache name is a string the worker compares for equality, so anything is
 * *technically* legal; the check is here because a stamp that arrived with a
 * newline or a quote in it would produce a worker that does not parse, and the
 * failure would show up as "the app has no service worker" days later.
 */
export function normalizeBuildId(raw: string): string {
  const id = raw.trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    throw new Error(`build-sw: refusing to stamp an unusable build id: ${JSON.stringify(raw)}`);
  }
  return id;
}

/** The stamp for a build, or the dev fallback when Vite has not produced one. */
export function readBuildId(distDir: string = DIST_DIR): string {
  const inputs = stampInputs(distDir);
  if (inputs.length === 0) return DEV_BUILD_ID;
  return normalizeBuildId(computeStamp(inputs));
}

/**
 * The served worker: the template with both placeholders replaced. It is an
 * error for either to be missing — that means somebody edited the version line
 * or the precache list out of the template, and the result would be a worker
 * whose cache name never changes again, or one that precaches nothing.
 */
export function renderServiceWorker(
  template: string,
  buildId: string,
  precache: readonly string[],
): string {
  for (const placeholder of [BUILD_ID_PLACEHOLDER, PRECACHE_PLACEHOLDER]) {
    if (!template.includes(placeholder)) {
      throw new Error(`build-sw: ${placeholder} is not in the template`);
    }
  }
  return template
    .replaceAll(BUILD_ID_PLACEHOLDER, normalizeBuildId(buildId))
    .replaceAll(PRECACHE_PLACEHOLDER, JSON.stringify(precache));
}

export interface BuildServiceWorkerOptions {
  publicDir?: string;
  distDir?: string;
  templatePath?: string;
}

export interface BuildServiceWorkerResult {
  buildId: string;
  precache: string[];
  /** Every file written. `dist/sw.js` only when there is a `dist/`. */
  written: string[];
}

export function buildServiceWorker(
  options: BuildServiceWorkerOptions = {},
): BuildServiceWorkerResult {
  const publicDir = options.publicDir ?? PUBLIC_DIR;
  const distDir = options.distDir ?? DIST_DIR;
  const template = readFileSync(options.templatePath ?? TEMPLATE_PATH, 'utf8');

  const buildId = readBuildId(distDir);
  const precache = precacheList(distDir);
  const worker = renderServiceWorker(template, buildId, precache);

  const written = [resolve(publicDir, 'sw.js')];
  // `dist/` too, and not as a nicety: this runs AFTER `vite build`, which has
  // already copied `public/` (and with it the PREVIOUS build's `sw.js`) into
  // `dist/`. Writing only `public/` would leave the served worker one build
  // behind — stamped for output it does not describe, which is worse than the
  // bug this script exists to fix.
  if (existsSync(distDir)) written.push(resolve(distDir, 'sw.js'));
  for (const path of written) writeFileSync(path, worker);

  return { buildId, precache, written };
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const { buildId, precache, written } = buildServiceWorker();
  if (buildId === DEV_BUILD_ID) {
    console.warn(
      `build-sw: no dist/${VITE_MANIFEST} — sw.js is stamped "dev" and precaches nothing hashed.`,
    );
  } else {
    console.log(
      `build-sw: stamped ${buildId} over ${stampInputs().length} inputs; ` +
        `precache ${precache.join(' ')}`,
    );
  }
  for (const path of written) console.log(`  wrote ${path}`);
}
