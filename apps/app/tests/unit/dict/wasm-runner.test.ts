/**
 * The `postMessage` bridge, without a browser (docs/plans/data.md D4).
 *
 * The Playwright suite proves the OPFS store answers a real 43 MB artifact
 * correctly. It cannot easily prove the *failure* shapes, because they are
 * things a healthy worker never does: dropping a reply, answering a batch of
 * three with two result sets, dying mid-call, or answering a call whose caller
 * has already aborted. Each of those is silent — a short result array reads as
 * "no rows", a dropped reply reads as a hang — so they are driven here against a
 * hand-made worker that does exactly the wrong thing on purpose.
 *
 * The seam is `WasmRunnerOptions.spawn`, which exists for this.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DictOpenError } from '@/lib/dict/open-error';
import {
  dictionaryRequested,
  forgetDictionaryRequest,
  rememberDictionaryRequest,
} from '@/lib/dict/requested';
import { createWasmDictStore } from '@/lib/dict/wasm-store';
import { wasmRunner } from '@/lib/dict/runners/wasm';
import type { WasmRequest, WasmResponse } from '@/lib/dict/runners/wasm-protocol';

const MANIFEST = {
  file: 'dict-1-test.sqlite',
  bytes: 1024,
  sha256: 'x',
  schemaVersion: 1,
  dictVersion: 'test',
};

/**
 * A `Worker` the test drives by hand.
 *
 * `reply` is the whole point: it is what a well-behaved worker would send, and
 * every test here changes one thing about it.
 */
class FakeWorker {
  readonly sent: WasmRequest[] = [];
  terminated = false;
  #listeners = new Map<string, Set<(event: unknown) => void>>();
  /** Answers each request; return undefined to answer nothing at all. */
  answer: (request: WasmRequest) => WasmResponse | undefined = (request) =>
    request.type === 'open'
      ? {
          type: 'ok',
          id: request.id,
          value: { mode: 'opfs', downloaded: 0, imported: false, transfer: null, sqliteVersion: '3' },
        }
      : { type: 'ok', id: request.id, value: [] };

  addEventListener(type: string, listener: (event: unknown) => void): void {
    if (!this.#listeners.has(type)) this.#listeners.set(type, new Set());
    this.#listeners.get(type)!.add(listener);
  }

  postMessage(request: WasmRequest): void {
    this.sent.push(request);
    const response = this.answer(request);
    if (response) this.emit('message', { data: response });
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}

function stubManifest(body: unknown = MANIFEST, ok = true): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status: ok ? 200 : 503,
      }),
    ),
  );
}

async function runnerWith(worker: FakeWorker) {
  stubManifest();
  return wasmRunner({ spawn: () => worker as unknown as Worker });
}

