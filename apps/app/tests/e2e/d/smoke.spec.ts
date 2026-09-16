/**
 * The CLI half, over HTTP, against the built server the rest of the e2e suite
 * is already running (`playwright.config.ts` → `pnpm -w build:e2e && pnpm -w preview`).
 *
 * This is the same `runSmoke` that `pnpm smoke` runs, wired in here so it is
 * not a script somebody has to remember, and so the two can never drift. The
 * failure it exists for — a route or an asset that is fine locally and absent
 * from the deployment — is invisible to a unit test and invisible in dev.
 *
 * `tests/unit/server/routes.test.ts` checks the route tables and `vercel.json`
 * statically; `tests/e2e/p0/routes.spec.ts` checks what renders; this checks
 * that the servers answer — both of them, since `backend.md` B1: the static
 * host on `baseURL` and `apps/server` on its own origin, which is what
 * `docs/deploy.md` §7 means by "the same run covers both halves".
 */
import { expect, test } from '@playwright/test';

import { checkRouteCoverage, runSmoke } from '../../../../../scripts/smoke';

/** Where `playwright.config.ts` starts `apps/server`, and what `.env.e2e` bakes in. */
const API_BASE = 'http://127.0.0.1:8787';

test.describe('production smoke', () => {
  // A cold dictionary load is seconds, and the first case pays for it; the
  // artifact case then transfers tens of megabytes off the preview server.
  test.setTimeout(300_000);

  test('every route has a case, and the built servers answer all of them', async ({ baseURL }) => {
    expect(
      checkRouteCoverage(),
      'a route apps/server declares has no case in SMOKE_CASES (scripts/smoke.ts)',
    ).toEqual([]);

    // The API base has to be passed: the app's origin serves no `/api/**` at
    // all now, and `vercel.json`'s fallback deliberately excludes `/api/` so
    // those paths 404 rather than answering `index.html`. Without it every API
    // case would fail against a perfectly healthy pair.
    const result = await runSmoke({
      baseURL: baseURL as string,
      apiBaseURL: API_BASE,
    });
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
