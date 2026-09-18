/**
 * The OPFS dictionary, at its own URL, driven from the console
 * (docs/plans/data.md D4).
 *
 * D4's eight criteria are about a real browser opening a real 43 MB artifact:
 * the same query answers as the Node runner, the latency of the calls D2 and D3
 * measured natively, a reload that fetches nothing, an eviction mid-session, a
 * second tab, three flavours of a broken download, `PRAGMA integrity_check`
 * timed in wasm, and `decomp.json` staying unfetched until something asks for
 * it. None of that can be asserted from Node, and none of it needs the app
 * booted around it — so this is a standalone page in the same shape as
 * `core.md` C5a's drag-select harness: outside `<Root>`, no providers, no
 * dictionary already open.
 *
 * Everything is driven through `window.__dictWasm`, which Playwright calls with
 * `page.evaluate`. The page renders the status so a person can open it too — the
 * harness is meant to be usable by the owner and by an adversarial reviewer, not
 * only by a spec file.
 *
 * **Dev and `--mode e2e` only**, by the same build-mode guard the gallery uses
 * (`src/routes.tsx`); `tests/e2e/core/gallery-excluded.spec.ts` proves this
 * module is absent from a production bundle. It does **not** prove the wasm
 * binary is, and it is not: Vite emits a worker referenced by
 * `new Worker(new URL(...))` at transform time, so `sqlite3.wasm` and the worker
 * chunk land in `dist/` whether or not anything reaches them. That spec says so
 * in a comment and HANDOFF.md carries the numbers — 1.31 MB of `dist/` a
 * production page never fetches.
 */
import { useEffect, useRef, useState } from 'react';

import { JsonDecompStore } from '@/lib/dict/decomp-json';
import { createWasmDictStore, type WasmDictStoreHandle } from '@/lib/dict/wasm-store';
import type { IntegrityReport, OpenReport } from '@/lib/dict/runners/wasm-protocol';
import type { DictStatus } from '@/lib/dict/store';
import type { SearchOptions } from '@/lib/dict/search';
import type { SegmentOptions } from '@/lib/dict/segment';
import type { DictEntry } from '@/lib/dict/types';
import type { HskBand } from '@/lib/types';

/**
 * The root element's `data-testid`, exported so
 * `tests/e2e/core/gallery-excluded.spec.ts` can grep a production bundle for it.
 *
 * A rendered marker rather than the route path, for the reason that spec records
 * in full: the route table carries its own `'/dict-wasm'` literal, so an
 * exported path constant nothing reads is shaken out of the bundle and the
 * negative test then tracks the route table instead of the harness module. A
 * marker the harness renders cannot be shaken out while the harness ships.
 */
export const DICT_HARNESS_MARKER = 'dict-wasm-harness';
export const DICT_HARNESS_PATH = '/dict-wasm';

export interface OpenOptions {
  manifestUrl?: string;
  artifactUrl?: string;
  forceMemory?: boolean;
  /**
   * 0 disables the store's result cache, which is what the latency table needs:
   * with it on, the second run of the same query is a Map lookup and the number
   * measures the cache rather than SQLite.
   */
  cacheSize?: number;
}

export interface DictWasmHarness {
  /** Build a fresh store and open it. Resolves with how the open went. */
  open(options?: OpenOptions): Promise<
    { ok: true; report: OpenReport } | { ok: false; status: DictStatus }
  >;
  status(): DictStatus;
  /** Every status this harness has seen since the last `open()`, oldest first. */
  statuses(): DictStatus[];
  search(query: string, options?: SearchOptions): Promise<unknown>;
  entries(ids: string[]): Promise<unknown>;
  segment(text: string, options?: SegmentOptions): Promise<unknown>;
  hskBand(band: HskBand, options?: { limit?: number; offset?: number }): Promise<unknown>;
  readingCount(simp: string): Promise<number>;
  wordsContaining(
    ch: string,
    options?: { script?: 'simp' | 'trad'; limit?: number },
  ): Promise<unknown>;
  /** The names `time()` accepts, in report order. */
  timed(): string[];
  /** Mean milliseconds over `runs`, after one warm-up. Criterion 2. */
  time(call: string, runs?: number): Promise<number>;
  /**
   * One batch straight at the `SqlRunner`, timed. This is how criterion 2's
   * number is taken apart when it comes out large: it separates SQLite plus the
   * `postMessage` bridge from the ranking that runs above them.
   */
  timeSql(
    batch: { sql: string; params?: (string | number | null)[] }[],
    runs?: number,
  ): Promise<{ ms: number; rows: number[] }>;
  /** One batch straight at the `SqlRunner`, answered. The same measuring tool. */
  sql(batch: { sql: string; params?: (string | number | null)[] }[]): Promise<unknown[][]>;
  integrityCheck(): Promise<IntegrityReport>;
  /** Drop the artifact out of the pool, as an eviction would. Criterion 4. */
  evict(): Promise<void>;
  /** Resolves once a recovery started by `evict()` has finished. */
  settled(): Promise<void>;
  decompose(chars: string): Promise<unknown>;
  /** Whether `decomp.json` has been asked for yet. Criterion 8. */
  decompFetched(): boolean;
  /** What this page actually pulled over the network for the artifact. */
  transferred(): { name: string; transferSize: number; encodedBodySize: number }[];
  close(): Promise<void>;
}

