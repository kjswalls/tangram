/**
 * The study queue (PLAN.md §3.3). Pure: it decides what is offered, it does not
 * touch the database. `lib/lists/today.ts` is the IO around it.
 *
 * Two invariants are load-bearing:
 *
 * 1. FSRS never sees lists — the queue builder decides what is offered, the
 *    scheduler only decides when a card comes back.
 * 2. An explicitly added card (lookup, ask, reader) is *always* in today's
 *    queue; `newPerDay` caps the spine auto-draw only.
 *
 * The daily cap counts **introductions**, not offers: `settings.introduced[day]`
 * goes up when a spine card is *created* (`lib/lists/introduce.ts`). A card that
 * was introduced and not yet graded stays in today's queue and is not charged
 * again — instead it lowers how many more may be drawn, so a learner who never
 * grades still never accumulates more than `newPerDay` untouched cards a day.
 * That is what "grade 10 new, reload → no further spine cards today" means.
 */

import { DEFAULT_SETTINGS, type CardRow, type SettingsRow } from '@/lib/db/schema';
import type { DrawCandidate } from '@/lib/lists/draw';
import { todayKey } from '@/lib/srs/day';

export interface QueueInput {
  now: number;
  /**
   * Every live card (`repository.allCards()`); due and new are read off it.
   * `due`/`candidates` remain accepted for callers that already have the two
   * narrower repository reads in hand.
   */
  cards?: readonly CardRow[];
  /** Cards past due, from `repository.listDue(now)`. */
  due?: readonly CardRow[];
  /** Cards in state New, from `repository.newCandidates(limit)`. */
  candidates?: readonly CardRow[];
  /** Entries with no card yet, in auto-draw order (`collectDrawCandidates`). */
  newCandidates?: readonly DrawCandidate[];
  /** The settings row; `newPerDay`/`introducedToday` below override it. */
  settings?: SettingsRow;
  newPerDay?: number;
  introducedToday?: number;
  dayRollover?: number;
}

export interface Queue {
  /** Due cards, oldest first. */
  due: CardRow[];
  /** New cards to introduce today, in the order they should be shown. */
  newCards: CardRow[];
  /** Everything to study now: due first, then new. */
  cards: CardRow[];
  /** Candidates today's cap still allows — cards to *create*, in draw order. */
  draws: DrawCandidate[];
  introducedToday: number;
  newPerDay: number;
  /** How many more new cards today's cap allows, before existing new cards. */
  newRemaining: number;
  /** How many candidates may still be turned into cards: the cap less the
   *  cards already introduced and not yet graded. */
  drawLimit: number;
  /** New cards on offer once `draws` have been created. */
  newAvailable: number;
}

/** True when the card was added by hand rather than drawn from the spine. */
export function isExplicitAdd(card: CardRow): boolean {
  const source = card.context?.source;
  return source === 'lookup' || source === 'ask' || source === 'reader';
}

const alive = (card: CardRow): boolean => card.deletedAt === null;

function unique(cards: readonly (readonly CardRow[])[]): CardRow[] {
  const seen = new Map<string, CardRow>();
  for (const group of cards) for (const card of group) if (!seen.has(card.id)) seen.set(card.id, card);
  return [...seen.values()];
}

export function buildQueue(input: QueueInput): Queue {
  const rollover = input.dayRollover ?? input.settings?.dayRollover ?? DEFAULT_SETTINGS.dayRollover;
  const key = todayKey(input.now, rollover);
  const newPerDay = input.newPerDay ?? input.settings?.newPerDay ?? DEFAULT_SETTINGS.newPerDay;
  const introducedToday =
    input.introducedToday ?? input.settings?.introduced?.[key] ?? 0;
  const newRemaining = Math.max(0, newPerDay - introducedToday);

  const all = unique([input.cards ?? [], input.due ?? [], input.candidates ?? []]).filter(alive);

  // A New card is never due, whatever its `due` column says (§3.3).
  const due = all
    .filter((card) => card.fsrs.state !== 0 && card.due <= input.now)
    .sort((a, b) => a.due - b.due);

  const fresh = all.filter((card) => card.fsrs.state === 0).sort((a, b) => a.createdAt - b.createdAt);
  const explicit = fresh.filter(isExplicitAdd);
  const introduced = fresh.filter((card) => !isExplicitAdd(card));
  const newCards = [...explicit, ...introduced];

  // Cards already introduced but never graded spend today's allowance.
  const drawLimit = Math.max(0, newRemaining - introduced.length);
  const draws = [...(input.newCandidates ?? [])].slice(0, drawLimit);

  return {
    due,
    newCards,
    cards: [...due, ...newCards],
    draws,
    introducedToday,
    newPerDay,
    newRemaining,
    drawLimit,
    newAvailable: newCards.length + draws.length,
  };
}
