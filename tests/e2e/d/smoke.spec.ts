/**
 * Every API route, over HTTP, against the built server the rest of the e2e
 * suite is already running (`playwright.config.ts` → `pnpm build && pnpm start`).
 *
 * This is the same `runSmoke` that `pnpm smoke` runs, wired in here so it is
 * not a script somebody has to remember. The failure it exists for —
 * a dictionary-reading route missing its `outputFileTracingIncludes` entry —
 * is invisible to a unit test and invisible in dev, and `/api/examples` and
 * `/api/recall` both shipped with it.
 *
 * `tests/unit/server/routes.test.ts` checks the tracing config statically and
 * that every handler has a case; this checks the server actually answers.
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
