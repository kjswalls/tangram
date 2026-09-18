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
export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-6">
      <h1
        data-route-heading
        tabIndex={-1}
        className="text-2xl font-semibold tracking-tight outline-none"
      >
        {title}
      </h1>
      {children ? <p className="mt-1 text-sm text-muted">{children}</p> : null}
    </div>
  );
}
