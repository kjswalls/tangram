/**
 * The review session (PLAN.md §3.3, phase P2).
 *
 * Pure functions only: what is in today's session, what each of the four
 * buttons would schedule, and what the empty state says. The store does the
 * IO, the components do the rendering, and everything decidable without a
 * database is decided here so it can be unit-tested.
 */

import type { CardRow, FsrsCardState, SettingsRow, StoredRating } from '@/lib/db/schema';
import { buildQueue } from '@/lib/lists/queue';
import { previewGrades, RATING_LABELS } from '@/lib/srs/card';
import type { ParameterSettings } from '@/lib/srs/params';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Shared so the two default arguments below do not allocate on every call. */
const EMPTY_SET: ReadonlySet<string> = new Set<string>();

/**
 * How many New cards to pull as auto-draw candidates. The cap that actually
 * decides how many are *offered* is `settings.newPerDay` inside `buildQueue`;
 * this is only the read size, and explicit adds bypass the cap, so it has to be
 * comfortably larger than a day's worth of either.
 */
export const NEW_CANDIDATE_LIMIT = 200;

export interface ReviewQueueInput {
  now: number;
  settings: SettingsRow;
  /** `repository.listDue(now)` — state ≠ New and due ≤ now, oldest first. */
  due: CardRow[];
  /** `repository.newCandidates(limit)` — every card still in state New. */
  candidates: CardRow[];
}

/**
 * The cards to study now: everything due, then the New cards today's queue
 * allows. Delegates to `lib/lists/queue.ts` rather than re-deriving the rules,
 * so "an explicit add is always in today's queue, `newPerDay` caps the spine
 * draw only" has exactly one implementation.
 *
 * The session store no longer calls this — it goes through `loadToday`, which
 * *introduces* as well as reads, so `/review` and Today cannot offer different
 * rows. This stays as the pure form of the same rule for callers holding the
 * two narrower repository reads.
 */
export function buildReviewQueue(input: ReviewQueueInput): CardRow[] {
  return buildQueue(input).cards;
}

/**
 * **The merged session** (docs/plans/core.md C7; wave-zero.md §9).
 *
 * product-decisions §1's central claim is that learning a new word, recognising
 * it and writing it are **one** session. Until C7 they were not: `buildQueue`
 * returns `[...due, ...newCards]`, so a learner with fifteen reviews and five
 * new words worked through fifteen cards and only then met a new word — and the
 * new words were introduced on a *different screen*, which is the half
 * `wave-zero.md` §9 says C7 owns.
 *
 * This is the interleave. It is composition over `buildQueue` and **nothing
 * about FSRS changes**: the scheduler decides when a card comes back, this
 * decides only the order the session offers what is already in the queue.
 *
 * The rule: spread the new words evenly through the due ones rather than
 * fronting or tailing them. A learner who stops halfway has then met roughly
 * half the day's new words, which is the honest split — fronting them spends
 * the whole day's introductions on a session that might be abandoned, and
 * tailing them means a bad day of reviews costs the new words entirely.
 *
 * **Due first at equal position.** The first card of a session is a review, not
 * a new word: opening Practice to something you have never seen reads as the
 * app ignoring the work you have waiting. (`step` is never below 1, so at
 * `served = 0` no new word can be owed before the first review.)
 */
export interface ServedSoFar {
  /** Reviews this session has already handed out. */
  due: number;
  /** New words this session has already handed out. */
  fresh: number;
}

const NOTHING_SERVED: ServedSoFar = { due: 0, fresh: 0 };

