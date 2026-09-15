/**
 * The CLI half, over HTTP, against the built server the rest of the e2e suite
 * is already running (`playwright.config.ts` → `pnpm -w build:e2e && pnpm -w preview`).
 *
 * This is the same `runSmoke` that `pnpm smoke` runs, wired in here so it is
 * not a script somebody has to remember, and so the two can never drift. The
 * failure it exists for — a route or an asset that is fine locally and absent
 * from the deployment — is invisible to a unit test and invisible in dev.
 *
 * `tests/unit/server/routes.test.ts` checks the route table, the tracing config
 * and `vercel.json` statically; `tests/e2e/p0/routes.spec.ts` checks what
 * renders; this checks that the server answers.
 */
import { expect, test } from '@playwright/test';

import { checkRouteCoverage, runSmoke } from '../../../../../scripts/smoke';

test.describe('production smoke', () => {
  // A cold dictionary load is seconds, and the first case pays for it; the
  // artifact case then transfers tens of megabytes off the preview server.
  test.setTimeout(300_000);

  test('every route has a case, and the built server answers all of them', async ({ baseURL }) => {
    expect(
      checkRouteCoverage(),
      'a route in app/api has no case in SMOKE_CASES (scripts/smoke.ts)',
    ).toEqual([]);

    const result = await runSmoke({ baseURL: baseURL as string });
    expect(result.failures.join('\n')).toBe('');
    expect(result.passed).toBeGreaterThan(15);

    // The suite always builds first, so a zero here is not "no build to read"
    // — it is the asset check having silently stopped working, which is how
    // "every hashed asset is 200" becomes a claim nobody makes.
    expect(result.assetsChecked, 'no hashed assets were checked').toBeGreaterThan(0);
    // Likewise for the host rules: `vercel.json` is the only place they live.
    expect(result.hostRulesChecked, 'no vercel.json rules were checked').toBeGreaterThan(3);
  });
});
