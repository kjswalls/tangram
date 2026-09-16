/**
 * The browser's `DictStore`, assembled (docs/plans/data.md D4).
 *
 * `SqliteDictStore` + the OPFS worker runner + the two things a browser needs
 * that Node does not: **download progress**, so `core.md` can draw a determinate
 * bar in front of a 43 MB first load, and **recovery**, because browser storage
 * is evicted and a store that spends the rest of the session wedged is worse
 * than one that re-downloads.
 *
 * Its own module rather than a function inside `runners/wasm.ts`: a runner is a
 * dumb pipe and should not import the store it feeds, and `browser-store.ts`
 * (`core.md` C4a's one construction site) should not have to know how a runner
 * is wired. `data.md` D6 is the phase that points `browser-store.ts` here; until
 * it does, the app is still on `HttpDictStore` and this is what D4's harness and
 * its Playwright suite drive.
 */
import { SqliteDictStore } from './sqlite-store';
import { wasmRunner, type WasmRunnerOptions, type WasmSqlRunner } from './runners/wasm';
import type { OpenReport } from './runners/wasm-protocol';

export interface WasmDictStoreOptions
  extends Pick<
    WasmRunnerOptions,
    'manifestUrl' | 'artifactUrl' | 'forceMemory' | 'spawn' | 'onUnavailable'
  > {
  /** Called once per successful open, with which rung answered and what it cost. */
  onOpen?: (report: OpenReport) => void;
  /** Called when a live database goes away and the store starts over. */
  onLost?: (message: string) => void;
  cacheSize?: number;
}

export interface WasmDictStoreHandle {
  store: SqliteDictStore;
  /**
   * Open **only if this origin already has the dictionary**, fetching nothing.
   *
   * The two-phase open `components/dict/dict-status.tsx` was drawn for: a
   * learner who has the artifact gets it back silently on every later visit,
   * and a learner who does not is left in `absent` — the screen with the size
   * on it and a button — rather than having 14 MB pulled down for them. It
   * resolves either way and never rejects: "there is nothing stored" is a
   * state, not an error.
   *
   * `data.md` D6 is why this exists. Before it, `<DictGate>`'s mount-time
   * `open()` was one HSK query against a route; after it, the same line meant
   * the whole artifact, which made `absent` unreachable and the silent download
   * the default the component's own header calls hostile.
   */
  openStored(): Promise<void>;
  /** The full open: fetch the manifest, import, and report progress. */
  download(): Promise<void>;
  /** The runner behind the current open — `integrityCheck()`, `evict()`, `report`. */
  runner(): WasmSqlRunner | undefined;
  /** Resolves once a recovery started by an eviction has finished. */
  settled(): Promise<void>;
  /**
   * Close the store **and stop recovering it**.
   *
   * Use this rather than `store.close()` wherever the store is being torn down
   * for good. `store.close()` alone is not enough: an eviction that arrives in
   * the same tick starts a recovery, the recovery's own `close()` runs first,
   * the caller's `close()` then returns immediately because there is nothing
   * left to close, and the recovery's `open()` spawns a fresh worker for a store
   * its owner believes is shut — holding the origin's only `opfs-sahpool` lock
   * with nobody to release it.
   */
  close(): Promise<void>;
}

export function createWasmDictStore(options: WasmDictStoreOptions = {}): WasmDictStoreHandle {
  let current: WasmSqlRunner | undefined;
  let recovery: Promise<void> | undefined;
  let disposed = false;
  /**
   * Which kind of open the next `connect` is for.
   *
   * A flag rather than a second store, because `SqliteDictStore` memoises one
   * connection and one status and the learner has one dictionary. `openStored`
   * sets it and clears it again in its own `finally`, so **every other open is
   * a full one** — including the eviction recovery below, deliberately:
   * re-downloading after an eviction is what `data.md` D4's recovery is for,
   * and asking again would be asking twice for something the learner has
   * already said yes to.
   */
  let storedOnly = false;

  const store = new SqliteDictStore({
    ...(options.cacheSize === undefined ? {} : { cacheSize: options.cacheSize }),
    connect: async (context) => {
      const runner = await wasmRunner({
        storedOnly,
        ...(options.manifestUrl === undefined ? {} : { manifestUrl: options.manifestUrl }),
        ...(options.artifactUrl === undefined ? {} : { artifactUrl: options.artifactUrl }),
        ...(options.forceMemory === undefined ? {} : { forceMemory: options.forceMemory }),
        ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
        onProgress: (received, total) => context.progress(received, total),
        onUnavailable: (message) => options.onUnavailable?.(message),
        onOpen: (report) => options.onOpen?.(report),
        onLost: (message) => {
          options.onLost?.(message);
          recover(message);
        },
      });
      current = runner;
      return runner;
    },
  });

  /**
   * Close, then open again. That is the whole of it, and it is deliberately the
   * store's own two public calls rather than a private repair path: the status
   * sequence a learner sees is `ready` → `absent` → `preparing` → `ready`, which
   * is exactly the banner `core.md` already draws for a first load.
   *
   * Guarded on `ready` so a worker that dies *during* an open cannot drive a
   * reopen loop — that failure has already been reported as `failed`, and the
   * retry is the caller's to ask for.
   */
  function recover(message: string): void {
    if (recovery || disposed) return;
    if (store.status.state !== 'ready') return;
    recovery = (async () => {
      try {
        await store.close();
        // Re-checked *between* the two calls, not only before them: a caller
        // tearing the store down while the close was in flight must win.
        if (disposed) return;
        await store.open();
      } catch {
        // `open()` has already set `failed` with its reason; rethrowing here
        // would only produce an unhandled rejection from an event handler.
        void message;
      } finally {
        recovery = undefined;
      }
    })();
  }

  return {
    store,
    async openStored() {
      if (store.status.state === 'ready') return;
      storedOnly = true;
      try {
        await store.open();
      } catch {
        // Nothing stored, so nothing is wrong: put the store back to `absent`,
        // which is the screen that asks. `close()` is what sets it, and it also
        // releases whatever the failed attempt held.
        await store.close().catch(() => undefined);
      } finally {
        storedOnly = false;
      }
    },
    async download() {
      storedOnly = false;
      await store.open();
    },
    runner: () => current,
    settled: async () => {
      await recovery;
    },
    close: async () => {
      disposed = true;
      await recovery?.catch(() => {});
      await store.close();
    },
  };
}
