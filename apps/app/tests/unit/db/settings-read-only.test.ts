/**
 * `getSettings()` must never throw in a read-only context (core.md C3).
 *
 * It is called from inside transactions and, since C3's
 * `PinyinDisplayProvider`, from inside a Dexie `liveQuery` — which refuses a
 * readwrite transaction outright. Its own header already called the write
 * best-effort, but only the fill-in write was guarded; **the create was not**,
 * so the first read on a fresh database inside a live query threw
 * "Readwrite transaction in liveQuery context", the error reached the router's
 * `errorElement`, and *every* route rendered "Something went wrong". Seventeen
 * e2e specs went red at once, and no unit test saw it, because no unit test
 * mounted a live query.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS, SETTINGS_ID } from '@/lib/db/schema';

import { freshRepository } from './fixtures';

const open: { close: () => void }[] = [];

afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

describe('getSettings in a read-only context', () => {
  it('returns the defaults on a FRESH database inside a read transaction', async () => {
    const { db, repo } = freshRepository();
    open.push(db);

    // A read transaction is the closest a unit test gets to a liveQuery: Dexie
    // refuses a write in both, with the same error.
    const settings = await db.transaction('r', db.settings, async () => repo.getSettings());
    expect(settings.pinyinDisplay).toBe(DEFAULT_SETTINGS.pinyinDisplay);
    expect(settings.id).toBe(SETTINGS_ID);
  });

  it('fills in a column the stored row predates, inside a read transaction', async () => {
    const { db, repo } = freshRepository();
    open.push(db);
    const now = Date.now();
    // A row written before `pinyinDisplay` existed.
    const stored: Record<string, unknown> = { ...DEFAULT_SETTINGS, createdAt: now, updatedAt: now };
    delete stored.pinyinDisplay;
    await db.settings.put(stored as never);

    const settings = await db.transaction('r', db.settings, async () => repo.getSettings());
    expect(settings.pinyinDisplay).toBe(DEFAULT_SETTINGS.pinyinDisplay);
  });

  /**
   * core.md C3: "`'always'` is the value a fresh database reads, asserted
   * against `DEFAULT_SETTINGS`." The literal is named on both sides on purpose
   * — comparing the read back to `DEFAULT_SETTINGS.pinyinDisplay` alone passes
   * for any default, including one a later edit changes by accident.
   */
  it("reads 'always' out of a fresh database, and that is what the default says", async () => {
    expect(DEFAULT_SETTINGS.pinyinDisplay).toBe('always');
    const { db, repo } = freshRepository();
    open.push(db);
    expect((await repo.getSettings()).pinyinDisplay).toBe('always');
  });

  it('still persists the row when it CAN write', async () => {
    const { db, repo } = freshRepository();
    open.push(db);
    await repo.getSettings();
    expect(await db.settings.get(SETTINGS_ID)).toBeDefined();
  });
});
