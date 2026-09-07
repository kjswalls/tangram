/**
 * The queue's rules (PLAN.md §3.3). Pure input → pure output; the database side
 * of the same rules is `today.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import { buildQueue, isExplicitAdd } from '@/lib/lists/queue';
import type { DrawCandidate } from '@/lib/lists/draw';
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

function reviewed(id: string, due: number): CardRow {
  return card(id, { due, fsrs: { ...newCard(NOW), state: 2, due } });
}

function explicit(id: string, source: ContextSource, createdAt = NOW): CardRow {
  return card(id, { context: { source, addedAt: createdAt }, createdAt });
}

function draw(entryId: string): DrawCandidate {
  return { entryId, from: 'spine', listId: 'hsk-3', band: 3 };
}

const settings: SettingsRow = { ...DEFAULT_SETTINGS, createdAt: NOW, updatedAt: NOW };

describe('buildQueue', () => {
  it('puts due cards first, oldest first', () => {
    const queue = buildQueue({
      now: NOW,
      settings,
      cards: [reviewed('a', NOW - 1000), reviewed('b', NOW - 5000)],
    });
    expect(queue.due.map((row) => row.id)).toEqual(['b', 'a']);
    expect(queue.cards[0].id).toBe('b');
  });

  it('never treats a New card as due, whatever its due column says', () => {
    const queue = buildQueue({ now: NOW, settings, cards: [card('fresh', { due: NOW - 5000 })] });
    expect(queue.due).toEqual([]);
    expect(queue.newCards.map((row) => row.id)).toEqual(['fresh']);
  });

  it('caps the draw at newPerDay minus what today already introduced', () => {
    const key = todayKey(NOW, settings.dayRollover);
    const capped: SettingsRow = { ...settings, newPerDay: 3, introduced: { [key]: 2 } };
    const queue = buildQueue({
      now: NOW,
      settings: capped,
      cards: [],
      newCandidates: [draw('s1'), draw('s2'), draw('s3')],
    });
    expect(queue.introducedToday).toBe(2);
    expect(queue.newRemaining).toBe(1);
    expect(queue.draws.map((row) => row.entryId)).toEqual(['s1']);
  });

  it('takes newPerDay and introducedToday directly when the caller has them', () => {
    const queue = buildQueue({
      now: NOW,
      newPerDay: 5,
      introducedToday: 4,
      cards: [],
      newCandidates: [draw('s1'), draw('s2')],
    });
    expect(queue.newRemaining).toBe(1);
    expect(queue.draws.map((row) => row.entryId)).toEqual(['s1']);
  });

  it('offers cards it introduced earlier and draws that many fewer', () => {
    // Introduced today, never graded: they are already paid for, so they stay on
    // offer — and they are why the draw stops at one more.
    const key = todayKey(NOW, settings.dayRollover);
    const capped: SettingsRow = { ...settings, newPerDay: 3, introduced: { [key]: 2 } };
    const queue = buildQueue({
      now: NOW,
      settings: capped,
      cards: [card('i1'), card('i2')],
      newCandidates: [draw('s1'), draw('s2')],
    });
    expect(queue.newCards.map((row) => row.id)).toEqual(['i1', 'i2']);
    expect(queue.drawLimit).toBe(0);
    expect(queue.draws).toEqual([]);
    expect(queue.newAvailable).toBe(2);
  });

  it('always offers an explicitly added card, even with the cap used up', () => {
    const key = todayKey(NOW, settings.dayRollover);
    const spent: SettingsRow = { ...settings, newPerDay: 1, introduced: { [key]: 1 } };
    const queue = buildQueue({
      now: NOW,
      settings: spent,
      cards: [explicit('looked-up', 'lookup')],
      newCandidates: [draw('s1')],
    });
    expect(queue.newRemaining).toBe(0);
    expect(queue.draws).toEqual([]);
    expect(queue.newCards.map((row) => row.id)).toEqual(['looked-up']);
  });

  it('shows explicit adds before drawn words, oldest first inside each', () => {
    const queue = buildQueue({
      now: NOW,
      settings,
      cards: [
        card('drawn-early', { createdAt: NOW - 5000 }),
        explicit('asked', 'ask', NOW - 1000),
        explicit('read', 'reader', NOW - 4000),
      ],
    });
    expect(queue.newCards.map((row) => row.id)).toEqual(['read', 'asked', 'drawn-early']);
  });

  it('ignores tombstones and cards that are no longer new', () => {
    const queue = buildQueue({
      now: NOW,
      settings,
      due: [card('gone', { deletedAt: NOW })],
      candidates: [
        card('deleted', { deletedAt: NOW }),
        reviewed('started', NOW + 5000),
      ],
    });
    expect(queue.due).toEqual([]);
    expect(queue.newCards).toEqual([]);
  });

  it('accepts the narrower repository reads and de-duplicates them', () => {
    const overdue = reviewed('a', NOW - 1000);
    const queue = buildQueue({
      now: NOW,
      settings,
      cards: [overdue],
      due: [overdue],
      candidates: [card('n1')],
    });
    expect(queue.due.map((row) => row.id)).toEqual(['a']);
    expect(queue.newCards.map((row) => row.id)).toEqual(['n1']);
  });

  it('reads the counter under the study day, not the calendar day', () => {
    // 01:30 with a 04:00 rollover still belongs to the previous calendar day.
    const lateNight = new Date(2026, 8, 8, 1, 30).getTime();
    const introduced = { [todayKey(NOW, settings.dayRollover)]: 10 };
    const stillYesterday = buildQueue({
      now: lateNight,
      settings: { ...settings, introduced },
      cards: [],
      newCandidates: [draw('s1')],
    });
    expect(stillYesterday.introducedToday).toBe(10);
    expect(stillYesterday.draws).toEqual([]);

    // 04:30 is a new study day: the allowance is back.
    const morning = new Date(2026, 8, 8, 4, 30).getTime();
    const fresh = buildQueue({
      now: morning,
      settings: { ...settings, introduced },
      cards: [],
      newCandidates: [draw('s1')],
    });
    expect(fresh.introducedToday).toBe(0);
    expect(fresh.draws.map((row) => row.entryId)).toEqual(['s1']);
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
