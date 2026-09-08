/**
 * Two open tabs (HANDOFF.md, "Still open after the merge" 2).
 *
 * `ensureSystemLists` and `loadToday` guard with a promise memoised per
 * repository, which holds inside one JS context and nowhere else: two tabs are
 * two contexts over one IndexedDB, so both could read "no lists yet" and both
 * create the eight system lists, and both could draw the day's ten words and
 * each charge `settings.introduced` for them.
 *
 * Two tabs is exactly what this file is: two `TangramDb` connections to one
 * database, driven concurrently. The fix under test is durable rather than
 * in-memory — a unique index on a system list's natural key, and a card write
 * that charges the day inside its own transaction — so a `BroadcastChannel`
 * (which cannot reach a tab in another process, and whose message arrives after
 * the write anyway) is not what is being relied on.
 */
import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';

import { createDexieRepository, TangramDb } from '@/lib/db/dexie';
import type { Repository } from '@/lib/db/repository';
import { STORES_V1, type ListRow } from '@/lib/db/schema';
import type { DrawCandidate } from '@/lib/lists/draw';
import { introduceCards } from '@/lib/lists/introduce';
import { loadToday } from '@/lib/lists/today';
import { ensureSystemLists, SYSTEM_LISTS } from '@/lib/lists/system-lists';
import { todayKey } from '@/lib/srs/day';
import { entry, fakeEntrySource } from './helpers';

const NOW = new Date(2026, 8, 8, 12).getTime();

let open: Dexie[] = [];

afterEach(() => {
  for (const db of open) db.close();
  open = [];
});

let counter = 0;

/** One database, two connections — a second tab, as far as IndexedDB is concerned. */
function twoTabs(): { name: string; a: Repository; b: Repository; dbA: TangramDb } {
  const name = `tangram-two-tabs-${Date.now()}-${counter++}`;
  const dbA = new TangramDb(name);
  const dbB = new TangramDb(name);
  open.push(dbA, dbB);
  return { name, a: createDexieRepository(dbA), b: createDexieRepository(dbB), dbA };
}

function candidates(count: number): DrawCandidate[] {
  return Array.from({ length: count }, (_, index) => {
    const row = entry({ simp: `词${index}`, id: `词${index}|词${index}[ci2 ${index}]` });
    return { entryId: row.id, from: 'spine' as const, listId: '', entry: row };
  });
}

