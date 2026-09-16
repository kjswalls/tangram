/**
 * The dictionary, server side, over the SQLite artifact (docs/plans/data.md D6).
 *
 * D6 deletes `lib/dict/load.ts` and `lib/dict/index.ts` — the 35 MB JSON parse
 * and the seven lazy indexes over it. Three routes still read the dictionary in
 * process: `/api/ask`, `/api/examples` and `/api/recall`. They are **not this
 * plan's to move** — `backend.md` B1 moves them to `apps/server`, and B2's
 * frozen contract is what takes retrieval off the server entirely (the client
 * has the dictionary and sends the retrieved rows). Until then they need a
 * dictionary, and it is the same artifact every other platform queries, read
 * through the same `DictStore` the browser and the phones use.
 *
 * What that buys beyond "it still works": the three routes now answer from the
 * file `pnpm data` ships rather than from a parallel JSON path, so there is
 * exactly one dictionary implementation left in the repository. A grounding bug
 * that only the server could have had is no longer possible.
 *
 * **Node-only.** It reaches `node:sqlite` through `lib/dict/runners/node.ts`.
 * Nothing in the browser bundle may import this module, and nothing does: the
 * routes are mounted by `vite-plugins/api.ts` in dev and preview, and the two
 * components that name a route module import only its response *type*.
 *
 * The runner is nevertheless imported **lazily**, inside `serverDictStore()`.
 * A static import puts `node:sqlite` in the module graph of anything that so
 * much as names a route handler, and one such thing exists already:
 * `tests/unit/server/access.test.ts` runs in **jsdom** — it is about the
 * browser's half of the gate — and imports the three routes to prove they refuse
 * a request without the header. Vite refuses to bundle a Node built-in for a
 * browser environment, so the static form failed that suite at import time,
 * before a single assertion ran. Deferring it costs one microtask on the first
 * query and keeps "reaching for a route" free of "opening a database".
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
import type { DictDataMissingBody } from '../dict/types';

/**
 * The dictionary has not been built.
 *
 * A fresh clone before `pnpm data` is a **normal** state, not an exception the
 * routes should 500 on — CLAUDE.md: "missing data is a banner, not a crash" —
 * so it is a distinguishable error the three routes turn into the same
 * `503 {error:'dict-data-missing'}` they have always answered with. The class
 * and `dictErrorResponse` come from `lib/dict/load.ts`, which D6 deletes; the
 * body shape is unchanged, which is what keeps `tests/e2e` and the banner
 * working across the cutover.
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

/** Tests and HMR teardown: close the connection and forget it. */
export async function closeServerDictStore(): Promise<void> {
  const held = cache();
  const store = held.store;
  held.store = undefined;
  await held.opening?.catch(() => undefined);
  held.opening = undefined;
  if (store) await store.close();
}

/**
 * The 503 a route answers when the dictionary has not been built, or `null` when
 * the error is something else and the route should let it through.
 */
export function dictErrorResponse(error: unknown): Response | null {
  if (!(error instanceof DictDataMissingError)) return null;
  // The body is byte-for-byte `lib/dict/load.ts`'s, hint included: it is what
  // the ask panel, the card back and two e2e specs match on, and D6 is not the
  // phase to move a string every one of them reads.
  const body: DictDataMissingBody = { error: 'dict-data-missing', hint: 'run pnpm data' };
  return Response.json(body, { status: 503 });
}
