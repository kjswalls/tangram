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
import { useEffect, useState, type ReactNode } from 'react';

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
  const [wide, setWide] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(WIDE_QUERY);
    const update = () => setWide(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return wide;
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

  return (
    <ScreenNavigateProvider value={(to) => navigate(pathFor(to))}>
      <div
        data-testid={wide ? 'wide-shell' : 'phone-shell'}
        data-shell={wide ? 'wide' : 'phone'}
        className="flex min-h-dvh flex-col"
      >
        <header
          className={cn(
            'border-b border-border bg-surface/80 backdrop-blur',
            wide ? '' : 'px-4 py-3',
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
