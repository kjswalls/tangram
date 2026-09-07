import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS, type CardRow, type SettingsRow } from '@/lib/db/schema';
import { newCard } from '@/lib/srs/card';
import {
  buildReviewQueue,
  emptyStateMessage,
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

  it('always offers an explicitly added New card, even with the day’s cap spent', () => {
    // §3.3: the newPerDay cap governs the spine auto-draw only.
    const added = card({ context: explicit('lookup'), createdAt: NOW - 10 });
    const fromSpine = card({ createdAt: NOW });
    const queue = buildReviewQueue({
      now: NOW,
      settings: settings({ newPerDay: 0 }),
      due: [],
      candidates: [fromSpine, added],
    });
    expect(queue.map((row) => row.id)).toEqual([added.id]);
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

  it('never claims less than a day (enable_short_term: false)', () => {
    expect(formatInterval(0)).toBe('1d');
    expect(formatInterval(0.4)).toBe('1d');
  });
});

describe('gradeOptions', () => {
  it('labels all four buttons with the interval each would schedule', () => {
    const options = gradeOptions(newCard(NOW), NOW);
    expect(options.map((option) => option.rating)).toEqual([1, 2, 3, 4]);
    expect(options.map((option) => option.label)).toEqual(['Again', 'Hard', 'Good', 'Easy']);
    for (const option of options) {
      expect(option.days).toBeGreaterThanOrEqual(1);
      expect(option.interval).toMatch(/^\d+(\.\d)?(d|mo|y)$/);
      expect(option.due - NOW).toBeGreaterThanOrEqual(86_400_000);
    }
  });

  it('orders the intervals Again ≤ Hard ≤ Good ≤ Easy', () => {
    const days = gradeOptions(newCard(NOW), NOW).map((option) => option.days);
    expect([...days].sort((a, b) => a - b)).toEqual(days);
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
