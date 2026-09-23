'use client';

/**
 * The shell (docs/plans/core.md C7; `wave-zero.md` §10c).
 *
 * **One component, two arrangements — not two components.** C7 calls for a
 * phone shell and a wide shell, and the first build was two components chosen
 * by a media query: `const Shell = wide ? WideShell : PhoneShell`. That swaps
 * the component *type* at one slot, so React destroys and rebuilds the entire
 * screen subtree every time the query flips — and `ReviewSession`'s unmount
 * cleanup is `reset()`. Rotating a phone mid-session threw the session's
 * progress away, a typed free-recall answer with it, and focus with that; and
 * because `useIsWide()` starts `false`, every wide page load mounted, unmounted
 * and remounted each screen. The identical-screens rule is not only about what
 * the two arrangements *show*: a screen that cannot tell which shell it is in
 * must also not be destroyed when the answer changes.
 *
 * So the tree is stable — root, header, `main`, bar — and `wide` decides only
 * where the tabs sit and how wide the column is. `children` occupies the same
 * position in both, which is what keeps its state.
 *
 * **The one difference is the tab bar's place**, and that is the whole of it:
 * the tabs sit in the header where a pointer already is, or in a thumb-reach
 * bar at the bottom of the viewport. Nothing else differs, and `wide-blurb` —
 * a subtitle an earlier draft showed only on wide — is gone for exactly that
 * reason.
 *
 * `data-testid` still reports `phone-shell` or `wide-shell`, because "exactly
 * one shell, always" is a thing C7's spec asserts and a thing worth asserting.
 *
 * This file is not in C7's Files list, which names `phone-shell.tsx` and
 * `wide-shell.tsx` and leaves the choosing unstated; those two files are gone.
 * Recorded in HANDOFF.md.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

import { useLocation, useNavigate } from 'react-router';

import { ScreenNavigateProvider, type ScreenDestination } from '@/components/screens/navigate';
import { SiteHeader } from '@/components/shell/site-header';
import { TabLink } from '@/components/shell/nav-link';
import { TABS, TAB_PATHS, listPath, tabForPath, type TabKey } from '@/components/shell/nav';
import { TabBar } from '@/components/ui/tab-bar';
import { cn } from '@/lib/cn';

/**
 * C1's `--breakpoint-wide`, as a media query.
 *
 * It is a copy of the token's value and `tests/unit/ui/tokens.test.ts` is where
 * that is checked — the browser gives no way to read a `@theme` variable as a
 * media query, so the two are kept in step by a test rather than by a comment
 * claiming they cannot drift. (They could; the test is what stops it.)
 */
export const WIDE_QUERY = '(min-width: 45rem)';

/**
 * `false` until the first effect, which is the safe direction: the phone
 * arrangement at a wide width for one frame is a narrower column, while the
 * wide arrangement on a phone is a tab row that does not fit. There is no SSR
 * here, so "one frame" is the whole of the cost — and since the arrangement no
 * longer changes the component tree, that frame no longer costs a remount.
 */
export function useIsWide(): boolean {
  return useMediaQuery(WIDE_QUERY);
}

/**
 * How tall the viewport must be before the wide header is pinned.
 *
 * **A phone in landscape is wide** — 45rem is narrower than any current phone
 * on its side — so without this it gets the pinned header, and a header of
 * 65–110px holds a fifth to a quarter of a ~390px viewport for good (WCAG
 * 1.4.10). The same is true of a desktop browser zoomed on a short screen. So
 * below this height the wide arrangement keeps its tabs in the header and lets
 * the header scroll away with the page, as the phone header does.
 *
 * 32rem (512px) sits above every phone's landscape height, the largest of
 * which is about 440px before the browser's own chrome, and below the usable
 * height of a laptop screen or a tablet on its side. A viewport this short
 * still has the tabs one scroll away — at the top of the page, where they
 * always were before the header was pinned.
 */
export const PIN_QUERY = '(min-height: 32rem)';

