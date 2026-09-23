/**
 * The pure dictionary helpers: ordering, grouping, ranking and paging, with no
 * index and no filesystem behind them (docs/plans/data.md D1, D2).
 *
 * Two implementations answer a search now — `lib/dict/search.ts` over the JSON
 * index, and `lib/dict/sqlite-store.ts` over a `SqlRunner` — and they have to
 * agree about everything except *which rows are candidates*. That difference is
 * the whole point of D2 and D3's differential tests; a difference in how the
 * candidates are then grouped, ranked or paged would be noise on top of it. So
 * the grouping, the five-key sort, the section allocation and the cursor live
 * here once, and both callers drive them.
 *
 * `compareEntries` lives here for a related reason: it is now a property of the
 * *artifact*. `scripts/build-data.ts` assigns `entries.rowid` in exactly this
 * order and `scripts/verify-data.ts` re-checks it, so `ORDER BY rowid`
 * reproduces every frequency-ordered list the app has without a five-clause
 * sort.
 *
 * Everything in this module is dependency-free, like `lib/dict/pinyin.ts`: it
 * runs in the build script, in Node, in a browser worker and behind the
 * Capacitor bridge.
 */
import { PREFERRED_READINGS } from './preferred-readings';
import type { DictEntry, EntryId, HskBand } from './types';

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

/** Sorts after every real band (1–7). Shared by the entry order and the group ranking. */
const NO_BAND = 8;

/** Every gloss is a pointer to another word, so the entry carries no meaning of its own. */
export function isCrossReferenceOnly(entry: Pick<DictEntry, 'glosses'>): boolean {
  return entry.glosses.length > 0 && entry.glosses.every((gloss) => CROSS_REFERENCE_RE.test(gloss));
}

/**
 * The band that decides reading order: none, for an entry that only points
 * elsewhere. HSK sometimes lists a reading whose CC-CEDICT entry is nothing but
 * a pointer — 尽可能's band-5 `jin4` says only "see 儘可能…[jin3 ke3 neng2]",
 * the reading it would have displaced — and a pointer is not a reading to teach
 * first.
 */
export function orderingBand(entry: Pick<DictEntry, 'hskBand' | 'glosses'>): number {
  if (entry.hskBand === undefined) return NO_BAND;
  return isCrossReferenceOnly(entry) ? NO_BAND : entry.hskBand;
}

const PREFERRED_IDS: ReadonlySet<string> = new Set(PREFERRED_READINGS.map((reading) => reading.id));

/** On the hand-kept list in `preferred-readings.ts`. */
export function isPreferredReading(entry: Pick<DictEntry, 'id'>): boolean {
  return PREFERRED_IDS.has(entry.id);
}

/**
 * Frequency first — that is the order every list in the UI wants. Entries of one
 * headword share a jieba frequency, so the tiebreaks decide between readings:
 * ordinary words before variants before proper nouns, then the hand-kept list,
 * then the HSK band, then the id for determinism.
 *
 * **These tiebreaks pick a headword's default reading**, and the reader's
 * ruby, the character sheet, "Add" and every list of readings show the first
 * one. Without them the id decided, alphabetically, and `吗[ma2]` sorts before
 * `吗[ma5]`: the app taught 说 as shuì, 要 as yāo and 吗 as má. A banded reading
 * sorts before an unbanded one and a lower band before a higher, because the HSK
 * list is the only source in the artifact that says which reading a learner
 * meets — except that an entry whose every gloss is a cross-reference has no
 * band here (`orderingBand`). Where the band still picks wrong, or neither
 * reading has one (么, 奇, 壳), `preferred-readings.ts` names the reading to
 * show first. HANDOFF.md "The default reading" and "Preferred readings" list
 * every headword these moved.
 *
 * It also reorders *different* headwords that share a frequency (most of the
 * unranked tail), which only ever changes rowid order among exact ties.
 */
