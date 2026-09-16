/**
 * The one place the app decides which `DictStore` it is talking to
 * (docs/plans/core.md C4a, docs/plans/data.md D6).
 *
 * Every consumer takes the store as a prop or reads it from here; nobody
 * constructs one. C4a's comment said `data.md` D4 would be "the single edit"
 * that swaps the HTTP bridge for the real thing; D4 correctly declined —
 * flipping it there would have taken the app off routes that still existed and
 * put a 43 MB import in front of every e2e test, inside a phase nobody would
 * review as D6. **This is that edit, and D6 is the phase that owns it.**
 * `createWasmDictStore()` is `SqliteDictStore` over the OPFS worker runner;
 * `JsonDecompStore` is `decomp.json`, fetched lazily and kept apart because its
 * licence differs. There is no longer a server in the lookup path at all.
 *
 * Memoised on `globalThis` for the same reason `lib/db/get-db.ts` is: Vite's
 * HMR re-evaluates a module and a second store would mean a second status, a
 * second probe, two banners disagreeing about whether the dictionary is there —
 * and, now that the store sits on an `opfs-sahpool` worker, a second worker
 * fighting the first for the origin's one exclusive lock.
 *
 * **Nothing here spawns a worker or fetches a byte until `open()`.**
 * `createWasmDictStore()` only wires a `connect` callback, so a module that
 * merely reaches for the store — and in a jsdom unit test that is most of
 * them — pays nothing. `components/dict/dict-gate.tsx` is what calls `open()`.
 */
import { JsonDecompStore } from './decomp-json';
import { createWasmDictStore, type WasmDictStoreHandle } from './wasm-store';
import type { DecompStore } from './decomp-store';
import type { DictStore } from './store';

const DICT_KEY = Symbol.for('tangram.dictStore');
const HANDLE_KEY = Symbol.for('tangram.dictHandle');
const DECOMP_KEY = Symbol.for('tangram.decompStore');

type Global = typeof globalThis & {
  [DICT_KEY]?: DictStore;
  [HANDLE_KEY]?: WasmDictStoreHandle;
  [DECOMP_KEY]?: DecompStore;
};

/**
 * The wasm handle behind the app's store.
 *
 * **Hold the handle, not the store** (docs/plans/data.md D4):
 * `WasmDictStoreHandle.close()` is the teardown API, because `store.close()`
 * alone lets an eviction arriving in the same tick start a recovery that spawns
 * a fresh worker for a store its owner believes is shut — holding the origin's
 * only `opfs-sahpool` lock with nobody left to release it. It also carries
 * `runner()` and `settled()`, which is what a diagnostic surface would read.
 *
 * Throws if a stand-in was installed with `setDictStore`, because then there is
 * no handle and answering with a fresh one would silently build a second store.
 */
export function getDictHandle(): WasmDictStoreHandle {
  const global = globalThis as Global;
  if (global[DICT_KEY] && !global[HANDLE_KEY]) {
    throw new Error('the dictionary store is a stand-in installed by setDictStore; it has no handle');
  }
  if (!global[HANDLE_KEY]) {
    const handle = createWasmDictStore();
    global[HANDLE_KEY] = handle;
    global[DICT_KEY] = handle.store;
  }
  return global[HANDLE_KEY] as WasmDictStoreHandle;
}

export function getDictStore(): DictStore {
  const global = globalThis as Global;
  return global[DICT_KEY] ?? getDictHandle().store;
}

/**
 * The app's store, opened **from storage only**.
 *
 * `SqliteDictStore` refuses a query before `open()` — "the dictionary is not
 * open" — and that is right: a SQLite connection is a thing you have or do not
 * have, and answering `[]` instead would be a lie. `HttpDictStore` had no such
 * state, so before `data.md` D6 every consumer could simply query.
 *
 * Two of them are **not** behind `<DictGate>`, deliberately, and they are the
 * reason this exists: `lib/lists/entry-source.ts` (the Practice queue's draw,
 * the lists page and the demo seed) and `components/review/example-sentences.tsx`
 * (the cited words on a card back). PLAN.md's rule is that the learner's own
 * data keeps working without a dictionary, so gating Practice to open one would
 * be the wrong fix; opening it where it is used is the right one.
 *
 * It is the **full** open — the same one `<DictGate>` does — and whether that is
 * right is the open question recorded in `dict-gate.tsx` and in HANDOFF.md: on
 * the web it means these two can start a 14 MB download that nobody asked for.
 * `getDictHandle().openStored()` is the one-line alternative, and it is not
 * taken here because a card back that silently has no dictionary while the
 * lookup tab downloads one would be a third behaviour nobody chose.
 *
 * `open()` is idempotent and shares one in-flight attempt across every caller,
 * so this costs a resolved promise once the dictionary is up. It **rejects**
 * when the dictionary cannot be opened, which is what each caller's existing
 * failure path already handles.
 */
export async function openDictStore(): Promise<DictStore> {
  const store = getDictStore();
  await store.open();
  return store;
}

export function getDecompStore(): DecompStore {
  const global = globalThis as Global;
  global[DECOMP_KEY] ??= new JsonDecompStore();
  return global[DECOMP_KEY];
}

/**
 * Tests only: put a stand-in behind `getDictStore()` / `getDecompStore()`.
 *
 * The alternative — threading a `store` prop through every component that reads
 * one — is the restructuring `core.md` C4a deliberately did not do, and D6 is
 * not the phase to do it either. A jsdom test that renders a card back wants
 * three entries by id, not a 43 MB OPFS import, and before D6 it got them by
 * stubbing `fetch` for the entries route. That route is gone; this replaces it.
 *
 * A stand-in is **never closed** by `resetDictStores()` — it is the caller's.
 */
export function setDictStore(store: DictStore, decomp?: DecompStore): void {
  const global = globalThis as Global;
  if (global[HANDLE_KEY]) {
    // Dropping a live handle would leave its worker holding the origin's only
    // `opfs-sahpool` lock with nobody left to release it. `resetDictStores()`
    // is what closes one, and a test that needs both calls it first.
    throw new Error('a real dictionary handle is open; await resetDictStores() before setDictStore');
  }
  global[DICT_KEY] = store;
  if (decomp) global[DECOMP_KEY] = decomp;
}

/**
 * Tests only: close anything this module built and drop the memos.
 *
 * Asynchronous, and it has to be. A real handle owns a worker holding the
 * origin's only `opfs-sahpool` lock; dropping the reference without closing
 * leaves that worker alive and the next store's `installOpfsSAHPoolVfs` racing
 * a corpse for the handles it needs.
 */
export async function resetDictStores(): Promise<void> {
  const global = globalThis as Global;
  const handle = global[HANDLE_KEY];
  delete global[DICT_KEY];
  delete global[HANDLE_KEY];
  delete global[DECOMP_KEY];
  if (handle) await handle.close();
}
