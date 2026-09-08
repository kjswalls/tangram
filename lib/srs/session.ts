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
 * When the next card comes back, for the empty state. New cards are excluded:
 * they are due "now" by construction and are held out by the daily cap, not by
 * the clock, so counting them would promise a card that the queue will not
 * offer until tomorrow.
 */
export function nextDueAt(cards: readonly CardRow[], now: number): number | null {
  let next: number | null = null;
  for (const card of cards) {
    if (card.deletedAt !== null) continue;
    if (card.fsrs.state === 0) continue;
    if (card.due <= now) continue;
    if (next === null || card.due < next) next = card.due;
  }
  return next;
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
  /** Again · Hard · Good · Easy. */
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

/** Keyboard 1–4 → `Rating` 1–4 (§3.3). Every other key is ignored. */
export function ratingFromKey(key: string): StoredRating | null {
  switch (key) {
    case '1':
      return 1;
    case '2':
      return 2;
    case '3':
      return 3;
    case '4':
      return 4;
    default:
      return null;
  }
}

/** Space or Enter flips the card; tapping it does the same thing. */
export function isRevealKey(key: string): boolean {
  return key === ' ' || key === 'Spacebar' || key === 'Enter';
}

/**
 * The empty state (§4, P2): when nothing is due, say when something will be.
 * Hours up to two days out, days beyond that — "next card in 36 hours" is more
 * use than "in 2 days" when you are deciding whether to wait.
 *
 * `waiting` is new words today's cap still allows but that could not be created
 * (the dictionary was unreachable — the load introduces them otherwise). Saying
 * "next card in 3 days" while the app is holding new words for the same learner
 * is the contradiction this argument exists to prevent.
 */
export function emptyStateMessage(next: number | null, now: number, waiting = 0): string {
  if (waiting > 0) {
    return `Nothing due — ${waiting} new ${waiting === 1 ? 'word is' : 'words are'} waiting, once the dictionary is back.`;
  }
  if (next === null) return 'Nothing due — no cards are scheduled yet.';
  const diff = Math.max(0, next - now);
  const hours = Math.max(1, Math.ceil(diff / HOUR_MS));
  if (hours <= 48) return `Nothing due — next card in ${hours} ${hours === 1 ? 'hour' : 'hours'}.`;
  const days = Math.max(1, Math.ceil(diff / DAY_MS));
  return `Nothing due — next card in ${days} ${days === 1 ? 'day' : 'days'}.`;
}
