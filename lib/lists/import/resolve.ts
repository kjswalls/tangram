/**
 * The importer's preview: parsed rows → dictionary candidates → a plan of entry
 * ids for one `addListMembers` call (PLAN.md §3.3, lists).
 *
 * The dictionary answers through a `Resolver` — `/api/dict/resolve` in the
 * browser, a hand-built map in a test — so the grouping, the default reading and
 * the skip rules below are unit-tested without a 35 MB file behind them.
 *
 * Dictionary only, by design: nothing here calls a model, and the preview shows
 * the learner every ambiguity rather than guessing past it.
 */
import { normalizePinyin, readingKeys } from '@/lib/dict/pinyin';
import type { ResolvedWord, ResolveVia } from '@/lib/dict/resolve';
import type { Entry, EntryId } from '@/lib/types';

import type { ImportFormat, ImportRow, ParsedImport } from './parse';

/** Every candidate for each word asked, in the order asked. */
export type Resolver = (words: string[]) => Promise<ResolvedWord[]>;

/**
 * One thing the learner can pick for a row: a headword under one reading. 了 has
 * `le` and `liǎo`; `le` (typed as pinyin) has 了, 乐 and 勒. CC-CEDICT's extra
 * rows for the same word and reading — a traditional variant, a capitalised
 * proper noun — fold into the most frequent one, so the picker lists readings
 * and words, never bookkeeping.
 */
export interface ReadingOption {
  /** `simp|toned reading` — stable across renders, and the `<option>` value. */
  key: string;
  entry: Entry;
}

export interface PreviewRow {
  index: number;
  row: ImportRow;
  via: ResolveVia;
  /** Empty when nothing matched. */
  options: ReadingOption[];
  /** The option the row's own reading picked, else the most frequent. Absent when unmatched. */
  defaultKey?: string;
}

export interface ImportPreview {
  format: ImportFormat;
  rows: PreviewRow[];
  skipped: number;
  dictVersion: string;
}

/** Words per `/api/dict/resolve` call — under the route's 1,000 cap. */
export const RESOLVE_CHUNK = 500;

function toned(pinyinNum: string): { toneless: string; toned: string } {
  const keys = readingKeys(pinyinNum);
  if (keys) return keys;
  const parsed = normalizePinyin(pinyinNum);
  return { toneless: parsed.toneless, toned: parsed.toned };
}

/** `simp|toned reading`, lower-cased, ü folded — what makes two entries "the same reading". */
export function optionKey(entry: Entry): string {
  return `${entry.simp}|${toned(entry.pinyinNum).toned}`;
}

/**
 * Candidates → picker options. Order is preserved (most frequent first), so the
 * first option is the default when the row carries no reading of its own.
 *
 * `alt` is the other script from a `simp[trad]` headword: candidates that do
 * not spell it are dropped, unless that would leave nothing — a Pleco export
 * that disagrees with CC-CEDICT about a variant still deserves a match.
 */
export function optionsFor(entries: readonly Entry[], alt?: string): ReadingOption[] {
  let pool = entries;
  if (alt) {
    const spelled = entries.filter((entry) => entry.simp === alt || entry.trad === alt);
    if (spelled.length > 0) pool = spelled;
  }
  const seen = new Set<string>();
  const options: ReadingOption[] = [];
  for (const entry of pool) {
    const key = optionKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    options.push({ key, entry });
  }
  return options;
}

/**
 * Which option a row's own reading names. Tone-exact when the hint carries
 * tones, toneless otherwise; `undefined` when the hint names none of them, so
 * the caller falls back to the most frequent rather than to a wrong reading.
 */
export function optionForReading(options: readonly ReadingOption[], hint?: string): ReadingOption | undefined {
  if (!hint) return undefined;
  const parsed = normalizePinyin(hint);
  if (!parsed.fullyParsed) return undefined;
  const withTones = parsed.syllables.some((syllable) => syllable.tone !== null);
  return options.find((option) => {
    const keys = toned(option.entry.pinyinNum);
    return withTones ? keys.toned === parsed.toned : keys.toneless === parsed.toneless;
  });
}

/**
 * Resolve every row. Words are sent once each, in chunks, and the answer is
 * spread back over the rows that asked for them.
 */
export async function buildPreview(parsed: ParsedImport, resolve: Resolver): Promise<ImportPreview> {
  const words = [...new Set(parsed.rows.map((row) => row.word))];
  const byWord = new Map<string, ResolvedWord>();
  for (let i = 0; i < words.length; i += RESOLVE_CHUNK) {
    const chunk = words.slice(i, i + RESOLVE_CHUNK);
    for (const result of await resolve(chunk)) byWord.set(result.word, result);
  }

  const rows = parsed.rows.map((row, index): PreviewRow => {
    const resolved = byWord.get(row.word) ?? byWord.get(row.word.trim());
    const options = optionsFor(resolved?.entries ?? [], row.alt);
    const chosen = optionForReading(options, row.pinyin) ?? options[0];
    return {
      index,
      row,
      via: options.length === 0 ? 'none' : (resolved?.via ?? 'none'),
      options,
      ...(chosen ? { defaultKey: chosen.key } : {}),
    };
  });

  return { format: parsed.format, rows, skipped: parsed.skipped, dictVersion: '' };
}

export type RowStatus =
  /** Goes into the list. */
  | 'add'
  /** Nothing in the dictionary matched. */
  | 'unmatched'
  /** The list already has this entry. */
  | 'present'
  /** An earlier row already chose this entry. */
  | 'duplicate';

export interface PlannedRow {
  index: number;
  status: RowStatus;
  entryId?: EntryId;
}

export interface ImportPlan {
  /** What to hand `addListMembers`, in row order, no repeats. */
  entryIds: EntryId[];
  rows: PlannedRow[];
  counts: Record<RowStatus, number>;
}

/**
 * The write, decided. `selections` overrides a row's default option (by row
 * index → option key); `present` is the target list's current membership.
 * Rows already in the list and rows repeating an earlier choice are skipped, so
 * a re-paste of the same export adds nothing and says so.
 */
export function planImport(
  preview: ImportPreview,
  selections: Readonly<Record<number, string>>,
  present: ReadonlySet<EntryId>,
): ImportPlan {
  const entryIds: EntryId[] = [];
  const chosen = new Set<EntryId>();
  const counts: Record<RowStatus, number> = { add: 0, unmatched: 0, present: 0, duplicate: 0 };
  const rows = preview.rows.map((row): PlannedRow => {
    const key = selections[row.index] ?? row.defaultKey;
    const option = row.options.find((candidate) => candidate.key === key) ?? row.options[0];
    let status: RowStatus;
    if (!option) status = 'unmatched';
    else if (present.has(option.entry.id)) status = 'present';
    else if (chosen.has(option.entry.id)) status = 'duplicate';
    else {
      status = 'add';
      chosen.add(option.entry.id);
      entryIds.push(option.entry.id);
    }
    counts[status] += 1;
    return { index: row.index, status, ...(option ? { entryId: option.entry.id } : {}) };
  });
  return { entryIds, rows, counts };
}
