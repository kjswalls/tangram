/**
 * The study queue (PLAN.md §3.3). Pure: it decides what is offered, it does not
 * touch the database. `lib/lists/today.ts` is the IO around it.
 *
 * Two invariants are load-bearing:
 *
 * 1. FSRS never sees lists — the queue builder decides what is offered, the
 *    scheduler only decides when a card comes back.
 * 2. An explicitly added card (lookup, ask, reader, and Phase 8's reverse) is
 *    *always* in today's queue; `newPerDay` caps the spine auto-draw only.
 *
 * The daily cap counts **introductions**, not offers: `settings.introduced[day]`
 * goes up when a non-explicit card is *created* — the spine draw, a list's "Add
 * to queue" and the demo seed all go through `lib/lists/introduce.ts`. A card
 * that was introduced today therefore costs its slot once and keeps it whether
 * or not it has been graded, which is what "grade 10 new, reload → no further
 * spine cards today" means. Charging at creation is not optional for a new
 * caller: `chargedToday` below also counts non-explicit cards created today, so
 * a path that forgets still cannot hand the allowance back by grading.
 *
 * Cards introduced on an *earlier* day and never graded are subtracted on top,
 * so a learner who never grades never accumulates more than `newPerDay`
 * untouched cards a day.
 */

import { DEFAULT_SETTINGS, type CardRow, type SettingsRow } from '@/lib/db/schema';
import type { DrawCandidate } from '@/lib/lists/draw';
import { startOfDay, todayKey } from '@/lib/srs/day';
import { isProduction } from '@/lib/srs/direction';

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
  /**
   * Whether meaning → hanzi cards are offered at all. Defaults to
   * `settings.productionDirection`, and to *true* when there is no settings row
   * to ask — a caller that has not stated an opinion is not stating "no".
   */
  includeProduction?: boolean;
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
  /**
   * Non-explicit cards this study day has already paid for: the persisted
   * counter, or the cards created today if some path failed to charge it.
   */
  chargedToday: number;
  /** Non-explicit cards introduced on an earlier day and still ungraded. */
  backlog: number;
  /** How many candidates may still be turned into cards: the cap less what
   *  today has spent and the untouched backlog from earlier days. */
  drawLimit: number;
  /** New cards on offer once `draws` have been created. */
  newAvailable: number;
}

/**
 * True when the card was added by hand rather than drawn from the spine.
 *
 * `reverse` is here for the same reason the other three are: it is a card the
 * learner asked for, one press at a time, on a word already on screen. The cap
 * exists to stop the *spine* introducing more than was asked for, not to
 * overrule what was asked for by hand. The bulk per-list production toggle is
 * deliberately **not** in this list — it writes `list`, and it charges.
 */
export function isExplicitAdd(card: CardRow): boolean {
  const source = card.context?.source;
  return source === 'lookup' || source === 'ask' || source === 'reader' || source === 'reverse';
}

const alive = (card: CardRow): boolean => card.deletedAt === null;

/** 0 for a card mid-step (FSRS Learning or Relearning), 1 for everything else. */
function stepRank(card: CardRow): number {
  return card.fsrs.state === 1 || card.fsrs.state === 3 ? 0 : 1;
}

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

  // "Also practise the other direction", off.
  //
  // The setting used to *reveal* the two ways of making a production card and
  // do nothing else, so turning it off changed nothing a learner could see: the
  // twins they had already made kept being served, Today kept counting them,
  // and with no way to delete a card there was no way out of the experiment.
  // Its label promises a study switch, so it is one. The rows are untouched —
  // this hides them from the queue and the counts that come off it, and turning
  // the setting back on brings each card back with the schedule it earned.
  const includeProduction =
    input.includeProduction ?? input.settings?.productionDirection ?? true;

  const all = unique([input.cards ?? [], input.due ?? [], input.candidates ?? []])
    .filter(alive)
    .filter((card) => includeProduction || !isProduction(card));

  // A New card is never due, whatever its `due` column says (§3.3).
  //
  // Order: cards mid-step first, then everything else, each by due instant.
  // Since Phase 8 `shortTermSteps` defaults on, so FSRS's Learning (1) and
  // Relearning (3) states actually occur and a card can mature *during* a
  // session. A card in a learning step is halfway through being acquired and
  // its step is a measured few minutes; a Review card three days overdue has
  // already waited three days and one more minute costs it nothing. Sorting
  // purely by `due` would put the overdue pile first and let every short step
  // rot behind it.
  const due = all
    .filter((card) => card.fsrs.state !== 0 && card.due <= input.now)
    .sort((a, b) => stepRank(a) - stepRank(b) || a.due - b.due);

  const fresh = all.filter((card) => card.fsrs.state === 0).sort((a, b) => a.createdAt - b.createdAt);
  const explicit = fresh.filter(isExplicitAdd);
  const introduced = fresh.filter((card) => !isExplicitAdd(card));
  const newCards = [...explicit, ...introduced];

  // A card created today has already been charged to the counter (see the
  // header). Counting them again here would subtract them twice; not counting
  // them at all is how a seeded or hand-queued card used to hand its slot back
  // the moment it was graded, so take whichever number is larger.
  const dayStart = startOfDay(input.now, rollover);
  const createdToday = all.filter(
    (card) => !isExplicitAdd(card) && card.createdAt >= dayStart,
  ).length;
  const chargedToday = Math.max(introducedToday, createdToday);
  const backlog = introduced.filter((card) => card.createdAt < dayStart).length;
  const drawLimit = Math.max(0, newPerDay - chargedToday - backlog);
  const draws = [...(input.newCandidates ?? [])].slice(0, drawLimit);

  return {
    due,
    newCards,
    cards: [...due, ...newCards],
    draws,
    introducedToday,
    newPerDay,
    newRemaining,
    chargedToday,
    backlog,
    drawLimit,
    newAvailable: newCards.length + draws.length,
  };
}
