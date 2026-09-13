/**
 * Dictionary data contract (PLAN.md §3.1), under the dictionary layer's own names.
 *
 * The shapes themselves are defined in `lib/types.ts`, which PLAN.md §4 freezes;
 * a definition living outside the frozen file would not actually be frozen. This
 * module is the dictionary layer's view of them — `Entry` is `DictEntry` here,
 * because the build script and the loader deal in dictionary rows, not app cards —
 * plus the response shapes that only the routes need.
 */

export type {
  Entry as DictEntry,
  EntryId,
  HskBand,
  DictSource,
  DictMeta,
  DictFile,
  DecompEntry,
  DecompFile,
} from '../types';

import type { Entry, HskBand } from '../types';

/** Body of a 503 from the dictionary routes when `data/*.json` has not been built. */
export interface DictDataMissingBody {
  error: 'dict-data-missing';
  hint: string;
}

/**
 * What every entry-bearing response says about the data behind it. The version
 * is `meta.version` from `data/dict.json` — the CC-CEDICT snapshot the rows were
 * cut from — and it is on the wire because `addCardFromEntry` stamps it onto the
 * card snapshot: a card that cannot name its dictionary cannot be re-checked
 * later. `SearchResult.dictVersion` is the same string.
 */
export interface DictResponseMeta {
  version: string;
}

export interface EntriesResponse {
  meta: DictResponseMeta;
  entries: Entry[];
}

export interface HskResponse {
  meta: DictResponseMeta;
  band: HskBand;
  entries: Entry[];
}
