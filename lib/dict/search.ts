/**
 * Search routing and ranking (PLAN.md §3.2).
 *
 * One box, no mode picker, so the router has to decide what the learner meant:
 *
 *   1. anything CJK          → hanzi: exact headwords, then prefixes, both scripts
 *   2. it parses as pinyin   → BOTH the pinyin and the gloss indexes, as labelled
 *                              sections whose order says which reading of the query
 *                              is more likely (`sun` is English, `dasuan` is pinyin)
 *   3. otherwise             → English glosses
 *
 * Results are grouped by headword (`trad|simp`), never by entry, so a polyphone
 * shows every reading it has instead of appearing three times: 了 is one result
 * carrying `le` and `liǎo`, which is also what makes "choose a reading" possible
 * on the way to a card.
 *
 * Everything here reads the indexes built in `lib/dict/index.ts`; nothing re-reads
 * `data/dict.json`.
 */
import { exactIds, getDictIndex, prefixIds, stemToken, type DictIndex, type SortedIndex } from './index';
import { normalizePinyin, type NormalizedPinyin } from './pinyin';
import type { DictEntry, EntryId, HskBand } from './types';

/** Which index answered. The UI labels every result with it. */
export type MatchSource = 'hanzi' | 'pinyin' | 'english';

/** Which router branch ran — useful in tests and in the API response. */
export type SearchRoute = 'hanzi' | 'pinyin+english' | 'english';

export interface SearchGroup {
  /** `trad|simp` — an entry id with the reading cut off. Stable, and the React key. */
  key: string;
  simp: string;
  trad: string;
  source: MatchSource;
  /** Ids that actually matched, best first. A subset of `entries`. */
  matchedIds: EntryId[];
  /** Every reading of this headword, matched ones first, then by frequency. */
  entries: DictEntry[];
  /** Lowest band among the readings, so the badge shows the easiest way in. */
  hskBand?: HskBand;
}

export interface SearchSection {
  source: MatchSource;
  /** Human label for the section header. */
  label: string;
  groups: SearchGroup[];
}

export interface SearchResult {
  query: string;
  route: SearchRoute;
  /** The capped page, in display order. `sections` is the same list, split up. */
  groups: SearchGroup[];
  sections: SearchSection[];
  /** Groups matched before the cap, so "showing 50 of 812" is honest. */
  total: number;
  /**
   * The CC-CEDICT snapshot these entries came from. It travels to the client
   * because `addCardFromEntry` stamps it onto the card snapshot, and a card that
   * cannot say which dictionary it was cut from cannot be re-checked later.
   */
  dictVersion: string;
  /** Results already shown before this page, summed over the sections. */
  offset: number;
  /** Pass back as `cursor` for the next page. Absent when this is the last one. */
  nextCursor?: string;
}

export interface SearchOptions {
  /** Groups per page. PLAN.md §3.2 caps a page at 50. */
  limit?: number;
  /** Opaque page marker from `nextCursor`. */
  cursor?: string;
}

export const SEARCH_PAGE_SIZE = 50;

const SECTION_LABELS: Record<MatchSource, string> = {
  hanzi: 'Hanzi',
  pinyin: 'Pinyin',
  english: 'English',
};

const MAX_HANZI_PREFIX_IDS = 400;
const MAX_PINYIN_PREFIX_IDS = 600;
/** Guard on one gloss token's posting list; the lists are frequency-ordered. */
const MAX_GLOSS_CANDIDATES = 5000;

const NO_BAND = 8;
const NO_RANK = Number.MAX_SAFE_INTEGER;

/**
 * CJK ideographs, including the extensions that live outside the BMP. Kept in one
 * place because `segment.ts` needs exactly the same answer to "is this hanzi".
 */
export const CJK_PATTERN =
  /[㐀-䶿一-鿿豈-﫿\u{20000}-\u{2A6DF}\u{2A700}-\u{2EBEF}\u{2F800}-\u{2FA1F}]/u;

export function hasCjk(text: string): boolean {
  return CJK_PATTERN.test(text);
}

// ---------------------------------------------------------------------------
// Headword prefix index
// ---------------------------------------------------------------------------

interface HeadwordIndexes {
  simp: SortedIndex;
  trad: SortedIndex;
}

/**
 * `bySimp`/`byTrad` are Maps, which cannot answer "starts with 打" without walking
 * 120k keys. Sorting them once per process buys a binary search instead; the
 * WeakMap keys off the index object, so a `resetDictCache()` drops this too.
 */
const HEADWORDS = new WeakMap<DictIndex, HeadwordIndexes>();

