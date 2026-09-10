/**
 * Every API route, over HTTP, against the built server the rest of the e2e
 * suite is already running (`playwright.config.ts` → `pnpm build && pnpm start`).
 *
 * This is the same `runSmoke` that `pnpm smoke` runs, wired in here so it is
 * not a script somebody has to remember. What it catches is what only exists
 * once the server is real: a route that throws at module scope, a middleware
 * that refuses something it should not, a page that fails to render.
 *
 * It does *not* see tracing. This run reads `data/` off the disk like any
 * `pnpm start` (docs/deploy.md §7), so a missing `outputFileTracingIncludes`
 * entry is invisible here; that is guarded statically by
 * `tests/unit/server/routes.test.ts`, which also checks every handler has a
 * case. `/api/examples` and `/api/recall` are why that guard exists: they reached
 * the Phase 8 merge with no entry of their own and the keys were added by hand,
 * with nothing automated noticing.
 */
import { expect, test } from '@playwright/test';

import { checkRouteCoverage, runSmoke } from '../../../scripts/smoke';

test.describe('production smoke', () => {
  // A cold dictionary load is seconds, and the first case pays for it.
  test.setTimeout(180_000);

  test('every route has a case, and the built server answers all of them', async ({ baseURL }) => {
    expect(
      checkRouteCoverage(),
      'a route in app/api has no case in SMOKE_CASES (scripts/smoke.ts)',
    ).toEqual([]);

    const result = await runSmoke({ baseURL: baseURL as string });
    expect(result.failures.join('\n')).toBe('');
    expect(result.passed).toBeGreaterThan(15);
  });
});
