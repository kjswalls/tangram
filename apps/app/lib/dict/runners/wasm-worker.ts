/// <reference lib="webworker" />
/**
 * The dedicated worker that owns the browser's dictionary (docs/plans/data.md D4).
 *
 * Everything about `sqlite-wasm` lives behind this file. The main thread gets a
 * `SqlRunner` (`wasm.ts`) and never sees a `sqlite3` object, which is what keeps
 * `SqliteDictStore` identical on Node, in a browser and on a phone.
 *
 * **`opfs-sahpool`, not the `opfs` VFS and not `SharedArrayBuffer`.** The other
 * OPFS VFS proxies its synchronous I/O through `Atomics.wait` on a
 * `SharedArrayBuffer`, which needs `Cross-Origin-Opener-Policy` and
 * `Cross-Origin-Embedder-Policy` on every response — headers a static host may
 * not offer and a Capacitor WebView cannot set at all (Capacitor #7813, closed
 * "not planned"). `opfs-sahpool` holds its own `FileSystemSyncAccessHandle`s and
 * needs neither. That is the whole reason the web dictionary is possible
 * (STACK §2.5).
 *
 * **Nothing here holds 43 MB in memory on the OPFS path.** `importDb`'s chunked
 * form is fed straight from the `fetch` body's reader, so the peak is one chunk.
 * The in-memory rung is the exception and says so.
 *
 * **Integrity is two cheap checks, not a hash.** `crypto.subtle.digest` is
 * one-shot — it takes a complete buffer and has no update/finalize form — so
 * hashing the download would mean either buffering all 43 MB, defeating the
 * chunked import, or taking a streaming-hash dependency in a phase whose only
 * new dependency is `@sqlite.org/sqlite-wasm`. Instead:
 *
 *   - **truncation** — the chunk lengths are summed and compared against the
 *     manifest's `bytes`. Exact, free, and reported as `reason: 'download'`.
 *   - **corruption** — after opening, `PRAGMA application_id`, `PRAGMA
 *     user_version` and `meta.dict_version` must be this artifact's. Those read
 *     a handful of pages, and they are what D1's magic number exists for.
 *     Reported as `reason: 'corrupt'`.
 *
 * A full `PRAGMA integrity_check` reads the entire file and is not run on open;
 * D4 measures how long it takes here so that choice is informed rather than
 * assumed, and it stays available for the day a query raises `SQLITE_CORRUPT`.
 * The manifest's `sha256` remains a build-side fact that `pnpm data:verify`
 * checks.
 */
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import type {
  Database,
  PreparedStatement,
  SAHPoolUtil,
  SqlValue as WasmSqlValue,
  Sqlite3Static,
} from '@sqlite.org/sqlite-wasm';

import { APPLICATION_ID, SCHEMA_VERSION, type DictManifest } from '../artifact';
import {
  droppedMessage,
  engineMessage,
  incompleteMessage,
  offlineMessage,
  refusedMessage,
  servedPageMessage,
  unreachableMessage,
} from '../failure';
import type { DictFailureReason } from '../open-error';
import type { SqlValue } from '../sql';
import { rowReader, type RowReader } from './wasm-extract';
import type {
  IntegrityReport,
  OpenReport,
  QueryReply,
  TransferTiming,
  WasmRequest,
  WasmResponse,
} from './wasm-protocol';

/**
 * The pool's own name and, by default, its OPFS directory (`.tangram-dict`).
 *
 * Named rather than left at `opfs-sahpool` so that the app's pool cannot
 * collide with any other sqlite-wasm on the origin: two pools sharing a
 * directory is explicitly undefined behaviour in the VFS's own documentation.
 */
const VFS_NAME = 'tangram-dict';

/** Everything in the pool this app put there. Used to sweep an old version out. */
const ARTIFACT_PATTERN = /^\/dict-\d+-.*\.sqlite$/;

/**
 * The artifact's own entry on this worker's resource timeline.
 *
 * Taken after the body has been fully read, because that is when the entry is
 * added for a streamed response. `transferSize === 0` alongside a real
 * `decodedBodySize` is the browser's HTTP cache answering; anything else is
 * bytes off the wire. D4 criterion 5 turns on exactly this distinction.
 */
function transferTiming(url: string): TransferTiming | null {
  const wanted = new URL(url, self.location.href).href;
  const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
  const entry = entries.filter((one) => one.name === wanted).at(-1);
  if (!entry) return null;
  return {
    transferSize: entry.transferSize,
    encodedBodySize: entry.encodedBodySize,
    decodedBodySize: entry.decodedBodySize,
    durationMs: entry.duration,
  };
}

