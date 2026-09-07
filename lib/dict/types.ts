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

export interface EntriesResponse {
  entries: Entry[];
}

export interface HskResponse {
  band: HskBand;
  entries: Entry[];
}
