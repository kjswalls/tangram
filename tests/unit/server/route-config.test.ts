/**
 * No route handler may export `maxDuration` or `memory`.
 *
 * This is not a style rule. `@vercel/next` bundles route handlers **whose
 * function configuration matches** into one Vercel Function — Vercel documents
 * it as "bundled into the fewest number of Vercel Functions possible, to help
 * reduce cold starts" — and this app relies on it: `vercel build` on this repo
 * produces exactly one real `.func` under `api/`, with the other seven routes as
 * symlinks to it (docs/deploy.md §5). One process means one 33 MB `dict.json`
 * parse, one set of lazy indexes, and one warm-up: the banner's
 * `HEAD /api/dict/hsk` warms the *same* instance that will answer the first
 * lookup (lib/dict/warm.ts).
 *
 * A `maxDuration` or `memory` on a single route is precisely what makes its
 * configuration differ, so that route is split into a function of its own. The
 * failure is silent: every test still passes, every route still answers, and the
 * only symptom is that one route pays a second cold start — a ~1 s first lookup
 * that comes back after somebody spent a phase removing it, with nothing in the
 * diff that looks like a performance change.
 *
 * If a ceiling is genuinely needed, it goes in `vercel.json` against
 * `app/api/**` so that every route keeps the same configuration, and
 * `docs/deploy.md` §6 records why. `scripts/coldstart-probe.ts` is the check
 * from outside: differing `x-tangram-instance` values across the dictionary
 * routes is what this regression looks like in production.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { discoverApiRoutes } from '@/lib/server/route-inventory';

const ROOT = resolve(__dirname, '../../..');

/**
 * The route-segment config values that change a handler's *function* config, and
 * so its bundling group. Next's other segment exports (`dynamic`, `revalidate`,
 * `fetchCache`…) do not — every route here exports `dynamic` and they still
 * share one function.
 */
const GROUPING_CONFIG = ['maxDuration', 'memory'] as const;

describe('function configuration', () => {
  // Enumerated from the shared inventory rather than a second directory walk, so
  // a route added anywhere under app/api is covered the day it is written.
  const routes = discoverApiRoutes(ROOT);

  it('finds the routes it is guarding', () => {
    expect(routes.length).toBeGreaterThanOrEqual(8);
  });

  it.each(GROUPING_CONFIG)('is exported by no route: %s', (name) => {
    const offenders = routes.filter((route) =>
      // Matches `export const x`, `export let/var x` and `export function x` —
      // any of which Next reads as segment config.
      new RegExp(`^export\\s+(?:const|let|var|async\\s+function|function)\\s+${name}\\b`, 'm').test(
        readFileSync(route.file, 'utf8'),
      ),
    );
    expect(
      offenders.map((route) => route.relativeFile),
      `exporting \`${name}\` splits these routes out of Vercel's shared function; put the ceiling in vercel.json for app/api/** instead`,
    ).toEqual([]);
  });
});
