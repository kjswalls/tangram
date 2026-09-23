/**
 * `SqlRunner` over `sqlite-wasm` on OPFS, from the main thread (docs/plans/data.md D4).
 *
 * A `postMessage` bridge to `wasm-worker.ts` with exactly the batch-per-call
 * contract the Capacitor runner will have, so the batching discipline is
 * identical on both platforms and D2's round-trip test covers both. Nothing
 * here knows any SQL.
 *
 * Two properties this file exists to guarantee, because both failure modes are
 * silent:
 *
 *  1. **No reply is ever dropped or delivered to the wrong caller.** Every
 *     request carries an id; a reply with no pending call is reported rather
 *     than ignored; and a `query` reply whose result array is a different length
 *     than its batch is rejected, because `SqlRunner`'s promise is one result
 *     set per batch member in order and a short array would read as "no rows".
 *  2. **A worker that dies takes its pending calls with it.** `error`,
 *     `messageerror` and the worker's own unhandled rejections all reject
 *     everything outstanding; without that the page waits forever on a promise
 *     nobody will settle.
 */
import { MANIFEST_FILE, type DictManifest } from '../artifact';
import { assetUrl } from '../asset-url';
import { engineMessage, refusedMessage, servedPageMessage } from '../failure';
import { DictOpenError } from '../open-error';
import type { SqlQuery, SqlRunner, SqlValue } from '../sql';
import type {
  IntegrityReport,
  OpenReport,
  QueryReply,
  WasmRequest,
  WasmResponse,
} from './wasm-protocol';

/** Where W2's build copies the artifacts: the root of the output, under their own names. */
export const DEFAULT_MANIFEST_URL = assetUrl(MANIFEST_FILE);

export interface WasmRunnerOptions {
  /** The pointer at the artifact's content-addressed filename. Never immutable. */
  manifestUrl?: string;
  /**
   * Open only what this origin has already stored, and **fetch nothing**.
   *
   * The same path a lost network takes (see `fetchManifest`), reached on
   * purpose: `components/dict/dict-status.tsx` says an `absent` dictionary is
   * "an explicit ask, with the size in it … a silent 14 MB download on a
   * metered connection is a hostile default", and `data.md` D6 is what made
   * `<DictGate>`'s mount-time `open()` mean *download* rather than *probe*.
   * With this set, the mount attempt costs nothing and either finds a
   * dictionary or leaves the learner the ask.
   */
  storedOnly?: boolean;
  /** Overrides where the `.sqlite` itself is fetched from. Tests use it. */
  artifactUrl?: (manifest: DictManifest) => string;
  /** Download/import progress, so the banner can draw a determinate bar. */
  onProgress?: (received: number, total: number) => void;
  /** Which rung answered, and what it cost. Called once per successful open. */
  onOpen?: (report: OpenReport) => void;
  /** `opfs-sahpool` was not available; the open continued in memory. */
  onUnavailable?: (message: string) => void;
  /** The database went away under a live session. The caller reopens. */
  onLost?: (message: string) => void;
  /** Tests only: skip the OPFS rung entirely. */
  forceMemory?: boolean;
  /** Tests only, and the seam that keeps this file free of `import.meta.url`. */
  spawn?: () => Worker;
}

/** What a `SqlRunner` over the worker can also do, for the phase's measurements. */
export interface WasmSqlRunner extends SqlRunner {
  readonly report: OpenReport;
  /** `PRAGMA integrity_check`, timed in wasm. D4 criterion 7. */
  integrityCheck(): Promise<IntegrityReport>;
  /** Tests only: drop the artifact out of the pool, as an eviction would. */
  evict(): Promise<void>;
}

function spawnWorker(): Worker {
  // `new URL(..., import.meta.url)` is the form Vite compiles into a worker
  // chunk; a computed specifier would be left as a runtime URL and 404 in the
  // build. `type: 'module'` because the worker imports `@sqlite.org/sqlite-wasm`.
  return new Worker(new URL('./wasm-worker.ts', import.meta.url), {
    type: 'module',
    name: 'tangram-dict',
  });
}

/**
 * A request as the caller writes it, before the link stamps an id on it.
 *
 * Distributive on purpose: a plain `Omit<WasmRequest, 'id'>` over a union
 * collapses to the members' *common* keys, so `manifest` and `batch` stop
 * existing and every call site becomes an excess-property error.
 */
type Unsent<T> = T extends { id: number } ? Omit<T, 'id'> : never;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

