/**
 * Typed fetchers for the dictionary routes (PLAN.md §3.2). Isomorphic: pass
 * `baseUrl` when calling from the server or a test, omit it in the browser.
 *
 * A missing data build is not an exception the UI should crash on — it is a state
 * with a banner — so the 503 is surfaced as `DictRequestError` with
 * `dataMissing === true` rather than an empty result.
 */
import type { DictEntry, EntriesResponse, EntryId, HskBand, HskResponse } from './types';

export class DictRequestError extends Error {
  override readonly name = 'DictRequestError';
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }

  /** `data/dict.json` has not been built — the shell shows one banner for this. */
  get dataMissing(): boolean {
    return this.code === 'dict-data-missing';
  }
}

export interface DictFetchOptions {
  /** Origin to prefix, e.g. `http://localhost:3000`. Empty in the browser. */
  baseUrl?: string;
  signal?: AbortSignal;
}

async function getJson<T>(path: string, options: DictFetchOptions = {}): Promise<T> {
  const res = await fetch(`${options.baseUrl ?? ''}${path}`, {
    signal: options.signal,
    headers: { accept: 'application/json' },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string; hint?: string } | null;
    throw new DictRequestError(
      res.status,
      body?.error ?? 'request-failed',
      body?.hint ?? `${path} returned HTTP ${res.status}`,
    );
  }
  return (await res.json()) as T;
}

/** Entries by id, in the order asked for. Unknown ids are simply absent. */
export async function fetchEntries(
  ids: readonly EntryId[],
  options?: DictFetchOptions,
): Promise<DictEntry[]> {
  if (ids.length === 0) return [];
  // Repeated params, not a comma list: ids contain commas inside their pinyin.
  const query = ids.map((id) => `ids=${encodeURIComponent(id)}`).join('&');
  const body = await getJson<EntriesResponse>(`/api/dict/entries?${query}`, options);
  return body.entries;
}

/** One HSK band, ordered by frequency. Band 7 is the list labelled "7–9". */
export async function fetchHskBand(
  band: HskBand,
  options?: DictFetchOptions,
): Promise<DictEntry[]> {
  const body = await getJson<HskResponse>(`/api/dict/hsk?band=${band}`, options);
  return body.entries;
}
