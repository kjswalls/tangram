/**
 * Server-side loader for the generated dictionary (PLAN.md §3.2).
 *
 * `data/dict.json` is ~35 MB, so it is read once per process and memoised on
 * `globalThis` — a module-level cache would be dropped on every HMR reload in dev
 * and re-read the file each time. One parsed copy exists; the indexes in
 * `lib/dict/index.ts` hold references into it, never clones.
 *
 * Missing data is a normal state (a fresh clone before `pnpm data`), so it throws a
 * distinguishable error that the routes turn into a 503 instead of a stack trace.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { DecompFile, DictDataMissingBody, DictFile } from './types';

export class DictDataMissingError extends Error {
  override readonly name = 'DictDataMissingError';
  readonly path: string;

  constructor(path: string, options?: { cause?: unknown }) {
    super(`dictionary data not found at ${path} — run pnpm data`, options);
    this.path = path;
  }
}

/** `TANGRAM_DATA_DIR` points at the directory holding dict.json; default `<cwd>/data`. */
export function dataDir(): string {
  const configured = process.env.TANGRAM_DATA_DIR;
  return configured ? resolve(configured) : resolve(process.cwd(), 'data');
}

interface DictCache {
  dict?: DictFile;
  decomp?: DecompFile;
  /** Built by lib/dict/index.ts; kept here so both survive HMR together. */
  index?: unknown;
}

const CACHE_KEY = Symbol.for('tangram.dict.cache');

export function dictCache(): DictCache {
  const holder = globalThis as typeof globalThis & { [CACHE_KEY]?: DictCache };
  return (holder[CACHE_KEY] ??= {});
}

function readJson<T>(filename: string): T {
  const path = resolve(dataDir(), filename);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (cause) {
    throw new DictDataMissingError(path, { cause });
  }
  try {
    return JSON.parse(raw) as T;
  } catch (cause) {
    // A truncated or half-written file is missing data as far as callers care.
    throw new DictDataMissingError(path, { cause });
  }
}

/** The parsed `data/dict.json`. Throws `DictDataMissingError` when it is not built. */
export function getDict(): DictFile {
  const cache = dictCache();
  if (!cache.dict) {
    const file = readJson<DictFile>('dict.json');
    if (!Array.isArray(file.entries) || file.entries.length === 0) {
      throw new DictDataMissingError(resolve(dataDir(), 'dict.json'));
    }
    cache.dict = file;
  }
  return cache.dict;
}

/**
 * The parsed `data/decomp.json`. Separate from the dictionary on purpose: it is
 * LGPL and must never be merged into a card snapshot.
 */
export function getDecomp(): DecompFile {
  const cache = dictCache();
  cache.decomp ??= readJson<DecompFile>('decomp.json');
  return cache.decomp;
}

/**
 * The one answer every dictionary route gives when the data has not been built
 * (PLAN.md §3.2). Returns null for any other error, which the route rethrows.
 */
export function dictErrorResponse(error: unknown): Response | null {
  if (!(error instanceof DictDataMissingError)) return null;
  const body: DictDataMissingBody = { error: 'dict-data-missing', hint: 'run pnpm data' };
  return Response.json(body, { status: 503 });
}

/** Test helper: drop the memoised copies so a test can change TANGRAM_DATA_DIR. */
export function resetDictCache(): void {
  const holder = globalThis as typeof globalThis & { [CACHE_KEY]?: DictCache };
  delete holder[CACHE_KEY];
}
