/**
 * The study queue (PLAN.md §3.3).
 *
 * **Phase 0 stub.** The signature and the two invariants below are final; the
 * auto-draw *ordering* (explicit adds, then active user lists in list order,
 * then spine bands from `settings.spineStartBand` upward) lands in Phase 3.
 * The two invariants that are already load-bearing:
 *
 * 1. FSRS never sees lists — the queue builder decides what is offered, the
 *    scheduler only decides when a card comes back.
 * 2. An explicitly added card (lookup, ask, reader) is *always* in today's
 *    queue; `newPerDay` caps the spine auto-draw only.
 */

import type { CardRow, SettingsRow } from '@/lib/db/schema';
import { todayKey } from '@/lib/srs/day';

export interface QueueInput {
  now: number;
  settings: SettingsRow;
  /** Cards past due, from `repository.listDue(now)`. */
  due: CardRow[];
  /** Cards in state New, from `repository.newCandidates(limit)`. */
  candidates: CardRow[];
}

export interface Queue {
  /** Due cards, oldest first. */
  due: CardRow[];
  /** New cards to introduce today, in the order they should be shown. */
  newCards: CardRow[];
  /** Everything to study now: due first, then new. */
  cards: CardRow[];
  introducedToday: number;
  /** How many more new cards today's cap allows. */
  newRemaining: number;
}

/** True when the card was added by hand rather than drawn from the spine. */
export function isExplicitAdd(card: CardRow): boolean {
  const source = card.context?.source;
  return source === 'lookup' || source === 'ask' || source === 'reader';
}

export function buildQueue({ now, settings, due, candidates }: QueueInput): Queue {
  const key = todayKey(now, settings.dayRollover);
  const introducedToday = settings.introduced[key] ?? 0;
  const newRemaining = Math.max(0, settings.newPerDay - introducedToday);

  const sortedDue = [...due].filter((card) => card.deletedAt === null).sort((a, b) => a.due - b.due);

  const fresh = [...candidates]
    .filter((card) => card.deletedAt === null && card.fsrs.state === 0)
    .sort((a, b) => a.createdAt - b.createdAt);

  // Explicit adds bypass the cap; spine draws take what is left of it.
  const explicit = fresh.filter(isExplicitAdd);
  const spine = fresh.filter((card) => !isExplicitAdd(card)).slice(0, newRemaining);
  const newCards = [...explicit, ...spine];

  return {
    due: sortedDue,
    newCards,
    cards: [...sortedDue, ...newCards],
    introducedToday,
    newRemaining,
  };
}