class WorkerLink {
  readonly #worker: Worker;
  readonly #options: WasmRunnerOptions;
  readonly #pending = new Map<number, Pending>();
  /**
   * Ids whose caller aborted. The worker cannot interrupt a running statement,
   * so its reply still arrives; it is dropped here rather than treated as the
   * id-space bug below.
   */
  readonly #abandoned = new Set<number>();
  #nextId = 1;
  #dead: Error | undefined;

  constructor(options: WasmRunnerOptions) {
    this.#options = options;
    this.#worker = (options.spawn ?? spawnWorker)();
    this.#worker.addEventListener('message', (event: MessageEvent<WasmResponse>) => {
      this.#receive(event.data);
    });
    this.#worker.addEventListener('error', (event) => {
      this.#die(new Error(engineMessage(`the worker failed: ${event.message || 'unknown error'}`)));
    });
    this.#worker.addEventListener('messageerror', () => {
      this.#die(new Error(engineMessage('the worker sent a message that could not be deserialised')));
    });
  }

  #receive(message: WasmResponse): void {
    switch (message.type) {
      case 'progress':
        this.#options.onProgress?.(message.received, message.total);
        return;
      case 'unavailable':
        this.#options.onUnavailable?.(message.message);
        return;
      case 'lost':
        this.#options.onLost?.(message.message);
        return;
      case 'ok':
      case 'error': {
        const pending = this.#pending.get(message.id);
        if (!pending) {
          if (this.#abandoned.delete(message.id)) return;
          // A reply with no caller and no abort behind it means the id space has
          // gone wrong, and the next symptom would be a result handed to the
          // wrong query. `throw` from here would only reach `window.onerror`:
          // nothing would be settled, no status would change, and the caller
          // whose id went missing would wait forever — which is the hang this
          // is supposed to be protecting against. `#die` is the loud version
          // that actually does something: every pending call rejects and the
          // store is told the connection is gone.
          this.#die(
            new Error(`the dictionary worker answered request ${message.id}, which nobody sent`),
          );
          return;
        }
        this.#pending.delete(message.id);
        if (message.type === 'ok') pending.resolve(message.value);
        else pending.reject(new DictOpenError(message.reason, message.message));
        return;
      }
    }
  }

  #die(error: Error): void {
    if (this.#dead) return;
    this.#dead = error;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.#options.onLost?.(error.message);
  }

  send<T>(request: Unsent<WasmRequest>, signal?: AbortSignal): Promise<T> {
    if (this.#dead) return Promise.reject(this.#dead);
    signal?.throwIfAborted();
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      // Abort drops the *caller's* interest, not the worker's work: the worker
      // has no way to interrupt a running statement, and a batch is measured in
      // single-digit milliseconds. The id moves to `#abandoned` so the reply
      // that still arrives is dropped quietly instead of resolving a promise
      // whose caller has gone.
      signal?.addEventListener(
        'abort',
        () => {
          if (!this.#pending.delete(id)) return;
          this.#abandoned.add(id);
          reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
        },
        { once: true },
      );
      this.#worker.postMessage({ ...request, id } as WasmRequest);
    });
  }

  terminate(): void {
    this.#worker.terminate();
    this.#abandoned.clear();
    if (!this.#dead) this.#dead = new Error('the dictionary connection is closed');
    for (const pending of this.#pending.values()) pending.reject(this.#dead);
    this.#pending.clear();
  }
}

/**
 * The manifest, or `null` when the **network** could not deliver one.
 *
 * The distinction between `null` and a throw is the whole of D6's offline
 * behaviour, so it is drawn here rather than sniffed at by the caller. `fetch`
 * rejects only when the request never completed — offline, DNS, a refused
 * connection — and resolves for every HTTP status. So:
 *
 * - **rejects → `null`**, and the worker opens whatever this origin already
 *   imported. A learner on a plane has a dictionary.
 * - **anything else → throw.** A 404, a body that is not JSON, JSON with no
 *   `file`: those are a deployment that is wrong, and answering them from a
 *   stale pooled artifact would hide exactly the mistake `data.md` D4 built the
 *   four failure reasons to name. `web.md` W2's SPA fallback makes the 404 case
 *   concrete — it answers a missing path with an HTML document and a 200.
 */
async function fetchManifest(url: string): Promise<DictManifest | null> {
  let response: Response;
  try {
    // `cache: 'no-cache'` mirrors the host rule (web.md W2 rule 5): the manifest
    // is the pointer at an immutable filename, so an immutably cached pointer is
    // a dictionary that can never be updated.
    response = await fetch(url, { credentials: 'same-origin', cache: 'no-cache' });
  } catch {
    return null;
  }
  if (!response.ok) {
    throw new DictOpenError('download', refusedMessage('manifest', response.status));
  }
  let manifest: DictManifest;
  try {
    manifest = (await response.json()) as DictManifest;
  } catch (error) {
    throw new DictOpenError('corrupt', servedPageMessage('manifest'), { cause: error });
  }
  if (typeof manifest?.file !== 'string' || typeof manifest?.bytes !== 'number') {
    throw new DictOpenError('corrupt', servedPageMessage('manifest-shape'));
  }
  return manifest;
}

/**
 * Open the browser's dictionary and hand back a `SqlRunner` over it.
 *
 * Every failure is a `DictOpenError` carrying one of `DictStatus`'s four
 * reasons, which is what lets `SqliteDictStore` put the right words on screen:
 * a truncated download is "try again", a file that is not this artifact is "we
 * will re-fetch it".
 */
export async function wasmRunner(options: WasmRunnerOptions = {}): Promise<WasmSqlRunner> {
  /**
   * The manifest, or `null` when the network could not give us one.
   *
   * **This is D6's acceptance criterion 3 in one branch.** The dictionary is
   * 43 MB in OPFS and the manifest is two hundred bytes served `no-cache`; the
   * only thing the manifest tells the worker is which file to import and what
   * to check the import against. Before this, an offline cold start threw here
   * and the learner had no dictionary at all — with the dictionary sitting in
   * their own browser, imported, verified and unreachable. Now the worker is
   * asked to open what the pool already holds, and only an origin that has
   * never imported one comes back `failed`.
   *
   * A **bad** manifest is still fatal, and the distinction is the point: a
   * `fetch` that rejects is the network, and every other failure — a 404, a
   * body that is not JSON, a JSON object with no `file` — is a deploy that is
   * wrong. Falling back to a stale pooled artifact on those would hide exactly
   * the mistake `data.md` D4 built the four failure reasons to name.
   */
  const manifest = options.storedOnly
    ? null
    : await fetchManifest(options.manifestUrl ?? DEFAULT_MANIFEST_URL);
  if (manifest === null && !options.storedOnly) {
    options.onUnavailable?.('the dictionary manifest could not be fetched; trying stored bytes');
  }
  const url = manifest === null ? null : options.artifactUrl?.(manifest) ?? assetUrl(manifest.file);
  const link = new WorkerLink(options);
  let report: OpenReport;
  try {
    report = await link.send<OpenReport>({
      type: 'open',
      manifest,
      url,
      ...(options.forceMemory === undefined ? {} : { forceMemory: options.forceMemory }),
    });
  } catch (error) {
    // Ask before terminating, exactly as `close()` does. A failed open can still
    // have installed the pool, and the worker releases its exclusive handles in
    // `close`; terminating without that leaves them held until the context is
    // torn down, and the retry the learner presses then falls to the in-memory
    // rung for no reason at all.
    await link.send({ type: 'close' }).catch(() => {});
    link.terminate();
    throw error;
  }
  options.onOpen?.(report);

  let closed = false;
  return {
    report,
    async query(batch: readonly SqlQuery[], signal?: AbortSignal) {
      if (closed) throw new Error('the dictionary connection is closed');
      const rows = await link.send<QueryReply>({ type: 'query', batch }, signal);
      if (!Array.isArray(rows) || rows.length !== batch.length) {
        throw new Error(
          `the dictionary worker answered ${Array.isArray(rows) ? rows.length : 'a non-array'} result sets for a batch of ${batch.length}`,
        );
      }
      return rows as Record<string, SqlValue>[][];
    },
    async integrityCheck() {
      if (closed) throw new Error('the dictionary connection is closed');
      return link.send<IntegrityReport>({ type: 'integrity' });
    },
    async evict() {
      if (closed) throw new Error('the dictionary connection is closed');
      await link.send<null>({ type: 'evict' });
    },
    async close() {
      if (closed) return;
      closed = true;
      // Ask first, terminate second. The worker releases the pool's sync access
      // handles in `close`; terminating without that leaves them held until the
      // context is torn down, and the *next* open then falls to the in-memory
      // rung for no reason at all.
      await link.send<null>({ type: 'close' }).catch(() => {});
      link.terminate();
    },
  };
}
