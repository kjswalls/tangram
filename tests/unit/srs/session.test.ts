import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS, type CardRow, type SettingsRow } from '@/lib/db/schema';
import type { DrawCandidate } from '@/lib/lists/draw';
import { buildQueue } from '@/lib/lists/queue';
import { newCard } from '@/lib/srs/card';
import {
  buildReviewQueue,
  emptyStateMessage,
  formatDelay,
  formatInterval,
  gradeOptions,
  isRevealKey,
  nextDueAt,
  ratingFromKey,
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
    expect(options.map((option) => option.label)).toEqual(['Again', 'Hard', 'Good', 'Easy']);
    for (const option of options) {
      expect(option.due).toBeGreaterThan(NOW);
      expect(option.ms).toBe(option.due - NOW);
      expect(option.interval).toMatch(/^\d+(\.\d)?(m|h|d|mo|y)$/);
    }
  });

  it('labels a learning step in minutes rather than rounding it up to a day', () => {
    // The default settings run FSRS's own learning steps, so Again on a new
    // card is one minute out. A button reading `1d` there would be describing
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

describe('the keyboard', () => {
  it('maps 1–4 to the four ratings and ignores everything else', () => {
    expect(ratingFromKey('1')).toBe(1);
    expect(ratingFromKey('2')).toBe(2);
    expect(ratingFromKey('3')).toBe(3);
    expect(ratingFromKey('4')).toBe(4);
    for (const key of ['0', '5', '9', 'a', 'g', 'Escape', 'ArrowRight', '', ' ']) {
      expect(ratingFromKey(key)).toBeNull();
    }
  });

  it('flips on space or enter only', () => {
    expect(isRevealKey(' ')).toBe(true);
    expect(isRevealKey('Enter')).toBe(true);
    expect(isRevealKey('f')).toBe(false);
    expect(isRevealKey('3')).toBe(false);
  });
});

describe('emptyStateMessage', () => {
  it('counts hours up to two days out', () => {
    expect(emptyStateMessage(NOW + 5 * HOUR, NOW)).toBe('Nothing due — next card in 5 hours.');
    expect(emptyStateMessage(NOW + 30 * 60_000, NOW)).toBe('Nothing due — next card in 1 hour.');
    expect(emptyStateMessage(NOW + 47 * HOUR, NOW)).toBe('Nothing due — next card in 47 hours.');
  });

  it('counts days beyond that', () => {
    expect(emptyStateMessage(NOW + 3 * DAY, NOW)).toBe('Nothing due — next card in 3 days.');
    expect(emptyStateMessage(NOW + 60 * DAY, NOW)).toBe('Nothing due — next card in 60 days.');
  });

  it('says so when nothing is scheduled', () => {
    expect(emptyStateMessage(null, NOW)).toBe('Nothing due — no cards are scheduled yet.');
  });
});