class WorkerOpenError extends Error {
  readonly reason: DictFailureReason;
  constructor(reason: DictFailureReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.reason = reason;
  }
}

let sqlite3: Sqlite3Static | undefined;
let pool: SAHPoolUtil | undefined;
let db: Database | undefined;
let opened: { manifest: DictManifest; name: string } | undefined;
/** Set by the test-only `evict` command; the next query reports it as a loss. */
let evicted = false;
const statements = new Map<string, Cached>();
/** Built on the first query, from whichever runtime `boot()` produced. */
let reader: RowReader | undefined;

function post(message: WasmResponse): void {
  self.postMessage(message);
}

async function boot(): Promise<Sqlite3Static> {
  try {
    sqlite3 ??= await sqlite3InitModule();
  } catch (error) {
    // A missing or unloadable `sqlite3.wasm` is a deploy problem, not a bad
    // file; unwrapped it reached the screen as `corrupt`.
    throw new WorkerOpenError('download', engineMessage(String(error)), { cause: error });
  }
  return sqlite3;
}

/**
 * One chunk of the body. A read that **rejects** is the connection dropping
 * part way through, and it is said as a download failure: unwrapped, the OPFS
 * rung took it for an import failure (and fetched all 43 MB again in memory)
 * and the memory rung let it reach the catch-all as `corrupt`.
 */
async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  received: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  try {
    return await reader.read();
  } catch (error) {
    throw new WorkerOpenError('download', droppedMessage(received, error), { cause: error });
  }
}

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

/**
 * The three checks that say "this is the dictionary the manifest names".
 *
 * Run against whichever rung opened the file, because the in-memory path can be
 * handed the same wrong bytes as the OPFS one. A missing `meta` table throws out
 * of the `SELECT` and lands here as `corrupt`, which is what a foreign database
 * is.
 */
function validate(connection: Database, manifest: DictManifest | null): void {
  /**
   * Read and check one value at a time, in cheapest-first order.
   *
   * Not "read all three, then compare all three": a database that is not this
   * artifact usually has no `meta` table at all, so the `SELECT` throws and the
   * only thing the message can say is "it did not answer". Checking as it goes
   * means the failure names `application_id` — one page, no table, the exact
   * thing D1's magic number exists for — and the message is the only evidence a
   * later reader has about *which* check caught it.
   */
  const read = (sql: string, what: string): unknown => {
    try {
      return connection.selectValue(sql);
    } catch (error) {
      throw new WorkerOpenError('corrupt', `the dictionary file has no ${what}`, { cause: error });
    }
  };
  const fail = (what: string): never => {
    throw new WorkerOpenError('corrupt', `the dictionary file is not this artifact: ${what}`);
  };

  const applicationId = read('PRAGMA application_id', 'application_id');
  if (Number(applicationId) !== APPLICATION_ID) {
    fail(`application_id is ${String(applicationId)}, expected ${APPLICATION_ID}`);
  }
  const userVersion = read('PRAGMA user_version', 'user_version');
  if (Number(userVersion) !== SCHEMA_VERSION) {
    fail(`user_version is ${String(userVersion)}, expected ${SCHEMA_VERSION}`);
  }
  const dictVersion = read(
    "SELECT value FROM meta WHERE key = 'dict_version'",
    'meta.dict_version',
  );
  // The third check needs something to check against. With no manifest — the
  // offline re-open — the row is still read, because reading it is what proves
  // there is a `meta` table at all, but there is nothing to compare it to: the
  // file came out of this origin's own pool under a name only a successful
  // import writes. `application_id` and `user_version` above still hold.
  if (manifest && dictVersion !== manifest.dictVersion) {
    fail(`meta.dict_version is ${String(dictVersion)}, the manifest says ${manifest.dictVersion}`);
  }
}

/** The `dict_version` this connection reports, for a synthesised manifest. */
function readDictVersion(connection: Database): string {
  return String(connection.selectValue("SELECT value FROM meta WHERE key = 'dict_version'") ?? '');
}

/** `SQLite format 3\0` — the first sixteen bytes of every SQLite database. */
const SQLITE_MAGIC = 'SQLite format 3\u0000';

/**
 * Reject a body that is not a database before a single byte reaches storage.
 *
 * `importDb` checks the same thing, but it reports it as an import failure, and
 * the two cases need different words on screen and different next steps.
 */
