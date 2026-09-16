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
 */
export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-6">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {children ? <p className="mt-1 text-sm text-muted">{children}</p> : null}
    </div>
  );
}
