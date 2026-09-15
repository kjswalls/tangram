import type { ReactNode } from 'react';

/**
 * One reviewable block of the gallery (docs/plans/core.md C1).
 *
 * Every section carries `data-testid="gallery-section"` and its key, so a spec
 * can screenshot per section and the adversarial review can name what it is
 * looking at.
 */
export function Section({
  id,
  title,
  note,
  children,
}: {
  id: string;
  title: string;
  note?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      id={`section-${id}`}
      data-testid="gallery-section"
      data-section={id}
      className="scroll-mt-20 border-t border-border pt-6 first:border-t-0 first:pt-0"
    >
      <h2 className="text-sm font-semibold tracking-wide text-muted uppercase">{title}</h2>
      {note ? <p className="mt-1 max-w-prose text-sm text-muted">{note}</p> : null}
      <div className="mt-4 flex flex-col gap-4">{children}</div>
    </section>
  );
}

/** A labelled row of specimens, so a variant grid reads as a grid. */
export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="font-mono text-xs text-muted">{label}</p>
      <div className="flex flex-wrap items-end gap-3">{children}</div>
    </div>
  );
}
