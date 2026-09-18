/**
 * The study day (PLAN.md §3.3).
 *
 * A day is the browser's local calendar day, rolling over at a local hour
 * (`settings.dayRollover`, default 04:00) — so a card graded at 01:30 belongs to
 * the day the learner thinks they are still in. Only counters use day keys;
 * `due` comparisons always use instants.
 */

export const DEFAULT_DAY_ROLLOVER = 4;

/** `YYYY-MM-DD` for the study day containing `now`. */
export function todayKey(
  now: Date | number = Date.now(),
  rollover: number = DEFAULT_DAY_ROLLOVER,
): string {
  const date = typeof now === 'number' ? new Date(now) : new Date(now.getTime());
  // Shifting the clock back by the rollover hour moves the small hours onto the
  // previous calendar day without any DST arithmetic of our own.
  date.setHours(date.getHours() - rollover);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Local instant the study day containing `now` began. */
export function startOfDay(
  now: Date | number = Date.now(),
  rollover: number = DEFAULT_DAY_ROLLOVER,
): number {
  const date = typeof now === 'number' ? new Date(now) : new Date(now.getTime());
  const shifted = new Date(date);
  shifted.setHours(shifted.getHours() - rollover);
  const start = new Date(shifted.getFullYear(), shifted.getMonth(), shifted.getDate(), rollover, 0, 0, 0);
  return start.getTime();
}
