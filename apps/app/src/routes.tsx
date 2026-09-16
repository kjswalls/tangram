/**
 * The route table (docs/plans/web.md W1).
 *
 * **This file is `web.md`'s and `core.md` C7 changed it.** W1 created it with
 * the eight routes of the day because W1 had to keep that day's suite green;
 * C7 collapsed them to three tabs (product-decisions §1) and re-ran
 * `pnpm smoke` and the service-worker specs against the collapsed table.
 *
 * **`TAB_PATHS` is the source** — `components/shell/nav.ts` — and the nav, the
 * smoke cases, the service worker's precache list and the phase notes all read
 * it, so this table and the tab bar cannot disagree. That is the job `NAV_ITEMS`
 * did for the seven, and `NAV_ITEMS` no longer exists.
 * `/library/lists/:id` is the fourth path and is not itself a tab.
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

import { TAB_PATHS } from '@/components/shell/nav';

import { Root } from './root';
import { GalleryRoute } from './routes/gallery';
import { SpanSelectRoute } from './routes/span-select';
import { ListDetailRoute } from './routes/list-detail';
import { LibraryRoute } from './routes/library';
import { NotFoundRoute } from './routes/not-found';
import { LookUpRoute } from './routes/look-up';
import { PracticeRoute } from './routes/practice';
import { TextsRoute } from './routes/texts';

/** Empty in every production build. See the note above. */
const devOnlyRoutes: RouteObject[] =
  import.meta.env.DEV || import.meta.env.MODE === 'e2e'
    ? [{ path: 'gallery', element: <GalleryRoute /> }]
    : [];

/**
 * `/span-select` — the drag-select harness (docs/plans/core.md C5a), **outside
 * the shell**.
 *
 * It is a top-level route rather than a child of `<Root>` because `ios.md` I2
 * opens it on a physical device with nothing else booted: no header, no nav, no
 * dictionary, no providers. Same build-mode guard as the gallery, so it leaves
 * a production build with it.
 */
const devOnlyStandalone: RouteObject[] =
  import.meta.env.DEV || import.meta.env.MODE === 'e2e'
    ? [{ path: '/span-select', element: <SpanSelectRoute /> }]
    : [];

export const routes: RouteObject[] = [
  ...devOnlyStandalone,
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
    /**
     * **Three tabs** (docs/plans/core.md C7). Seven routes became three
     * destinations plus two sub-paths that keep their tab marked: `/read` is a
     * text a learner comes back to, and `/library/lists/:id` is one list.
     *
     * The paths come from `components/shell/nav.ts`'s `TAB_PATHS` rather than
     * being written here, so the tab bar and the router cannot disagree about
     * where a tab is — which is the job `NAV_ITEMS` did for the seven.
     *
     * **There are no redirects from the old paths, deliberately.** There are no
     * users and no bookmarks (CLAUDE.md), and a redirect would make C7's
     * criterion "no spec references a removed route" untestable: a stale
     * `page.goto('/review')` would keep passing.
     * `tests/unit/shell/tab-routes.test.ts` fails if one comes back.
     */
    children: [
      { index: true, element: <LookUpRoute /> },
      { path: TAB_PATHS.texts.slice(1), element: <TextsRoute /> },
      { path: TAB_PATHS.practice.slice(1), element: <PracticeRoute /> },
      { path: TAB_PATHS.library.slice(1), element: <LibraryRoute /> },
      { path: TAB_PATHS.list.slice(1), element: <ListDetailRoute /> },
      ...devOnlyRoutes,
      // Inside the layout, so a 404 keeps the header and the tab bar.
      { path: '*', element: <NotFoundRoute /> },
    ],
  },
];
