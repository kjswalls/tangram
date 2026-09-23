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
 * Six decisions in here that the plan does not make:
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
 * - **The first render announces nothing** — and the sentinel is the *pathname
 *   it mounted on*, not a boolean. A `useRef(true)` flag flipped inside the
 *   effect is consumed by StrictMode's mount → cleanup → mount in development,
 *   so the real mount took the announcing branch and every `pnpm dev` session
 *   opened with focus yanked to the heading. Found by W8a's adversarial review;
 *   production React made it invisible, and `tests/unit/render.tsx` has no
 *   StrictMode, so nothing else would have.
 * - **The same name twice still announces.** A live region speaks on
 *   *mutation*: writing the same string is no mutation and says nothing at all.
 *   So the region is cleared first and filled a tick later, which is the
 *   standard way to repeat an announcement. (Every list used to be headed
 *   "Library", which is how this was found; each list is headed with its own
 *   name now, but two routes can still share one — two lists called "Verbs".)
 * - **A heading whose name is still loading is waited for.** A list's name is
 *   in IndexedDB and arrives a read after the route renders, so at the commit
 *   the heading holds nothing — or, moving straight from one list to another,
 *   the *previous* list's name. `PageHeader` marks that heading `aria-busy`,
 *   and the announcement waits for the mark to clear, for at most
 *   `HEADING_WAIT_MS`. Focus does not wait: it moves to the heading at once,
 *   because the element is the same one either way and a screen reader left
 *   on the tab that was just pressed is the trap this file exists for.
 * - **A deliberate navigation can claim focus, and the claim is a deferral, not
 *   a cancellation.** `Mod+K` from another tab navigates to Look up *and*
 *   focuses the box; both this effect and `focusLookupInput`'s frame loop then
 *   want focus on the same commit, and whichever lands last wins. It failed two
 *   runs in five. So the claimant says so before navigating and this effect
 *   stands aside — but only for `FOCUS_CLAIM_GRACE_MS`, after which it checks
 *   whether focus actually landed inside the new view and takes it if not.
 *   Cancelling outright would be worse than the race: the box lives inside
 *   `<DictGate>` and is simply absent on an origin with no dictionary, so
 *   `focusLookupInput` gives up silently, the element focus came from has
 *   unmounted, and focus falls to `<body>` — which is exactly the screen-reader
 *   trap this component exists to prevent.
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

/**
 * Long enough for React to paint the cleared region, short enough that the
 * announcement still belongs to the navigation that caused it.
 */
export const ANNOUNCE_DELAY_MS = 60;

/**
 * How long a claimant has to land focus inside the new view before the
 * announcer stops standing aside. Long enough for `focusLookupInput`'s frame
 * loop to find a box that renders normally; short enough that a screen reader
 * is not left on `<body>` for a noticeable beat when it never appears.
 */
export const FOCUS_CLAIM_GRACE_MS = 200;

/**
 * How long the announcement waits for a busy heading's name. A list's name is
 * one IndexedDB read; this is the ceiling for a slow device, after which the
 * route's generic name is spoken rather than nothing.
 */
export const HEADING_WAIT_MS = 2000;

const isBusy = (heading: HTMLElement | null) => heading?.getAttribute('aria-busy') === 'true';

/**
 * Set by whoever is about to navigate *and* move focus themselves. Read once,
 * by the next route change, and cleared there whether or not it matched — a
 * claim that outlived its navigation would silence the announcer's focus move
 * on some later, unrelated one.
 */
let focusClaim: string | null = null;

/** Claim focus for the navigation to `pathname`. See `FOCUS_CLAIM_GRACE_MS`. */
export function claimRouteFocus(pathname: string): void {
  focusClaim = pathname;
}

export function RouteAnnouncer() {
  const { pathname } = useLocation();
  const [announced, setAnnounced] = useState('');
  /** The path this mounted on. See the header — a boolean is not StrictMode-proof. */
  const announcedFor = useRef(pathname);

  useEffect(() => {
    if (announcedFor.current === pathname) return;
    announcedFor.current = pathname;

    const claimed = focusClaim === pathname;
    focusClaim = null;

    const heading = routeHeading();
    const moveFocus = () => {
      const target = heading ?? document.querySelector<HTMLElement>('main');
      if (!target) return;
      // A heading is not focusable by nature. `-1` makes it programmatically
      // focusable without putting it in the tab order, which is the whole of
      // what this needs and the standard spelling of it.
      if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
    };

    let grace: ReturnType<typeof setTimeout> | undefined;
    if (claimed) {
      grace = setTimeout(() => {
        const active = document.activeElement;
        const landed =
          active instanceof HTMLElement &&
          active !== document.body &&
          document.querySelector('main')?.contains(active) === true;
        if (!landed) moveFocus();
      }, FOCUS_CLAIM_GRACE_MS);
    } else {
      moveFocus();
    }

    // The announcement is not affected by the claim: whoever pressed the key
    // still needs to hear which route they are on. The heading is read when it
    // is spoken, not now — see `HEADING_WAIT_MS` — and re-found then, in case
    // the view replaced the element while its name loaded.
    const announce = () => {
      const current = routeHeading();
      const name = isBusy(current) ? undefined : current?.textContent?.trim();
      setAnnounced(name && name !== '' ? name : fallbackRouteName(pathname));
    };

    let observer: MutationObserver | undefined;
    let ceiling: ReturnType<typeof setTimeout> | undefined;
    const stopWaiting = () => {
      observer?.disconnect();
      observer = undefined;
      if (ceiling !== undefined) clearTimeout(ceiling);
      ceiling = undefined;
    };

    setAnnounced('');
    const timer = setTimeout(() => {
      const main = document.querySelector('main');
      if (!isBusy(routeHeading()) || !main || typeof MutationObserver !== 'function') {
        announce();
        return;
      }
      observer = new MutationObserver(() => {
        if (isBusy(routeHeading())) return;
        stopWaiting();
        announce();
      });
      observer.observe(main, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['aria-busy'],
      });
      ceiling = setTimeout(() => {
        stopWaiting();
        announce();
      }, HEADING_WAIT_MS);
    }, ANNOUNCE_DELAY_MS);
    return () => {
      clearTimeout(timer);
      stopWaiting();
      if (grace !== undefined) clearTimeout(grace);
    };
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