export function compareEntries(a: DictEntry, b: DictEntry): number {
  return (
    (b.freq ?? -1) - (a.freq ?? -1) ||
    Number(a.isVariant) - Number(b.isVariant) ||
    Number(a.properNoun) - Number(b.properNoun) ||
    Number(isPreferredReading(b)) - Number(isPreferredReading(a)) ||
    orderingBand(a) - orderingBand(b) ||
    (a.id < b.id ? -1 : 1)
  );
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/**
 * CJK ideographs, including the extensions that live outside the BMP. Kept in
 * one place because `segment.ts` and the store need exactly the same answer to
 * "is this hanzi".
 *
 * It stops at U+2EBEF: extension G (U+30000–U+3134A) and extension H are **not**
 * covered, and twelve single-character headwords in the current snapshot are
 * ext-G hanzi that carry real script evidence. Widening it is a behavioural
 * change to segmentation and search routing and is nobody's yet — see
 * HANDOFF.md, `data.md` D1.
 */
export const CJK_PATTERN =
  /[㐀-䶿一-鿿豈-﫿\u{20000}-\u{2A6DF}\u{2A700}-\u{2EBEF}\u{2F800}-\u{2FA1F}]/u;

/**
 * A gloss that only points at another word: "see 儘可能…", "used in 似的…",
 * "variant of 家伙…", with any qualifier CC-CEDICT puts first ("old variant of",
 * "erhua variant of", "(Tw) see"). The leading parenthetical and the qualifier
 * words are `build-data.ts`'s `VARIANT_RE` shape. The word pointed at must
 * start with a hanzi, which is what keeps out glosses that carry a meaning and
 * only begin like a pointer: "see you again later", "used in place names".
 */
const CROSS_REFERENCE_RE = new RegExp(
  String.raw`^(?:\([^)]*\)\s*)?(?:see(?: also)?|used in|(?:[A-Za-z]+\s+){0,2}variant of)\s+` +
    CJK_PATTERN.source,
  'iu',
);

export function hasCjk(text: string): boolean {
  return CJK_PATTERN.test(text);
}

/** Trivial English stemming, applied identically at build and query time. */
export function stemToken(token: string): string {
  if (token.length > 5 && token.endsWith('ing')) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith('ed')) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

/** `a-z`, `0-9` or an apostrophe — the alphabet a gloss token is made of. */
function isTokenChar(code: number): boolean {
  return (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 39;
}

/**
 * A gloss → the stemmed tokens it is indexed under, deduped, in order.
 *
 * One scan over the lowercased string rather than replace-split-map-filter.
 * It is called 195,550 times while the gloss index is built, again by
 * `scripts/build-data.ts` for every row of `gloss_fts`, and again on every
 * English query. `tests/unit/server/cold-start.test.ts` checks it agrees with
 * its slower predecessor on every gloss in the built dictionary, so this is a
 * faster spelling of the same function and not a different one.
 */
export function glossTokens(gloss: string): string[] {
  const lower = gloss.toLowerCase();
  const out: string[] = [];
  const seen = new Set<string>();
  const length = lower.length;
  let i = 0;
  while (i < length) {
    if (!isTokenChar(lower.charCodeAt(i))) {
      i += 1;
      continue;
    }
    let start = i;
    while (i < length && isTokenChar(lower.charCodeAt(i))) i += 1;
    let end = i;
    // A leading or trailing apostrophe is punctuation, not part of the word.
    while (start < end && lower.charCodeAt(start) === 39) start += 1;
    while (end > start && lower.charCodeAt(end - 1) === 39) end -= 1;
    if (end <= start) continue;
    const token = stemToken(lower.slice(start, end));
    if (token && !seen.has(token)) {
      seen.add(token);
      out.push(token);
    }
  }
  return out;
}

/**
 * Split a comma-separated id list, e.g. from `?ids=`. An id is `trad|simp[pinyin]`
 * and the pinyin of a proverb contains commas (`yi1 bu4 zuo4 , er4 bu4 xiu1`), so
 * only commas outside the brackets separate ids.
 */
export function parseIdList(value: string): EntryId[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of value) {
    if (ch === '[') depth += 1;
    else if (ch === ']') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.map((id) => id.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Grouping and ranking
// ---------------------------------------------------------------------------

/** Which index answered. The UI labels every result with it. */
export type MatchSource = 'hanzi' | 'pinyin' | 'english';

export const SECTION_LABELS: Record<MatchSource, string> = {
  hanzi: 'Hanzi',
  pinyin: 'Pinyin',
  english: 'English',
};

/** PLAN.md §3.2 caps a page at 50 groups. */
export const SEARCH_PAGE_SIZE = 50;

const NO_RANK = Number.MAX_SAFE_INTEGER;

/**
 * What ranking needs to know about one matched reading.
 *
 * Deliberately narrow: the store reads these eight columns for up to 5,000
 * candidate rows per keystroke and the full row — glosses, both pinyin forms,
 * classifiers — only for the ≤50 groups a page actually shows.
 */
export interface RankFacts {
  id: EntryId;
  simp: string;
  trad: string;
  isVariant: boolean;
  properNoun: boolean;
  hskBand?: number;
  freqRank?: number;
}

/** A headword group, ranked, before its entries have been fetched. */
export interface GroupCandidate {
  /** `trad|simp` — an entry id with the reading cut off. Stable, and the React key. */
  key: string;
  simp: string;
  trad: string;
  /** Best tier any of its readings hit. */
  tier: number;
  /** Ids that actually matched, best first. */
  matched: EntryId[];
  sortKey: [number, number, number, number, string];
}

function quality(entry: { isVariant: boolean; properNoun: boolean }): number {
  // PLAN.md §3.2: real words > variants > proper nouns.
  if (!entry.isVariant && !entry.properNoun) return 0;
  return entry.isVariant ? 1 : 2;
}

interface Bucket {
  simp: string;
  trad: string;
  tier: number;
  matched: EntryId[];
  seen: Set<EntryId>;
  quality: number;
  band: number;
  rank: number;
}

/**
 * Groups keyed by `trad|simp`, each keeping the best tier any of its readings
 * hit. Insertion order is candidate order, which is frequency order on both
 * implementations — the JSON posting lists and `ORDER BY rowid` are the same
 * ordering by `compareEntries`'s construction.
 */
export class CandidateSet {
  readonly #groups = new Map<string, Bucket>();

  add(facts: RankFacts, tier: number): void {
    const key = `${facts.trad}|${facts.simp}`;
    const existing = this.#groups.get(key);
    if (!existing) {
      this.#groups.set(key, {
        simp: facts.simp,
        trad: facts.trad,
        tier,
        matched: [facts.id],
        seen: new Set([facts.id]),
        quality: quality(facts),
        band: facts.hskBand ?? NO_BAND,
        rank: facts.freqRank ?? NO_RANK,
      });
      return;
    }
    existing.tier = Math.min(existing.tier, tier);
    if (existing.seen.has(facts.id)) return;
    existing.seen.add(facts.id);
    existing.matched.push(facts.id);
    existing.quality = Math.min(existing.quality, quality(facts));
    existing.band = Math.min(existing.band, facts.hskBand ?? NO_BAND);
    existing.rank = Math.min(existing.rank, facts.freqRank ?? NO_RANK);
  }

  addAll(rows: Iterable<RankFacts>, tier: number): void {
    for (const row of rows) this.add(row, tier);
  }

  get size(): number {
    return this.#groups.size;
  }

  /** Every group, ranked. Tier, then quality, then band, then jieba rank, then key. */
  ordered(): GroupCandidate[] {
    const rows: GroupCandidate[] = [];
    for (const [key, bucket] of this.#groups) {
      rows.push({
        key,
        simp: bucket.simp,
        trad: bucket.trad,
        tier: bucket.tier,
        matched: bucket.matched,
        sortKey: [bucket.tier, bucket.quality, bucket.band, bucket.rank, key],
      });
    }
    rows.sort((a, b) => {
      for (let i = 0; i < 4; i += 1) {
        const diff = (a.sortKey[i] as number) - (b.sortKey[i] as number);
        if (diff !== 0) return diff;
      }
      return a.sortKey[4] < b.sortKey[4] ? -1 : a.sortKey[4] > b.sortKey[4] ? 1 : 0;
    });
    return rows;
  }
}

/** One group with its entries — a `SearchGroup` without importing `search.ts`. */
export interface MaterialisedGroup {
  key: string;
  simp: string;
  trad: string;
  source: MatchSource;
  matchedIds: EntryId[];
  entries: DictEntry[];
  hskBand?: HskBand;
}

/**
 * Attach a group's entries: matched readings first, then the rest of the
 * headword's readings in frequency order.
 *
 * `readings` is every reading of this exact headword, in `compareEntries` order
 * — `index.bySimp.get(simp)` filtered by `trad` on one side, `ORDER BY rowid` on
 * the other. The band on the group comes from **all** the readings, not only the
 * matched ones, so the badge shows the easiest way in.
 */
export function materialise(
  candidate: GroupCandidate,
  readings: readonly DictEntry[],
  source: MatchSource,
): MaterialisedGroup {
  const matched = new Set(candidate.matched);
  const byId = new Map(readings.map((entry) => [entry.id, entry]));
  const entries: DictEntry[] = [];
  for (const id of candidate.matched) {
    const entry = byId.get(id);
    if (entry) entries.push(entry);
  }
  for (const entry of readings) {
    if (!matched.has(entry.id)) entries.push(entry);
  }
  const groupBand = entries.reduce<number>(
    (low, entry) => Math.min(low, entry.hskBand ?? NO_BAND),
    NO_BAND,
  );
  return {
    key: candidate.key,
    simp: candidate.simp,
    trad: candidate.trad,
    source,
    matchedIds: candidate.matched,
    entries,
    ...(groupBand === NO_BAND ? {} : { hskBand: groupBand as HskBand }),
  };
}

// ---------------------------------------------------------------------------
// Sections, the cursor and the page
// ---------------------------------------------------------------------------

/**
 * A headword both indexes matched belongs to whichever ranked it higher — 孫 is
 * `sun` the reading far more than it is the "Sun" inside "surname Sun", and 龍 the
 * same for `long`. Ties go to the leading section.
 *
 * This has to happen before paging, not during it: assigning per page would let
 * page 2 repeat what page 1 already showed, and claiming the group while ranking
 * would let the leading section take it and then cut it at the cap, which is how
 * 孙 vanished from a search for `sun` entirely.
 */
export function dedupeSections<T extends { key: string }>(sections: readonly T[][]): T[][] {
  if (sections.length < 2) return sections.map((groups) => [...groups]);
  const owner = new Map<string, { section: number; position: number }>();
  sections.forEach((groups, index) =>
    groups.forEach((group, position) => {
      const held = owner.get(group.key);
      if (!held || position < held.position) owner.set(group.key, { section: index, position });
    }),
  );
  return sections.map((groups, index) =>
    groups.filter((group) => owner.get(group.key)?.section === index),
  );
}

/**
 * Split one page between the sections.
 *
 * A flat "first 50 of the concatenation" would bury the second section entirely:
 * `he` has hundreds of readings before 他's gloss is reached, and `sun` hundreds
 * of glosses before 孙. Both answers are the point of running both indexes, so
 * every trailing section is reserved a share of the page and the leading section
 * takes what is left — which is still most of it.
 */
export function allocate(counts: readonly number[], limit: number): number[] {
  const share = Math.floor(limit / (counts.length + 1));
  const reserved = counts.map((count, i) => (i === 0 ? 0 : Math.min(count, share)));
  let left = limit;
  const takes: number[] = [];
  for (let i = 0; i < counts.length; i += 1) {
    const forOthers = reserved.slice(i + 1).reduce((sum, value) => sum + value, 0);
    const take = Math.max(0, Math.min(counts[i], left - forOthers));
    takes.push(take);
    left -= take;
  }
  return takes;
}

/** `"12.4"` — how far into each section this page starts. */
export function parseCursor(cursor: string | undefined, sections: number): number[] {
  const starts = new Array<number>(sections).fill(0);
  if (!cursor) return starts;
  cursor.split('.').forEach((part, i) => {
    const value = Number(part);
    if (i < sections && Number.isFinite(value) && value > 0) starts[i] = Math.floor(value);
  });
  return starts;
}

export interface PageWindow {
  /** Per section: which slice of its groups this page shows. */
  slices: { start: number; end: number }[];
  /** Groups matched before the cap, summed over the sections. */
  total: number;
  /** Results already shown before this page. */
  offset: number;
  nextCursor?: string;
}

/**
 * Which groups this page shows, as index arithmetic over already-ranked,
 * already-deduped sections.
 *
 * Separated from materialisation because the two implementations materialise at
 * different moments: the JSON one already holds every entry in memory, while the
 * store fetches full rows for the page's groups only — up to 50 groups instead
 * of up to 5,000.
 */
export function pageWindow(
  counts: readonly number[],
  options: { limit?: number; cursor?: string },
): PageWindow {
  const limit = Math.max(1, options.limit ?? SEARCH_PAGE_SIZE);
  const starts = parseCursor(options.cursor, counts.length);
  const remaining = counts.map((count, i) => Math.max(0, count - starts[i]));
  const takes = allocate(remaining, limit);
  const ends = starts.map((start, i) => start + takes[i]);
  return {
    slices: starts.map((start, i) => ({ start, end: ends[i] })),
    total: counts.reduce((sum, count) => sum + count, 0),
    offset: starts.reduce((sum, start) => sum + start, 0),
    ...(counts.some((count, i) => ends[i] < count) ? { nextCursor: ends.join('.') } : {}),
  };
}

// ---------------------------------------------------------------------------
// English glosses (docs/plans/data.md D3)
// ---------------------------------------------------------------------------

// Moved here from `search.ts` so the store can rank FTS5's candidates with the
// same function the JSON index ranks its posting lists with. `glossTier` is why
// Tangram does not need `bm25()` — which is just as well, since `bm25()` returns
// 0 for every row on a contentless `detail=none` table — and two copies of a
// four-tier ranking rule would be two rankings.
/**
 * Words that carry no meaning of their own in a gloss. Dropping them is what makes
 * "to plan" the same shape as "plan" — one tier apart, not unrelated.
 */
export const GLOSS_STOPWORDS = new Set(['to', 'a', 'an', 'the', 'be', 'of', 'sth', 'sb', "one's"]);

/**
 * The irregular plurals a learner actually types. `stemToken` handles `-s`, which
 * covers almost everything; without these, `women` misses 女人 and `people` misses
 * 人 — and PLAN.md §3.2 names `women` as a query that must work.
 */
export const IRREGULAR: Record<string, string> = {
  women: 'woman',
  men: 'man',
  children: 'child',
  people: 'person',
  feet: 'foot',
  teeth: 'tooth',
  mice: 'mouse',
  geese: 'goose',
  wives: 'wife',
  knives: 'knife',
  leaves: 'leaf',
};

/** One English word → its lookup form. Applied to the query and to every gloss. */
export function lemma(word: string): string {
  return IRREGULAR[word] ?? stemToken(word);
}

export function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9']+/g, ' ')
    .split(' ')
    .map((token) => token.replace(/^'+|'+$/g, ''))
    .filter(Boolean);
}

/** A query → its words, each in its lookup form. Applied to the query only. */
export function lemmas(text: string): string[] {
  return words(text).map(lemma);
}

/**
 * One CC-CEDICT gloss → the senses a query can match whole.
 *
 * CC-CEDICT packs near-synonyms into one gloss with semicolons and prefixes them
 * with register notes: 他 is `"(third-person singular) (…) he; him; his"`. Split on
 * the semicolons and drop the parentheticals and `he` is a whole-gloss match, which
 * is the difference between 他 and 怹 answering a search for "he".
 */
export function glossSenses(gloss: string): string[] {
  return gloss
    .split(';')
    .map((sense) => {
      let text = sense.trim();
      let previous = '';
      while (text !== previous) {
        previous = text;
        text = text.replace(/^\([^()]*\)\s*/, '').replace(/\s*\([^()]*\)$/, '').trim();
      }
      return text;
    })
    .filter(Boolean);
}

function equalSequence(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

function containsRun(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let i = 0; i <= haystack.length - needle.length; i += 1) {
    let hit = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) {
        hit = false;
        break;
      }
    }
    if (hit) return true;
  }
  return false;
}

/**
 * The gloss tiers of PLAN.md §3.2, best first:
 *   0 whole-gloss match (`plan` → "plan")
 *   1 the whole gloss once the grammar words are dropped (`plan` → "to plan")
 *   2 the query as a contiguous phrase inside a longer gloss
 *   3 the query's words scattered through a phrase
 * `Infinity` when the gloss does not match at all.
 */
export function glossTier(entry: DictEntry, queryWords: readonly string[]): number {
  const queryCore = queryWords.filter((word) => !GLOSS_STOPWORDS.has(word));
  let best = Infinity;
  for (const gloss of entry.glosses) {
    for (const sense of glossSenses(gloss)) {
      const senseWords = lemmas(sense);
      if (senseWords.length === 0) continue;
      if (equalSequence(senseWords, queryWords)) return 0;
      const senseCore = senseWords.filter((word) => !GLOSS_STOPWORDS.has(word));
      if (queryCore.length > 0 && equalSequence(senseCore, queryCore)) best = Math.min(best, 1);
      else if (containsRun(senseWords, queryWords)) best = Math.min(best, 2);
      else if (queryWords.every((word) => senseWords.includes(word))) best = Math.min(best, 3);
    }
  }
  return best;
}