export function interleaveNew(
  due: readonly CardRow[],
  fresh: readonly CardRow[],
  served: ServedSoFar = NOTHING_SERVED,
): CardRow[] {
  if (fresh.length === 0) return [...due];
  if (due.length === 0) return [...fresh];

  /**
   * **`served` is what makes this a schedule rather than a decoration**, and
   * the first version did not have it.
   *
   * The session store rebuilds the queue after *every* grade — it has to, so a
   * card that came back on a short step is picked up — and it reads the next
   * card as `queue[0]`. Without an offset each rebuild re-spreads the *remaining*
   * new words through the *remaining* reviews, so the first new word is always
   * about `remainingDue / remainingNew` places away and the learner never
   * arrives. Simulated over fifteen reviews and five new words, the order
   * actually served was all fifteen reviews and then all five new words:
   * exactly the `[...due, ...newCards]` this function exists to replace.
   *
   * Counting what the session has already handed out fixes it, because the
   * spacing is then computed over the *whole* session rather than over what is
   * left of it. `tests/unit/srs/merged-session.test.ts` runs the simulation.
   */
  const totalDue = served.due + due.length;
  const totalFresh = served.fresh + fresh.length;
  // One new word every `step` items, counted over the session's full length so
  // the last new word lands near the end rather than in the middle.
  const step = (totalDue + totalFresh) / totalFresh;

  const out: CardRow[] = [];
  let placed = served.fresh;
  let position = served.due + served.fresh;
  let nextAt = step * (placed + 1);

  /** Hand out whatever new words this position has now earned. */
  const takeNew = () => {
    while (placed < totalFresh && position >= Math.round(nextAt)) {
      out.push(fresh[placed - served.fresh]);
      placed += 1;
      position += 1;
      nextAt += step;
    }
  };

  // Before the first review as well as after each one: a new word whose turn
  // came while the learner was away from the tab belongs at the front of the
  // rebuilt queue, not one review later.
  takeNew();
  for (const card of due) {
    out.push(card);
    position += 1;
    takeNew();
  }
  // Whatever did not fit — a session with more new words than reviews.
  for (let index = placed - served.fresh; index < fresh.length; index += 1) {
    out.push(fresh[index]);
  }
  return out;
}

/**
 * How many times one card may be served in a single session before it is set
 * aside (see `deferredCardIds`). With `shortTermSteps` on, Again on a card in a
 * learning step schedules it a minute out, so a learner who keeps missing it is
 * handed the same card back for as long as they keep pressing 1 — the session
 * would never end on its own. Six is a number, not a discovery: enough that a
 * word you are actually acquiring gets its short steps, few enough that a word
 * you are not stops eating the session.
 */
export const MAX_SESSION_REPEATS = 6;

/**
 * How far ahead the session will wait for a card. Learning steps are 1m and
 * 10m and relearning is 10m, so a quarter of an hour covers every schedule the
 * short steps can produce; beyond it the session is genuinely over and the
 * empty state says when to come back rather than holding a timer open.
 */
export const SESSION_RETURN_HORIZON_MS = 15 * 60_000;

/**
 * The cards this session has served too many times, by id.
 *
 * `repeats` is the session's own tally — grades written since the route was
 * opened, keyed by card — and it is deliberately *not* persisted: leaving and
 * coming back is the learner deciding to try again, and the app has no business
 * remembering a bad five minutes across sessions.
 */
export function deferredCardIds(
  repeats: Readonly<Record<string, number>>,
  limit: number = MAX_SESSION_REPEATS,
): Set<string> {
  const out = new Set<string>();
  for (const [id, count] of Object.entries(repeats)) if (count >= limit) out.add(id);
  return out;
}

/** The queue minus the cards this session has set aside. */
export function sessionQueue(
  cards: readonly CardRow[],
  deferred: ReadonlySet<string>,
): CardRow[] {
  return deferred.size === 0 ? [...cards] : cards.filter((card) => !deferred.has(card.id));
}

/**
 * When the next card comes back, for the empty state. New cards are excluded:
 * they are due "now" by construction and are held out by the daily cap, not by
 * the clock, so counting them would promise a card that the queue will not
 * offer until tomorrow. So are the cards this session has set aside — the
 * session is not going to offer them however long you wait.
 */
export function nextDueAt(
  cards: readonly CardRow[],
  now: number,
  deferred: ReadonlySet<string> = EMPTY_SET,
): number | null {
  let next: number | null = null;
  for (const card of cards) {
    if (card.deletedAt !== null) continue;
    if (card.fsrs.state === 0) continue;
    if (card.due <= now) continue;
    if (deferred.has(card.id)) continue;
    if (next === null || card.due < next) next = card.due;
  }
  return next;
}


/**
 * How long to wait before re-reading the queue for a card that has not matured
 * yet, or `null` when the session should simply end.
 *
 * Split out of the component so the decision is testable without a timer: the
 * component owns *when* to arm it (only with nothing on screen — a re-read
 * under a card would swap the card out mid-answer), this owns whether it is
 * worth arming at all. Floored at a second so a due instant that has already
 * slipped past cannot spin the load in a tight loop, and nudged half a second
 * beyond the instant so the re-read finds the card due rather than one tick
 * short of it.
 */
