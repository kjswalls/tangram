import type { ReactNode } from 'react';

import { AskPanel } from '@/components/lookup/ask-panel';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/cn';
import type { CardContext } from '@/lib/types';

/**
 * The lookup panel shell. **Frozen after Phase 0** — Phase 1 fills the body with
 * dictionary results (as `children`) and Phase 4 fills the `ask` slot; neither
 * edits this file, which is what keeps those two worktrees off each other.
 *
 * Deliberately not a client component: it holds no state, so it renders in
 * either tree and both phases can pass whatever they need as elements.
 *
 * The dictionary body and the ask slot are independent by construction: a slow
 * or failing provider leaves the body untouched (§3.4).
 *
 * **Phase 4's one edit to this file** (sanctioned; see HANDOFF.md, "Phases 4–5"): when no
 * `ask` slot is passed, the ask panel is the default content of the ask region.
 * Every caller of `LookupPanel` — the lookup page today, the reader tomorrow —
 * therefore gets the ask panel without either of them being edited, and a
 * caller that wants something else in the slot still wins. The two regions have
 * different testids on purpose: `lookup-ask-slot` still means "somebody injected
 * a slot", which is what the Phase 0/1 specs assert about.
 *
 * **The review's one further edit** (HANDOFF.md, "Phases 4–5 review fixes"):
 * `askQuery` splits "what the panel is showing" from "what the ask is about".
 * `/lookup` shows the picked headword and keeps asking about the sentence the
 * learner typed; without it, picking a result re-asked with the headword and
 * wiped the answer that was being read.
 */
export interface LookupPanelProps {
  query: string;
  /**
   * What the ask panel asks about, when that is not the same as the headword
   * the panel is showing (the review fix in HANDOFF.md, "Phases 4–5 review
   * fixes"). Picking a dictionary result must not silently re-ask about the
   * headword and throw away the answer to the sentence the learner typed.
   */
  askQuery?: string;
  /** Where the query came from: the sentence, the question, the reader offset. */
  context?: CardContext;
  slots?: { ask?: ReactNode };
  /** The dictionary result body. The placeholder shows when there is none. */
  children?: ReactNode;
  className?: string;
}

export function LookupPanel({
  query,
  askQuery,
  context,
  slots,
  children,
  className,
}: LookupPanelProps) {
  const provenance = context?.sentence ?? context?.question;
  const asked = askQuery ?? query;

  return (
    <section
      data-testid="lookup-panel"
      className={cn('rounded-xl border border-border bg-surface', className)}
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-4 py-3">
        <h2 className="hanzi text-xl font-medium">
          {query || <span className="font-sans text-base text-muted">Nothing looked up yet</span>}
        </h2>
        {context ? <Badge tone="accent">from {context.source}</Badge> : null}
      </header>

      {provenance ? (
        <p className="hanzi border-b border-border px-4 py-2 text-sm text-muted">{provenance}</p>
      ) : null}

      <div data-testid="lookup-body" className="px-4 py-4">
        {children ?? (
          <p className="text-sm text-muted">
            Dictionary results arrive in Phase 1. The panel, its provenance line and the ask slot
            are the contract everything else builds against.
          </p>
        )}
      </div>

      {slots?.ask ? (
        <div data-testid="lookup-ask-slot" className="border-t border-border px-4 py-4">
          {slots.ask}
        </div>
      ) : asked.trim() ? (
        <div data-testid="lookup-ask" className="border-t border-border px-4 py-4">
          <AskPanel query={asked} context={context} />
        </div>
      ) : null}
    </section>
  );
}