describe('two tabs, one database', () => {
  it('creates the eight system lists once, not sixteen', async () => {
    const { a, b } = twoTabs();

    await Promise.all([ensureSystemLists(a), ensureSystemLists(b)]);

    const lists = await a.lists();
    expect(lists).toHaveLength(SYSTEM_LISTS.length);
    const keys = lists.map((list) => list.systemKey);
    expect(new Set(keys).size).toBe(lists.length);
    expect(keys.filter((key) => key === 'looked-up')).toHaveLength(1);
    expect(keys.filter((key) => key === 'hsk:1')).toHaveLength(1);
    // Both tabs see one set of lists, not one each.
    expect(await b.lists()).toHaveLength(SYSTEM_LISTS.length);
  });

  it('refuses a second row for a system list even when a caller insists', async () => {
    // The index is the durable half of the fix: `createList` asking first is
    // what makes the normal path quiet, but a path that does not ask is refused
    // by the database rather than growing a list nothing reads.
    const { a, dbA } = twoTabs();
    const lists = await ensureSystemLists(a);
    const lookedUp = lists.find((list) => list.kind === 'looked-up');
    if (!lookedUp) throw new Error('expected a "Looked up" list');

    await expect(
      dbA.lists.add({ ...lookedUp, id: 'a-second-looked-up' }),
    ).rejects.toThrow(/constraint/i);
    expect(await a.lists()).toHaveLength(SYSTEM_LISTS.length);
  });

  it('charges the day once for a word both tabs draw', async () => {
    const { a, b } = twoTabs();
    const draw = candidates(10);

    const [first, second] = await Promise.all([
      introduceCards(a, draw, { now: NOW }),
      introduceCards(b, draw, { now: NOW }),
    ]);

    const cards = await a.allCards();
    expect(cards).toHaveLength(10);
    // Between them the two tabs created ten cards — whichever ran second found
    // them committed and reported nothing created.
    expect(first.created.length + second.created.length).toBe(10);
    // Both tabs still report the whole draw as today's cards, which is what the
    // page shows: the cap is about what exists, not about who made it.
    expect(first.cards).toHaveLength(10);
    expect(second.cards).toHaveLength(10);

    const settings = await a.getSettings();
    expect(settings.introduced[todayKey(NOW, settings.dayRollover)]).toBe(10);
  });

  it('opens Today in both and introduces the day once', async () => {
    // The whole bug, end to end: two page loads, each reading an empty card
    // table, each drawing the same words from the same spine band.
    const { a, b } = twoTabs();
    const band3 = Array.from({ length: 20 }, (_, index) =>
      entry({ simp: `第${index}`, id: `第${index}|第${index}[di4 ${index}]`, hskBand: 3 }),
    );
    const source = fakeEntrySource({ 3: band3 });
    await a.setSettings({ newPerDay: 4 });

    const [tabA, tabB] = await Promise.all([
      loadToday({ repo: a, now: NOW, source }),
      loadToday({ repo: b, now: NOW, source }),
    ]);

    const cards = await a.allCards();
    expect(cards).toHaveLength(4);
    expect(tabA.created.length + tabB.created.length).toBe(4);
    // Both pages show the same four words, and the day has been charged for
    // four — not eight, and not four twice with one write lost.
    expect(tabA.newCount).toBe(4);
    expect(tabB.newCount).toBe(4);
    const settings = await a.getSettings();
    expect(settings.introduced[todayKey(NOW, settings.dayRollover)]).toBe(4);
    expect(await a.lists()).toHaveLength(SYSTEM_LISTS.length);
  });

  it('does not lose one tab’s charge under the other’s', async () => {
    const { a, b } = twoTabs();
    const key = todayKey(NOW, (await a.getSettings()).dayRollover);

    await Promise.all([a.bumpIntroduced(key, 5), b.bumpIntroduced(key, 5)]);

    expect((await a.getSettings()).introduced[key]).toBe(10);
  });

  it('never decrements the counter', async () => {
    const { a } = twoTabs();
    const key = todayKey(NOW, (await a.getSettings()).dayRollover);
    await a.bumpIntroduced(key, 3);
    await a.bumpIntroduced(key, 0);
    await a.bumpIntroduced(key, -5);
    expect((await a.getSettings()).introduced[key]).toBe(3);
  });

  it('still lets a deleted system list be recreated: the tombstone releases the key', async () => {
    // Deleting a system list is a reset, not a removal (HANDOFF.md), so the
    // uniqueness must not outlive the row it belongs to.
    const { a } = twoTabs();
    const lists = await ensureSystemLists(a);
    const band3 = lists.find((list) => list.systemKey === 'hsk:3');
    if (!band3) throw new Error('expected an HSK 3 list');

    await a.deleteList(band3.id);
    expect((await a.lists()).some((list) => list.systemKey === 'hsk:3')).toBe(false);

    const again = await ensureSystemLists(a);
    const recreated = again.filter((list) => list.systemKey === 'hsk:3');
    expect(recreated).toHaveLength(1);
    expect(recreated[0].id).not.toBe(band3.id);
    expect(again).toHaveLength(SYSTEM_LISTS.length);
  });
});

describe('a database written before the index existed', () => {
  it('upgrades to v2 by stamping the keys and retiring a duplicate', async () => {
    const name = `tangram-v1-${Date.now()}-${counter++}`;
    const legacy = new Dexie(name);
    legacy.version(1).stores(STORES_V1);
    open.push(legacy);

    const base = {
      name: 'Looked up',
      owner: 'system' as const,
      kind: 'looked-up' as const,
      active: true,
      order: 0,
      updatedAt: 1,
      deletedAt: null,
    };
    // What the bug this closes actually produced: two tabs, two "Looked up".
    await legacy.table<ListRow, string>('lists').bulkAdd([
      { ...base, id: 'older', createdAt: 1 },
      { ...base, id: 'younger', createdAt: 2 },
      { ...base, id: 'hsk-1', name: 'HSK 1', kind: 'hsk', band: 1, order: 1, createdAt: 3 },
    ]);
    legacy.close();

    const db = new TangramDb(name);
    open.push(db);
    const repo = createDexieRepository(db);
    const lists = await repo.lists();

    // The oldest row is the one the app has been using, so it is the survivor.
    expect(lists.map((list) => list.id)).toEqual(['older', 'hsk-1']);
    expect(lists.map((list) => list.systemKey)).toEqual(['looked-up', 'hsk:1']);
    expect(db.verno).toBe(2);

    // And the constraint is live from here on.
    await expect(
      db.lists.add({ ...base, id: 'a-third', systemKey: 'looked-up', createdAt: 4 }),
    ).rejects.toThrow(/constraint/i);
  });
});
