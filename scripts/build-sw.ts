/**
 * Writes `public/sw.js` from `scripts/sw.template.js`, binding the worker's
 * cache name to the build (PLAN.md §3.6; HANDOFF.md, Phase 6 review fixes 2,
 * "Not fixed, on purpose").
 *
 * Why this exists at all: the worker's cache name was a hand-bumped literal
 * (`tangram-v2`), and `activate` deletes every cache that is not the current
 * one. On a routine `next build` the name did not change, so nothing was ever
 * purged and the hashed `/_next/static/**` chunks of every past deploy stayed
 * in the cache forever. The chunks are content-hashed, so what was kept was
 * never *wrong* — only unbounded, which is a storage bill the learner pays and
 * a quota the browser eventually enforces by evicting the whole origin.
 *
 * Next writes `.next/BUILD_ID` on every build, and it changes exactly when the
 * output does, so it is the honest version for a cache of that output. Run
 * after `next build` (`pnpm build` does); with no build to read, the worker is
 * stamped `dev` and says so, because `pnpm dev` never registers one anyway
 * (`components/pwa/register-sw.tsx`).
 *
 * The template is deliberately *not* under `public/`: a file served at
 * `/sw.template.js` is a second, placeholder-stamped worker one URL away from
 * the real one.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const TEMPLATE_PATH = resolve(repoRoot, 'scripts/sw.template.js');
export const OUTPUT_PATH = resolve(repoRoot, 'public/sw.js');
export const BUILD_ID_PATH = resolve(repoRoot, '.next/BUILD_ID');

/** What the template carries where the build's id belongs. */
export const BUILD_ID_PLACEHOLDER = '__TANGRAM_BUILD_ID__';

/** The stamp used when there is no build to read (a bare `pnpm sw`, `next dev`). */
export const DEV_BUILD_ID = 'dev';

/**
 * The build id, as a cache name may carry it.
 *
 * A cache name is a string the worker compares for equality, so anything is
 * *technically* legal; the check is here because a build id that arrived with a
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

/** `.next/BUILD_ID` if a build has run, else the dev stamp. */
export function readBuildId(path: string = BUILD_ID_PATH): string {
  if (!existsSync(path)) return DEV_BUILD_ID;
  return normalizeBuildId(readFileSync(path, 'utf8'));
}

/**
 * The served worker: the template with its placeholder replaced. It is an error
 * for the placeholder to be missing — that means somebody edited the version
 * line out of the template, and the result would be a worker whose cache name
 * never changes again, which is the bug this script exists to fix.
 */
export function renderServiceWorker(template: string, buildId: string): string {
  if (!template.includes(BUILD_ID_PLACEHOLDER)) {
    throw new Error(`build-sw: ${BUILD_ID_PLACEHOLDER} is not in the template`);
  }
  return template.replaceAll(BUILD_ID_PLACEHOLDER, normalizeBuildId(buildId));
}

export function buildServiceWorker(): { buildId: string; output: string } {
  const buildId = readBuildId();
  const worker = renderServiceWorker(readFileSync(TEMPLATE_PATH, 'utf8'), buildId);
  writeFileSync(OUTPUT_PATH, worker);
  return { buildId, output: OUTPUT_PATH };
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const { buildId } = buildServiceWorker();
  if (buildId === DEV_BUILD_ID) {
    console.warn('build-sw: no .next/BUILD_ID — public/sw.js is stamped "dev".');
  } else {
    console.log(`build-sw: public/sw.js stamped ${buildId}`);
  }
}
