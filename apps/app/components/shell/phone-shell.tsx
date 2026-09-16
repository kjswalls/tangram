'use client';

/**
 * The phone shell (docs/plans/core.md C7; §1's layout facts).
 *
 * **Three tabs, at the bottom, thumb-reachable**, with
 * `env(safe-area-inset-bottom)` as padding so the bar's background extends
 * under the home indicator rather than the last row of buttons sitting on top
 * of it. §1 states the placement because `ios.md` I5's safe-area work and
 * `android.md` A2's inset work both depend on it and were otherwise guessing.
 *
 * The header is the wordmark and nothing else: the tabs are the navigation and
 * a second row of them at the top would be the seven-route header again.
 *
 * `<main>` carries the bar's height as bottom padding — a fixed bar over a
 * scrolling column hides whatever the column ends with, and on this app that is
 * the grade dock on a practice card, which is the one control a learner cannot
 * do without.
 */
import type { ReactNode } from 'react';

import { SiteHeader } from '@/components/shell/site-header';
import { TabLink } from '@/components/shell/nav-link';
import { TABS, type TabKey } from '@/components/shell/nav';
import { TabBar } from '@/components/ui/tab-bar';

export function PhoneShell({ active, children }: { active?: TabKey; children: ReactNode }) {
  return (
    <div data-testid="phone-shell" data-shell="phone" className="flex min-h-dvh flex-col">
      <header className="border-b border-border bg-surface/80 px-4 py-3 backdrop-blur">
        <SiteHeader />
      </header>

      {/*
        `pb-24` is the bar (≈56px) plus room to breathe; the bar itself adds the
        safe-area inset on top of that, inside its own padding.
      */}
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 pt-4 pb-24">{children}</main>

      <TabBar
        className="fixed inset-x-0 bottom-0 z-20"
        items={TABS}
        {...(active === undefined ? {} : { active })}
        renderItem={(item, state) => (
          <TabLink item={item} active={state.active} className={state.className} />
        )}
      />
    </div>
  );
}
