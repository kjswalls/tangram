/**
 * The one place the app decides which `DictStore` it is talking to
 * (docs/plans/core.md C4a).
 *
 * Every consumer takes the store as a prop or reads it from here; nobody
 * constructs one. When `data.md` D4 lands the OPFS-backed `SqlRunner`, this
 * file is the single edit — `new SqliteDictStore({ connect: opfsRunner })` —
 * and no component changes.
 *
 * Memoised on `globalThis` for the same reason `lib/db/get-db.ts` is: Vite's
 * HMR re-evaluates a module and a second store would mean a second status, a
 * second probe and two banners disagreeing about whether the dictionary is
 * there.
 */
import { HttpDecompStore, HttpDictStore } from './http-store';
import type { DecompStore } from './decomp-store';
import type { DictStore } from './store';

const DICT_KEY = Symbol.for('tangram.dictStore');
const DECOMP_KEY = Symbol.for('tangram.decompStore');

type Global = typeof globalThis & {
  [DICT_KEY]?: DictStore;
  [DECOMP_KEY]?: DecompStore;
};

export function getDictStore(): DictStore {
  const store = globalThis as Global;
  store[DICT_KEY] ??= new HttpDictStore();
  return store[DICT_KEY];
}

export function getDecompStore(): DecompStore {
  const store = globalThis as Global;
  store[DECOMP_KEY] ??= new HttpDecompStore();
  return store[DECOMP_KEY];
}

/** Tests only: drop the memo so the next call builds a fresh store. */
export function resetDictStores(): void {
  const store = globalThis as Global;
  delete store[DICT_KEY];
  delete store[DECOMP_KEY];
}
