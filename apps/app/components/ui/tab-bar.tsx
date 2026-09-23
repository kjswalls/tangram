import type { ReactNode } from 'react';

import type { TabAccent } from '@/components/ui/tab-accent';
import { cn } from '@/lib/cn';

/**
 * The phone shell's tab bar (docs/plans/core.md C1; C7 mounts it).
 *
 * §1 states the placement and this is where it lands: **three tabs, at the
 * bottom on a phone, thumb-reachable**, with `env(safe-area-inset-bottom)` as
 * padding so the bar's background extends under the home indicator rather than
 * the last row of buttons sitting on top of it. `ios.md` I5's safe-area work and
 * `android.md` A2's inset work both depend on this being here and not guessed at
 * twice.
 *
 * **It takes a link renderer rather than importing the router.** C7's rule is
 * that a screen cannot tell which shell it is in, and the same discipline is
 * cheap here: `components/ui/**` is the layer both shells and the gallery
 * render, and the gallery has no router destinations to point at. The shell
 * passes a renderer; the gallery passes a no-op one.
 *
 * **The active tint is the destination's own, not one colour for all three.**
 * §1 assigns the accents by meaning — jade is Look up, vermillion is Practice
 * and the single primary action, gold is "new" — so a bar that painted whatever
 * tab was active in vermillion put a permanent vermillion-tinted region in the
 * chrome of every screen, next to the one vermillion action that screen is
 * allowed. Look up is the app's home; it is jade there. `accent` defaults to
 * `neutral`, which is ink on a `--border` pill and is the right answer for a
 * destination with no colour of its own.
 */
export type { TabAccent };

export interface TabItem {
  key: string;
  label: string;
  /** Decorative; the label is the accessible name. */
  icon?: ReactNode;
  /** Defaults to `neutral`. See the header. */
  accent?: TabAccent;
}

/**
 * Generic over the item, so a caller with a richer tab — the shells' `TabItem`
 * in `components/shell/nav.ts` carries a path and a blurb — gets it back in the
 * renderer rather than having to look it up again by key. Anything satisfying
 * `TabItem` is a tab as far as this component is concerned.
 */
export interface TabBarProps<T extends TabItem = TabItem> {
  items: readonly T[];
  /** `key` of the active tab, or undefined when none is. */
  active?: string;
  /**
   * Renders one tab's clickable body. The shell hands back a router `<Link>`;
   * the gallery hands back a `<button>`. `active` drives `aria-current`.
   */
  renderItem: (item: T, state: { active: boolean; className: string }) => ReactNode;
  className?: string;
  'aria-label'?: string;
}

/** The part every tab shares, whatever its accent. */
// `wide:whitespace-nowrap`: in the wide header the bar is shrink-to-fit, and
// each flex-1 item was sized below its label, so "Look up" broke onto two lines
// at 844px and at 1280px (first-run audit). Wide only: the phone bar is the
// full width, and at 320px under a large text setting the three labels only fit
// because "Look up" may wrap there (the audit's second review measured it).
export const TAB_ITEM_CLASS =
  'flex flex-1 flex-col items-center justify-center gap-0.5 rounded-[var(--r-sm)] ' +
  'px-2 py-1.5 text-xs font-medium min-h-11 text-muted wide:whitespace-nowrap';

const ACTIVE: Record<TabAccent, string> = {
  neutral: 'aria-[current=page]:text-ink aria-[current=page]:bg-border/60',
  lookup: 'aria-[current=page]:text-lookup aria-[current=page]:bg-lookup-soft',
  practice: 'aria-[current=page]:text-practice aria-[current=page]:bg-practice-soft',
  new: 'aria-[current=page]:text-new aria-[current=page]:bg-new-soft',
};

/**
 * The class a renderer applies, so the two shells cannot drift apart. Exported
 * as a function rather than a constant because the accent is per destination;
 * `TAB_ITEM_CLASS` is still the shared half, and the tests assert both.
 */
export function tabItemClass(accent: TabAccent = 'neutral'): string {
  return `${TAB_ITEM_CLASS} ${ACTIVE[accent]}`;
}

export { ACTIVE as TAB_ACTIVE_CLASS };

export function TabBar<T extends TabItem>({
  items,
  active,
  renderItem,
  className,
  'aria-label': label = 'Main',
}: TabBarProps<T>) {
  return (
    <nav
      aria-label={label}
      data-testid="tab-bar"
      className={cn(
        'border-t border-border bg-surface/95 backdrop-blur',
        'pb-[env(safe-area-inset-bottom)]',
        className,
      )}
    >
      <ul className="mx-auto flex w-full max-w-3xl items-stretch gap-1 px-2 py-1">
        {items.map((item) => (
          <li key={item.key} className="flex flex-1">
            {renderItem(item, {
              active: item.key === active,
              className: tabItemClass(item.accent),
            })}
          </li>
        ))}
      </ul>
    </nav>
  );
}