function toSorted(groups: Map<string, EntryId[]>): SortedIndex {
  const keys = [...groups.keys()].sort();
  return { keys, ids: keys.map((key) => groups.get(key) as EntryId[]) };
}

function headwords(index: DictIndex): HeadwordIndexes {
  let cached = HEADWORDS.get(index);
  if (!cached) {
    cached = { simp: toSorted(index.bySimp), trad: toSorted(index.byTrad) };
    HEADWORDS.set(index, cached);
  }
  return cached;
}

/**
 * Build the headword prefix indexes now, if this process has not already.
 *
 * `HEADWORDS` lives outside the `DICT_INDEX_PARTS` vocabulary, so a warm-up that
 * walks the index parts does not touch it and the first search of a session still
 * pays for it. `lib/dict/warm.ts` needs to force it, and a cache with a second
 * owner reaching into it from outside is a cache that quietly grows two
 * invalidation rules — so it asks here instead.
 *
 * Returns whether this call is the one that built it, which is what lets the
 * warm-up report work done rather than work intended.
 */
export function warmHeadwords(index: DictIndex): boolean {
  if (HEADWORDS.has(index)) return false;
  headwords(index);
  return true;
}

/** Whether this process has the headword prefix indexes for `index`. Diagnostic. */
export function headwordsWarm(index: DictIndex): boolean {
  return HEADWORDS.has(index);
}

// ---------------------------------------------------------------------------
// English glosses
// ---------------------------------------------------------------------------

/**
 * Words that carry no meaning of their own in a gloss. Dropping them is what makes
 * "to plan" the same shape as "plan" — one tier apart, not unrelated.
 */
const GLOSS_STOPWORDS = new Set(['to', 'a', 'an', 'the', 'be', 'of', 'sth', 'sb', "one's"]);

/**
 * The irregular plurals a learner actually types. `stemToken` handles `-s`, which
 * covers almost everything; without these, `women` misses 女人 and `people` misses
 * 人 — and PLAN.md §3.2 names `women` as a query that must work.
 */
const IRREGULAR: Record<string, string> = {
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

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9']+/g, ' ')
    .split(' ')
    .map((token) => token.replace(/^'+|'+$/g, ''))
    .filter(Boolean);
}