function assertSqliteHeader(chunk: Uint8Array): void {
  for (let index = 0; index < SQLITE_MAGIC.length; index += 1) {
    if (chunk[index] !== SQLITE_MAGIC.charCodeAt(index)) {
      throw new WorkerOpenError(
        'corrupt',
        servedPageMessage('file'),
      );
    }
  }
}

/**
 * Stream the artifact into the pool, one chunk at a time.
 *
 * `total` is the manifest's `bytes` rather than `Content-Length`, deliberately:
 * under content negotiation the header is the *compressed* length while
 * `response.body` yields decoded bytes, so a progress bar driven by the header
 * would run to 300%.
 */
async function importArtifact(
  target: SAHPoolUtil,
  name: string,
  url: string,
  manifest: DictManifest,
): Promise<{ downloaded: number; transfer: TransferTiming | null }> {
  let response: Response;
  try {
    response = await fetch(url, { credentials: 'same-origin' });
  } catch (error) {
    throw new WorkerOpenError('download', unreachableMessage(error), {
      cause: error,
    });
  }
  if (!response.ok) {
    throw new WorkerOpenError('download', refusedMessage('file', response.status));
  }
  if (!response.body) {
    throw new WorkerOpenError('download', 'the dictionary fetch returned no body to stream');
  }
  const reader = response.body.getReader();
  let received = 0;
  let checked = false;
  post({ type: 'progress', received: 0, total: manifest.bytes });
  try {
    await target.importDb(name, async () => {
      const { done, value } = await readChunk(reader, received);
      if (done || !value) return undefined;
      if (!checked && received === 0 && value.byteLength >= SQLITE_MAGIC.length) {
        checked = true;
        assertSqliteHeader(value);
      }
      received += value.byteLength;
      post({ type: 'progress', received, total: manifest.bytes });
      return value;
    });
  } catch (error) {
    await reader.cancel().catch(() => {});
    target.unlink(name);
    // A body that is not a database at all is `corrupt`, not `import`, and the
    // distinction is a deployment mistake this repo can actually make: an SPA
    // fallback answers a missing path with 200 and an HTML document, which is
    // exactly what a manifest naming a file the deploy did not carry looks like.
    // "The dictionary could not be imported" would blame the learner's storage
    // and offer the wrong remedy, and there is no point retrying those bytes in
    // memory either. Everything else — a full pool, an I/O error, quota — is
    // `import`, and the caller's ladder retries it in memory as D4's rung (a).
    if (error instanceof WorkerOpenError) throw error;
    throw new WorkerOpenError('import', `the dictionary could not be imported: ${String(error)}`, {
      cause: error,
    });
  }
  if (received !== manifest.bytes) {
    // The one truncation check, and it is exact. Unlink first: a short file left
    // in the pool under the manifest's name is one a later load would trust.
    target.unlink(name);
    throw new WorkerOpenError(
      'download',
      incompleteMessage(received, manifest.bytes),
    );
  }
  return { downloaded: received, transfer: transferTiming(url) };
}

/**
 * Install the pool, retrying briefly.
 *
 * `acquireAccessHandles` does **not** retry: it calls `createSyncAccessHandle()`
 * on every slot and throws on the first `NoModificationAllowedError`, which is
 * what a handle held elsewhere raises. That matters for one very ordinary case —
 * **a reload**. The outgoing document's worker releases its handles when its
 * context is torn down, asynchronously and with no ordering guarantee relative
 * to the new document's worker, so a plain refresh can lose the race and take
 * rung (a): a 43 MB re-download into the heap, gone again on the next reload,
 * with nothing that ever tries OPFS again. A few hundred milliseconds of retry
 * closes a window measured in milliseconds.
 *
 * A genuine second tab holds the lock for its whole session, so it pays this
 * delay before falling to memory. That is the right way round: a second tab is
 * rare and already pays a 43 MB fetch; a reload is not rare at all.
 */
/**
 * The install options, plus one the shipped typings do not declare.
 *
 * `forceReinitIfPreviouslyFailed` is documented in the package's own source and
 * implemented at runtime (`initPromises[vfsName]` is deleted when it is set),
 * but `dist/index.d.mts` 3.53.4-build1 omits it from the parameter type. A
 * widened local type rather than an `as any`: the option is real, and the day
 * the typings catch up this stops being needed rather than silently hiding a
 * mistake.
 */
type InstallOptions = Parameters<Sqlite3Static['installOpfsSAHPoolVfs']>[0] & {
  forceReinitIfPreviouslyFailed?: boolean;
};

