'use client';

/**
 * Which shell (docs/plans/core.md C7).
 *
 * **One shell in the DOM at a time, chosen by a media query**, rather than both
 * rendered with one hidden. Two copies would mean two tab bars, two
 * `aria-current`s and two of every test id in them — and a screen reader would
 * read the hidden one unless every branch remembered `aria-hidden`. The
 * breakpoint is C1's `--breakpoint-wide` (45rem / 720px), read from the
 * stylesheet's own variable rather than repeated, so the shells and the `wide:`
 * variant cannot drift.
 *
 * **The screen is rendered once, by either.** That is C7's rule made structural:
 * the shells differ in where the tabs sit and how wide the column is, and in
 * nothing else, so there is exactly one place a screen can be.
 *
 * This file is not in C7's Files list — it names `phone-shell.tsx` and
 * `wide-shell.tsx` and leaves the choosing unstated. Recorded in HANDOFF.md.
 */
import { useEffect, useState, type ReactNode } from 'react';

import { useLocation, useNavigate } from 'react-router';

import { ScreenNavigateProvider, type ScreenDestination } from '@/components/screens/navigate';
import { PhoneShell } from '@/components/shell/phone-shell';
import { WideShell } from '@/components/shell/wide-shell';
import { TAB_PATHS, listPath, tabForPath } from '@/components/shell/nav';

/** C1's `--breakpoint-wide`, as a media query. */
export const WIDE_QUERY = '(min-width: 45rem)';

/**
 * `false` until the first effect, which is the safe direction: the phone shell
 * at a wide width for one frame is a narrower column, while the wide shell on a
 * phone is a tab row that does not fit. There is no SSR here, so "one frame" is
 * the whole of the cost.
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
  if (to.tab === 'lookup') return 'view' in to && to.view === 'texts' ? TAB_PATHS.texts : TAB_PATHS.lookup;
  if (to.tab === 'practice') return TAB_PATHS.practice;
  return 'list' in to && to.list ? listPath(to.list) : TAB_PATHS.library;
}

export function AppShell({ children }: { children: ReactNode }) {
  const wide = useIsWide();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const active = tabForPath(pathname);

  const Shell = wide ? WideShell : PhoneShell;
  return (
    <ScreenNavigateProvider value={(to) => navigate(pathFor(to))}>
      <Shell {...(active === undefined ? {} : { active })}>{children}</Shell>
    </ScreenNavigateProvider>
  );
}
