import { describe, expect, it } from 'vitest';

/**
 * PLAN.md §3.3: importing anything under `lib/db` under Node must not throw and
 * must not open a database. If this fails, something acquired a side effect at
 * import time and the module can no longer be pulled into a server file.
 */
describe('lib/db import surface', () => {
  it('imports without throwing', async () => {
    const db = await import('@/lib/db');
    expect(typeof db.getDb).toBe('function');
    expect(typeof db.getRepository).toBe('function');
    expect(db.DB_VERSION).toBe(3);
  });

  it('creates the Dexie instance lazily and memoises it', async () => {
    const { getDb, getRepository, closeDb } = await import('@/lib/db');
    const first = getDb();
    expect(getDb()).toBe(first);
    expect(getRepository()).toBe(getRepository());
    expect(first.verno).toBe(3);
    await closeDb();
    expect(getDb()).not.toBe(first);
    await closeDb();
  });

  it('declares exactly the same stores at every version, all keyed on a string id', async () => {
    const { STORES_V1, STORES_V2, STORES_V3, STORES } = await import('@/lib/db');
    expect(STORES).toBe(STORES_V3);
    expect(Object.keys(STORES_V2)).toEqual(Object.keys(STORES_V1));
    expect(Object.keys(STORES_V3)).toEqual(Object.keys(STORES_V1));
    expect(Object.keys(STORES_V1)).toEqual([
      'words',
      'cards',
      'reviews',
      'lists',
      'list_members',
      'known_words',
      'texts',
      'ask_cache',
      'settings',
    ]);
    for (const definition of Object.values(STORES_V1)) {
      expect(definition.startsWith('id')).toBe(true);
      expect(definition).not.toContain('++');
    }
    for (const definition of Object.values(STORES_V2)) {
      expect(definition.startsWith('id')).toBe(true);
      expect(definition).not.toContain('++');
    }
    for (const definition of Object.values(STORES_V3)) {
      expect(definition.startsWith('id')).toBe(true);
      expect(definition).not.toContain('++');
    }
    expect(STORES_V1.reviews).toContain('[cardId+reviewedAt]');
    expect(STORES_V1.list_members).toContain('[listId+entryId]');

    // v2 is v1 plus one index, and it is the one the double-introduce fix
    // needs: a system list's natural key, unique.
    expect(STORES_V2.lists).toBe(`${STORES_V1.lists}, &systemKey`);
    for (const [name, definition] of Object.entries(STORES_V1)) {
      if (name === 'lists') continue;
      expect(STORES_V2[name as keyof typeof STORES_V2]).toBe(definition);
    }

    // v3 is v2 plus one index, and it is the one a per-direction card lookup
    // needs. Every other store, `lists` included, is v2 byte for byte — and
    // `cards` keeps every index it had, so no existing query changes plan.
    expect(STORES_V3.cards).toBe(`${STORES_V2.cards}, [entryId+direction]`);
    for (const [name, definition] of Object.entries(STORES_V2)) {
      if (name === 'cards') continue;
      expect(STORES_V3[name as keyof typeof STORES_V3]).toBe(definition);
    }
  });
});
