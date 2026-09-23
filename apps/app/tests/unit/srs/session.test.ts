import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS, type CardRow, type SettingsRow } from '@/lib/db/schema';
import type { DrawCandidate } from '@/lib/lists/draw';
import { buildQueue } from '@/lib/lists/queue';
import { newCard } from '@/lib/srs/card';
import {
  buildReviewQueue,
  deferredCardIds,
  emptyStateMessage,
  formatDelay,
  formatInterval,
  gradeOptions,
  MAX_SESSION_REPEATS,
  nextDueAt,
  returningByNext,
  returningWithin,
  sessionQueue,
  sessionRefreshDelay,
  SESSION_RETURN_HORIZON_MS,
} from '@/lib/srs/session';
import type { CardContext } from '@/lib/types';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 8, 7, 12);

const settings = (patch: Partial<SettingsRow> = {}): SettingsRow => ({
  ...DEFAULT_SETTINGS,
  createdAt: 0,
  updatedAt: 0,
  ...patch,
});

let seq = 0;

function card(patch: Partial<CardRow> & { due?: number } = {}): CardRow {
  const fsrs = { ...newCard(NOW), ...(patch.fsrs ?? {}) };
  return {
    id: `card-${seq++}`,
    wordId: 'w',
    entryId: `entry-${seq}`,
    kind: 'word',
    direction: 'recognition',
    snapshot: {
      simp: '打算',
      trad: '打算',
      pinyinMarked: 'dǎsuàn',
      pinyinNum: 'da3 suan4',
      glosses: ['to plan'],
      classifiers: [],
      dictVersion: 'test',
    },
    fsrs,
    due: patch.due ?? fsrs.due,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...patch,
  } as CardRow;
}

const explicit = (source: CardContext['source']): CardContext => ({ source, addedAt: NOW });

describe('buildReviewQueue', () => {
  it('walks everything due, oldest first', () => {
    const older = card({ fsrs: { ...newCard(NOW), state: 2 }, due: NOW - 3 * DAY });
    const newer = card({ fsrs: { ...newCard(NOW), state: 2 }, due: NOW - DAY });
    const queue = buildReviewQueue({
      now: NOW,
      settings: settings(),
      due: [newer, older],
      candidates: [],
    });
    expect(queue.map((row) => row.id)).toEqual([older.id, newer.id]);
  });

  it('always offers an explicitly added New card first, even with the day’s cap spent', () => {
    // §3.3: the newPerDay cap governs the spine auto-*draw* only. After the P3
    // merge the cap is charged when a spine card is **created**, so a card that
    // already exists is offered whatever the counter says — it lowers how many
    // more may be drawn instead (`buildQueue().drawLimit`). What survives here
    // is the ordering guarantee: an explicit add is never behind a spine card.
    const added = card({ context: explicit('lookup'), createdAt: NOW - 10 });
    const fromSpine = card({ createdAt: NOW });
    const queue = buildReviewQueue({
      now: NOW,
      settings: settings({ newPerDay: 0 }),
      due: [],
      candidates: [fromSpine, added],
    });
    expect(queue.map((row) => row.id)).toEqual([added.id, fromSpine.id]);
  });

  it('spends the cap on the draw, not on the cards already made', () => {
    const fromSpine = card({ createdAt: NOW });
    const queue = buildQueue({
      now: NOW,
      settings: settings({ newPerDay: 1 }),
      candidates: [fromSpine],
      newCandidates: [{ entryId: 'e', from: 'spine', listId: 'hsk-3', band: 3 } satisfies DrawCandidate],
    });
    expect(queue.cards.map((row) => row.id)).toEqual([fromSpine.id]);
    expect(queue.drawLimit).toBe(0);
    expect(queue.draws).toEqual([]);
  });

  it('puts due cards ahead of new ones', () => {
    const due = card({ fsrs: { ...newCard(NOW), state: 2 }, due: NOW - DAY });
    const fresh = card({ context: explicit('reader') });
    const queue = buildReviewQueue({
      now: NOW,
      settings: settings(),
      due: [due],
      candidates: [fresh],
    });
    expect(queue.map((row) => row.id)).toEqual([due.id, fresh.id]);
  });
});

