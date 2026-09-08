import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { todayKey } from '@/lib/srs/day';
import {
  dueForecast,
  peak,
  reviewsPerDay,
  studyDays,
  studyDaysEndingAt,
  windowEnd,
} from '@/lib/stats/workload';
import { DAY, NOW, dueCard, review } from './fixtures';

const ROLLOVER = 4;

describe('reviews per day', () => {
  it('is the window ending on today, one column per study day', () => {
    const columns = reviewsPerDay([], { now: NOW, days: 30, rollover: ROLLOVER });
    expect(columns).toHaveLength(30);
    expect(columns[29].dayKey).toBe(todayKey(NOW, ROLLOVER));
    expect(new Set(columns.map((column) => column.dayKey)).size).toBe(30);
    // Ordered oldest first, and contiguous.
    for (let index = 1; index < columns.length; index += 1) {
      expect(columns[index].start).toBeGreaterThan(columns[index - 1].start);
    }
  });

  it('counts each review into the study day it happened in', () => {
    const columns = reviewsPerDay(
      [
        review({ reviewedAt: NOW }),
        review({ reviewedAt: NOW }),
        review({ reviewedAt: NOW - 3 * DAY }),
        // Outside the window: dropped, not folded into the oldest column.
        review({ reviewedAt: NOW - 60 * DAY }),
        // In the future: not a column either.
        review({ reviewedAt: NOW + 2 * DAY }),
      ],
      { now: NOW, days: 30, rollover: ROLLOVER },
    );
    const total = columns.reduce((sum, column) => sum + column.count, 0);
    expect(total).toBe(3);
    expect(columns[29].count).toBe(2);
    expect(columns[26].count).toBe(1);
  });

  it('puts a small-hours review in the study day the learner thinks they are in', () => {
    // 02:00 with a 04:00 rollover is still yesterday (PLAN.md §3.3).
    const lateNight = new Date(2026, 5, 15, 2, 30).getTime();
    const columns = reviewsPerDay([review({ reviewedAt: lateNight })], {
      now: NOW,
      days: 30,
      rollover: ROLLOVER,
    });
    expect(columns[29].count).toBe(0);
    expect(columns[28].count).toBe(1);
    expect(columns[28].dayKey).toBe('2026-06-14');
  });
});

describe('the due forecast', () => {
  it('counts each card exactly once', () => {
    const cards = [
      // Spread across the window, including both edges.
      dueCard(NOW),
      dueCard(NOW + 0.5 * DAY),
      dueCard(NOW + DAY),
      dueCard(NOW + 7 * DAY),
      dueCard(NOW + 29 * DAY),
      // Overdue: still due, folded onto today.
      dueCard(NOW - DAY),
      dueCard(NOW - 400 * DAY),
      // Past the window.
      dueCard(NOW + 45 * DAY),
      // New: has a due instant, is not a review debt.
      dueCard(NOW + 2 * DAY, 0),
      dueCard(NOW - DAY, 0),
    ];

    const forecast = dueForecast(cards, { now: NOW, days: 30, rollover: ROLLOVER });
    const drawn = forecast.days.reduce((sum, day) => sum + day.count, 0);

    expect(forecast.days).toHaveLength(30);
    expect(drawn).toBe(forecast.counted);
    expect(forecast.counted).toBe(7);
    expect(forecast.beyond).toBe(1);
    expect(forecast.overdue).toBe(2);
    expect(forecast.scheduled).toBe(8);
    // Eight scheduled cards, eight countings: no card is in two columns, and
    // none has been dropped between the bars and the sentence under them.
    expect(forecast.counted + forecast.beyond).toBe(
      cards.filter((card) => card.fsrs.state !== 0).length,
    );
  });

  /**
   * "Already overdue" means what it says.
   *
   * The panel prints this number verbatim — "…, of which N are already overdue
   * and sit on today" — and it was computed as `due < todayStart`, the 04:00
   * study-day boundary. At midday that hides every card that came due this
   * morning: a card three hours overdue was reported as not overdue at all, and
   * a learner with a real morning backlog was told there was none.
   */
  it('counts a card that came due earlier today as overdue', () => {
    const forecast = dueForecast([dueCard(NOW - 3 * 3_600_000)], {
      now: NOW,
      days: 30,
      rollover: ROLLOVER,
    });
    expect(forecast.days[0].count).toBe(1);
    expect(forecast.counted).toBe(1);
    expect(forecast.beyond).toBe(0);
    expect(forecast.overdue).toBe(1);
  });

  it('counts nothing due later today as overdue, and never more than it counted', () => {
    const cards = [
      dueCard(NOW - 3 * 3_600_000), // this morning: overdue
      dueCard(NOW - 2 * DAY), // an older backlog card: overdue
      dueCard(NOW + 3 * 3_600_000), // this evening: due today, not yet overdue
      dueCard(NOW + 5 * DAY),
    ];
    const forecast = dueForecast(cards, { now: NOW, days: 30, rollover: ROLLOVER });
    expect(forecast.overdue).toBe(2);
    expect(forecast.days[0].count).toBe(3);
    expect(forecast.overdue).toBeLessThanOrEqual(forecast.counted);
  });

  it('never double-counts however the dues fall', () => {
    // A card every six hours for 40 days, plus a backlog: the arithmetic that
    // would count a boundary card twice has 160 chances to show itself.
    const cards = [
      ...Array.from({ length: 160 }, (_, index) => dueCard(NOW + index * 6 * 3_600_000)),
      ...Array.from({ length: 12 }, (_, index) => dueCard(NOW - (index + 1) * DAY)),
    ];
    const forecast = dueForecast(cards, { now: NOW, days: 30, rollover: ROLLOVER });
    const drawn = forecast.days.reduce((sum, day) => sum + day.count, 0);
    expect(drawn + forecast.beyond).toBe(cards.length);
    expect(forecast.overdue).toBe(12);
    expect(forecast.days[0].count).toBeGreaterThanOrEqual(12);
  });

  it('starts today and tiles up to, but not into, the day after the last column', () => {
    const columns = studyDays(NOW, 30, ROLLOVER);
    expect(columns[0].dayKey).toBe(todayKey(NOW, ROLLOVER));
    const end = windowEnd(columns, ROLLOVER);
    expect(end).toBeGreaterThan(columns[29].start);
    // A card due one millisecond before the end is in; one at the end is beyond.
    const inside = dueForecast([dueCard(end - 1)], { now: NOW, days: 30, rollover: ROLLOVER });
    const outside = dueForecast([dueCard(end)], { now: NOW, days: 30, rollover: ROLLOVER });
    expect(inside.counted).toBe(1);
    expect(inside.beyond).toBe(0);
    expect(outside.counted).toBe(0);
    expect(outside.beyond).toBe(1);
  });

  it('has nothing to draw and says so, rather than dividing by zero', () => {
    const forecast = dueForecast([], { now: NOW, days: 30, rollover: ROLLOVER });
    expect(forecast.counted).toBe(0);
    expect(forecast.scheduled).toBe(0);
    expect(forecast.days.every((day) => day.count === 0)).toBe(true);
  });
});

