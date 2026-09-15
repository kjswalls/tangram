/**
 * What the main thread and the OPFS worker say to each other (docs/plans/data.md D4).
 *
 * A third module rather than types inside `wasm.ts`, for one reason: the worker
 * would otherwise have to import the main-thread runner to name a message, and
 * an accidental value import there pulls `SqliteDictStore` and everything under
 * it into the worker bundle. Everything here is `type`-only and erases at
 * compile, so `import type { … } from './wasm-protocol'` costs the worker
 * nothing.
 *
 * Every request carries an `id` and every reply names it. A reply with no
 * matching pending call is dropped loudly (`wasm.ts`), because the failure this
 * protocol is most likely to have is a result going to the wrong caller — the
 * `SqlRunner` contract is "the results come back in the same order as the batch"
 * and a batch whose result array is a different length is a silent wrong answer.
 */
import type { DictManifest } from '../artifact';
import type { DictFailureReason } from '../open-error';
import type { SqlQuery, SqlValue } from '../sql';

/** Which rung of D4's fallback ladder the worker ended up on. */
export type DictStorageMode = 'opfs' | 'memory';

export interface OpenRequest {
  type: 'open';
  id: number;
  /** The manifest as fetched; `bytes` is the truncation check and `file` the cache key. */
  manifest: DictManifest;
  /** Where the `.sqlite` is. Absolute or same-origin relative. */
  url: string;
  /**
   * Tests only: skip `opfs-sahpool` and go straight to the in-memory rung, so
   * the fallback can be exercised without a second tab.
   */
  forceMemory?: boolean;
}

export type WasmRequest =
  | OpenRequest
  | { type: 'query'; id: number; batch: readonly SqlQuery[] }
  /** `PRAGMA integrity_check`, timed. D4 criterion 7 — not on any hot path. */
  | { type: 'integrity'; id: number }
  /** Tests only: drop the artifact out of the pool, as an eviction would. */
  | { type: 'evict'; id: number }
  | { type: 'close'; id: number };

/**
 * What the network actually cost, read off the **worker's own** resource
 * timeline.
 *
 * It has to be the worker's, and that is the trap this field exists to close:
 * the fetch happens inside the worker, so `performance.getEntriesByType`
 * on the *page* returns nothing for the artifact — and a criterion that sums an
 * empty list reports zero bytes transferred and reads as "the cache served it".
 * `transferSize` of 0 with a non-zero `decodedBodySize` is a cache hit; equal to
 * `encodedBodySize` plus headers is a real download.
 */
export interface TransferTiming {
  transferSize: number;
  encodedBodySize: number;
  decodedBodySize: number;
  durationMs: number;
}

export interface OpenReport {
  mode: DictStorageMode;
  /** Bytes read out of the response body. 0 when the pool already had the file. */
  downloaded: number;
  /** Whether this open had to fetch the artifact at all. */
  imported: boolean;
  /** Null when nothing was fetched, or when the entry could not be found. */
  transfer: TransferTiming | null;
  sqliteVersion: string;
}

export interface IntegrityReport {
  ms: number;
  /** SQLite's own answer. `['ok']` on a healthy file. */
  rows: string[];
}

export type WasmResponse =
  /** Unsolicited, during an import. `total` is the manifest's `bytes`. */
  | { type: 'progress'; received: number; total: number }
  /**
   * Unsolicited. `opfs-sahpool` could not be installed — no OPFS, no sync access
   * handles, or (the common one) a second tab against the pool's exclusive
   * per-origin lock. The open then continues on the in-memory rung; this is how
   * the page and the phase writeup learn which rung answered.
   */
  | { type: 'unavailable'; message: string }
  /**
   * Unsolicited. The database this worker was answering from is gone — evicted,
   * unlinked, or its handle revoked. The main thread closes and re-opens the
   * store, which is what puts the banner back through `preparing` → `ready`.
   */
  | { type: 'lost'; message: string }
  | { type: 'ok'; id: number; value: unknown }
  | { type: 'error'; id: number; message: string; reason: DictFailureReason };

/** Rows come back exactly as `SqlRunner` promises: one array per batch member. */
export type QueryReply = Record<string, SqlValue>[][];
