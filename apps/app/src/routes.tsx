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
 */
import type { RouteObject } from 'react-router';

import { Root } from './root';
import { ListDetailRoute } from './routes/list-detail';
import { ListsRoute } from './routes/lists';
import { NotFoundRoute } from './routes/not-found';
import { LookupRoute } from './routes/lookup';
import { ReadRoute } from './routes/read';
import { ReviewRoute } from './routes/review';
import { SettingsRoute } from './routes/settings';
import { StatsRoute } from './routes/stats';
import { TodayRoute } from './routes/today';

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
      // Inside the layout, so a 404 keeps the header and the nav.
      { path: '*', element: <NotFoundRoute /> },
    ],
  },
];
