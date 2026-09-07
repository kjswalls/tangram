import { describe, expect, it } from 'vitest';

import { buildQueue, isExplicitAdd } from '@/lib/lists/queue';
import type { CardRow, SettingsRow } from '@/lib/db/schema';
import { DEFAULT_SETTINGS } from '@/lib/db/schema';
import { newCard } from '@/lib/srs/card';
import { todayKey } from '@/lib/srs/day';
import type { ContextSource } from '@/lib/types';

const NOW = new Date(2026, 8, 7, 12).getTime();

function card(id: string, overrides: Partial<CardRow> = {}): CardRow {
  const fsrs = newCard(NOW);
  return {
    id,
    wordId: `w-${id}`,
    entryId: `e-${id}`,
    kind: 'word',
    direction: 'recognition',
    snapshot: {
      simp: id,
      trad: id,
      pinyinMarked: '',
      pinyinNum: '',
      glosses: [],
      classifiers: [],
      dictVersion: 'test',
    },
    fsrs,
    due: fsrs.due,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

function explicit(id: string, source: ContextSource, createdAt = NOW): CardRow {
  return card(id, { context: { source, addedAt: createdAt }, createdAt });
}

const settings: SettingsRow = { ...DEFAULT_SETTINGS, createdAt: NOW, updatedAt: NOW };

describe('buildQueue', () => {
  it('puts due cards first, oldest first', () => {
    const a = card('a', { due: NOW - 1000, fsrs: { ...newCard(NOW), state: 2, due: NOW - 1000 } });
    const b = card('b', { due: NOW - 5000, fsrs: { ...newCard(NOW), state: 2, due: NOW - 5000 } });
    const queue = buildQueue({ now: NOW, settings, due: [a, b], candidates: [] });
    expect(queue.due.map((row) => row.id)).toEqual(['b', 'a']);
    expect(queue.cards[0].id).toBe('b');
  });

  it('caps spine draws at newPerDay minus what today already introduced', () => {
    const key = todayKey(NOW, settings.dayRollover);
    const capped: SettingsRow = { ...settings, newPerDay: 3, introduced: { [key]: 2 } };
    const candidates = ['s1', 's2', 's3'].map((id) => card(id));
    const queue = buildQueue({ now: NOW, settings: capped, due: [], candidates });
    expect(queue.introducedToday).toBe(2);
    expect(queue.newRemaining).toBe(1);
    expect(queue.newCards.map((row) => row.id)).toEqual(['s1']);
  });

  it('always offers an explicitly added card, even with the cap used up', () => {
    const key = todayKey(NOW, settings.dayRollover);
    const spent: SettingsRow = { ...settings, newPerDay: 1, introduced: { [key]: 1 } };
    const queue = buildQueue({
      now: NOW,
      settings: spent,
      due: [],
      candidates: [card('spine'), explicit('looked-up', 'lookup')],
    });
    expect(queue.newRemaining).toBe(0);
    expect(queue.newCards.map((row) => row.id)).toEqual(['looked-up']);
  });

  it('ignores tombstones and cards that are no longer new', () => {
    const queue = buildQueue({
      now: NOW,
      settings,
      due: [card('gone', { deletedAt: NOW })],
      candidates: [
        card('deleted', { deletedAt: NOW }),
        card('started', { fsrs: { ...newCard(NOW), state: 2 } }),
      ],
    });
    expect(queue.due).toEqual([]);
    expect(queue.newCards).toEqual([]);
  });

  it('counts lookup, ask and reader adds as explicit; seeded and list draws are not', () => {
    expect(isExplicitAdd(explicit('a', 'lookup'))).toBe(true);
    expect(isExplicitAdd(explicit('b', 'ask'))).toBe(true);
    expect(isExplicitAdd(explicit('c', 'reader'))).toBe(true);
    expect(isExplicitAdd(explicit('d', 'seed'))).toBe(false);
    expect(isExplicitAdd(explicit('e', 'list'))).toBe(false);
    expect(isExplicitAdd(card('f'))).toBe(false);
  });
});