/** A worker that opens cleanly and answers `SqliteDictStore.open()`'s own batch. */
function spawnReadyWorker(into: FakeWorker[]): Worker {
  const worker = new FakeWorker();
  worker.answer = (request) => {
    if (request.type === 'open') {
      return {
        type: 'ok',
        id: request.id,
        value: { mode: 'opfs', downloaded: 0, imported: false, transfer: null, sqliteVersion: '3' },
      };
    }
    if (request.type === 'query') {
      // `open()` reads `meta` and the whole `chars` table in one batch.
      return {
        type: 'ok',
        id: request.id,
        value: [
          [
            { key: 'schema_version', value: '1' },
            { key: 'dict_version', value: 'test' },
            { key: 'entry_count', value: '1' },
            { key: 'words_total_simp', value: '1' },
            { key: 'words_total_trad', value: '1' },
            { key: 'max_len_simp', value: '1' },
            { key: 'max_len_trad', value: '1' },
          ],
          [],
        ],
      };
    }
    return { type: 'ok', id: request.id, value: null };
  };
  into.push(worker);
  return worker as unknown as Worker;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the worker bridge', () => {
  it('returns one result set per batch member, in order', async () => {
    const worker = new FakeWorker();
    worker.answer = (request) =>
      request.type === 'query'
        ? { type: 'ok', id: request.id, value: request.batch.map((_, index) => [{ n: index }]) }
        : {
            type: 'ok',
            id: request.id,
            value: { mode: 'opfs', downloaded: 0, imported: false, transfer: null, sqliteVersion: '3' },
          };
    const runner = await runnerWith(worker);
    const rows = await runner.query([{ sql: 'a' }, { sql: 'b' }, { sql: 'c' }]);
    expect(rows).toEqual([[{ n: 0 }], [{ n: 1 }], [{ n: 2 }]]);
  });

  /**
   * The silent one. `SqlRunner` promises one result set per batch member, and
   * the store reads them positionally — `results[2]` is the gloss candidates.
   * A short array makes every later index shift by one and every query answer
   * silently wrong, which no assertion about *values* would catch.
   */
  it('rejects a reply whose result array is shorter than its batch', async () => {
    const worker = new FakeWorker();
    worker.answer = (request) =>
      request.type === 'query'
        ? { type: 'ok', id: request.id, value: [[{ n: 0 }]] }
        : {
            type: 'ok',
            id: request.id,
            value: { mode: 'opfs', downloaded: 0, imported: false, transfer: null, sqliteVersion: '3' },
          };
    const runner = await runnerWith(worker);
    await expect(runner.query([{ sql: 'a' }, { sql: 'b' }])).rejects.toThrow(
      /1 result sets for a batch of 2/,
    );
  });

  it('rejects a reply that is not an array at all', async () => {
    const worker = new FakeWorker();
    worker.answer = (request) =>
      request.type === 'query'
        ? { type: 'ok', id: request.id, value: { rows: [] } }
        : {
            type: 'ok',
            id: request.id,
            value: { mode: 'opfs', downloaded: 0, imported: false, transfer: null, sqliteVersion: '3' },
          };
    const runner = await runnerWith(worker);
    await expect(runner.query([{ sql: 'a' }])).rejects.toThrow(/a non-array/);
  });

  /**
   * A reply with no caller means the id space has diverged, and the caller whose
   * id went missing is waiting forever. Throwing from the listener would reach
   * `window.onerror` and settle nothing; the link kills itself instead, so every
   * pending call rejects and the store is told the connection is gone.
   */
  it('kills the link when a reply arrives that nobody asked for', async () => {
    const worker = new FakeWorker();
    stubManifest();
    const lost: string[] = [];
    const runner = await wasmRunner({
      spawn: () => worker as unknown as Worker,
      onLost: (message) => lost.push(message),
    });
    worker.answer = () => undefined; // never answers
    const stuck = runner.query([{ sql: 'a' }]);
    worker.emit('message', { data: { type: 'ok', id: 999, value: [] } });
    await expect(stuck).rejects.toThrow(/which nobody sent/);
    expect(lost.join('')).toMatch(/which nobody sent/);
  });

  /**
   * A worker that dies takes its pending calls with it. Without this the page
   * waits forever on a promise nobody will settle, and the symptom is a search
   * box that never answers rather than an error anybody can see.
   */
  it('rejects every pending call when the worker errors, and says it is lost', async () => {
    const worker = new FakeWorker();
    stubManifest();
    const lost: string[] = [];
    const runner = await wasmRunner({
      spawn: () => worker as unknown as Worker,
      onLost: (message) => lost.push(message),
    });
    worker.answer = () => undefined; // never answers
    const pending = runner.query([{ sql: 'a' }]);
    worker.emit('error', { message: 'boom' });
    await expect(pending).rejects.toThrow(/boom/);
    expect(lost).toHaveLength(1);
    // And it stays dead: a later call fails immediately rather than hanging.
    await expect(runner.query([{ sql: 'b' }])).rejects.toThrow(/boom/);
  });

  it('rejects pending calls when a message cannot be deserialised', async () => {
    const worker = new FakeWorker();
    const runner = await runnerWith(worker);
    worker.answer = () => undefined;
    const pending = runner.query([{ sql: 'a' }]);
    worker.emit('messageerror', {});
    await expect(pending).rejects.toThrow(/could not be deserialised/);
  });

  /**
   * An aborted call's reply still arrives — the worker cannot interrupt a
   * running statement — and must be dropped quietly rather than treated as the
   * id-space bug above.
   */
  it('drops the late reply to an aborted call without complaining', async () => {
    const worker = new FakeWorker();
    const runner = await runnerWith(worker);
    let held: WasmRequest | undefined;
    worker.answer = (request) => {
      held = request;
      return undefined;
    };
    const controller = new AbortController();
    const pending = runner.query([{ sql: 'a' }], controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(() =>
      worker.emit('message', { data: { type: 'ok', id: held!.id, value: [[]] } }),
    ).not.toThrow();
  });

  it('asks the worker to close before terminating it', async () => {
    const worker = new FakeWorker();
    const runner = await runnerWith(worker);
    await runner.close();
    expect(worker.sent.at(-1)?.type).toBe('close');
    expect(worker.terminated).toBe(true);
    // Idempotent, and a query after close is an error rather than a hang.
    await runner.close();
    await expect(runner.query([{ sql: 'a' }])).rejects.toThrow(/closed/);
  });

  it('carries the worker´s failure reason out as a DictOpenError', async () => {
    const worker = new FakeWorker();
    worker.answer = (request) => ({
      type: 'error',
      id: request.id,
      message: 'short',
      reason: 'download',
    });
    stubManifest();
    await expect(wasmRunner({ spawn: () => worker as unknown as Worker })).rejects.toMatchObject({
      name: 'DictOpenError',
      reason: 'download',
    });
    // The worker is not left running behind a failed open.
    expect(worker.terminated).toBe(true);
  });
});