function lemmas(text: string): string[] {
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

/**
 * True when the raw query is itself an English **word** — the `sun`/`can`/`women`
 * rule.
 *
 * "Appears somewhere in a gloss" is not that test. `shi` appears as a token in
 * 39 glosses ("jiang shi" for 殭屍, "lüshi form" for 排律) because CC-CEDICT
 * romanises inside its English, and taking that as an English word buried 是,
 * 事, 十 — every HSK 1–2 reading of the syllable — under the reserved 16 rows of
 * a section that had nothing a learner typing `shi` wanted. So the query has to
 * be a whole *sense* of some entry (tier 0 or 1 of `glossTier`), which is what
 * "the English word" means: 太阳 is "sun", 女人 is "woman", and no entry is "shi".
 */
function isGlossToken(index: DictIndex, query: string): boolean {
  const token = query.trim().toLowerCase();
  if (!/^[a-z']{3,}$/.test(token)) return false;
  const queryWords = lemmas(token);
  if (queryWords.length === 0) return false;
  const forms = new Set([stemToken(token), lemma(token)]);
  for (const form of forms) {
    for (const id of (index.byGloss.get(form) ?? []).slice(0, MAX_GLOSS_CANDIDATES)) {
      const entry = index.entries.get(id);
      if (entry && glossTier(entry, queryWords) <= 1) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Candidate collection
// ---------------------------------------------------------------------------

interface Candidate {
  tier: number;
  matched: EntryId[];
  seen: Set<EntryId>;
}

/** Groups keyed by `trad|simp`, each keeping the best tier any of its readings hit. */
class Candidates {
  private readonly index: DictIndex;
  private readonly groups = new Map<string, Candidate>();

  constructor(index: DictIndex) {
    this.index = index;
  }

  add(id: EntryId, tier: number): void {
    const entry = this.index.entries.get(id);
    if (!entry) return;
    const key = `${entry.trad}|${entry.simp}`;
    const existing = this.groups.get(key);
    if (!existing) {
      this.groups.set(key, { tier, matched: [id], seen: new Set([id]) });
      return;
    }
    existing.tier = Math.min(existing.tier, tier);
    if (!existing.seen.has(id)) {
      existing.seen.add(id);
      existing.matched.push(id);
    }
  }

  addAll(ids: readonly EntryId[], tier: number): void {
    for (const id of ids) this.add(id, tier);
  }

  get size(): number {
    return this.groups.size;
  }

  entries(): [string, Candidate][] {
    return [...this.groups];
  }
}

function quality(entry: DictEntry): number {
  // PLAN.md §3.2: real words > variants > proper nouns.
  if (!entry.isVariant && !entry.properNoun) return 0;
  return entry.isVariant ? 1 : 2;
}

function buildGroup(
  index: DictIndex,
  key: string,
  candidate: Candidate,
  source: MatchSource,
): { group: SearchGroup; sortKey: [number, number, number, number, string] } {
  const [trad, simp] = key.split('|');
  // Every reading of the headword, in the index's frequency order, matched first.
  const all = (index.bySimp.get(simp) ?? []).filter(
    (id) => (index.entries.get(id) as DictEntry).trad === trad,
  );
  const matched = candidate.matched;
  const rest = all.filter((id) => !candidate.seen.has(id));
  const orderedIds = [...matched, ...rest];
  const entries = orderedIds.map((id) => index.entries.get(id) as DictEntry);
  const matchedEntries = matched.map((id) => index.entries.get(id) as DictEntry);

  let bestQuality = 3;
  let bestBand = NO_BAND;
  let bestRank = NO_RANK;
  for (const entry of matchedEntries) {
    bestQuality = Math.min(bestQuality, quality(entry));
    bestBand = Math.min(bestBand, entry.hskBand ?? NO_BAND);
    bestRank = Math.min(bestRank, entry.freqRank ?? NO_RANK);
  }
  const groupBand = entries.reduce<number>(
    (low, entry) => Math.min(low, entry.hskBand ?? NO_BAND),
    NO_BAND,
  );

  return {
    group: {
      key,
      simp,
      trad,
      source,
      matchedIds: matched,
      entries,
      ...(groupBand === NO_BAND ? {} : { hskBand: groupBand as HskBand }),
    },
    sortKey: [candidate.tier, bestQuality, bestBand, bestRank, key],
  };
}

function rank(index: DictIndex, candidates: Candidates, source: MatchSource): SearchGroup[] {
  const rows = candidates
    .entries()
    .map(([key, candidate]) => buildGroup(index, key, candidate, source));
  rows.sort((a, b) => {
    for (let i = 0; i < 4; i += 1) {
      const diff = (a.sortKey[i] as number) - (b.sortKey[i] as number);
      if (diff !== 0) return diff;
    }
    return a.sortKey[4] < b.sortKey[4] ? -1 : a.sortKey[4] > b.sortKey[4] ? 1 : 0;
  });
  return rows.map((row) => row.group);
}

// ---------------------------------------------------------------------------
// The three sources
// ---------------------------------------------------------------------------

function hanziGroups(index: DictIndex, query: string): SearchGroup[] {
  const candidates = new Candidates(index);
  candidates.addAll(index.bySimp.get(query) ?? [], 0);
  candidates.addAll(index.byTrad.get(query) ?? [], 0);
  const { simp, trad } = headwords(index);
  candidates.addAll(prefixIds(simp, query, MAX_HANZI_PREFIX_IDS), 1);
  candidates.addAll(prefixIds(trad, query, MAX_HANZI_PREFIX_IDS), 1);
  return rank(index, candidates, 'hanzi');
}

function pinyinGroups(index: DictIndex, pinyin: NormalizedPinyin): SearchGroup[] {
  const candidates = new Candidates(index);
  const toned = pinyin.syllables.some((syllable) => syllable.tone !== null);
  // Tone-exact beats toneless beats prefix (PLAN.md §3.2).
  if (toned) candidates.addAll(exactIds(index.byPinyinToned, pinyin.toned), 0);
  candidates.addAll(exactIds(index.byPinyinToneless, pinyin.toneless), 1);
  const prefixIndex = toned ? index.byPinyinToned : index.byPinyinToneless;
  const prefixKey = toned ? pinyin.toned : pinyin.toneless;
  candidates.addAll(prefixIds(prefixIndex, prefixKey, MAX_PINYIN_PREFIX_IDS), 2);
  return rank(index, candidates, 'pinyin');
}

function englishGroups(index: DictIndex, query: string): SearchGroup[] {
  const queryWords = lemmas(query);
  if (queryWords.length === 0) return [];

  // Candidates = entries whose glosses carry every word of the query. The posting
  // lists are frequency-ordered, so the guard keeps the words a learner is likeliest
  // to want rather than an arbitrary slice.
  let pool: EntryId[] | null = null;
  for (const word of queryWords) {
    const forms = new Set([stemToken(word), lemma(word)]);
    const ids = new Set<EntryId>();
    for (const form of forms) {
      for (const id of (index.byGloss.get(form) ?? []).slice(0, MAX_GLOSS_CANDIDATES)) ids.add(id);
    }
    pool = pool === null ? [...ids] : pool.filter((id) => ids.has(id));
    if (pool.length === 0) return [];
  }

  const candidates = new Candidates(index);
  for (const id of pool ?? []) {
    const entry = index.entries.get(id);
    if (!entry) continue;
    const tier = glossTier(entry, queryWords);
    if (Number.isFinite(tier)) candidates.add(id, tier);
  }
  return rank(index, candidates, 'english');
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/**
 * Which section leads when a query is both pinyin and English (PLAN.md §3.2).
 *
 * Typed tones are the one unambiguous signal, so they win outright. Failing that,
 * a query that is itself an English gloss token of three letters or more is far
 * likelier to be the English word than the syllable that spells the same
 * (`sun`, `can`, `women`); shorter ones (`he`, `ta`) are not, and two syllables or
 * an apostrophe mean the learner was writing pinyin.
 */
function pinyinFirst(index: DictIndex, query: string, pinyin: NormalizedPinyin): boolean {
  if (pinyin.syllables.some((syllable) => syllable.tone !== null)) return true;
  if (isGlossToken(index, query)) return false;
  // An apostrophe or a second syllable says "pinyin", and so does the fallback for
  // a one-syllable query that is not an English word at all (`ta`, `ni`), so the
  // two clauses PLAN.md §3.2 lists here agree: only the gloss-token rule flips it.
  return true;
}

function section(source: MatchSource, groups: SearchGroup[]): SearchSection {
  return { source, label: SECTION_LABELS[source], groups };
}

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
function dedupe(sections: SearchSection[]): SearchSection[] {
  if (sections.length < 2) return sections;
  const owner = new Map<string, { section: number; position: number }>();
  sections.forEach((part, index) =>
    part.groups.forEach((group, position) => {
      const held = owner.get(group.key);
      if (!held || position < held.position) owner.set(group.key, { section: index, position });
    }),
  );
  return sections.map((part, index) =>
    section(
      part.source,
      part.groups.filter((group) => owner.get(group.key)?.section === index),
    ),
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
function allocate(counts: readonly number[], limit: number): number[] {
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
function parseCursor(cursor: string | undefined, sections: number): number[] {
  const starts = new Array<number>(sections).fill(0);
  if (!cursor) return starts;
  cursor.split('.').forEach((part, i) => {
    const value = Number(part);
    if (i < sections && Number.isFinite(value) && value > 0) starts[i] = Math.floor(value);
  });
  return starts;
}

function paginate(
  query: string,
  route: SearchRoute,
  ordered: SearchSection[],
  options: SearchOptions,
  dictVersion: string,
): SearchResult {
  const limit = Math.max(1, options.limit ?? SEARCH_PAGE_SIZE);
  const starts = parseCursor(options.cursor, ordered.length);
  const rest = ordered.map((part, i) => part.groups.slice(starts[i]));
  const takes = allocate(rest.map((groups) => groups.length), limit);

  const ends = starts.map((start, i) => start + takes[i]);
  const sections = ordered
    .map((part, i) => section(part.source, rest[i].slice(0, takes[i])))
    .filter((part) => part.groups.length > 0);
  const total = ordered.reduce((sum, part) => sum + part.groups.length, 0);
  const more = ordered.some((part, i) => ends[i] < part.groups.length);

  return {
    query,
    route,
    groups: sections.flatMap((part) => part.groups),
    sections,
    total,
    dictVersion,
    offset: starts.reduce((sum, start) => sum + start, 0),
    ...(more ? { nextCursor: ends.join('.') } : {}),
  };
}

/**
 * The one entry point. Throws `DictDataMissingError` if `data/` was never built,
 * which the route turns into a 503.
 */
export function search(rawQuery: string, options: SearchOptions = {}): SearchResult {
  const query = rawQuery.trim();
  const index = getDictIndex();
  const version = index.meta.version;
  if (!query) return paginate(query, 'english', [], options, version);

  if (hasCjk(query)) {
    return paginate(query, 'hanzi', [section('hanzi', hanziGroups(index, query))], options, version);
  }

  const pinyin = normalizePinyin(query);
  if (pinyin.fullyParsed) {
    // Both sections always run; only their order is in question, and the loser
    // still shows — that is what makes `he` answer with 和 *and* 他.
    const asPinyin = section('pinyin', pinyinGroups(index, pinyin));
    const asEnglish = section('english', englishGroups(index, query));
    const ordered = dedupe(
      pinyinFirst(index, query, pinyin) ? [asPinyin, asEnglish] : [asEnglish, asPinyin],
    );
    return paginate(query, 'pinyin+english', ordered, options, version);
  }

  return paginate(query, 'english', [section('english', englishGroups(index, query))], options, version);
}