describe('nextDueAt', () => {
  it('finds the nearest future due instant', () => {
    const soon = card({ fsrs: { ...newCard(NOW), state: 2 }, due: NOW + 5 * HOUR });
    const later = card({ fsrs: { ...newCard(NOW), state: 2 }, due: NOW + 9 * DAY });
    expect(nextDueAt([later, soon], NOW)).toBe(NOW + 5 * HOUR);
  });

  it('ignores the past, tombstones, and New cards', () => {
    const past = card({ fsrs: { ...newCard(NOW), state: 2 }, due: NOW - DAY });
    const dead = card({ fsrs: { ...newCard(NOW), state: 2 }, due: NOW + HOUR, deletedAt: NOW });
    // A New card is due "now" by construction and is held back by the daily cap,
    // not the clock: promising it as "the next card" would be a lie.
    const fresh = card({ due: NOW + HOUR, fsrs: { ...newCard(NOW), state: 0 } });
    expect(nextDueAt([past, dead, fresh], NOW)).toBeNull();
  });

  it('is null when there is nothing scheduled at all', () => {
    expect(nextDueAt([], NOW)).toBeNull();
  });
});

describe('formatInterval', () => {
  it('shows days, then months, then years', () => {
    expect(formatInterval(1)).toBe('1d');
    expect(formatInterval(8)).toBe('8d');
    expect(formatInterval(29)).toBe('29d');
    expect(formatInterval(30)).toBe('1mo');
    expect(formatInterval(90)).toBe('3mo');
    expect(formatInterval(365)).toBe('1.0y');
    expect(formatInterval(730)).toBe('2.0y');
  });

  it('rounds anything under a day up to a day — days are its smallest unit', () => {
    expect(formatInterval(0)).toBe('1d');
    expect(formatInterval(0.4)).toBe('1d');
  });
});

/**
 * `shortTermSteps` defaults on since Phase 8, so a button can schedule ten
 * minutes. `formatInterval` still only knows days and up, which is why the
 * sub-day case has a formatter of its own rather than a special case inside it.
 */
describe('formatDelay', () => {
  it('says minutes, then hours, then hands over to formatInterval', () => {
    expect(formatDelay(60_000)).toBe('1m');
    expect(formatDelay(10 * 60_000)).toBe('10m');
    expect(formatDelay(90 * 60_000)).toBe('2h');
    expect(formatDelay(5 * HOUR)).toBe('5h');
    expect(formatDelay(DAY)).toBe('1d');
    expect(formatDelay(40 * DAY)).toBe('1mo');
  });

  it('never claims zero: a scheduled card is always some time away', () => {
    expect(formatDelay(0)).toBe('1m');
    expect(formatDelay(20_000)).toBe('1m');
  });
});

describe('gradeOptions', () => {
  it('labels all four buttons with the interval each would schedule', () => {
    const options = gradeOptions(newCard(NOW), NOW);
    expect(options.map((option) => option.rating)).toEqual([1, 2, 3, 4]);
    // C8's words, ratings 1–4 unchanged. The pairing is the assertion: a
    // relabelling that reordered them would move every learner's grade by one.
    expect(options.map((option) => option.label)).toEqual([
      'Forgot it',
      'Barely remembered',
      'Got it',
      'Instant',
    ]);
    for (const option of options) {
      expect(option.due).toBeGreaterThan(NOW);
      expect(option.ms).toBe(option.due - NOW);
      expect(option.interval).toMatch(/^\d+(\.\d)?(m|h|d|mo|y)$/);
    }
  });

  it('labels a learning step in minutes rather than rounding it up to a day', () => {
    // The default settings run FSRS's own learning steps, so "Forgot it" on a
    // new card is one minute out. A button reading `1d` there would be describing
    // a schedule the app is not going to follow.
    const again = gradeOptions(newCard(NOW), NOW)[0];
    expect(again.ms).toBeLessThan(DAY);
    expect(again.days).toBe(0);
    expect(again.interval).toMatch(/^\d+m$/);
  });

  it('runs the preview under the settings the grade will use', () => {
    const off = gradeOptions(newCard(NOW), NOW, { shortTermSteps: false });
    for (const option of off) {
      expect(option.days).toBeGreaterThanOrEqual(1);
      expect(option.ms).toBeGreaterThanOrEqual(DAY);
      expect(option.interval).toMatch(/^\d+(\.\d)?(d|mo|y)$/);
    }
  });

  it('orders the intervals Again ≤ Hard ≤ Good ≤ Easy', () => {
    const delays = gradeOptions(newCard(NOW), NOW).map((option) => option.ms);
    expect([...delays].sort((a, b) => a - b)).toEqual(delays);
  });
});