describe('the manifest', () => {
  it('fails as a download when it cannot be fetched', async () => {
    stubManifest(MANIFEST, false);
    await expect(wasmRunner({ spawn: () => new FakeWorker() as unknown as Worker })).rejects
      .toMatchObject({ reason: 'download' });
  });

  it('fails as corrupt when it is not JSON', async () => {
    stubManifest('<html>404</html>');
    await expect(wasmRunner({ spawn: () => new FakeWorker() as unknown as Worker })).rejects
      .toMatchObject({ reason: 'corrupt' });
  });

  it('fails as corrupt when it has no file and bytes', async () => {
    stubManifest({ schemaVersion: 1 });
    await expect(wasmRunner({ spawn: () => new FakeWorker() as unknown as Worker })).rejects
      .toMatchObject({ reason: 'corrupt' });
  });

  it('is a DictOpenError, so the store can pick the right words', async () => {
    stubManifest(MANIFEST, false);
    await wasmRunner({ spawn: () => new FakeWorker() as unknown as Worker }).catch(
      (error: unknown) => {
        expect(error).toBeInstanceOf(DictOpenError);
      },
    );
  });
});

describe('the store around it', () => {
  /**
   * Eviction recovery, without OPFS: the worker says `lost`, and the store goes
   * `ready` → `absent` → `preparing` → `ready` on its own. The Playwright suite
   * proves the same thing against a real pool; this proves the wiring, which is
   * the half that can break without anybody noticing until a device is evicted.
   */
  it('closes and reopens when the worker reports the database lost', async () => {
    const workers: FakeWorker[] = [];
    stubManifest();
    const handle = createWasmDictStore({ spawn: () => spawnReadyWorker(workers) });
    const states: string[] = [];
    handle.store.subscribe((status) => states.push(status.state));
    await handle.store.open();
    expect(handle.store.status).toEqual({ state: 'ready', version: 'test' });

    workers[0].emit('message', { data: { type: 'lost', message: 'evicted' } });
    await handle.settled();
    expect(states).toEqual(['preparing', 'ready', 'absent', 'preparing', 'ready']);
    // A *new* worker, because the old one's pool handles are gone with it.
    expect(workers).toHaveLength(2);
    await handle.close();
  });

  /**
   * Tearing the store down while an eviction is starting a recovery.
   *
   * **What this pins is the outcome, and the mechanism is worth stating because
   * it is not the `disposed` flag.** `handle.close()` awaits the in-flight
   * recovery before closing, so even a recovery that reopens is closed again
   * afterwards; mutating either `disposed` check leaves this test green. The
   * flag is what stops the recovery doing 43 MB of pointless work in between,
   * and what stops a `lost` arriving *after* the teardown from starting one.
   *
   * The case this does **not** cover, recorded rather than hidden: a caller that
   * reaches past the handle and calls `store.close()` directly, mid-recovery,
   * can have its close undone by the recovery's `open()`. The handle's `close()`
   * is the teardown API for exactly that reason — `browser-store.ts` will hold
   * the handle, not the store — and there is no live caller of the other shape.
   */
  it('a close during a recovery leaves no worker running', async () => {
    const workers: FakeWorker[] = [];
    stubManifest();
    const handle = createWasmDictStore({ spawn: () => spawnReadyWorker(workers) });
    await handle.store.open();
    expect(handle.store.status.state).toBe('ready');

    workers[0].emit('message', { data: { type: 'lost', message: 'evicted' } });
    await handle.close();
    await handle.settled();
    expect(handle.store.status.state).toBe('absent');
    expect(workers.filter((worker) => !worker.terminated)).toHaveLength(0);
  });

  /**
   * The inbound half of the status model.
   *
   * `DictStatus.preparing` carries `received`/`total` so `core.md` can draw a
   * determinate bar in front of a 43 MB first load, and the only party that
   * knows those numbers is the runner doing the fetching. Before D4 `connect()`
   * took no argument at all and a web open was an indeterminate spinner.
   */
  it('reports download progress through the preparing status', async () => {
    stubManifest();
    const statuses: unknown[] = [];
    let worker!: FakeWorker;
    const handle = createWasmDictStore({
      spawn: () => {
        worker = new FakeWorker();
        worker.answer = (request) => {
          if (request.type === 'open') {
            worker.emit('message', { data: { type: 'progress', received: 10, total: 100 } });
            worker.emit('message', { data: { type: 'progress', received: 100, total: 100 } });
            return {
              type: 'ok',
              id: request.id,
              value: { mode: 'opfs', downloaded: 100, imported: true, transfer: null, sqliteVersion: '3' },
            };
          }
          return { type: 'error', id: request.id, message: 'stop here', reason: 'corrupt' };
        };
        return worker as unknown as Worker;
      },
    });
    handle.store.subscribe((status) => statuses.push(status));
    // The open fails at the `meta` read, deliberately: this test is about what
    // the status carried on the way, not about a successful open.
    await expect(handle.store.open()).rejects.toThrow(/stop here/);
    expect(statuses).toContainEqual({ state: 'preparing', received: 10, total: 100 });
    expect(statuses).toContainEqual({ state: 'preparing', received: 100, total: 100 });
    // …and a late chunk after the attempt settled must not drag it back.
    const settled = statuses.length;
    worker.emit('message', { data: { type: 'progress', received: 50, total: 100 } });
    expect(statuses).toHaveLength(settled);
  });

  /**
   * The guard on `recover()`. A worker that dies *during* an open reports
   * `lost` — the same message an eviction sends — and without the `ready` guard
   * the store would close and reopen against a worker that is going to die the
   * same way, on a failure it has already reported.
   */
  it('does not reopen when the worker dies during the first open', async () => {
    const workers: FakeWorker[] = [];
    stubManifest();
    const handle = createWasmDictStore({
      spawn: () => {
        const worker = new FakeWorker();
        worker.answer = () => undefined; // never answers
        workers.push(worker);
        // The worker dies as soon as the open request reaches it.
        queueMicrotask(() => worker.emit('error', { message: 'worker gone' }));
        return worker as unknown as Worker;
      },
    });
    await expect(handle.store.open()).rejects.toThrow(/worker gone/);
    await handle.settled();
    expect(handle.store.status).toMatchObject({ state: 'failed' });
    expect(workers, 'the store reopened against a worker that had just died').toHaveLength(1);
  });

  /**
   * **The two-phase open**, which is the whole of the fix for `data.md` D6's one
   * shipped defect.
   *
   * `<DictGate>`'s mount used to call `store.open()`, and once D6 pointed the
   * app at the OPFS store that line meant *fetch 43 MB* — with no ask, and from
   * `lib/lists/entry-source.ts` as well, which is not behind any gate. The
   * mount is `openStored()` now. Asserted here rather than only in Playwright
   * because the interesting half is which bytes were asked for, and `fetch` is
   * a spy in this file.
   */
  describe('the two-phase open', () => {
    // The ask is once **per origin** and the record of it is `localStorage`
    // (`lib/dict/requested.ts`), which jsdom shares across tests in a file.
    // Every case here says for itself whether this origin has consented.
    beforeEach(() => forgetDictionaryRequest());
    afterEach(() => forgetDictionaryRequest());

    /**
     * A worker that opens only when it is handed a manifest — an origin with
     * nothing stored, which is what a fresh install is.
     */
    function spawnEmptyOrigin(into: FakeWorker[]): Worker {
      const worker = spawnReadyWorker(into);
      const fake = into[into.length - 1];
      const base = fake.answer;
      fake.answer = (request) =>
        request.type === 'open' && request.manifest === null
          ? { type: 'error', id: request.id, message: 'nothing stored', reason: 'import' }
          : base(request);
      return worker;
    }

    it('openStored() fetches nothing and leaves an empty origin in `absent`', async () => {
      const workers: FakeWorker[] = [];
      stubManifest();
      const handle = createWasmDictStore({ spawn: () => spawnEmptyOrigin(workers) });
      const seen: string[] = [];
      handle.store.subscribe((status) => seen.push(status.state));

      await handle.openStored();

      // `absent` is the ask, and it is a state rather than an error: nothing
      // rejected, and the screen with the size on it is what the gate draws.
      expect(handle.store.status).toEqual({ state: 'absent' });
      // Not even the manifest. This is the assertion the defect would fail.
      expect(globalThis.fetch).not.toHaveBeenCalled();
      // And it said nothing on the way: no `preparing` card over a fetch that
      // is not happening, and no `failed` card for a question, not an error.
      // `close()`'s own `absent` is the only transition a probe may publish.
      expect(seen.filter((state) => state !== 'absent')).toEqual([]);
      await handle.close();
    });

    it('a probe that has found nothing does not look again', async () => {
      const workers: FakeWorker[] = [];
      stubManifest();
      const handle = createWasmDictStore({ spawn: () => spawnEmptyOrigin(workers) });

      await handle.openStored();
      await handle.openStored();
      await handle.openStored();

      // One worker for three probes. `openStored()` is called from a mount
      // effect and from `openDictStore()`, which the lists page calls per band
      // and the card back calls per card; a fresh install would otherwise spend
      // a worker, a wasm boot and a pool install to re-learn the same "no".
      expect(workers).toHaveLength(1);
      expect(handle.store.status).toEqual({ state: 'absent' });
      await handle.close();
    });

    /**
     * **The ask is once per origin**, and this is the case that rule exists
     * for: a second tab cannot take `opfs-sahpool`'s exclusive handles, so its
     * probe fails exactly as a fresh install's does. Asking again would be
     * asking twice for something the learner has already paid for — the same
     * reasoning `recover()` above already applies to an eviction.
     */
    it('an origin that has already said yes gets a full open, not the ask', async () => {
      const workers: FakeWorker[] = [];
      stubManifest();
      rememberDictionaryRequest();
      const handle = createWasmDictStore({ spawn: () => spawnEmptyOrigin(workers) });

      await handle.openStored();

      expect(handle.store.status).toEqual({ state: 'ready', version: 'test' });
      expect(globalThis.fetch).toHaveBeenCalled();
      await handle.close();
    });

    it('download() records the ask before it fetches, not after', async () => {
      const workers: FakeWorker[] = [];
      stubManifest();
      const handle = createWasmDictStore({
        spawn: () => {
          // Fails, so nothing is stored and nothing succeeded — and the record
          // must still be there, because a reload part-way through a download
          // has to come back to a download rather than to the ask.
          const worker = new FakeWorker();
          worker.answer = (request) => ({
            type: 'error',
            id: request.id,
            message: 'the connection dropped',
            reason: 'download',
          });
          workers.push(worker);
          return worker as unknown as Worker;
        },
      });

      await expect(handle.download()).rejects.toThrow(/connection dropped/);
      expect(dictionaryRequested()).toBe(true);
      await handle.close();
    });

    it('download() is the full open, and it is what the ask reaches', async () => {
      const workers: FakeWorker[] = [];
      stubManifest();
      const handle = createWasmDictStore({ spawn: () => spawnEmptyOrigin(workers) });

      await handle.openStored();
      expect(handle.store.status.state).toBe('absent');

      await handle.download();

      expect(handle.store.status).toEqual({ state: 'ready', version: 'test' });
      expect(globalThis.fetch).toHaveBeenCalled();
      await handle.close();
    });

    it('openStored() over a dictionary that is already there costs nothing', async () => {
      const workers: FakeWorker[] = [];
      stubManifest();
      const handle = createWasmDictStore({ spawn: () => spawnReadyWorker(workers) });

      await handle.download();
      expect(handle.store.status.state).toBe('ready');

      await handle.openStored();

      // One worker, one open: a returning learner's every later mount is free.
      expect(workers).toHaveLength(1);
      expect(handle.store.status).toEqual({ state: 'ready', version: 'test' });
      await handle.close();
    });

    /**
     * **The race the split creates.** `SqliteDictStore.open()` shares one
     * in-flight attempt across every caller, which is right within a kind of
     * open and wrong across them: a `download()` that simply awaited `open()`
     * while a probe was out would join the probe, resolve when the probe
     * resolved, and fetch nothing — the learner presses "Get it" and lands back
     * on the same card.
     */
    it('a download asked for during a probe still downloads', async () => {
      const workers: FakeWorker[] = [];
      stubManifest();
      let held: WasmRequest | undefined;
      const handle = createWasmDictStore({
        spawn: () => {
          const worker = spawnEmptyOrigin(workers);
          const fake = workers[workers.length - 1];
          const base = fake.answer;
          fake.answer = (request) => {
            // Hold the probe open, so the press below really does land while it
            // is still out rather than after it.
            if (request.type === 'open' && request.manifest === null) {
              held = request;
              return undefined;
            }
            return base(request);
          };
          return worker;
        },
      });

      const probe = handle.openStored();
      const download = handle.download();

      // …and now the probe answers: there was nothing stored after all.
      workers[0].emit('message', {
        data: { type: 'error', id: held!.id, message: 'nothing stored', reason: 'import' },
      });
      await probe;
      await download;

      expect(handle.store.status).toEqual({ state: 'ready', version: 'test' });
      expect(globalThis.fetch).toHaveBeenCalled();
      await handle.close();
    });

    it('a probe asked for during a download joins it rather than racing it', async () => {
      const workers: FakeWorker[] = [];
      stubManifest();
      const handle = createWasmDictStore({ spawn: () => spawnReadyWorker(workers) });

      const download = handle.download();
      const probe = handle.openStored();
      await Promise.all([download, probe]);

      // One worker: the probe did not start a second open, and — the thing that
      // would actually hurt — it did not close the download's store behind it.
      expect(workers).toHaveLength(1);
      expect(handle.store.status).toEqual({ state: 'ready', version: 'test' });
      await handle.close();
    });

    it('a probe leaves a settled failure, and its message, alone', async () => {
      const workers: FakeWorker[] = [];
      stubManifest();
      const handle = createWasmDictStore({
        spawn: () => {
          const worker = new FakeWorker();
          worker.answer = (request) => ({
            type: 'error',
            id: request.id,
            message: 'no storage',
            reason: 'storage',
          });
          workers.push(worker);
          return worker as unknown as Worker;
        },
      });

      await expect(handle.download()).rejects.toThrow(/no storage/);
      expect(handle.store.status).toMatchObject({ state: 'failed', reason: 'storage' });

      // An ungated caller mounting a moment later — the Practice queue's draw,
      // a card back — must not replace the reason on screen with a bare ask.
      await handle.openStored();
      expect(handle.store.status).toMatchObject({ state: 'failed', reason: 'storage' });
      expect(workers).toHaveLength(1);
      await handle.close();
    });
  });

  it('does not chase a worker that reports a failure reason on open', async () => {
    const workers: FakeWorker[] = [];
    stubManifest();
    const handle = createWasmDictStore({
      spawn: () => {
        const worker = new FakeWorker();
        worker.answer = (request) => ({
          type: 'error',
          id: request.id,
          message: 'no storage',
          reason: 'storage',
        });
        workers.push(worker);
        return worker as unknown as Worker;
      },
    });
    await expect(handle.store.open()).rejects.toThrow(/no storage/);
    expect(handle.store.status).toMatchObject({ state: 'failed', reason: 'storage' });
    // One attempt, not a reopen loop: the failure has already been reported and
    // the retry is the caller's to ask for.
    expect(workers).toHaveLength(1);
  });
});
