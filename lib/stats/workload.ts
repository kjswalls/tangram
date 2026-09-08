/**
 * Workload (Phase 8): what you have been doing, and what is coming.
 *
 * Two series on one time axis, meeting at today — reviews already done for the
 * last 30 study days, cards scheduled to come due for the next 30. They are the
 * same unit (reviews in a day) which is why they share an axis; the point of
 * putting them together is that a forecast means nothing without the recent
 * load beside it. "220 due on Thursday" is only alarming if you normally do 40.
 *
 * Both are **counts**, so neither has a minimum: a count is exact at any size
 * (`lib/stats/thresholds.ts`). What they need instead is to be countable — one
 * card, one bar, once — which is what `dueForecast` guarantees and what its
 * test pins.
 */

import type { CardRow } from '@/lib/db/schema';
import type { ReviewRow } from '@/lib/db/schema';
import { startOfDay, todayKey } from '@/lib/srs/day';

/** One column: the study day it covers and how many things land in it. */
export interface DayCount {
  /** `YYYY-MM-DD`, the study day's key (`lib/srs/day.ts`). */
  dayKey: string;
  /** Local instant the study day begins. */
  start: number;
  count: number;
}

/**
 * `count` consecutive study days starting at the one containing `from`.
 *
 * Walked with `setDate`, not by adding 86,400,000ms: a day is a calendar day,
 * and across a DST boundary one of them is 23 or 25 hours long. Fixed-millisecond
 * arithmetic silently produces a duplicate or a missing day key twice a year,
 * and the bar it drops is a real day of reviews.
 */
export function studyDays(from: number, count: number, rollover: number): DayCount[] {
  const cursor = new Date(startOfDay(from, rollover));
  const days: DayCount[] = [];
  for (let index = 0; index < count; index += 1) {
    const start = cursor.getTime();
    days.push({ dayKey: todayKey(start, rollover), start, count: 0 });
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

/** The window ending on the study day containing `now`, `count` days long. */
export function studyDaysEndingAt(now: number, count: number, rollover: number): DayCount[] {
  const cursor = new Date(startOfDay(now, rollover));
  cursor.setDate(cursor.getDate() - (count - 1));
  return studyDays(cursor.getTime(), count, rollover);
}

export interface WindowOptions {
  now: number;
  days: number;
  rollover: number;
}

/**
 * Reviews per study day over the window ending today. Reviews outside it are
 * ignored — the caller passes whatever rows it has, and the window decides.
 */
export function reviewsPerDay(
  reviews: readonly ReviewRow[],
  { now, days, rollover }: WindowOptions,
): DayCount[] {
  const columns = studyDaysEndingAt(now, days, rollover);
  const index = new Map(columns.map((column, at) => [column.dayKey, at]));
  for (const review of reviews) {
    const at = index.get(todayKey(review.reviewedAt, rollover));
    if (at !== undefined) columns[at].count += 1;
  }
  return columns;
}

/** The instant the window closes: the start of the day after the last column. */
export function windowEnd(columns: readonly DayCount[], rollover: number): number {
  const last = columns[columns.length - 1];
  if (!last) return 0;
  const cursor = new Date(last.start);
  cursor.setDate(cursor.getDate() + 1);
  return startOfDay(cursor.getTime(), rollover);
}

export interface Forecast {
  days: DayCount[];
  /** Cards whose due instant has already passed: folded into today's column. */
  overdue: number;
  /** Cards drawn in the window — the bars sum to this. */
  counted: number;
  /** Scheduled cards due after the window. Stated, never drawn. */
  beyond: number;
  /** Cards with a schedule at all: `counted + beyond`. */
  scheduled: number;
}

/**
 * Cards coming due, per study day, starting today.
 *
 * Three decisions, each of which would otherwise be a lie on the chart:
 *
 * - **New cards are excluded.** A card in state New carries a `due` of the
 *   moment it was created, so counting them would put every word you have ever
 *   added to a list on today's bar and call it a review debt. What introduces a
 *   new card is the daily cap on Today, not its due date.
 * - **Overdue cards land on today.** They are due; the schedule says so. Dropping
 *   them would forecast a quiet week to someone with 300 cards waiting, which is
 *   the exact failure this chart exists to prevent. `overdue` is reported so the
 *   column can say how much of it is backlog.
 * - **Each card is counted once.** A card has one due instant, so it falls in one
 *   column or past the end — never both, never neither.
 */
export function dueForecast(
  cards: readonly CardRow[],
  { now, days, rollover }: WindowOptions,
): Forecast {
  const columns = studyDays(now, days, rollover);
  const index = new Map(columns.map((column, at) => [column.dayKey, at]));
  const end = windowEnd(columns, rollover);
  const todayStart = columns[0]?.start ?? startOfDay(now, rollover);

  let overdue = 0;
  let counted = 0;
  let beyond = 0;

  for (const card of cards) {
    if (card.fsrs.state === 0) continue;
    const due = card.due;
    if (!Number.isFinite(due)) continue;
    if (due < todayStart) {
      columns[0].count += 1;
      overdue += 1;
      counted += 1;
      continue;
    }
    if (due >= end) {
      beyond += 1;
      continue;
    }
    const at = index.get(todayKey(due, rollover));
    if (at === undefined) {
      // Unreachable while the columns are contiguous, and cheaper to prove than
      // to assume: a due instant inside the window has a column by construction.
      beyond += 1;
      continue;
    }
    columns[at].count += 1;
    counted += 1;
  }

  return { days: columns, overdue, counted, beyond, scheduled: counted + beyond };
}

/** The tallest column across both series, so they share one y-scale. */
export function peak(...series: readonly DayCount[][]): number {
  let top = 0;
  for (const days of series) {
    for (const day of days) if (day.count > top) top = day.count;
  }
  return top;
}
