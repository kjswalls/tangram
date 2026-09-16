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
import { dictionaryRequested, rememberDictionaryRequest } from './requested';
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
  /**
   * The two open kinds, in flight, tracked separately — and the reason is that
   * `SqliteDictStore.open()` **shares one attempt across every caller**.
   *
   * That sharing is right within a kind and wrong across them: a `download()`
   * that arrived while a probe was in flight would join the probe, resolve when
   * the probe resolved, and fetch nothing — the learner presses "Get it" and
   * lands back on the same card. So a download waits for a probe to settle and
   * then opens for real, and a probe that arrives during a download joins the
   * download rather than trying to downgrade it.
   */
  let probing: Promise<void> | undefined;
  let downloading: Promise<void> | undefined;
  /**
   * This document has already looked, and there was nothing here.
   *
   * A probe is not free — it spawns a worker, fetches and boots the sqlite-wasm
   * binary, installs the pool and tears all of it down again — and `openStored()`
   * is called from a **mount effect** and from `openDictStore()`, which
   * `lib/lists/entry-source.ts` calls per operation and
   * `components/review/example-sentences.tsx` calls per card back. Without this
   * a fresh install spends a worker per card, per band, per navigation, to
   * re-learn the same "no".
   *
   * Cleared by `download()`, which is the only thing that can change the answer
   * from inside this document, and by an eviction (which can only follow a
   * successful open, so it clears it by construction).
   */
  let probedEmpty = false;

  const store = new SqliteDictStore({
    ...(options.cacheSize === undefined ? {} : { cacheSize: options.cacheSize }),
    // A probe reports only its success. See `SqliteStoreOptions.announceOpen`.
    announceOpen: () => !storedOnly,
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
        // Stated rather than inherited: recovery is a full open, and a probe
        // that happened to be in flight when the eviction landed must not turn
        // it into a stored-only one.
        storedOnly = false;
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
      if (disposed) return;
      if (store.status.state === 'ready') return;
      // A download or a recovery already under way is the stronger open, and in
      // both cases the learner has already asked for the dictionary; join it
      // rather than racing it back down to a probe.
      if (downloading) return downloading.catch(() => undefined);
      if (recovery) return recovery.catch(() => undefined);
      if (probing) return probing;
      // `failed` is a settled answer with a reason on screen and a retry beside
      // it. Probing over it would replace that with the bare ask and lose the
      // message.
      if (store.status.state === 'failed') return;
      // Asked and answered, in this document. See `probedEmpty`.
      if (probedEmpty) return;
      // The slot is cleared by a chained `.finally`, not by an inner one, and
      // it holds for the **whole** call including the escalation below: a probe
      // that turned into a download is still what a concurrent `openStored()`
      // should join, and `download()` waits this out before it fetches.
      const attempt: Promise<void> = (async () => {
        storedOnly = true;
        try {
          await store.open();
          return;
        } catch {
          // Fall through: what to do about it depends on whether this origin
          // has ever said yes, which the probe itself cannot tell.
        } finally {
          storedOnly = false;
        }
        if (disposed) return;
        if (!dictionaryRequested()) {
          // A fresh install. Nothing is stored, nobody has consented, and the
          // right screen is the ask. `close()` is what sets `absent`, and it
          // also releases whatever the failed attempt held.
          probedEmpty = true;
          await store.close().catch(() => undefined);
          return;
        }
        // The learner has already paid for this dictionary on this origin. The
        // probe failing here means this *document* could not reach it — a
        // second tab holding the pool's exclusive handles, a reload that lost
        // the same race, a download a reload interrupted, an eviction between
        // sessions. Re-asking would be asking twice; the full open is what
        // `data.md` D4's ladder already does for all four, and it draws a
        // progress bar where there is a gate to draw it on.
        await store.open().catch(() => undefined);
      })().finally(() => {
        if (probing === attempt) probing = undefined;
      });
      probing = attempt;
      return attempt;
    },
    async download() {
      if (disposed) return;
      // Never join a probe: it resolves without fetching, and this call's whole
      // job is to fetch. A loop rather than one await, because a fresh probe
      // can start in the microtasks between the awaited one settling and this
      // continuation resuming. Their failures are not this call's problem.
      while (probing) await probing.catch(() => undefined);
      if (recovery) await recovery.catch(() => undefined);
      if (store.status.state === 'ready') return;
      if (downloading) return downloading;
      // Before the fetch, not after it: a reload part-way through a download
      // must come back to a download rather than to the ask, and the card the
      // learner is looking at promises exactly that ("it picks up where it left
      // off if you close the app").
      rememberDictionaryRequest();
      probedEmpty = false;
      const attempt = (async () => {
        storedOnly = false;
        try {
          await store.open();
        } finally {
          downloading = undefined;
        }
      })();
      downloading = attempt;
      return attempt;
    },
    runner: () => current,
    settled: async () => {
      await recovery;
    },
    close: async () => {
      disposed = true;
      // Every open this handle can have started, not just the recovery: a probe
      // that escalated into a download is a fetch with a worker behind it, and
      // closing over the top of one leaves that worker holding the origin's
      // only `opfs-sahpool` lock with nobody left to release it. `disposed`
      // stops a *new* one; these three wait out the ones already running.
      await recovery?.catch(() => {});
      await probing?.catch(() => {});
      await downloading?.catch(() => {});
      await store.close();
    },
  };
}
