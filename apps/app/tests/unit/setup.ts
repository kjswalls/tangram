import 'fake-indexeddb/auto';
import '@testing-library/jest-dom/vitest';

import { beforeEach } from 'vitest';

import { closeDb } from '@/lib/db/get-db';

/**
 * Every test starts from an empty IndexedDB, not just a closed connection.
 *
 * `closeDb()` drops the memoised Dexie instance and nothing else, which is its
 * production meaning; fake-indexeddb's databases outlive it for the rest of the
 * worker. So a test that wrote a card through `getRepository()` left it there
 * for every later test in the same file, and a test asserting "no cards yet"
 * passed only while its assertion beat the count query back —
 * `tests/unit/pwa/data-safety.test.tsx` lost that race on some full runs
 * (HANDOFF.md, "Test isolation"). Deleting every database here, before each
 * test, makes an empty store the starting state rather than a timing accident.
 *
 * `closeDb()` first, so the memoised connection is not the one that blocks the
 * delete. A connection a test opened itself and left open is closed by Dexie's
 * own `versionchange` handler, which is what lets the delete through.
 */
beforeEach(async () => {
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
        }),
    ),
  );
});