export function sessionRefreshDelay(
  next: number | null,
  now: number,
  horizonMs: number = SESSION_RETURN_HORIZON_MS,
): number | null {
  if (next === null) return null;
  const delay = next - now;
  if (delay > horizonMs) return null;
  return Math.max(1_000, delay + 500);
}

/**
 * How many cards come back inside the horizon — the honest count behind
 * "2 cards come back in 4 minutes". Same exclusions as `nextDueAt`.
 */
export function returningWithin(
  cards: readonly CardRow[],
  now: number,
  horizonMs: number = SESSION_RETURN_HORIZON_MS,
  deferred: ReadonlySet<string> = EMPTY_SET,
): number {
  let count = 0;
  for (const card of cards) {
    if (card.deletedAt !== null) continue;
    if (card.fsrs.state === 0) continue;
    if (card.due <= now) continue;
    if (card.due - now > horizonMs) continue;
    if (deferred.has(card.id)) continue;
    count += 1;
  }
  return count;
}

/**
 * How many come back by the minute the empty state names — the count behind
 * "2 words come back in 1 minute". `returningWithin` over the whole horizon is
 * the right total for the progress bar and the wrong count for that sentence:
 * after two "Forgot it" (1 min) and eight "Got it" (10 min) it said "10 words
 * come back in 1 minute" (first-run audit, HANDOFF.md 2026-09-23). The window
 * is rounded exactly as `emptyStateMessage` rounds the minutes it prints.
 */
export function returningByNext(
  cards: readonly CardRow[],
  now: number,
  next: number | null,
  deferred: ReadonlySet<string> = EMPTY_SET,
): number {
  if (next === null) return 0;
  const minutes = Math.max(1, Math.ceil(Math.max(0, next - now) / MINUTE_MS));
  return returningWithin(cards, now, minutes * MINUTE_MS, deferred);
}

/**
 * A scheduling interval of a day or more, as a button label. Days are the
 * smallest unit it knows: anything under one rounds *up* to `1d`, which was
 * true of every schedule v1 could produce (`enable_short_term: false`) and is
 * why sub-day delays now go through `formatDelay` instead.
 */
export function formatInterval(days: number): string {
  const whole = Math.max(1, Math.round(days));
  if (whole < 30) return `${whole}d`;
  if (whole < 365) return `${Math.round(whole / 30)}mo`;
  const years = whole / 365;
  return `${years < 10 ? years.toFixed(1) : String(Math.round(years))}y`;
}

/**
 * A delay shorter than a day, as a button label: `1m`, `10m`, `4h`.
 *
 * It exists because `settings.shortTermSteps` defaults on (Phase 8): Again on a
 * new card schedules one minute, and a button that answered `1d` to that would
 * be describing a schedule the app is not going to follow. A minute is the
 * floor — the learning steps do not go below it — and anything from a day up is
 * handed back to `formatInterval`, so there is still exactly one place each
 * unit is spelled.
 */
export function formatDelay(ms: number): string {
  if (ms >= DAY_MS) return formatInterval(ms / DAY_MS);
  if (ms >= HOUR_MS) return `${Math.round(ms / HOUR_MS)}h`;
  return `${Math.max(1, Math.round(ms / MINUTE_MS))}m`;
}

export interface GradeOption {
  rating: StoredRating;
  /** Forgot it · Barely remembered · Got it · Instant (C8). Ratings 1–4, unchanged. */
  label: string;
  /** `10m`, `1d`, `3d`, `8d` … — what this button would schedule. */
  interval: string;
  /** Whole days the scheduler booked, or 0 for a learning step inside the day. */
  days: number;
  /** The delay itself, in ms. The honest number when `days` is 0. */
  ms: number;
  due: number;
}

/**
 * The four buttons, each carrying the interval `fsrs.repeat()` would give it.
 *
 * `settings` is threaded through because the preview must run under the same
 * parameters the grade will (retention, short-term steps, the learner's own
 * weights): a button that promises an interval a different scheduler would
 * produce is worse than no interval at all.
 */
