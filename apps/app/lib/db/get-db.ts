'use client';

/**
 * The one place a Dexie instance comes from (PLAN.md §3.3).
 *
 * Lazy and memoised on `globalThis`, so it survives HMR and so that importing
 * anything under `lib/db` never opens a database — which is what lets the same
 * modules be imported under Node in tests.
 */

import { createDexieRepository, TangramDb } from '@/lib/db/dexie';
import type { Repository } from '@/lib/db/repository';

interface DbGlobal {
  __tangramDb__?: TangramDb;
  __tangramRepository__?: Repository;
}

const store = globalThis as typeof globalThis & DbGlobal;

export function getDb(): TangramDb {
  return (store.__tangramDb__ ??= new TangramDb());
}

export function getRepository(): Repository {
  return (store.__tangramRepository__ ??= createDexieRepository(getDb()));
}

/** Drop the memoised instances. Tests use it to start from a clean database. */
export async function closeDb(): Promise<void> {
  store.__tangramDb__?.close();
  store.__tangramDb__ = undefined;
  store.__tangramRepository__ = undefined;
}