function useMediaQuery(media: string): boolean {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(media);
    const update = () => setMatches(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, [media]);
  return matches;
}

/**
 * The CSS variable the wide header's measured height is written to, on `<html>`.
 *
 * **The wide header is pinned to the top of the viewport**, which it was not
 * until the wide-shell phase: at any real scroll depth the tab bar used to be
 * off screen, so a pointer user had to scroll back to the top to change tabs.
 * Pinning it costs something everywhere else, because the browser now puts
 * things *under* it: a focus move that scrolls, Tab through a page, an in-page
 * anchor and `scrollIntoView()` all aim at the top edge of the viewport, and
 * that edge is the header's now.
 *
 * `app/globals.css` turns this variable into `scroll-padding-top` on the root
 * scroller, which is the one knob every one of those paths honours — so they
 * land clear of the header without each caller knowing it exists. It is also
 * the shell's top padding (the header is out of flow) and how the two
 * `md:sticky` side panels (Look up's answer, the reader's) sit below the
 * header rather than under it.
 *
 * **`fixed`, not `sticky`, and the difference is measured.** A sticky header
 * is still *in* the root scroller, and with the scroll padding in place its
 * own tab links sit inside the padded band — so the browser judges a stuck
 * tab link out of view and "scrolls it into view" by moving the page, which
 * leaves the header where it was and the learner 364px from where they were.
 * `focus()` on a tab did it, and so did Playwright's scroll-before-click, which
 * is how it was found: the scroll-restoration spec saved the wrong offset. A
 * fixed element is not scrolled by the root scroller, so neither path moves
 * the page. `tests/e2e/core/wide-shell.spec.ts` holds it.
 *
 * **Measured, not computed.** The header wraps below ~800px when the wordmark
 * and the tabs stop fitting on one row, and a font swap or a zoom changes its
 * height too. `--tab-bar-height` is a hand-computed copy of a height and its
 * own comment records the pixel that cost; this one is read off the element.
 *
 * Zero — absent — in the phone arrangement, whose header scrolls away with the
 * page exactly as it always did, **and in a wide arrangement too short to pin
 * it** (`PIN_QUERY`), whose header does the same. Everything that reads the
 * variable — the shell's padding, the scroll padding, the side panels' offset
 * and height — therefore falls back to zero in both, with no second rule.
 */
export const HEADER_HEIGHT_VAR = '--shell-header-height';

function usePinnedHeaderHeight(header: RefObject<HTMLElement | null>, pinned: boolean): void {
  // A layout effect: the header leaves the flow on the render that makes it
  // wide, and the shell's padding has to be the right height before that
  // render is painted or the page's first line flashes under the header.
  useLayoutEffect(() => {
    const root = document.documentElement;
    const node = header.current;
    if (!pinned || !node) {
      root.style.removeProperty(HEADER_HEIGHT_VAR);
      return;
    }
    const write = () => {
      root.style.setProperty(HEADER_HEIGHT_VAR, `${node.getBoundingClientRect().height}px`);
    };
    write();
    // jsdom has no ResizeObserver; the one write above is all a unit test sees.
    if (typeof ResizeObserver !== 'function') {
      return () => root.style.removeProperty(HEADER_HEIGHT_VAR);
    }
    const observer = new ResizeObserver(write);
    observer.observe(node);
    return () => {
      observer.disconnect();
      root.style.removeProperty(HEADER_HEIGHT_VAR);
    };
  }, [header, pinned]);
}

/** Where a screen's destination actually is. The only place that knows. */
export function pathFor(to: ScreenDestination): string {
  if (to.tab === 'lookup') {
    return 'view' in to && to.view === 'texts' ? TAB_PATHS.texts : TAB_PATHS.lookup;
  }
  if (to.tab === 'practice') return TAB_PATHS.practice;
  return 'list' in to && to.list ? listPath(to.list) : TAB_PATHS.library;
}

