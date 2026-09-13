/**
 * Shared vocabulary for the whole app (PLAN.md §3.1, §3.2, §3.4).
 *
 * Frozen after Phase 0: every phase imports from here, so a change is a merge
 * conflict waiting to happen. Needed changes go through HANDOFF.md.
 *
 * The dictionary data contract lives here rather than under `lib/dict/` because
 * freezing a shape only works if the definition sits inside the frozen file —
 * P1 owns `lib/dict/**` and would otherwise be free to edit `Entry`.
 * `lib/dict/types.ts` re-exports these under the dictionary layer's own names
 * (`Entry` is `DictEntry` there), so there is exactly one definition.
 */

/** `trad|simp[pinyinNum]` — CC-CEDICT's natural key, identical to ivankra's CEDICT column. */
export type EntryId = string;

/** 1–6 are HSK 3.0 bands; 7 stands for the band labelled "7–9". */
export type HskBand = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** One dictionary headword-reading pair, as `data/dict.json` stores it (§3.1). */
export interface Entry {
  /** `trad|simp[pinyinNum]`, unique across the whole dictionary. */
  id: EntryId;
  simp: string;
  trad: string;
  /** CC-CEDICT numbered pinyin, e.g. `da3 suan4`. `u:` is ü. */
  pinyinNum: string;
  /** Mechanically derived from `pinyinNum` by lib/dict/pinyin.ts, e.g. `dǎsuàn`. */
  pinyinMarked: string;
  /** Glosses with `CL:` lines removed. */
  glosses: string[];
  /** Simplified classifier characters lifted out of the `CL:` glosses, e.g. `['个']`. */
  classifiers: string[];
  /** The pinyin is capitalized (CC-CEDICT's convention for proper nouns). */
  properNoun: boolean;
  /** Every gloss is some flavour of "variant of …". */
  isVariant: boolean;
  /** The id this entry is a variant of, when that entry exists. */
  variantOf?: EntryId;
  /** A gloss starts with "surname ". */
  surname: boolean;
  /** HSK 3.0 part of speech, from the HSK row that matched. */
  pos?: string;
  hskBand?: HskBand;
  /** 1 = most frequent word in jieba's dictionary. */
  freqRank?: number;
  /** Raw jieba frequency count. */
  freq?: number;
}

export interface DictSource {
  name: string;
  /** URL, or `npm:<pkg>@<version>` for packaged data. */
  url: string;
  license: string;
  /** Set when Tangram derives something the upstream file does not contain. */
  modifications?: string;
}

export interface DictMeta {
  /** The CC-CEDICT snapshot the entries come from; travels on every card snapshot. */
  version: string;
  builtAt: string;
  sources: DictSource[];
}

export interface DictFile {
  meta: DictMeta;
  entries: Entry[];
}

export interface DecompEntry {
  /** IDS decomposition, e.g. `⿰扌丁`. `？` marks an unknown component. */
  decomposition: string;
  radical: string;
  definition?: string;
}

/** `data/decomp.json` — keyed by single character. Kept apart: its licence differs. */
export type DecompFile = Record<string, DecompEntry>;

export const HSK_BANDS: readonly HskBand[] = [1, 2, 3, 4, 5, 6, 7];

/** Label for a band; 7 is the combined "7–9" band. */
export function hskBandLabel(band: HskBand): string {
  return band === 7 ? '7–9' : String(band);
}

/**
 * Entry ids are CC-CEDICT's natural key, `trad|simp[pinyinNum]`. Splitting one
 * is how code that only has an id (e.g. `known_words`) recovers the headword
 * without a dictionary round-trip. Returns null for anything else.
 */
export function parseEntryId(id: string): { trad: string; simp: string; pinyinNum: string } | null {
  const match = /^([^|]+)\|([^[]+)\[(.*)\]$/.exec(id);
  if (!match) return null;
  return { trad: match[1], simp: match[2], pinyinNum: match[3] };
}

/**
 * A segmentation token (§3.2). Non-CJK runs are `text` tokens: never looked up,
 * never coloured. `entryIds` carries every reading, frequency-ordered, never truncated.
 */
export interface Token {
  text: string;
  /** Offsets into the source string, in UTF-16 code units. */
  start: number;
  end: number;
  kind: 'word' | 'text';
  entryIds: string[];
  via: 'entry' | 'fallback';
}

/**
 * Where a card's provenance came from.
 *
 * `reverse` is the single-card "add the reverse" press (Phase 8): an explicit
 * add like `lookup`/`ask`/`reader`, and marked as one so it does not spend the
 * day's new-card allowance. Without it a twin inherited its parent's `list`
 * and quietly charged the spine for a card the learner asked for by hand.
 */
export type ContextSource = 'lookup' | 'ask' | 'reader' | 'reverse' | 'list' | 'seed';

/**
 * Provenance: the sentence a word was met in, or the question that produced it.
 * Travels with the card and is shown on its back (§1, commitment 2).
 */
export interface CardContext {
  sentence?: string;
  question?: string;
  query?: string;
  /** Offset and length of the target inside `sentence`, for highlighting. */
  offset?: number;
  length?: number;
  source: ContextSource;
  addedAt: number;
}

/** What `openLookup()` is handed: the query plus where it came from. */
export interface LookupRequest {
  query: string;
  context?: CardContext;
}

/** A list as the UI needs it, without the row's bookkeeping columns. */
export interface ListRef {
  id: string;
  name: string;
  kind: 'hsk' | 'looked-up' | 'custom';
  band?: HskBand;
  active: boolean;
  order: number;
}

/** The learner snapshot that travels with an ask request (§3.3, §3.4). */
export interface LearnerProfile {
  estimatedBand: HskBand;
  /** ≤200 simplified headwords the learner already knows. */
  knownSample: string[];
}

/** A token in a `sayIt` phrase: either a cited dictionary entry or the model's own string. */
export type AskToken = { entryId: string; text?: never } | { text: string; entryId?: never };

export interface AskMatch {
  entryId: string;
  senseIndex: number;
  whyThisOne: string;
}

export interface AskSayIt {
  tokens: AskToken[];
  en: string;
  register: string;
}

/**
 * The model's answer (§3.4). Ids and indexes only — hanzi and pinyin are rendered
 * from the cited entries, never from the model's own text, and the ask cache stores
 * this shape verbatim so no dictionary text is redistributed from it.
 */
export interface AskResponse {
  /** Plain prose, no CJK. */
  interpretation: string;
  matches: AskMatch[];
  sayIt: AskSayIt[];
  /** Plain prose, no CJK. */
  notes: string[];
}

/** An `AskResponse` that has been through `lib/ai/ground.ts`. */
export type ValidatedAskResponse = AskResponse;
