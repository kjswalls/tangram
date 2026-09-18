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
 * **Nothing here spawns a worker or fetches a byte until an open.**
 * `createWasmDictStore()` only wires a `connect` callback, so a module that
 * merely reaches for the store — and in a jsdom unit test that is most of
 * them — pays nothing. And the open is two calls, not one:
 * `components/dict/dict-gate.tsx` mounts with `openStored()`, which fetches
 * nothing either, and only its button calls `download()`.
 */
import { JsonDecompStore } from './decomp-json';
import { createWasmDictStore, type WasmDictStoreHandle } from './wasm-store';
import { DictUnavailableError } from './unavailable';
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
 * The two-phase open, for whoever holds a `DictStore` and not the handle.
 *
 * `DictStore` is frozen by `data.md` D1's first commit and has one `open()`,
 * which on the web means *fetch 43 MB*. `openStored` / `download` is the
 * distinction the learner actually cares about and it lives on
 * `WasmDictStoreHandle`, one layer below what the UI is handed — so this is the
 * adapter, and it is the only place that knows which of the two a given store
 * can do.
 */
export interface DictOpener {
  /**
   * Open **only if this origin already has the artifact**, fetching nothing.
   * Never rejects: "there is nothing stored" is a state, not an error.
   */
  openStored(): Promise<void>;
  /** The full open — the download the `absent` card's button asks for. */
  download(): Promise<void>;
}

/**
 * The opener for a store, whether or not this module built it.
 *
 * For the app's own store that is the handle, which has both halves. For
 * anything installed by `setDictStore` — the gallery's `FakeDictStore`, a
 * jsdom stand-in, a real `SqliteDictStore` a unit test drives itself — there is
 * only `open()`, so:
 *
 * - `download()` is `open()`, which is what a plain `DictStore` means by it;
 * - `openStored()` does **nothing**. That is the conservative reading and the
 *   correct one: a store with no stored-only rung cannot answer "only if you
 *   already have it" without fetching, and fetching is the one thing this call
 *   promises not to do. It leaves the status where it was, which on a store
 *   nobody has opened is `absent` — the ask.
 */
export function getDictOpener(store: DictStore = getDictStore()): DictOpener {
  const handle = handleFor(store);
  if (handle) return handle;
  return {
    openStored: async () => {},
    download: () => store.open(),
  };
}

/** The wasm handle behind `store`, or nothing if this module did not build it. */
function handleFor(store: DictStore): WasmDictStoreHandle | undefined {
  const handle = (globalThis as Global)[HANDLE_KEY];
  return handle && handle.store === store ? handle : undefined;
}

/**
 * The app's store, opened **from what is already on the device**, for the two
 * consumers that are not behind the gate.
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
 * **It is `openStored()`, not `open()`, and that is the sharper half of the fix
 * this branch is.** These two callers sit outside the gate, so there is no
 * banner, no progress bar and no cancel anywhere on screen — a full open here
 * meant that a fresh install on cellular data which taps **Library** and never
 * opens Look up downloaded 14 MB unasked, because `ListsView`'s mount effect
 * fills an HSK list through `source.band(1)`. The Practice queue's draw was the
 * same path. Nothing here fetches now: a learner who has the dictionary gets it
 * back silently, and a learner who does not gets the *degraded* screen these
 * callers already draw — a list of their own words with no glosses, which is
 * what "the app keeps working without a dictionary" has always meant.
 *
 * The ask itself belongs to `<DictGate>`, which is a surface with room for it.
 *
 * It **rejects** when the dictionary is not there, which is what each caller's
 * existing failure path already handles — and it rejects here rather than
 * letting the query throw, so the error says what is true ("not on this
 * device") instead of advising an `open()` that is the thing being avoided.
 */
export async function openDictStore(): Promise<DictStore> {
  const store = getDictStore();
  const handle = handleFor(store);
  if (handle) {
    await handle.openStored();
  } else {
    // A stand-in installed by `setDictStore` — a jsdom fake, the gallery's
    // store. It has one `open()` and no bytes behind it, so opening it is what
    // a test means by installing it, and the probe/download distinction has
    // nothing to be about. Not `getDictOpener()`'s fallback, whose
    // `openStored()` is a no-op: that one is written for `<DictGate>`, which
    // must not open a store it was handed, and this one has to.
    await store.open();
  }
  if (store.status.state !== 'ready') {
    // A named class, not a bare Error: the three screens that surface this have
    // only a flattened `error.message` to go on by the time it reaches them, and
    // `lib/dict/unavailable.ts` is what lets them recognise it and render the
    // dictionary's own card instead of the string (docs/plans/web.md W6).
    throw new DictUnavailableError();
  }
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
