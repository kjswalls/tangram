import type { CardRow } from '@/lib/db/schema';
import { isPhraseSnapshot } from '@/lib/db/schema';

export interface PhraseFaceProps {
  card: CardRow;
}

/**
 * The front of a phrase card.
 *
 * A phrase card's snapshot is a list of tokens, each one either a cited
 * dictionary entry or a string the model invented (`lib/db/schema.ts`,
 * `PhraseToken`) — and the review path has never drawn that distinction: it
 * rendered `snapshot.simp`, the joined text, at 6xl with no flag anywhere on
 * the card (HANDOFF.md, Phases 4–5 review fixes, "Not done, and why"). Adding
 * a phrase with an unverified token is refused at the Add now, but a card
 * written before that rule exists in databases already.
 *
 * This is the seam where that gets fixed: per-token markup lives here, behind
 * one component, so `review-card.tsx` stays frozen while it lands. Until then
 * it renders exactly what the card rendered before — the joined simplified
 * text — so nothing on screen changes on the way through.
 */
export function PhraseFace({ card }: PhraseFaceProps) {
  const snapshot = isPhraseSnapshot(card.snapshot) ? card.snapshot : null;
  if (!snapshot) return null;

  return (
    <h2 data-testid="phrase-face" className="hanzi text-6xl font-medium sm:text-7xl">
      {snapshot.simp}
    </h2>
  );
}
