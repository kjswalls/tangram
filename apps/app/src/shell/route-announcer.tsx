'use client';

/**
 * Focus and the announcement, on every route change (docs/plans/web.md W8).
 *
 * **A document navigation moves focus and resets scroll; a client-side one does
 * neither**, and an SPA that skips this is a screen-reader trap: the reader is
 * left at the bottom of the page it just left, with no signal that anything
 * changed. W8 calls it "not optional polish; it is the thing SPAs are notorious
 * for getting wrong".
 *
 * Three decisions in here that the plan does not make:
 *
 * - **It keys on `pathname`, never on the whole location.** `?q=` changes the
 *   location on every settled keystroke (`src/url/lookup-query.ts`), and an
 *   announcer keyed on `location` would rip focus out of the lookup box and
 *   back to the heading in the middle of typing a word. A search is not a route
 *   change.
 * - **`focus({ preventScroll: true })`, always.** Focusing an element scrolls
 *   it into view by default, which is precisely the scroll position
 *   `<ScrollRestoration>` has just restored on a Back press. The two would
 *   fight, and the announcer would win, and criterion 3 would fail for a reason
 *   nothing in it mentions.
 * - **The first render announces nothing.** On a cold load the browser has
 *   already put the learner at the top of a freshly rendered document; moving
 *   focus and announcing there would be an SPA impersonating a page load.
 *
 * The heading is the route's name — every screen opens with one `PageHeader`
 * (`components/ui/page-header.tsx`), which carries `data-route-heading` for
 * exactly this. The fallbacks are the first `<h1>` in `<main>` and then `<main>`
 * itself, so a route that somehow has no heading still moves focus somewhere
 * inside the new view rather than leaving it on the tab the learner just left.
 */
import { useEffect, useRef, useState } from 'react';

import { useLocation } from 'react-router';

import { TAB_PATHS, tabForPath, TABS } from '@/components/shell/nav';

export const ROUTE_HEADING_ATTR = 'data-route-heading';

/** The route's name when the DOM has no heading to read it off. */
export function fallbackRouteName(pathname: string): string {
  if (pathname === TAB_PATHS.texts) return 'Your own texts';
  const tab = tabForPath(pathname);
  return TABS.find((item) => item.key === tab)?.label ?? 'Page';
}

/** The element a route change moves focus to, and reads its name from. */
export function routeHeading(doc: Document = document): HTMLElement | null {
  return (
    doc.querySelector<HTMLElement>(`main [${ROUTE_HEADING_ATTR}]`) ??
    doc.querySelector<HTMLElement>('main h1')
  );
}

export function RouteAnnouncer() {
  const { pathname } = useLocation();
  const [announced, setAnnounced] = useState('');
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const heading = routeHeading();
    const target = heading ?? document.querySelector<HTMLElement>('main');
    if (target) {
      // A heading is not focusable by nature. `-1` makes it programmatically
      // focusable without putting it in the tab order, which is the whole of
      // what this needs and the standard spelling of it.
      if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
    }
    const name = heading?.textContent?.trim();
    setAnnounced(name && name !== '' ? name : fallbackRouteName(pathname));
  }, [pathname]);

  return (
    <div
      data-testid="route-announcer"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="sr-only"
    >
      {announced}
    </div>
  );
}
