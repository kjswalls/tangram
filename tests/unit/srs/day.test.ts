import { describe, expect, it } from 'vitest';

import { DEFAULT_DAY_ROLLOVER, startOfDay, todayKey } from '@/lib/srs/day';

/** Local-time constructor, because the study day is the browser's local day. */
const at = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m - 1, d, h, min);

describe('todayKey', () => {
  it('rolls over at 04:00 local, not midnight', () => {
    expect(todayKey(at(2026, 9, 7, 3, 59))).toBe('2026-09-06');
    expect(todayKey(at(2026, 9, 7, 4, 0))).toBe('2026-09-07');
  });

  it('keeps the rest of the day on the same key', () => {
    expect(todayKey(at(2026, 9, 7, 12, 0))).toBe('2026-09-07');
    expect(todayKey(at(2026, 9, 7, 23, 59))).toBe('2026-09-07');
    expect(todayKey(at(2026, 9, 8, 0, 30))).toBe('2026-09-07');
  });

  it('honours a different rollover hour', () => {
    expect(todayKey(at(2026, 9, 7, 3, 59), 0)).toBe('2026-09-07');
    expect(todayKey(at(2026, 9, 7, 5, 0), 6)).toBe('2026-09-06');
    expect(DEFAULT_DAY_ROLLOVER).toBe(4);
  });

  it('accepts epoch ms as well as a Date', () => {
    const now = at(2026, 9, 7, 12, 0);
    expect(todayKey(now.getTime())).toBe(todayKey(now));
  });

  it('does not mutate the date it is given', () => {
    const now = at(2026, 9, 7, 3, 0);
    const before = now.getTime();
    todayKey(now);
    expect(now.getTime()).toBe(before);
  });

  it('startOfDay is the rollover instant of the same key', () => {
    const start = startOfDay(at(2026, 9, 7, 3, 59));
    expect(new Date(start).getHours()).toBe(4);
    expect(todayKey(start)).toBe('2026-09-06');
    expect(start).toBe(at(2026, 9, 6, 4, 0).getTime());
  });
});
