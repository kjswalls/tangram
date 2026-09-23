import 'fake-indexeddb/auto';
import '@testing-library/jest-dom/vitest';

import { beforeEach, vi } from 'vitest';

import { closeDb } from '@/lib/db/get-db';

/**
 * Every test starts from an empty IndexedDB, not just a closed connection.
 *
 * `closeDb()` drops the memoised Dexie instance and nothing else, which is its
 * production meaning; fake-indexeddb's databases outlive it for the rest of the
 * file. So a test that wrote a card through `getRepository()` left it there
 * for every later test in the same file, and a test asserting "no cards yet"
 * passed only while its assertion beat the count query back —
 * `tests/unit/pwa/data-safety.test.tsx` lost that race on some full runs
 * (HANDOFF.md, "Test isolation"). Deleting every database here, before each
 * test, makes an empty store the starting state rather than a timing accident.
 * A consequence: nothing seeded into IndexedDB in a `beforeAll` survives to the
 * tests — seed in `beforeEach`.
 *
 * `closeDb()` is not what lets the delete through — Dexie closes any open
 * connection on `versionchange` — it is here so the next `getDb()` builds a new
 * instance rather than reopening one that watched its database disappear.
 *
 * Real timers first: fake-indexeddb schedules on `setImmediate`, so a previous
 * test that left fake timers installed would hang this hook with a timeout that
 * names the wrong test. And a delete that something blocks fails here, loudly,
 * rather than hanging the same way.
 */
beforeEach(async () => {
  vi.useRealTimers();
  await closeDb();
  const databases = await indexedDB.databases();
  await Promise.all(
    databases.map(
      ({ name }) =>
        new Promise<void>((resolve, reject) => {
          if (!name) return resolve();
          const request = indexedDB.deleteDatabase(name);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
          request.onblocked = () =>
            reject(new Error(`deleteDatabase('${name}') was blocked by a connection left open`));
        }),
    ),
  );
});
