/**
 * What went wrong, in words a deployer can act on, derived from a failed
 * `DictStatus` without changing it (first-run audit follow-up, HANDOFF.md).
 *
 * **Why this exists.** C4a's second pass drew the store's raw `message` under
 * every failure on purpose: it was how whoever deployed the app told "the file
 * was never built or is not on the server" from "the network dropped" from "the
 * browser refused storage". The first-run audit took that line out of
 * production, correctly — it was "TypeError: Failed to fetch" in monospace, in
 * front of a learner — and on a deployed build the causes then looked the same,
 * on a phone with no console. This module puts the diagnosis back as a plain
 * sentence, and the raw text stays in the console.
 *
 * **Why the message and not a new field.** `DictStatus` is frozen (`data.md`
 * D1's first commit), and `failed` carries only `reason` and `message`. The
 * four reasons are right as far as they go; what `download` cannot say is
 * whether the server answered "no" or never answered at all. The opener knows
 * — it holds the HTTP status — so it writes that into `message`, and it writes
 * it with the builders below, which are the only producers of the shapes
 * `diagnose` reads back. The builders and the reader sit in one file so they
 * cannot drift apart without a test here noticing.
 *
 * No runtime imports: the dictionary worker imports this module too.
 */
import type { DictStatus } from './store';

type Failed = Extract<DictStatus, { state: 'failed' }>;

/** Which request failed. Both are the deployer's to put on the server. */
export type DictRequestKind = 'manifest' | 'file';

/**
 * The plain-words causes, one per thing a deployer would do differently.
 *
 * - `not-on-server` — the server answered 404, 410 or 503 for the manifest or
 *   the file: `pnpm data` was not run, or its output was not deployed.
 * - `served-page` — the server answered 200 with something that is not the
 *   manifest or not a database. An SPA fallback does this for a path it does
 *   not have, so it is usually `not-on-server` in disguise.
 * - `server-refused` — any other HTTP refusal (403, 500…).
 * - `unreachable` — the request never completed: offline, DNS, a refused
 *   connection, a blocked cross-origin request.
 * - `incomplete` — the transfer ended short of the manifest's byte count, or
 *   the connection dropped part way through the body.
 * - `engine` — the dictionary's worker or its SQLite engine would not start: a
 *   worker chunk or `sqlite3.wasm` missing from the deploy, or a worker that
 *   died. Nothing is wrong with the learner's file, and "damaged" would say so.
 * - `storage`, `import`, `corrupt` — the other three reasons, which need no
 *   refinement beyond their own.
 * - `unknown` — a `download` failure this module did not write. It still gets
 *   a sentence; it just cannot say more than the reason does.
 */
export type DictDiagnosis =
  | 'not-on-server'
  | 'served-page'
  | 'server-refused'
  | 'unreachable'
  | 'incomplete'
  | 'engine'
  | 'storage'
  | 'import'
  | 'corrupt'
  | 'unknown';

const HTTP = /^the dictionary (?:manifest|fetch) answered (\d{3})\b/;
const UNREACHABLE = /^the dictionary (?:manifest )?could not be fetched\b/;
const SERVED_PAGE =
  /^the dictionary (?:manifest is not JSON|manifest has no file and bytes|download is not a SQLite database)\b/;
const INCOMPLETE = /^the dictionary download (?:was|stopped after) \d+ bytes\b/;
const ENGINE = /^the dictionary engine could not start\b/;

/** The server answered, and said no. */
export function refusedMessage(kind: DictRequestKind, status: number): string {
  return kind === 'manifest'
    ? `the dictionary manifest answered ${status}`
    : `the dictionary fetch answered ${status}`;
}

/**
 * The file's request never completed. `error` is the raw cause, kept for the
 * console. (An unreachable *manifest* is not a failure by itself — the opener
 * falls back to stored bytes — so it only fails as `offlineMessage`.)
 */
export function unreachableMessage(error: unknown): string {
  return `the dictionary could not be fetched: ${String(error)}`;
}

/**
 * Offline with nothing stored: the manifest was unreachable and the browser has
 * no dictionary to fall back on. `detail` finishes the sentence.
 */
export function offlineMessage(detail: string): string {
  return `the dictionary manifest could not be fetched and ${detail}`;
}

/**
 * The server answered 200 with something that is not what was asked for: a
 * manifest that is not JSON, JSON without `file` and `bytes` (an API fallback
 * answering `{}`), or a "database" that is not one.
 */
export function servedPageMessage(kind: DictRequestKind | 'manifest-shape'): string {
  if (kind === 'manifest-shape') return 'the dictionary manifest has no file and bytes';
  return kind === 'manifest'
    ? 'the dictionary manifest is not JSON'
    : 'the dictionary download is not a SQLite database — the server answered with something else';
}

/**
 * The connection dropped mid-body: `reader.read()` rejected. Not a bad file —
 * it used to reach the screen as `corrupt`, "damaged", because nothing wrapped
 * the rejection.
 */
export function droppedMessage(received: number, error: unknown): string {
  return `the dictionary download stopped after ${received} bytes: ${String(error)}`;
}

/** The worker or the SQLite engine would not start, or the worker died. */
export function engineMessage(detail: string): string {
  return `the dictionary engine could not start: ${detail}`;
}

/** The body ended before the manifest's byte count. */
export function incompleteMessage(received: number, expected: number): string {
  return `the dictionary download was ${received} bytes, the manifest says ${expected}`;
}

/** Read a failed status back into one of the causes above. */
export function diagnose(status: Failed): DictDiagnosis {
  const { reason, message } = status;
  if (SERVED_PAGE.test(message)) return 'served-page';
  if (ENGINE.test(message)) return 'engine';
  if (reason !== 'download') return reason;
  const http = HTTP.exec(message);
  if (http) {
    const code = Number(http[1]);
    return code === 404 || code === 410 || code === 503 ? 'not-on-server' : 'server-refused';
  }
  if (UNREACHABLE.test(message)) return 'unreachable';
  if (INCOMPLETE.test(message)) return 'incomplete';
  return 'unknown';
}