/*
 * The keyboard cases that were here moved with their subject: `ratingFromKey`
 * and `isRevealKey` are gone, and the four grades and the reveal key are rows
 * in `src/keys/registry.ts` (docs/plans/web.md W8). What replaces these two
 * cases is `tests/unit/keys/registry.test.ts`, which checks the whole table for
 * collisions rather than one function for a mapping.
 */

describe('emptyStateMessage', () => {
  it('counts minutes inside the hour — the short steps made that reachable', () => {
    // Until Phase 8 this floored at one hour, because with
    // `enable_short_term: false` nothing could ever be nine minutes away. Now
    // Again on a new card is one minute, and "next card in 1 hour" would send
    // the learner away from a session that is not over.
    expect(emptyStateMessage({ next: NOW + 9 * 60_000, now: NOW })).toBe(
      'All done for now — 1 word comes back in 9 minutes.',
    );
    expect(emptyStateMessage({ next: NOW + 30_000, now: NOW })).toBe(
      'All done for now — 1 word comes back in 1 minute.',
    );
    expect(emptyStateMessage({ next: NOW + 4 * 60_000, now: NOW, returning: 3 })).toBe(
      'All done for now — 3 words come back in 4 minutes.',
    );
  });

  it('counts hours up to two days out', () => {
    expect(emptyStateMessage({ next: NOW + 5 * HOUR, now: NOW })).toBe(
      'All done — the next word comes back in 5 hours.',
    );
    expect(emptyStateMessage({ next: NOW + 90 * 60_000, now: NOW })).toBe(
      'All done — the next word comes back in 2 hours.',
    );
    expect(emptyStateMessage({ next: NOW + 47 * HOUR, now: NOW })).toBe(
      'All done — the next word comes back in 47 hours.',
    );
  });

  it('counts days beyond that', () => {
    expect(emptyStateMessage({ next: NOW + 3 * DAY, now: NOW })).toBe(
      'All done — the next word comes back in 3 days.',
    );
    expect(emptyStateMessage({ next: NOW + 60 * DAY, now: NOW })).toBe(
      'All done — the next word comes back in 60 days.',
    );
  });

  it('says so when nothing is scheduled', () => {
    expect(emptyStateMessage({ next: null, now: NOW })).toBe(
      'Nothing to practise yet — look a word up and it joins the next session.',
    );
  });

  it('names the cards the session set aside rather than hiding them', () => {
    expect(emptyStateMessage({ next: null, now: NOW, deferred: 1 })).toBe(
      'Nothing more to practise right now. 1 word you kept missing is set aside until next time.',
    );
    expect(emptyStateMessage({ next: NOW + 2 * DAY, now: NOW, deferred: 3 })).toBe(
      'All done — the next word comes back in 48 hours. 3 words you kept missing are set aside until next time.',
    );
  });

  it('still puts the dictionary outage first', () => {
    expect(emptyStateMessage({ next: NOW + DAY, now: NOW, waiting: 2 })).toBe(
      'All done — 2 new words are waiting, once the dictionary is back.',
    );
  });
});

describe('the intra-session repeat cap', () => {
  it('sets a card aside once it has been served MAX_SESSION_REPEATS times', () => {
    const repeats = { a: MAX_SESSION_REPEATS, b: MAX_SESSION_REPEATS - 1, c: 0 };
    expect([...deferredCardIds(repeats)]).toEqual(['a']);
    expect(deferredCardIds(repeats, 2)).toEqual(new Set(['a', 'b']));
  });

  it('is what makes the session terminate', () => {
    // Again on a card in a learning step schedules it a minute out, so without
    // a cap a learner who keeps pressing 1 is served the same card forever.
    const failing = card({ fsrs: { ...newCard(NOW), state: 1 }, due: NOW - 1 });
    const other = card({ fsrs: { ...newCard(NOW), state: 2 }, due: NOW - DAY });
    const queue = [failing, other];

    let repeats: Record<string, number> = {};
    for (let i = 0; i < MAX_SESSION_REPEATS; i += 1) {
      expect(sessionQueue(queue, deferredCardIds(repeats))).toContain(failing);
      repeats = { ...repeats, [failing.id]: (repeats[failing.id] ?? 0) + 1 };
    }
    const left = sessionQueue(queue, deferredCardIds(repeats));
    expect(left).not.toContain(failing);
    expect(left).toEqual([other]);
  });

  it('keeps a set-aside card out of every number the empty state quotes', () => {
    const aside = card({ fsrs: { ...newCard(NOW), state: 1 }, due: NOW + 60_000 });
    const later = card({ fsrs: { ...newCard(NOW), state: 2 }, due: NOW + 5 * DAY });
    const deferred = deferredCardIds({ [aside.id]: MAX_SESSION_REPEATS });

    expect(nextDueAt([aside, later], NOW)).toBe(aside.due);
    expect(nextDueAt([aside, later], NOW, deferred)).toBe(later.due);
    expect(returningWithin([aside, later], NOW)).toBe(1);
    expect(returningWithin([aside, later], NOW, SESSION_RETURN_HORIZON_MS, deferred)).toBe(0);
  });
});

