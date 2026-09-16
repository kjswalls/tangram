/**
 * The root route element — what `app/layout.tsx` composed (docs/plans/web.md W1).
 *
 * `<html>` and `<body>` live in `index.html` now, with the metadata and viewport
 * that Next's `metadata`/`viewport` exports emitted. What is left is the four
 * mounted-once components and the `<main>` wrapper, plus the `<Outlet />` that
 * used to be `children`.
 */
import type { ReactNode } from 'react';

import { Outlet, ScrollRestoration } from 'react-router';

import { PinyinDisplayProvider } from '@/components/hanzi/pinyin-display';
import { RegisterServiceWorker } from '@/components/pwa/register-sw';
import { AppShell } from '@/components/shell/app-shell';
import { HardwareBackButton } from '@/components/shell/hardware-back-button';
import { TestHooks } from '@/components/shell/test-hooks';

/**
 * `children` is for the router's `errorElement`, which renders outside the
 * `<Outlet />` and would otherwise lose the header and the nav.
 *
 * `<ScrollRestoration />` is not decoration: `history.scrollRestoration` is
 * `auto` by default and cannot work in an SPA, because the browser restores the
 * offset at popstate — before React has re-rendered the page it belongs to. Next
 * handled this; a data-mode router does it only if asked.
 */
export function Root({ children }: { children?: ReactNode }) {
  return (
    // One subscription to the pinyin-visibility setting for the whole tree,
    // rather than one per Chinese run — a passage has hundreds (core.md C3).
    <PinyinDisplayProvider>
      <TestHooks />
      <RegisterServiceWorker />
      {/*
        Android's hardware back button (docs/plans/android.md A1). Renders
        nothing and does nothing off Android; it is mounted here, beside the
        other mounted-once components, because it must see every navigation and
        there is exactly one of it. `core.md` C7 re-baselined its tab list.
      */}
      <HardwareBackButton />
      {/*
        The shell owns the header, the tab bar and the `<main>` column now
        (core.md C7): which of the two it is depends on the width, and both put
        the screen in exactly one place.
      */}
      <AppShell>{children ?? <Outlet />}</AppShell>
      <ScrollRestoration />
    </PinyinDisplayProvider>
  );
}
