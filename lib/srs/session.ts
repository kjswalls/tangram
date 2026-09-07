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
 * draw only" has exactly one implementation (P3 owns that file and fills in the
 * auto-draw ordering; this call site keeps working when it does).
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
 * A scheduling interval as a button label. With `enable_short_term: false`
 * nothing is ever shorter than a day, so days are the smallest unit shown.
 */
export function formatInterval(days: number): string {
  const whole = Math.max(1, Math.round(days));
  if (whole < 30) return `${whole}d`;
  if (whole < 365) return `${Math.round(whole / 30)}mo`;
  const years = whole / 365;
  return `${years < 10 ? years.toFixed(1) : String(Math.round(years))}y`;
}

export interface GradeOption {
  rating: StoredRating;
  /** Again · Hard · Good · Easy. */
  label: string;
  /** `1d`, `3d`, `8d` … — what this button would schedule. */
  interval: string;
  days: number;
  due: number;
}

/** The four buttons, each carrying the interval `fsrs.repeat()` would give it. */
export function gradeOptions(state: FsrsCardState, now: number = Date.now()): GradeOption[] {
  return previewGrades(state, now).map((preview) => {
    // `scheduled_days` is the scheduler's own answer; the due instant is the
    // fallback for the (theoretical) case where it comes back as 0.
    const days = preview.scheduledDays > 0
      ? preview.scheduledDays
      : Math.max(1, Math.round((preview.due - now) / DAY_MS));
    return {
      rating: preview.rating,
      label: RATING_LABELS[preview.rating],
      interval: formatInterval(days),
      days,
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
 */
export function emptyStateMessage(next: number | null, now: number): string {
  if (next === null) return 'Nothing due — no cards are scheduled yet.';
  const diff = Math.max(0, next - now);
  const hours = Math.max(1, Math.ceil(diff / HOUR_MS));
  if (hours <= 48) return `Nothing due — next card in ${hours} ${hours === 1 ? 'hour' : 'hours'}.`;
  const days = Math.max(1, Math.ceil(diff / DAY_MS));
  return `Nothing due — next card in ${days} ${days === 1 ? 'day' : 'days'}.`;
}