describe('the shared scale', () => {
  it('is the tallest column of either series', () => {
    const past = reviewsPerDay([review({ reviewedAt: NOW }), review({ reviewedAt: NOW })], {
      now: NOW,
      days: 30,
      rollover: ROLLOVER,
    });
    const forecast = dueForecast(
      Array.from({ length: 5 }, () => dueCard(NOW + 3 * DAY)),
      { now: NOW, days: 30, rollover: ROLLOVER },
    );
    expect(peak(past, forecast.days)).toBe(5);
    expect(peak([])).toBe(0);
  });
});

/**
 * A day is a calendar day, and twice a year one of them is 23 or 25 hours long.
 * Walking the window by adding 86,400,000ms produces a repeated or a skipped
 * day key across those boundaries, and the bar it drops is a real day of
 * reviews. The window is walked with `setDate` for exactly this reason, so the
 * claim is tested where it can fail rather than in UTC where it cannot.
 */
describe('across a daylight-saving boundary', () => {
  const original = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = 'America/New_York';
  });
  afterAll(() => {
    process.env.TZ = original;
  });

  it('keeps one column per day, each starting at the rollover hour', () => {
    // 8 Mar 2026 springs forward; 1 Nov 2026 falls back.
    for (const anchor of [new Date(2026, 2, 12, 12).getTime(), new Date(2026, 10, 5, 12).getTime()]) {
      const columns = studyDaysEndingAt(anchor, 30, ROLLOVER);
      expect(columns).toHaveLength(30);
      expect(new Set(columns.map((column) => column.dayKey)).size).toBe(30);
      expect(columns[29].dayKey).toBe(todayKey(anchor, ROLLOVER));
      // Every column opens at 04:00 local. The naive walk drifts an hour at the
      // boundary and every column after it opens at 03:00 or 05:00 instead.
      for (const column of columns) {
        expect(new Date(column.start).getHours()).toBe(ROLLOVER);
      }

      const naive = Array.from({ length: 30 }, (_, index) => columns[0].start + index * DAY);
      expect(naive.some((start) => new Date(start).getHours() !== ROLLOVER)).toBe(true);
    }
  });

  it('drops a whole day of the window when the clocks go back', () => {
    // Fall-back: +24h from 04:00 lands on 03:00, which the 04:00 rollover reads
    // as the previous study day — so the naive walk visits one day twice and
    // never visits another at all.
    const anchor = new Date(2026, 10, 5, 12).getTime();
    const columns = studyDaysEndingAt(anchor, 30, ROLLOVER);
    const naive = Array.from({ length: 30 }, (_, index) =>
      todayKey(columns[0].start + index * DAY, ROLLOVER),
    );
    expect(new Set(naive).size).toBe(29);
  });
});
