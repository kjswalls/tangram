/**
 * Today, against a real database (PLAN.md §3.3, §4 P3): the counts, the
 * persisted introduced counter, and the two acceptance lines that are only true
 * across a reload.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createDexieRepository, TangramDb } from '@/lib/db/dexie';
import type { Repository } from '@/lib/db/repository';
import { queueFromList } from '@/lib/lists/introduce';
import { addCardTracked } from '@/lib/lists/looked-up';
import { markListKnown } from '@/lib/lists/members';
import { ensureSystemLists, findHskList } from '@/lib/lists/system-lists';
import { loadToday } from '@/lib/lists/today';
import { todayKey } from '@/lib/srs/day';
import { requireDictData } from '../dict/data-required';
import { dictEntrySource, entry, fakeEntrySource, freshRepository } from './helpers';

const NOW = new Date(2026, 8, 7, 12).getTime();
const DAY = 86_400_000;

let open: TangramDb[] = [];

beforeAll(() => {
  requireDictData();
});

afterEach(() => {
  for (const db of open) db.close();
  open = [];
});

function setup(): { db: TangramDb; repo: Repository; reopen: () => Repository } {
  const { db, repo } = freshRepository();
  open.push(db);
  // A reload is a new Dexie instance and a new repository over the same store —
  // exactly what the browser does, and the only way to prove the counter is
  // persisted rather than remembered.
  const reopen = () => {
    const next = new TangramDb(db.name);
    open.push(next);
    return createDexieRepository(next);
  };
  return { db, repo, reopen };
}

describe('loadToday', () => {
  it('introduces newPerDay words, then holds the line across a reload', async () => {
    const { repo, reopen } = setup();
    const source = dictEntrySource();
    await repo.setSettings({ newPerDay: 3 });

    const first = await loadToday({ repo, now: NOW, source });
    expect(first.newCount).toBe(3);
    expect(first.created).toHaveLength(3);
    expect(first.introducedToday).toBe(3);
    expect(first.settings.introduced[todayKey(NOW, 4)]).toBe(3);

    // Reload: the same three cards, no new ones, the counter untouched.
    const again = await loadToday({ repo: reopen(), now: NOW, source });
    expect(again.created).toEqual([]);
    expect(again.newCount).toBe(3);
    expect(again.introducedToday).toBe(3);
    expect(again.newCards.map((card) => card.entryId)).toEqual(
      first.newCards.map((card) => card.entryId),
    );
  });

  it('offers no further spine cards once the day’s ten have been graded', async () => {
    const { repo, reopen } = setup();
    const source = dictEntrySource();

    const first = await loadToday({ repo, now: NOW, source });
    expect(first.newCount).toBe(10);
    for (const card of first.newCards) await repo.grade(card.id, 3, NOW);

    const after = await loadToday({ repo: reopen(), now: NOW + 60_000, source });
    expect(after.created).toEqual([]);
    expect(after.newCards).toEqual([]);
    expect(after.newCount).toBe(0);
    // They are scheduled, not gone: FSRS put them a day or more out.
    expect(after.dueCount).toBe(0);
    expect((await repo.allCards()).length).toBe(10);
  });

  it('counts a hand-queued word against the day, graded or not', async () => {
    // The acceptance line PLAN §3.3 states, in the shape that used to break it:
    // a card created outside the spine draw ("Add to queue" on a list, and the
    // demo seed the same way) charges `settings.introduced` at creation, so
    // grading it cannot reopen the slot.
    const { repo, reopen } = setup();
    const source = dictEntrySource();
    await repo.setSettings({ newPerDay: 3 });
    const [byHand] = await source.band(4);
    await queueFromList(repo, byHand, { now: NOW });
    expect((await repo.getSettings()).introduced[todayKey(NOW, 4)]).toBe(1);

    const first = await loadToday({ repo, now: NOW, source });
    expect(first.created).toHaveLength(2);
    expect(first.newCount).toBe(3);
    expect(first.introducedToday).toBe(3);

    // Grade every one of them and reload: no fourth card today.
    for (const card of first.newCards) await repo.grade(card.id, 3, NOW);
    const after = await loadToday({ repo: reopen(), now: NOW + 60_000, source });
    expect(after.created).toEqual([]);
    expect(after.newCards).toEqual([]);
    expect(after.newCount).toBe(0);
    expect(after.queue.drawLimit).toBe(0);
    expect((await repo.allCards()).length).toBe(3);
  });

  it('queues a word by hand only once, however often the button is pressed', async () => {
    const { repo } = setup();
    const source = dictEntrySource();
    const [word] = await source.band(4);
    const first = await queueFromList(repo, word, { now: NOW });
    const again = await queueFromList(repo, word, { now: NOW });
    expect(again.id).toBe(first.id);
    expect((await repo.getSettings()).introduced[todayKey(NOW, 4)]).toBe(1);
  });

  it('starts again after the study day rolls over', async () => {
    const { db, repo } = setup();
    const source = dictEntrySource();
    await repo.setSettings({ newPerDay: 2 });
    const first = await loadToday({ repo, now: NOW, source });
    for (const card of first.created) await repo.grade(card.id, 3, NOW);
    // These cards were introduced *at NOW*, and the fixture has to say so:
    // the repository stamps `createdAt` from the wall clock, while `buildQueue`
    // compares that stamp against the injected `now` (`createdToday`, the
    // backstop for a path that forgot to charge the counter). Left at the real
    // clock, the two disagree the moment the real date passes NOW — the day
    // this test was written it passed, and on 2026-09-08 it went red without a
    // line of source changing.
    await db.cards.where('id').anyOf(first.created.map((card) => card.id)).modify({ createdAt: NOW });

    // 01:00 the next calendar day is still the same study day (04:00 rollover),
    // so the counter still reads yesterday's two and nothing is drawn.
    const lateNight = new Date(2026, 8, 8, 1, 0).getTime();
    const still = await loadToday({ repo, now: lateNight, source });
    expect(still.created).toEqual([]);
    expect(still.introducedToday).toBe(2);

    // 05:00 is a new study day: the allowance is back.
    const morning = new Date(2026, 8, 8, 5, 0).getTime();
    const next = await loadToday({ repo, now: morning, source });
    expect(next.created).toHaveLength(2);
    expect(next.introducedToday).toBe(2);
    // Yesterday's count is kept, not overwritten: the counter is per day key.
    expect(next.settings.introduced[todayKey(NOW, 4)]).toBe(2);
    expect(next.settings.introduced[todayKey(morning, 4)]).toBe(2);
  });

  it('holds the allowance for cards it introduced and no one has graded', async () => {
    const { repo } = setup();
    const source = dictEntrySource();
    await repo.setSettings({ newPerDay: 2 });
    await loadToday({ repo, now: NOW, source });

    // Two untouched cards from yesterday: today draws none, and still offers
    // exactly two — the cap is on cards in flight, not on page loads.
    const tomorrow = new Date(2026, 8, 8, 9, 0).getTime();
    const next = await loadToday({ repo, now: tomorrow, source });
    expect(next.created).toEqual([]);
    expect(next.newCount).toBe(2);
  });

  it('draws from the next band once the bands below it are known', async () => {
    const { repo } = setup();
    const source = dictEntrySource();
    await repo.setSettings({ newPerDay: 4 });
    const lists = await ensureSystemLists(repo);
    for (const band of [1, 2, 3] as const) {
      await markListKnown(repo, findHskList(lists, band)!, source);
    }

    const today = await loadToday({ repo, now: NOW, source });
    expect(today.created).toHaveLength(4);
    for (const card of today.created) {
      expect(card.snapshot).toMatchObject({ hskBand: 4 });
    }
  });

  it('always offers an explicit add, and it does not spend the daily cap', async () => {
    const { repo } = setup();
    const looked = entry({ simp: '锅' });
    const drawn = entry({ simp: '甲' });
    const source = fakeEntrySource({ 3: [drawn, entry({ simp: '乙' })] });
    await repo.setSettings({ newPerDay: 1 });
    await addCardTracked(repo, looked, { source: 'lookup', query: '锅', addedAt: NOW });

    const today = await loadToday({ repo, now: NOW, source });
    // The looked-up word is on top of the day's one spine word, not instead of it.
    expect(today.introducedToday).toBe(1);
    expect(today.newCards.map((card) => card.entryId)).toEqual([looked.id, drawn.id]);
    expect(today.newCount).toBe(2);
  });

  it('counts due cards and keeps them ahead of the new ones', async () => {
    const { repo } = setup();
    const source = fakeEntrySource({ 3: [entry({ simp: '甲' })] });
    const old = entry({ simp: '旧' });
    const card = await addCardTracked(repo, old, { source: 'lookup', addedAt: NOW - 30 * DAY });
    await repo.grade(card.id, 3, NOW - 20 * DAY);

    await repo.setSettings({ newPerDay: 1 });
    const today = await loadToday({ repo, now: NOW, source });
    expect(today.dueCount).toBe(1);
    expect(today.queue.cards[0].entryId).toBe(old.id);
    expect(today.newCount).toBe(1);
  });

  it('creates the system lists on first visit', async () => {
    const { repo } = setup();
    expect(await repo.lists()).toEqual([]);
    const today = await loadToday({ repo, now: NOW, source: fakeEntrySource({}) });
    expect(today.lists).toHaveLength(8);
  });
});