async function installWithRetry(runtime: Sqlite3Static): Promise<SAHPoolUtil> {
  const DELAYS = [0, 60, 180];
  let last: unknown;
  for (const delay of DELAYS) {
    if (delay > 0) await new Promise((resume) => setTimeout(resume, delay));
    const options: InstallOptions = {
      name: VFS_NAME,
      // **Without this the loop is dead code**, and that is not a guess:
      // `installOpfsSAHPoolVfs` memoises its result per VFS name *including
      // rejections* (`initPromises[vfsName]`), and rethrows the cached error
      // on every later call unless told otherwise. Attempts 2 and 3 would
      // sleep and rethrow attempt 1's failure without touching OPFS.
      //
      // The library's own documentation describes this option as being for
      // "flaky environments which may mysteriously fail to permit access to
      // OPFS sync access handles on an initial attempt but permit it on a
      // second attempt", and says it "should never be used". The caution is
      // about trusting an environment that fails at random; this failure is
      // neither mysterious nor random — it is one document's worker holding
      // handles the next document's worker is asking for, and it resolves the
      // moment the first context is torn down. Retrying the first attempt is
      // pointless anyway, so it is only ever set on a retry.
      forceReinitIfPreviouslyFailed: delay > 0,
    };
    try {
      return await runtime.installOpfsSAHPoolVfs(options);
    } catch (error) {
      last = error;
    }
  }
  throw last;
}

/** The OPFS rung. Returns `undefined` when the pool itself is unavailable. */
async function openOnOpfs(
  manifest: DictManifest | null,
  url: string | null,
): Promise<
  { db: Database; downloaded: number; imported: boolean; transfer: TransferTiming | null } | undefined
> {
  const runtime = await boot();
  try {
    pool = await installWithRetry(runtime);
  } catch (error) {
    // No OPFS, no sync access handles, or — the common one — a second tab: the
    // pool takes an exclusive handle on each of its files per origin, so the
    // second holder cannot acquire them. Rung (a) handles all three the same way.
    post({ type: 'unavailable', message: `opfs-sahpool is unavailable: ${String(error)}` });
    return undefined;
  }

  if (!manifest) {
    // No manifest, so no name to look for and nothing to import: open the one
    // artifact this origin already has. More than one cannot normally exist —
    // the sweep below unlinks the others on a version bump — and if somehow two
    // do, guessing between them is worse than saying so.
    const pooled = pool.getFileNames().filter((file) => ARTIFACT_PATTERN.test(file));
    if (pooled.length !== 1) {
      releasePool();
      throw new WorkerOpenError(
        'download',
        pooled.length === 0
          ? offlineMessage('there is no dictionary in this browser yet')
          : offlineMessage(`this browser holds ${pooled.length} dictionaries`),
      );
    }
    return openPooled(pooled[0]);
  }

  const name = `/${manifest.file}`;
  const present = pool.getFileNames().includes(name);
  let downloaded = 0;
  let transfer: TransferTiming | null = null;
  if (!present) {
    // A version bump is a new filename, so the old one is dead weight holding a
    // pool slot and 43 MB of the origin's quota. Sweep before importing.
    for (const existing of pool.getFileNames()) {
      if (existing !== name && ARTIFACT_PATTERN.test(existing)) pool.unlink(existing);
    }
    try {
      ({ downloaded, transfer } = await importArtifact(pool, name, url as string, manifest));
    } catch (error) {
      // Whatever the reason, this worker is done with the pool: either the
      // caller falls to the in-memory rung or the open fails outright. Holding
      // the exclusive handles past that point is what makes the retry — and any
      // other tab — land on the memory rung for no reason.
      releasePool();
      throw error;
    }
  }

  let connection: Database;
  try {
    connection = new pool.OpfsSAHPoolDb(name);
  } catch (error) {
    pool.unlink(name);
    releasePool();
    throw new WorkerOpenError('corrupt', `the imported dictionary would not open: ${String(error)}`, {
      cause: error,
    });
  }
  try {
    validate(connection, manifest);
  } catch (error) {
    connection.close();
    // Drop it: a file that is not this artifact must not be trusted on the next
    // load either, and unlinking is what makes the retry a fresh download.
    pool.unlink(name);
    releasePool();
    throw error;
  }
  return { db: connection, downloaded, imported: !present, transfer };
}

/**
 * Open a file the pool already holds, with no manifest to check it against.
 *
 * Separate from the branch above rather than folded into it, because the two
 * differ in what happens when the file is bad: an imported file that fails
 * `validate` is unlinked, so the next load re-downloads it; this one is
 * unlinked too, and the difference is that there is nothing to re-download
 * from until the network is back. Both say `corrupt`, which is the honest
 * answer either way.
 */