export function gradeOptions(
  state: FsrsCardState,
  now: number = Date.now(),
  settings?: ParameterSettings | null,
): GradeOption[] {
  return previewGrades(state, now, settings).map((preview) => {
    const ms = Math.max(0, preview.due - now);
    // `scheduled_days` is the scheduler's own answer, and it is 0 for a
    // learning step — which is a real schedule, not a missing one.
    const days = preview.scheduledDays > 0
      ? preview.scheduledDays
      : ms >= DAY_MS
        ? Math.max(1, Math.round(ms / DAY_MS))
        : 0;
    return {
      rating: preview.rating,
      label: RATING_LABELS[preview.rating],
      interval: days >= 1 ? formatInterval(days) : formatDelay(ms),
      days,
      ms,
      due: preview.due,
    };
  });
}

/*
 * `ratingFromKey` and `isRevealKey` used to live here and are gone
 * (docs/plans/web.md W8). The keys they described — Space or Enter to reveal,
 * 1–4 to grade — are rows in `src/keys/registry.ts` under the `review` scope
 * now, with the descriptions the generated help sheet shows. Two places
 * spelling the same four keys is two places that can disagree, and the registry
 * is the one a test can check for collisions.
 */

export interface EmptyState {
  /** `nextDueAt` — when the soonest card the session would offer comes back. */
  next: number | null;
  now: number;
  /**
   * New words today's cap still allows but that could not be created (the
   * dictionary was unreachable — the load introduces them otherwise). Saying
   * "next card in 3 days" while the app is holding new words for the same
   * learner is the contradiction this field exists to prevent.
   */
  waiting?: number;
  /** `returningWithin` — how many come back inside the short-step horizon. */
  returning?: number;
  /**
   * `returningByNext` — how many come back by the minute the sentence names.
   * When given, it is the count the minutes branch prints; `returning` stays
   * the progress bar's total.
   */
  returningByNext?: number;
  /** Cards this session set aside after `MAX_SESSION_REPEATS` (see above). */
  deferred?: number;
}

/**
 * The empty state (§4, P2): when nothing is due, say when something will be.
 *
 * Three granularities, because since Phase 8 all three are reachable. Minutes
 * up to the hour — `shortTermSteps` defaults on, so "come back in nine minutes"
 * is a thing the scheduler now actually says, and rounding it up to "1 hour"
 * (which is what this did until Phase 8) sent the learner away from a session
 * that was not over. Hours up to two days, because "in 36 hours" is more use
 * than "in 2 days" when you are deciding whether to wait. Days beyond that.
 *
 * Cards the session set aside are named in a second sentence rather than
 * hidden: the queue is not empty because there is nothing left to do, and a
 * learner who is told "nothing due" while three cards they kept missing sit in
 * the database has been lied to.
 */
export function emptyStateMessage(state: EmptyState): string {
  const { next, now } = state;
  const waiting = state.waiting ?? 0;
  const returning = state.returning ?? 0;
  const deferred = state.deferred ?? 0;

  const aside =
    deferred > 0
      ? ` ${deferred} ${deferred === 1 ? 'word you kept missing is' : 'words you kept missing are'} set aside until next time.`
      : '';

  if (waiting > 0) {
    return `All done — ${waiting} new ${waiting === 1 ? 'word is' : 'words are'} waiting, once the dictionary is back.${aside}`;
  }
  if (next === null) {
    if (deferred > 0) return `Nothing more to practise right now.${aside}`;
    return 'Nothing to practise yet — look a word up and it joins the next session.';
  }

  const diff = Math.max(0, next - now);
  if (diff < HOUR_MS) {
    const minutes = Math.max(1, Math.ceil(diff / MINUTE_MS));
    // `returning` is the count the caller measured over the same horizon; one
    // card is the floor because `next` being non-null means there is one.
    const count = Math.max(1, state.returningByNext ?? returning);
    return `All done for now — ${count} ${count === 1 ? 'word comes' : 'words come'} back in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.${aside}`;
  }
  const hours = Math.ceil(diff / HOUR_MS);
  if (hours <= 48) {
    return `All done — the next word comes back in ${hours} ${hours === 1 ? 'hour' : 'hours'}.${aside}`;
  }
  const days = Math.max(1, Math.ceil(diff / DAY_MS));
  return `All done — the next word comes back in ${days} ${days === 1 ? 'day' : 'days'}.${aside}`;
}
