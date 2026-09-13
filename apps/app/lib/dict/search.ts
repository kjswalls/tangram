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
import { exactIds, getDictIndex, prefixIds, type DictIndex, type SortedIndex } from './index';
import { normalizePinyin, type NormalizedPinyin } from './pinyin';
import {
  CandidateSet,
  SECTION_LABELS,
  dedupeSections,
  hasCjk,
  materialise,
  pageWindow,
  stemToken,
  type GroupCandidate,
  type MatchSource,
} from './rank';
import type { DictEntry, EntryId, HskBand } from './types';

/**
 * The grouping, the five-key sort, the section allocation and the cursor are
 * `lib/dict/rank.ts`'s, shared with `lib/dict/sqlite-store.ts` (data.md D2).
 * The two implementations differ in which rows are candidates — that is what
 * D2's and D3's differential tests are for — and must not differ in what
 * happens to them afterwards.
 */
export { CJK_PATTERN, hasCjk, SEARCH_PAGE_SIZE } from './rank';
export type { MatchSource } from './rank';

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
  /**
   * Drop a superseded keystroke's work rather than rendering it
   * (docs/plans/data.md D2). Ignored by the JSON implementation, which is
   * synchronous; honoured by `lib/dict/sqlite-store.ts` and passed to the
   * runner, where on the Capacitor bridge it is the difference between a queued
   * round trip and a cancelled one.
   *
   * It rides in the options rather than as a third parameter because
   * `DictStore.search` is a frozen surface with two (data.md D1's first commit)
   * and `SearchOptions` is this layer's own.
   */
  signal?: AbortSignal;
}

const MAX_HANZI_PREFIX_IDS = 400;
const MAX_PINYIN_PREFIX_IDS = 600;
/** Guard on one gloss token's posting list; the lists are frequency-ordered. */
const MAX_GLOSS_CANDIDATES = 5000;

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

/**
 * Grouping, the five-key sort and materialisation are `lib/dict/rank.ts`'s,
 * shared with the store. This side only has to turn ids into the eight facts
 * ranking needs, and to say which readings a headword has — both of which the
 * index answers directly.
 */
function collect(index: DictIndex, ids: readonly EntryId[], tier: number, into: CandidateSet): void {
  for (const id of ids) {
    const entry = index.entries.get(id);
    if (!entry) continue;
    into.add(
      {
        id: entry.id,
        simp: entry.simp,
        trad: entry.trad,
        isVariant: entry.isVariant,
        properNoun: entry.properNoun,
        ...(entry.hskBand === undefined ? {} : { hskBand: entry.hskBand }),
        ...(entry.freqRank === undefined ? {} : { freqRank: entry.freqRank }),
      },
      tier,
    );
  }
}

/** Every reading of one headword, in the index's frequency order. */
function readingsOf(index: DictIndex, candidate: GroupCandidate): DictEntry[] {
  return (index.bySimp.get(candidate.simp) ?? [])
    .map((id) => index.entries.get(id) as DictEntry)
    .filter((entry) => entry.trad === candidate.trad);
}

function toGroup(index: DictIndex, candidate: GroupCandidate, source: MatchSource): SearchGroup {
  return materialise(candidate, readingsOf(index, candidate), source);
}

// ---------------------------------------------------------------------------
// The three sources
// ---------------------------------------------------------------------------

function hanziCandidates(index: DictIndex, query: string): GroupCandidate[] {
  const candidates = new CandidateSet();
  collect(index, index.bySimp.get(query) ?? [], 0, candidates);
  collect(index, index.byTrad.get(query) ?? [], 0, candidates);
  const { simp, trad } = headwords(index);
  collect(index, prefixIds(simp, query, MAX_HANZI_PREFIX_IDS), 1, candidates);
  collect(index, prefixIds(trad, query, MAX_HANZI_PREFIX_IDS), 1, candidates);
  return candidates.ordered();
}

function pinyinCandidates(index: DictIndex, pinyin: NormalizedPinyin): GroupCandidate[] {
  const candidates = new CandidateSet();
  const toned = pinyin.syllables.some((syllable) => syllable.tone !== null);
  // Tone-exact beats toneless beats prefix (PLAN.md §3.2).
  if (toned) collect(index, exactIds(index.byPinyinToned, pinyin.toned), 0, candidates);
  collect(index, exactIds(index.byPinyinToneless, pinyin.toneless), 1, candidates);
  const prefixIndex = toned ? index.byPinyinToned : index.byPinyinToneless;
  const prefixKey = toned ? pinyin.toned : pinyin.toneless;
  collect(index, prefixIds(prefixIndex, prefixKey, MAX_PINYIN_PREFIX_IDS), 2, candidates);
  return candidates.ordered();
}

function englishCandidates(index: DictIndex, query: string): GroupCandidate[] {
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

  const candidates = new CandidateSet();
  for (const id of pool ?? []) {
    const entry = index.entries.get(id);
    if (!entry) continue;
    const tier = glossTier(entry, queryWords);
    if (!Number.isFinite(tier)) continue;
    collect(index, [id], tier, candidates);
  }
  return candidates.ordered();
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

interface CandidateSection {
  source: MatchSource;
  candidates: GroupCandidate[];
}

/**
 * Rank, dedupe, page, and only then attach entries.
 *
 * The order matters and is shared with the store: deduping before paging is what
 * stops page 2 repeating page 1, and materialising after paging is what lets the
 * store fetch full rows for ≤50 groups instead of up to 5,000. Here every entry
 * is already in memory, so materialising late costs nothing and keeps the two
 * implementations the same shape.
 */
function paginate(
  query: string,
  route: SearchRoute,
  ordered: readonly CandidateSection[],
  options: SearchOptions,
  dictVersion: string,
  index: DictIndex,
): SearchResult {
  const deduped = dedupeSections(ordered.map((part) => part.candidates));
  const window = pageWindow(
    deduped.map((groups) => groups.length),
    options,
  );
  const sections: SearchSection[] = [];
  deduped.forEach((groups, i) => {
    const { start, end } = window.slices[i];
    const page = groups.slice(start, end);
    if (page.length === 0) return;
    sections.push({
      source: ordered[i].source,
      label: SECTION_LABELS[ordered[i].source],
      groups: page.map((candidate) => toGroup(index, candidate, ordered[i].source)),
    });
  });

  return {
    query,
    route,
    groups: sections.flatMap((part) => part.groups),
    sections,
    total: window.total,
    dictVersion,
    offset: window.offset,
    ...(window.nextCursor === undefined ? {} : { nextCursor: window.nextCursor }),
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
  if (!query) return paginate(query, 'english', [], options, version, index);

  if (hasCjk(query)) {
    return paginate(
      query,
      'hanzi',
      [{ source: 'hanzi', candidates: hanziCandidates(index, query) }],
      options,
      version,
      index,
    );
  }

  const pinyin = normalizePinyin(query);
  if (pinyin.fullyParsed) {
    // Both sections always run; only their order is in question, and the loser
    // still shows — that is what makes `he` answer with 和 *and* 他.
    const asPinyin: CandidateSection = {
      source: 'pinyin',
      candidates: pinyinCandidates(index, pinyin),
    };
    const asEnglish: CandidateSection = {
      source: 'english',
      candidates: englishCandidates(index, query),
    };
    const ordered = pinyinFirst(index, query, pinyin) ? [asPinyin, asEnglish] : [asEnglish, asPinyin];
    return paginate(query, 'pinyin+english', ordered, options, version, index);
  }

  return paginate(
    query,
    'english',
    [{ source: 'english', candidates: englishCandidates(index, query) }],
    options,
    version,
    index,
  );
}