declare global {
  interface Window {
    __dictWasm?: DictWasmHarness;
  }
}

/** 77 hanzi — the passage length D3 measured its candidate fetch against. */
export const PARAGRAPH =
  '我打算明天去北京看朋友。他有意见，所以我们研究生命的起源。中华人民共和国的首都是北京，' +
  '我随便看看这本书，把手表放在桌子上，然后就回家了。今天天气很好，适合出去走走。';

interface TimedCall {
  /** Not measured. Fetches whatever the call needs as an argument. */
  prepare?: (handle: WasmDictStoreHandle) => Promise<void>;
  run: (handle: WasmDictStoreHandle) => Promise<unknown>;
}

/**
 * Every call D2 and D3 put a native number against, so D4's table sits beside
 * theirs row for row and STACK known-unknown #10's "2–5× native" becomes a
 * measurement rather than an extrapolation.
 */
let fiftyIds: string[] = [];

const TIMED: Record<string, TimedCall> = {
  "search('打算') — hanzi exact": { run: (h) => h.store.search('打算') },
  "search('打') — hanzi prefix, LIMIT 400/script": { run: (h) => h.store.search('打') },
  "search('中') — hanzi prefix, LIMIT 400/script": { run: (h) => h.store.search('中') },
  "search('dasuan') — pinyin exact": { run: (h) => h.store.search('dasuan') },
  "search('da3suan4') — pinyin exact, toned": { run: (h) => h.store.search('da3suan4') },
  "search('da') — pinyin prefix, LIMIT 600": { run: (h) => h.store.search('da') },
  "search('plan') — gloss FTS5, cap 5000": { run: (h) => h.store.search('plan') },
  "search('to plan') — two terms": { run: (h) => h.store.search('to plan') },
  "search('to') — 31,561 postings, over the 5,000 cap": { run: (h) => h.store.search('to') },
  "search('the') — over the 5,000 cap": { run: (h) => h.store.search('the') },
  'segment(77 hanzi)': { run: (h) => h.store.segment(PARAGRAPH) },
  'entries(50 ids)': {
    prepare: async (h) => {
      const band = (await h.store.hskBand(1, { limit: 50 })) as DictEntry[];
      fiftyIds = band.map((entry) => entry.id);
    },
    run: (h) => h.store.entries(fiftyIds),
  },
  'hskBand(1) — the whole band': { run: (h) => h.store.hskBand(1) },
  'hskBand(7, {limit:50, offset:100})': {
    run: (h) => h.store.hskBand(7, { limit: 50, offset: 100 }),
  },
  "readingCount('看')": { run: (h) => h.store.readingCount('看') },
  "wordsContaining('算', {limit:50})": {
    run: (h) => h.store.wordsContaining('算', { limit: 50 }),
  },
};