function Tabs({ active, className }: { active?: TabKey; className?: string }) {
  return (
    <TabBar
      {...(className === undefined ? {} : { className })}
      items={TABS}
      {...(active === undefined ? {} : { active })}
      renderItem={(item, state) => (
        <TabLink item={item} active={state.active} className={state.className} />
      )}
    />
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const wide = useIsWide();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const active = tabForPath(pathname);
  // Wide, and tall enough to spare the header (`PIN_QUERY`). `false` until the
  // first effect, like `wide`: a header in flow for one frame is the safe side.
  const tall = useMediaQuery(PIN_QUERY);
  const pinned = wide && tall;
  const headerRef = useRef<HTMLElement>(null);
  usePinnedHeaderHeight(headerRef, pinned);

  return (
    <ScreenNavigateProvider value={(to) => navigate(pathFor(to))}>
      <div
        data-testid={wide ? 'wide-shell' : 'phone-shell'}
        data-shell={wide ? 'wide' : 'phone'}
        // `globals.css` keys the root's scroll padding on this.
        data-header={pinned ? 'pinned' : 'in-flow'}
        // The header is out of flow when pinned; this is the room it took.
        className={cn(
          'flex min-h-dvh flex-col',
          pinned ? 'pt-[var(--shell-header-height)] print:pt-0' : '',
        )}
      >
        {/*
          Pinned on a wide screen, so the tabs stay where the pointer can reach
          them at any scroll depth — see `HEADER_HEIGHT_VAR` for what that costs,
          where it is paid, and why `fixed` rather than `sticky`. `z-30` is above
          the page's own stacking (the stats tooltip, the practice bar) and below
          `Sheet`'s `z-40`, so an open sheet still covers it. The phone
          arrangement is unchanged: its tabs are a `fixed` bar at the bottom and
          its header scrolls away.

          Two things a pinned header owes that an in-flow one did not: the top
          safe-area inset, because `index.html` asks for `viewport-fit=cover`
          and a tablet in the wide arrangement would otherwise keep the tabs
          under its status bar at every depth (the measured height includes the
          inset, so the padding and the scroll padding clear it too); and
          `print:static`, because a fixed element repeats on every printed page
          and the shell's padding clears only the first.

          Pinned only when the viewport is tall enough to spare it
          (`PIN_QUERY`): a wide viewport that is short — a phone on its side —
          keeps the tabs in the header and the header in flow, so it scrolls
          away like the phone's. The safe-area inset stays either way; in flow,
          the header is still the first thing under the status bar.
        */}
        <header
          ref={headerRef}
          data-testid="shell-header"
          className={cn(
            'border-b border-border bg-surface/80 backdrop-blur',
            wide ? 'pt-[env(safe-area-inset-top,0px)]' : 'px-4 py-3',
            pinned && 'fixed inset-x-0 top-0 z-30 print:static',
          )}
        >
          {wide ? (
            <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-3 px-6 py-3">
              <SiteHeader />
              {/* No top border and no safe-area padding: it is inside the
                  header here, not a bar hanging off the bottom of the viewport. */}
              <Tabs
                {...(active === undefined ? {} : { active })}
                className="w-auto border-t-0 bg-transparent pb-0 backdrop-blur-none"
              />
            </div>
          ) : (
            <SiteHeader />
          )}
        </header>

        {/*
          The screen, in the same slot either way. `--tab-bar-height` is zero in
          the wide arrangement (`tokens.css`), so one expression covers both:
          the bar's own height plus room to breathe on a phone, and the plain
          page padding on a wide screen.
        */}
        <main
          className={cn(
            'mx-auto w-full flex-1',
            wide
              ? 'max-w-5xl px-6 py-6'
              : 'max-w-3xl px-4 pt-4 pb-[calc(var(--tab-bar-height)+1.5rem)]',
          )}
        >
          {children}
        </main>

        {wide ? null : (
          <Tabs {...(active === undefined ? {} : { active })} className="fixed inset-x-0 bottom-0 z-20" />
        )}
      </div>
    </ScreenNavigateProvider>
  );
}
