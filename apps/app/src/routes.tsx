/**
 * The route table (docs/plans/web.md W1).
 *
 * **This file is `web.md`'s and `core.md` C7 changes it.** W1 creates it with
 * today's eight routes because W1 must keep today's suite green; C7 collapses
 * them to three tabs (product-decisions §1), and C7's commit re-runs
 * `pnpm smoke` and the service-worker specs against the collapsed table.
 *
 * `NAV_ITEMS` stays the source of the seven nav routes — the nav, the smoke
 * cases and the phase notes all read it — so this table and the nav cannot
 * disagree. `/lists/:id` is the eighth and is not in the nav.
 *
 * **`/gallery` is the ninth, and never in a production build**
 * (docs/plans/core.md C1). The guard is the BUILD MODE, and that choice is
 * load-bearing:
 *
 * - `import.meta.env.DEV` is true under `pnpm dev`, which is where the owner
 *   and the adversarial review actually open the gallery. C1 calls it "what
 *   makes each later phase reviewable without driving the whole app"; a gallery
 *   that only exists inside a test build is not that.
 * - `import.meta.env.MODE === 'e2e'` is true only for `pnpm build:e2e`, which
 *   passes `--mode e2e`. The suite runs against a **production** build
 *   (`import.meta.env.PROD` stays true, so the service worker still registers
 *   and `tests/e2e/p6/pwa.spec.ts` still passes) — the mode is a build-time
 *   constant Vite substitutes, and nothing in the environment can turn it on.
 *
 * An earlier draft keyed this to a `VITE_TANGRAM_GALLERY` environment variable
 * and it failed open in both directions: `/gallery` did not exist under
 * `pnpm dev` at all, and a plain `vite build` shipped the whole gallery
 * whenever that variable happened to be in the environment — which `pnpm e2e`
 * itself put there. The mode cannot be switched on by an ambient variable, and
 * `tests/e2e/core/gallery-excluded.spec.ts` builds in production mode **with**
 * that variable set to prove it.
 *
 * Both constants fold to `false` in a production build, so `GalleryRoute` has
 * no live reference and the whole gallery subtree tree-shakes out.
 *
 * `pnpm smoke` needs no exemption: `web.md` W2 derives its cases from the
 * production route table, which by construction has no `/gallery` in it.
 * **W2 must not "fix" the missing case by adding one.**
 */

import type { RouteObject } from 'react-router';

import { Root } from './root';
import { GalleryRoute } from './routes/gallery';
import { ListDetailRoute } from './routes/list-detail';
import { ListsRoute } from './routes/lists';
import { NotFoundRoute } from './routes/not-found';
import { LookupRoute } from './routes/lookup';
import { ReadRoute } from './routes/read';
import { ReviewRoute } from './routes/review';
import { SettingsRoute } from './routes/settings';
import { StatsRoute } from './routes/stats';
import { TodayRoute } from './routes/today';

/** Empty in every production build. See the note above. */
const devOnlyRoutes: RouteObject[] =
  import.meta.env.DEV || import.meta.env.MODE === 'e2e'
    ? [{ path: 'gallery', element: <GalleryRoute /> }]
    : [];

export const routes: RouteObject[] = [
  {
    path: '/',
    element: <Root />,
    // Without this, any error thrown by any route component — and any unmatched
    // URL, which the SPA fallback makes routine — replaces the entire app with
    // React Router's unstyled built-in error page. See routes/not-found.tsx.
    errorElement: (
      <Root>
        <NotFoundRoute />
      </Root>
    ),
    children: [
      { index: true, element: <TodayRoute /> },
      { path: 'lookup', element: <LookupRoute /> },
      { path: 'review', element: <ReviewRoute /> },
      { path: 'read', element: <ReadRoute /> },
      { path: 'lists', element: <ListsRoute /> },
      { path: 'lists/:id', element: <ListDetailRoute /> },
      { path: 'stats', element: <StatsRoute /> },
      { path: 'settings', element: <SettingsRoute /> },
      ...devOnlyRoutes,
      // Inside the layout, so a 404 keeps the header and the nav.
      { path: '*', element: <NotFoundRoute /> },
    ],
  },
];