async function openPooled(
  name: string,
): Promise<{ db: Database; downloaded: number; imported: boolean; transfer: TransferTiming | null }> {
  const held = pool as SAHPoolUtil;
  let connection: Database;
  try {
    connection = new held.OpfsSAHPoolDb(name);
  } catch (error) {
    held.unlink(name);
    releasePool();
    throw new WorkerOpenError('corrupt', `the stored dictionary would not open: ${String(error)}`, {
      cause: error,
    });
  }
  try {
    validate(connection, null);
  } catch (error) {
    connection.close();
    held.unlink(name);
    releasePool();
    throw error;
  }
  return { db: connection, downloaded: 0, imported: false, transfer: null };
}

/**
 * Rung (a): the whole artifact in the wasm heap, gone on reload.
 *
 * ~43 MB of heap, and it is the price of a second tab or of an origin with no
 * OPFS. The pool's exclusive lock means the bytes cannot be read back out of it
 * — the pool's on-disk layout is the VFS's own opaque format, not a plain OPFS
 * file — so this re-fetches. D4 criterion 5 measures what that actually costs
 * over the network.
 */
async function openInMemory(
  manifest: DictManifest,
  url: string,
): Promise<{ db: Database; downloaded: number; imported: boolean; transfer: TransferTiming | null }> {
  const runtime = await boot();

  /**
   * The buffer is allocated in the **wasm heap up front** and each chunk is
   * written straight into it.
   *
   * The obvious shape — `await response.arrayBuffer()` then
   * `allocFromTypedArray` — holds the artifact twice at the peak, once in the JS
   * heap and once in the wasm heap, so rung (a) costs ~86 MB rather than the
   * ~43 MB `data.md` budgets for it. On a memory-constrained WebView that is the
   * difference between the fallback working and the tab being killed. Writing
   * into the allocation as the body arrives also means this rung can report real
   * progress, which `arrayBuffer()` cannot: it is one unstreamed read, so the
   * determinate bar would sit at nothing and then jump to 100% on exactly the
   * slowest rung there is.
   */
  let pointer = 0;
  try {
    pointer = runtime.wasm.alloc(manifest.bytes);
  } catch (error) {
    throw new WorkerOpenError(
      'storage',
      `there was not enough memory for the dictionary: ${String(error)}`,
      { cause: error },
    );
  }

  let received = 0;
  try {
    let response: Response;
    try {
      response = await fetch(url, { credentials: 'same-origin' });
    } catch (error) {
      throw new WorkerOpenError('download', unreachableMessage(error), {
        cause: error,
      });
    }
    if (!response.ok) {
      throw new WorkerOpenError('download', refusedMessage('file', response.status));
    }
    if (!response.body) {
      throw new WorkerOpenError('download', 'the dictionary fetch returned no body to stream');
    }
    const reader = response.body.getReader();
    post({ type: 'progress', received: 0, total: manifest.bytes });
    for (;;) {
      const { done, value } = await readChunk(reader, received);
      if (done || !value) break;
      if (received === 0 && value.byteLength >= SQLITE_MAGIC.length) assertSqliteHeader(value);
      if (received + value.byteLength > manifest.bytes) {
      // Longer than the manifest says. Stop rather than write past the
      // allocation — the byte-count check below would catch it, but only after
      // corrupting the wasm heap.
        await reader.cancel().catch(() => {});
        received += value.byteLength;
        break;
      }
      // `heap8u()` is re-read each chunk rather than hoisted: a `Uint8Array` over
      // the wasm memory is detached the moment that memory grows, and a view
      // captured before the loop would silently write into a dead buffer.
      runtime.wasm.heap8u().set(value, pointer + received);
      received += value.byteLength;
      post({ type: 'progress', received, total: manifest.bytes });
    }
    if (received !== manifest.bytes) {
      throw new WorkerOpenError(
        'download',
        incompleteMessage(received, manifest.bytes),
      );
    }
  } catch (error) {
    runtime.wasm.dealloc(pointer);
    throw error;
  }
  const transfer = transferTiming(url);

  const connection = new runtime.oo1.DB(':memory:');
  const rc = runtime.capi.sqlite3_deserialize(
    connection.pointer!,
    'main',
    pointer,
    manifest.bytes,
    manifest.bytes,
    // FREEONCLOSE so the 43 MB is released with the handle — and so the
    // allocation above is SQLite's to free from here on, which is why nothing
    // below deallocs it. READONLY because the dictionary is read-only
    // everywhere and it stops SQLite trying to grow a buffer it does not own.
    runtime.capi.SQLITE_DESERIALIZE_FREEONCLOSE | runtime.capi.SQLITE_DESERIALIZE_READONLY,
  );
  if (rc !== 0) {
    // Closed, not `dealloc`ed, and deliberately. With
    // `SQLITE_DESERIALIZE_FREEONCLOSE` set, SQLite frees the buffer on its own
    // error path as well as on close, so an explicit `dealloc` here risks a
    // double free — which is worse than the alternative by a wide margin.
    // Closing covers the case where ownership did pass, and the main thread
    // terminates this worker after a failed open, which reclaims the heap
    // either way.
    connection.close();
    throw new WorkerOpenError('corrupt', `sqlite3_deserialize failed with ${String(rc)}`);
  }
  try {
    validate(connection, manifest);
  } catch (error) {
    connection.close();
    throw error;
  }
  return { db: connection, downloaded: received, imported: true, transfer };
}