describe('returningWithin', () => {
  it('counts only future, non-New cards inside the horizon', () => {
    const soon = card({ fsrs: { ...newCard(NOW), state: 1 }, due: NOW + 60_000 });
    const alsoSoon = card({ fsrs: { ...newCard(NOW), state: 3 }, due: NOW + 9 * 60_000 });
    const beyond = card({ fsrs: { ...newCard(NOW), state: 2 }, due: NOW + HOUR });
    const past = card({ fsrs: { ...newCard(NOW), state: 2 }, due: NOW - 1 });
    const fresh = card({ fsrs: { ...newCard(NOW), state: 0 }, due: NOW + 60_000 });
    const dead = card({ fsrs: { ...newCard(NOW), state: 2 }, due: NOW + 60_000, deletedAt: NOW });
    expect(returningWithin([soon, alsoSoon, beyond, past, fresh, dead], NOW)).toBe(2);
  });
});

describe('returningByNext — the count the sentence names', () => {
  // First-run audit: two "Forgot it" (1 min) and eight "Got it" (10 min) read
  // "All done for now — 10 words come back in 1 minute".
  const learning = (due: number) => card({ fsrs: { ...newCard(NOW), state: 1 }, due });
  const cards = [
    ...Array.from({ length: 2 }, () => learning(NOW + 60_000)),
    ...Array.from({ length: 8 }, () => learning(NOW + 10 * 60_000)),
  ];

  it('counts only the cards due by the minute the message prints', () => {
    const next = nextDueAt(cards, NOW);
    expect(returningWithin(cards, NOW)).toBe(10);
    expect(returningByNext(cards, NOW, next)).toBe(2);
    expect(
      emptyStateMessage({
        next,
        now: NOW,
        returning: returningWithin(cards, NOW),
        returningByNext: returningByNext(cards, NOW, next),
      }),
    ).toBe('All done for now — 2 words come back in 1 minute.');
  });

  it('rounds its window the way the message rounds its minutes', () => {
    // Next at 90 s prints "2 minutes", so a card at 2 min is in the count and
    // one at 2 min + 1 s is not.
    const set = [learning(NOW + 90_000), learning(NOW + 120_000), learning(NOW + 121_000)];
    expect(returningByNext(set, NOW, NOW + 90_000)).toBe(2);
    expect(returningByNext([], NOW, null)).toBe(0);
  });
});

describe('sessionRefreshDelay', () => {
  it('waits for a card inside the short-step horizon', () => {
    expect(sessionRefreshDelay(NOW + 9 * 60_000, NOW)).toBe(9 * 60_000 + 500);
    expect(sessionRefreshDelay(NOW + 60_000, NOW)).toBe(60_500);
  });

  it('does not wait for a card that is hours or days away — the session is over', () => {
    expect(sessionRefreshDelay(NOW + HOUR, NOW)).toBeNull();
    expect(sessionRefreshDelay(NOW + 3 * DAY, NOW)).toBeNull();
    expect(sessionRefreshDelay(null, NOW)).toBeNull();
  });

  it('floors at a second so a due instant already past cannot spin the load', () => {
    expect(sessionRefreshDelay(NOW - 10 * 60_000, NOW)).toBe(1_000);
    expect(sessionRefreshDelay(NOW, NOW)).toBe(1_000);
  });
});
