/**
 * The dictionary under Node, over the SQLite artifact (docs/plans/data.md D6).
 *
 * **What this module is, after `backend.md` B2.** D6 wrote it so the three model
 * routes could read the dictionary in process while they waited for B2's
 * contract flip to take retrieval off the server entirely. The flip has landed:
 * `apps/server` holds no dictionary, imports nothing from `apps/app`, and
 * `apps/server/tests/workspace.test.ts` asserts both. So **no production code
 * reaches this file any more.**
 *
 * It is kept, deliberately, as the Node-side opener the unit suites use —
 * `tests/unit/ai/ask-client.test.ts` runs the whole retrieval-and-grounding
 * pipeline against the real 124k-entry artifact through it, and
 * `tests/unit/srs/support-pool.test.ts` resolves a real support pool the same
 * way. Those are claims about Chinese words, and a fixture dictionary is a
 * fixture that can agree with a bug. It is the same `DictStore` the browser and
 * the phones use, so there is still exactly one dictionary implementation in
 * this repository.
 *
 * **What went with the routes.** `dictErrorResponse` — the
 * `503 {error:'dict-data-missing'}` the three handlers answered with — is
 * deleted. The frozen ask contract lists every error body those routes may
 * return and says of that code: "it is **not** here and must not come back:
 * after B2 the server has no dictionary, so it cannot have a missing one, and a
 * server that still answered it would be telling the browser about a file the
 * browser owns." The client's own missing-dictionary banner is `data.md`'s
 * (`DictStatus`) and is unaffected.
 *
 * **Node-only.** It reaches `node:sqlite` through `lib/dict/runners/node.ts`,
 * and nothing in the browser bundle may import it. The runner is imported
 * **lazily**, inside `serverDictStore()`: a static import puts `node:sqlite` in
 * the module graph of anything that so much as names this file, and Vite
 * refuses to bundle a Node built-in for a browser environment.
 *
 * The connection is memoised on `globalThis`, not at module scope, for the
 * reason `lib/db/get-db.ts` is: Vite re-evaluates a module on every HMR edit and
 * a second `DatabaseSync` per edit is a file handle per edit.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { MANIFEST_FILE, type DictManifest } from '../dict/artifact';
import { SqliteDictStore } from '../dict/sqlite-store';
import { dataDir } from './roots';
import type { DictStore } from '../dict/store';

/**
 * The dictionary has not been built.
 *
 * A fresh clone before `pnpm data` is a **normal** state, not an exception to
 * crash on — CLAUDE.md: "missing data is a banner, not a crash". It is a
 * distinguishable error so a caller can tell "no artifact" from "a broken one";
 * the only callers left are the unit suites, and `tests/unit/dict/data-required`
 * is what turns it into a skip rather than a red suite.
 */
export class DictDataMissingError extends Error {
  override readonly name = 'DictDataMissingError';
  readonly path: string;

  constructor(path: string, options?: { cause?: unknown }) {
    super(`dictionary data not found at ${path} — run pnpm data`, options);
    this.path = path;
  }
}

interface DictCache {
  store?: SqliteDictStore;
  opening?: Promise<SqliteDictStore>;
}

const CACHE_KEY = Symbol.for('tangram.server.dict');

function cache(): DictCache {
  const holder = globalThis as typeof globalThis & { [CACHE_KEY]?: DictCache };
  holder[CACHE_KEY] ??= {};
  return holder[CACHE_KEY];
}

/** The manifest beside the artifact, or a `DictDataMissingError`. */
function manifest(): { manifest: DictManifest; path: string } {
  const dir = dataDir();
  const manifestPath = resolve(dir, MANIFEST_FILE);
  if (!existsSync(manifestPath)) throw new DictDataMissingError(manifestPath);
  let parsed: DictManifest;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as DictManifest;
  } catch (cause) {
    throw new DictDataMissingError(manifestPath, { cause });
  }
  const path = resolve(dir, parsed.file);
  if (!existsSync(path)) throw new DictDataMissingError(path);
  return { manifest: parsed, path };
}

/**
 * The open store, opened on first use.
 *
 * Concurrent callers share one attempt, and a **failed** attempt is not cached:
 * the slot is cleared in `finally`, so a request that arrives after `pnpm data`
 * has finally been run gets a dictionary rather than the first request's error
 * for the life of the process.
 */
export function serverDictStore(): Promise<DictStore> {
  const held = cache();
  if (held.store) return Promise.resolve(held.store);
  if (held.opening) return held.opening;
  const attempt = (async () => {
    const { path } = manifest();
    const { nodeRunner } = await import('../dict/runners/node');
    const store = new SqliteDictStore({ connect: async () => nodeRunner(path) });
    await store.open();
    held.store = store;
    return store;
  })();
  const tracked = attempt.finally(() => {
    if (held.opening === tracked) held.opening = undefined;
  });
  held.opening = tracked;
  return tracked;
}

/**
 * Tests and HMR teardown: close the connection and forget it.
 *
 * **The in-flight open is awaited first, and then cleared again.** An open that
 * is still running writes `held.store` when it resolves, so clearing the slot
 * before awaiting it puts the connection straight back — and the caller, which
 * is a test about to point `TANGRAM_DATA_DIR` at an empty directory, goes on
 * with a live dictionary memoised on `globalThis` and proves nothing. Caught by
 * an adversarial reviewer; the order below is the fix and the second read of
 * `held.store` is the whole of it.
 */
export async function closeServerDictStore(): Promise<void> {
  const held = cache();
  // Let a pending attempt finish so its `held.store = store` lands where this
  // can see it. A rejected attempt has nothing to close.
  await held.opening?.catch(() => undefined);
  const store = held.store;
  held.store = undefined;
  held.opening = undefined;
  if (store) await store.close();
}
