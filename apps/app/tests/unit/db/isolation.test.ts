/**
 * Every test starts from an empty IndexedDB (`tests/unit/setup.ts`).
 *
 * The first test leaves as much behind as a careless test could: a card through
 * the memoised repository, a card in a privately named database, and both
 * connections still open. The second asserts none of it survived. Order is the
 * point, so the second also checks the first actually ran before it — a
 * shuffled run would otherwise pass this vacuously.
 *
 * Without the setup file's delete, `closeDb()` in a file's `afterEach` only
 * drops the memo, fake-indexeddb keeps every row, and `data-safety.test.tsx`'s
 * "no cards yet" test raced a card left by the test above it. HANDOFF.md,
 * "Test isolation", has the reproduction.
 */
import { describe, expect, it } from 'vitest';

import { createDexieRepository, TangramDb } from '@/lib/db/dexie';
import { getRepository } from '@/lib/db/get-db';
import { DASUAN, KANKAN } from './fixtures';

let leftBehind = false;

describe('a test cannot see what the previous one wrote', () => {
  it('writes, and closes nothing', async () => {
    await getRepository().addCardFromEntry(DASUAN, undefined, 0, 'test-dict');
    const privateDb = new TangramDb('tangram-isolation-guard');
    await createDexieRepository(privateDb).addCardFromEntry(KANKAN, undefined, 0, 'test-dict');

    expect(await getRepository().allCards()).toHaveLength(1);
    expect(await indexedDB.databases()).toHaveLength(2);
    leftBehind = true;
  });

  it('starts from no databases at all', async () => {
    expect(leftBehind).toBe(true);
    expect(await indexedDB.databases()).toEqual([]);
    expect(await getRepository().allCards()).toEqual([]);
    expect(await createDexieRepository(new TangramDb('tangram-isolation-guard')).allCards()).toEqual(
      [],
    );
  });
});
