'use client';

/**
 * One tab, as a router link (docs/plans/core.md C7).
 *
 * `TabBar` takes a **renderer** rather than importing the router, because
 * `components/ui/**` is the layer both shells and the gallery render and the
 * gallery has no destinations to point at. This is the shells' renderer; the
 * gallery passes a `<button>`.
 *
 * `aria-current="page"` is what marks the tab a learner is on, and it is the
 * attribute `TabBar`'s accent classes key off — so the mark and the tint cannot
 * disagree. Which tab is active is `tabForPath()`'s answer, not this
 * component's: a sub-path like `/read` or `/library/lists/42` keeps its tab
 * marked, and deciding that per link is how the two came apart before.
 */
import { Link } from 'react-router';

import type { TabItem } from '@/components/shell/nav';

export function TabLink({
  item,
  active,
  className,
}: {
  item: TabItem;
  active: boolean;
  className?: string;
}) {
  return (
    <Link
      to={item.path}
      data-testid="tab-link"
      data-tab={item.key}
      // The same tooltip in both shells: anything one shell says and the other
      // does not is a second design (C7's identical-screens rule).
      title={item.blurb}
      aria-current={active ? 'page' : undefined}
      className={className}
    >
      {item.label}
    </Link>
  );
}
