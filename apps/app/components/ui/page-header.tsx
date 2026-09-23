import type { ReactNode } from 'react';

/**
 * Every screen opens the same way: one h1, one line of what it is.
 *
 * It lives in `components/ui/` since core.md C7 and it used to be in
 * `components/shell/`. A heading is not the shell — it holds no navigation, no
 * router and no knowledge of where it is — and C7's rule is that a screen
 * imports nothing from `components/shell/**`. Moving it is cheaper and more
 * honest than carving an exception into the rule, which is the kind of
 * exception that grows.
 *
 * **`data-route-heading` and `tabIndex={-1}` are `web.md` W8's**, and they are
 * two halves of one thing: a client-side navigation has to move focus into the
 * new view or a screen reader is left on the page it just left, and the heading
 * is where a document navigation would have put it. `-1` makes it focusable by
 * script without adding it to the tab order; the attribute is how
 * `src/shell/route-announcer.tsx` finds it without guessing at the DOM. The
 * announcer reads the route's name off it too, which is why the `<p>` below is
 * a sibling rather than a child.
 */
export function PageHeader({
  title,
  children,
  trail,
  busy = false,
}: {
  title: string;
  children?: ReactNode;
  /**
   * Where this page sits, above the heading — one list's way back to Library.
   * Outside the `<h1>`, so the route's name the announcer reads is the page's
   * own and not "Library HSK 1".
   */
  trail?: ReactNode;
  /**
   * The name is still loading. A list's name lives in IndexedDB and arrives a
   * read after the route renders; `aria-busy` tells the announcer to wait for
   * it rather than speak whatever the heading holds at the commit — which,
   * moving from one list to the next, is the *previous* list's name.
   */
  busy?: boolean;
}) {
  return (
    <div className="mb-6">
      {trail}
      <h1
        data-route-heading
        tabIndex={-1}
        aria-busy={busy ? 'true' : undefined}
        className="text-2xl font-semibold tracking-tight outline-none"
      >
        {/* A non-breaking space while busy keeps the line's height, so the page
            does not jump when the name arrives. */}
        {busy ? '\u00a0' : title}
      </h1>
      {children ? <p className="mt-1 text-sm text-muted">{children}</p> : null}
    </div>
  );
}