export function DictWasmHarness() {
  const handleRef = useRef<WasmDictStoreHandle | undefined>(undefined);
  /**
   * Built eagerly, and that is the point: a lazily-constructed store would make
   * `decompFetched()` return false before the first `decompose()` call whatever
   * the store did, so criterion 8's "nothing has been fetched yet" assertion
   * could not fail. Constructing it costs nothing — `JsonDecompStore` fetches on
   * first use, which is the property under test.
   */
  const decompRef = useRef<JsonDecompStore>(new JsonDecompStore());
  const seen = useRef<DictStatus[]>([]);
  const [status, setStatus] = useState<DictStatus>({ state: 'absent' });
  const [note, setNote] = useState('idle');

  useEffect(() => {
    const api: DictWasmHarness = {
      async open(options = {}) {
        // A fresh store per call, because most of the criteria are about what a
        // *cold* open does. Anything left over is closed first, which also
        // releases the pool's exclusive handles.
        await handleRef.current?.close().catch(() => {});
        const handle = createWasmDictStore({
          ...(options.manifestUrl === undefined ? {} : { manifestUrl: options.manifestUrl }),
          ...(options.artifactUrl === undefined
            ? {}
            : { artifactUrl: () => options.artifactUrl as string }),
          ...(options.forceMemory === undefined ? {} : { forceMemory: options.forceMemory }),
          ...(options.cacheSize === undefined ? {} : { cacheSize: options.cacheSize }),
          onLost: (message) => setNote(`lost: ${message}`),
          onUnavailable: (message) => setNote(`opfs unavailable: ${message}`),
        });
        handleRef.current = handle;
        seen.current = [handle.store.status];
        setStatus(handle.store.status);
        handle.store.subscribe((next) => {
          seen.current = [...seen.current, next];
          setStatus(next);
        });
        try {
          await handle.store.open();
        } catch {
          return { ok: false, status: handle.store.status };
        }
        const report = handle.runner()?.report;
        if (!report) return { ok: false, status: handle.store.status };
        return { ok: true, report };
      },
      status: () => handleRef.current?.store.status ?? { state: 'absent' },
      statuses: () => seen.current,
      search: (query, options) => open_().store.search(query, options),
      entries: (ids) => open_().store.entries(ids),
      segment: (text, options) => open_().store.segment(text, options),
      hskBand: (band, options) => open_().store.hskBand(band, options),
      readingCount: (simp) => open_().store.readingCount(simp),
      wordsContaining: (ch, options) => open_().store.wordsContaining(ch, options),
      timed: () => Object.keys(TIMED),
      async time(call, runs = 10) {
        const handle = open_();
        const timed = TIMED[call];
        if (!timed) throw new Error(`no timed call named ${call}`);
        await timed.prepare?.(handle);
        // One warm-up so the number is the steady state a learner's second
        // keystroke sees, not the first statement preparation. The spec opens
        // this store with `cacheSize: 0`, so every run below really executes.
        await timed.run(handle);
        const times: number[] = [];
        for (let index = 0; index < runs; index += 1) {
          const started = performance.now();
          await timed.run(handle);
          times.push(performance.now() - started);
        }
        return times.reduce((total, one) => total + one, 0) / times.length;
      },
      async timeSql(batch, runs = 5) {
        const runner = runner_();
        const first = await runner.query(batch);
        const times: number[] = [];
        for (let index = 0; index < runs; index += 1) {
          const started = performance.now();
          await runner.query(batch);
          times.push(performance.now() - started);
        }
        return {
          ms: times.reduce((total, one) => total + one, 0) / times.length,
          rows: first.map((set) => set.length),
        };
      },
      sql: (batch) => runner_().query(batch),
      integrityCheck: () => runner_().integrityCheck(),
      evict: () => runner_().evict(),
      settled: () => open_().settled(),
      decompose: (chars) => decompRef.current.decompose(chars),
      decompFetched: () => decompRef.current.fetched,
      transferred: () =>
        performance
          .getEntriesByType('resource')
          .filter((entry) => /dict-\d+-[^/]*\.sqlite/.test(entry.name))
          .map((entry) => {
            const timing = entry as PerformanceResourceTiming;
            return {
              name: timing.name,
              transferSize: timing.transferSize,
              encodedBodySize: timing.encodedBodySize,
            };
          }),
      async close() {
        // The handle's close, not the store's: it also stops a recovery that an
        // eviction may have started in the same tick.
        await handleRef.current?.close();
        handleRef.current = undefined;
      },
    };

    function open_(): WasmDictStoreHandle {
      const handle = handleRef.current;
      if (!handle) throw new Error('call window.__dictWasm.open() first');
      return handle;
    }

    function runner_() {
      const runner = open_().runner();
      if (!runner) throw new Error('the dictionary is not open');
      return runner;
    }

    window.__dictWasm = api;
    return () => {
      delete window.__dictWasm;
    };
  }, []);

  return (
    <main data-testid={DICT_HARNESS_MARKER} style={{ padding: '1.5rem', fontFamily: 'monospace' }}>
      <h1 style={{ fontSize: '1rem', fontWeight: 700 }}>data.md D4 — the OPFS dictionary</h1>
      <p data-testid="dict-wasm-status">{describe(status)}</p>
      <p data-testid="dict-wasm-note">{note}</p>
      <p>
        Drive it from the console: <code>await window.__dictWasm.open()</code>, then{' '}
        <code>await window.__dictWasm.search(&apos;打算&apos;)</code>.
      </p>
    </main>
  );
}

function describe(status: DictStatus): string {
  switch (status.state) {
    case 'preparing':
      return status.total
        ? `preparing ${Math.round(((status.received ?? 0) / status.total) * 100)}%`
        : 'preparing';
    case 'ready':
      return `ready ${status.version}`;
    case 'failed':
      return `failed (${status.reason}): ${status.message}`;
    default:
      return 'absent';
  }
}
