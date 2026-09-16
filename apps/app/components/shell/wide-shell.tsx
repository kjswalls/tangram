'use client';

/**
 * The wide shell (docs/plans/core.md C7; `wave-zero.md` §10c).
 *
 * **The same three destinations in a wider container, not a second design.**
 * §1 says so and §10c settles what "wide" gets: the **page shell**, not the
 * command palette. The palette's only real justification was a global hotkey,
 * a browser tab cannot summon itself, and the desktop application that could is
 * deferred — so `core.md` C9 is cancelled and this is what wide screens get.
 *
 * The difference from the phone is the tab bar's *place*, not the screens: the
 * tabs sit in the header beside the wordmark, where a pointer already is, and
 * nothing is fixed to the bottom of a viewport that is not a thumb's reach.
 * That is the whole of it, which is what "close to free" in §1 means and what
 * C7's identical-screens criterion is asserting.
 */
import type { ReactNode } from 'react';

import { SiteHeader } from '@/components/shell/site-header';
import { TabLink } from '@/components/shell/nav-link';
import { TABS, type TabKey } from '@/components/shell/nav';
import { TabBar } from '@/components/ui/tab-bar';

export function WideShell({ active, children }: { active?: TabKey; children: ReactNode }) {
  return (
    <div data-testid="wide-shell" data-shell="wide" className="flex min-h-dvh flex-col">
      <header className="border-b border-border bg-surface/80 backdrop-blur">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-3 px-6 py-3">
          <SiteHeader />
          <TabBar
            // No top border and no safe-area padding: it is inside the header
            // here, not a bar hanging off the bottom of the viewport.
            className="w-auto border-t-0 bg-transparent pb-0 backdrop-blur-none"
            items={TABS}
            {...(active === undefined ? {} : { active })}
            renderItem={(item, state) => (
              <TabLink item={item} active={state.active} className={state.className} />
            )}
          />
        </div>
      </header>

      {/*
        Nothing here but the screen. An earlier draft put the tab's blurb above
        it, which is exactly the drift this phase's criterion is aimed at: one
        shell showing a sentence the other does not.
      */}
      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-6">{children}</main>
    </div>
  );
}