async function open(
  manifest: DictManifest | null,
  url: string | null,
  forceMemory: boolean,
): Promise<OpenReport> {
  const runtime = await boot();
  let result:
    | { db: Database; downloaded: number; imported: boolean; transfer: TransferTiming | null }
    | undefined;
  let mode: 'opfs' | 'memory' = 'opfs';

  if (forceMemory) {
    if (!manifest) throw new WorkerOpenError('download', 'the in-memory rung needs a manifest to fetch');
    mode = 'memory';
    result = await openInMemory(manifest, url as string);
  } else {
    try {
      result = await openOnOpfs(manifest, url);
    } catch (error) {
      // D4's ladder, rung (a), in full: "`opfs-sahpool` unavailable, **or
      // `importDb` fails** → open an in-memory database". `openOnOpfs` returns
      // undefined for the first and throws for the second, and only `import`
      // falls through — a short download (`download`) would fetch the same short
      // bytes again, and a file that is not this artifact (`corrupt`) is not made
      // right by holding it in memory. Criterion 6 requires both of those to be
      // terminal, and they are.
      if (!(error instanceof WorkerOpenError) || error.reason !== 'import') throw error;
      result = undefined;
    }
    if (!result) {
      // Give the pool's exclusive handles back before spending 43 MB of heap.
      // Whatever went wrong, this worker is not going to use the pool, and
      // holding its handles is what stops the *next* tab getting the OPFS rung.
      releasePool();
      if (!manifest) {
        // Rung (a) fetches 43 MB. With no manifest there is no network to fetch
        // it from, and "opfs-sahpool is unavailable" offline is simply no
        // dictionary — said plainly rather than after a failed download.
        throw new WorkerOpenError(
          'download',
          offlineMessage('this browser has no storage to read one from'),
        );
      }
      mode = 'memory';
      result = await openInMemory(manifest, url as string);
    }
  }

  db = result.db;
  // With no manifest the file is its own description: the name it is stored
  // under is `dict-<schema>-<cedict>.sqlite`, and the version is in `meta`.
  const resolved: DictManifest = manifest ?? {
    file: (pool as SAHPoolUtil).getFileNames().filter((f) => ARTIFACT_PATTERN.test(f))[0].slice(1),
    bytes: 0,
    sha256: '',
    schemaVersion: SCHEMA_VERSION,
    dictVersion: readDictVersion(result.db),
  };
  opened = { manifest: resolved, name: `/${resolved.file}` };
  evicted = false;
  return {
    mode,
    downloaded: result.downloaded,
    imported: result.imported,
    transfer: result.transfer,
    sqliteVersion: runtime.version.libVersion,
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

interface Cached {
  statement: PreparedStatement;
  /** Read once per statement, not once per row. See `runBatch`. */
  columns: string[];
}

function statementFor(connection: Database, sql: string): Cached {
  let cached = statements.get(sql);
  if (!cached) {
    const statement = connection.prepare(sql);
    cached = { statement, columns: statement.getColumnNames() };
    statements.set(sql, cached);
  }
  return cached;
}

/**
 * One batch, in order, on the one connection — the `SqlRunner` contract.
 *
 * Statements are cached by SQL text exactly as the Node runner caches them.
 * Every query in the layer is a constant string with bound parameters except the
 * chunked `IN (…)` ones, whose text varies with the chunk length, and D3 fixed
 * those at 900 values — so the cache is bounded by the distinct lengths a
 * session sees.
 */
/**
 * SQLite result codes that mean the database this worker is holding is not
 * coming back: the file is gone, unreadable, or not a database any more.
 *
 * `SQLITE_IOERR` is what a revoked or invalidated sync access handle surfaces
 * as, and it is the shape a real OPFS eviction takes: storage is reclaimed under
 * disk pressure while the page is open, and the *next* query is where the app
 * finds out. `SQLITE_CORRUPT` and `SQLITE_NOTADB` cover a file that is still
 * there and no longer usable.
 */
const FATAL_RESULT_CODES = new Set([
  10, // SQLITE_IOERR
  11, // SQLITE_CORRUPT
  14, // SQLITE_CANTOPEN
  26, // SQLITE_NOTADB
]);

/** Fatal by the message, for builds or paths that do not carry a result code. */
const FATAL_MESSAGE = /disk i\/o error|not a database|database disk image is malformed|file is not a database|unable to open database/i;

function isFatal(error: unknown): boolean {
  const code = (error as { resultCode?: number } | undefined)?.resultCode;
  if (typeof code === 'number' && FATAL_RESULT_CODES.has(code & 0xff)) return true;
  return error instanceof Error && FATAL_MESSAGE.test(error.message);
}

/**
 * The database is gone. Close what is left and tell the main thread.
 *
 * **This is the production path behind D4's criterion 4**, and it is the only
 * one: `recover()` in `wasm-store.ts` is driven by the `lost` message, and a real
 * eviction never announces itself — it arrives as a `step()` throw inside an
 * ordinary query. Without this the store would spend the rest of the session
 * answering every keystroke with an error, which is exactly the wedged outcome
 * the criterion exists to rule out.
 *
 * On a corruption code the file is still readable, so `PRAGMA integrity_check`
 * is worth its cost *here* and nowhere else — this is the rule D4 measured it
 * for. Six seconds on a session that is already broken buys a message that says
 * which of the two happened.
 */
function markLost(error: unknown): void {
  let detail = error instanceof Error ? error.message : String(error);
  const code = (error as { resultCode?: number } | undefined)?.resultCode;
  if (db && typeof code === 'number' && ((code & 0xff) === 11 || (code & 0xff) === 26)) {
    try {
      const report = integrityCheck();
      detail += ` — PRAGMA integrity_check in ${Math.round(report.ms)} ms said ${report.rows
        .slice(0, 3)
        .join('; ')}`;
    } catch {
      detail += ' — PRAGMA integrity_check could not run';
    }
  }
  finalizeStatements();
  try {
    db?.close();
  } catch {
    // Already gone.
  }
  db = undefined;
  post({ type: 'lost', message: `the dictionary became unreadable: ${detail}` });
}

function readRows(
  statement: PreparedStatement,
  columns: readonly string[],
  rows: Record<string, SqlValue>[],
): void {
  if (!sqlite3) throw new Error('sqlite-wasm has not been initialised');
  reader ??= rowReader(sqlite3);
  reader(statement, columns, rows);
}

function runBatch(batch: WasmRequest & { type: 'query' }): QueryReply {
  if (evicted) {
    // What a revoked sync access handle produces, in the one shape a test can
    // reach. It carries `SQLITE_IOERR` so it travels the same path.
    throw Object.assign(new Error('disk I/O error'), { resultCode: 10 });
  }
  if (!db) {
    // Either `close()` ran, or a previous query already found the database
    // gone. Both are "there is nothing to answer with"; only the first is
    // ordinary, and it has already been reported.
    throw new Error('the dictionary connection is closed');
  }
  const out: QueryReply = [];
  for (const query of batch.batch) {
    const { statement, columns } = statementFor(db, query.sql);
    try {
      statement.reset(true);
      const params = query.params ?? [];
      if (params.length > 0) statement.bind(params as WasmSqlValue[]);
      const rows: Record<string, SqlValue>[] = [];
      // The column names are read once per *statement* (`statementFor`), not
      // per row: oo1's `get({})` re-derives them on every row, which D4
      // measured at 71 ms against 24 ms for `get(array)` on the gloss query.
      // Each cell then comes out through raw `capi` calls rather than
      // `Stmt.get()` at all — `wasm-extract.ts` says what that saves and why
      // the values cannot differ.
      readRows(statement, columns, rows);
      out.push(rows);
    } finally {
      // Release the statement's page references and its bindings whatever
      // happened; a statement left mid-scan pins pages for the session.
      statement.reset(true);
    }
  }
  if (out.length !== batch.batch.length) {
    // Cannot happen from the loop above, and is asserted anyway: a result array
    // shorter than its batch is the silent wrong answer this protocol fears.
    throw new Error(`the batch of ${batch.batch.length} produced ${out.length} result sets`);
  }
  return out;
}

/** `runBatch`, plus the "is the database gone?" question every query answers. */
function runBatchWatched(batch: WasmRequest & { type: 'query' }): QueryReply {
  try {
    return runBatch(batch);
  } catch (error) {
    if (isFatal(error)) markLost(error);
    throw error;
  }
}

function finalizeStatements(): void {
  for (const { statement } of statements.values()) {
    try {
      statement.finalize();
    } catch {
      // A statement belonging to an already-closed database throws; there is
      // nothing left to release and nothing useful to report.
    }
  }
  statements.clear();
}

async function closeAll(): Promise<void> {
  finalizeStatements();
  try {
    db?.close();
  } catch {
    // Already gone.
  }
  db = undefined;
  opened = undefined;
  releasePool();
}

/**
 * Hand the pool's sync access handles back.
 *
 * `opfs-sahpool` holds one per file, exclusively per origin, so a worker that
 * keeps them is a worker that forces every other tab onto the in-memory rung.
 * Terminating the worker releases them eventually; "eventually" is exactly what
 * makes a reopened store fall to memory for no reason, so it is done explicitly
 * on every path that stops using the pool.
 */
function releasePool(): void {
  if (!pool) return;
  try {
    pool.pauseVfs();
  } catch {
    // Nothing acquired, or already paused.
  }
  pool = undefined;
}

/**
 * Simulates the one thing no test can otherwise reach: the artifact going away
 * under a live session.
 *
 * Eviction is real — browser storage is reclaimed under disk pressure — and the
 * store has to come back from it rather than spend the session wedged. The
 * database is closed first because `unlink` on a file in active use is
 * explicitly undefined behaviour in the VFS's documentation, and a test built on
 * undefined behaviour proves nothing.
 *
 * **It does not post `lost` itself.** That would make criterion 4 a test of a
 * signal the test supplies. Instead it leaves the worker in the state a real
 * eviction leaves it in — no usable database — and the *next query* takes the
 * production path through `markLost`, exactly as a `SQLITE_IOERR` from a revoked
 * access handle would.
 */
function evict(): void {
  const name = opened?.name;
  finalizeStatements();
  try {
    db?.close();
  } catch {
    // Already gone.
  }
  db = undefined;
  evicted = true;
  if (pool && name) pool.unlink(name);
}

function integrityCheck(): IntegrityReport {
  if (!db) throw new Error('the dictionary connection is closed');
  const started = performance.now();
  const rows = db.exec({
    sql: 'PRAGMA integrity_check',
    rowMode: 'array',
    returnValue: 'resultRows',
  }) as WasmSqlValue[][];
  const ms = performance.now() - started;
  return { ms, rows: rows.map((row) => String(row[0])) };
}

// ---------------------------------------------------------------------------
// The message loop
// ---------------------------------------------------------------------------

self.addEventListener('message', (event: MessageEvent<WasmRequest>) => {
  const request = event.data;
  void (async () => {
    try {
      switch (request.type) {
        case 'open': {
          const report = await open(request.manifest, request.url, request.forceMemory ?? false);
          post({ type: 'ok', id: request.id, value: report });
          return;
        }
        case 'query': {
          post({ type: 'ok', id: request.id, value: runBatchWatched(request) });
          return;
        }
        case 'integrity': {
          post({ type: 'ok', id: request.id, value: integrityCheck() });
          return;
        }
        case 'evict': {
          evict();
          post({ type: 'ok', id: request.id, value: null });
          return;
        }
        case 'close': {
          await closeAll();
          post({ type: 'ok', id: request.id, value: null });
          return;
        }
      }
    } catch (error) {
      post({
        type: 'error',
        id: request.id,
        message: error instanceof Error ? error.message : String(error),
        reason: error instanceof WorkerOpenError ? error.reason : 'corrupt',
      });
    }
  })();
});

/**
 * A rejection nobody awaited still has to reach the main thread.
 *
 * Without these the failure mode is a worker that stops answering while the page
 * waits forever on a promise — which is exactly the "unhandled rejection in the
 * worker" the review lens names. There is no request id to answer, so the main
 * thread's link treats a `lost` as a reason to reopen and, failing that, to fail
 * every pending call.
 */
self.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
  event.preventDefault();
  post({ type: 'lost', message: `unhandled rejection in the dictionary worker: ${String(event.reason)}` });
});
