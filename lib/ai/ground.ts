/**
 * Grounding (PLAN.md §3.4, step 3) — the file that makes the model's answer
 * safe to show.
 *
 * The dictionary is ground truth; the model writes the prose. So:
 *
 *  1. a `match` whose `entryId` is not in the retrieved set, or whose
 *     `senseIndex` is past the end of that entry's glosses, is **dropped**;
 *  2. a `sayIt` phrase is **rendered from its cited entries** — the hanzi and
 *     the pinyin come from the dictionary row, never from the model, so a
 *     response carrying a wrong reading cannot change a character on screen;
 *  3. a `{text}` token (the model's own string, no citation) is flagged
 *     `aiGenerated` on that token alone;
 *  4. the rendered phrase is **re-segmented** and anything that does not look
 *     like real Chinese words is flagged `unverified` (see `UNVERIFIED` below);
 *  5. CJK runs are stripped out of the prose fields, because prose is the one
 *     place the model writes freely and a hallucinated headword hiding in a
 *     sentence would bypass every rule above.
 *
 * Everything here is pure: segmentation and dictionary lookups arrive as
 * injected functions (`GroundContext`). That is deliberate — `lib/dict/segment`
 * pulls a 35 MB loader that must never reach the browser, and the ask panel
 * imports this module to re-render a cached answer.
 */

import { z } from 'zod';

import type { Entry, EntryId, Token } from '@/lib/types';

// ---------------------------------------------------------------------------
// The validated shape — what the client renders and what the cache stores
// ---------------------------------------------------------------------------

/** A cited dictionary entry. `polyphone` means the headword has several readings. */
export interface GroundedEntryToken {
  entryId: EntryId;
  text?: never;
  polyphone?: boolean;
  unverified?: boolean;
}

/** The model's own string: no dictionary row stands behind it. */
export interface GroundedTextToken {
  text: string;
  entryId?: never;
  aiGenerated: true;
  unverified?: boolean;
}

export type GroundedToken = GroundedEntryToken | GroundedTextToken;

export interface GroundedMatch {
  entryId: EntryId;
  senseIndex: number;
  whyThisOne: string;
}

export interface GroundedSayIt {
  tokens: GroundedToken[];
  en: string;
  register: string;
  /** True when any token is flagged — the UI warns once for the phrase. */
  unverified: boolean;
}

/**
 * The answer after validation. Ids, indexes and the model's prose — no
 * dictionary text — which is exactly what `ask_cache` may store (CLAUDE.md,
 * licence boundary). It re-renders against the dictionary at display time.
 */
export interface GroundedAskResponse {
  interpretation: string;
  matches: GroundedMatch[];
  sayIt: GroundedSayIt[];
  notes: string[];
}

const groundedTokenSchema = z.union([
  z.object({
    entryId: z.string().min(1),
    polyphone: z.boolean().optional(),
    unverified: z.boolean().optional(),
  }),
  z.object({
    text: z.string().min(1),
    // Defaulted, not optional: a token with no citation is by definition the
    // model's own, and rows written before this phase carry no flag.
    aiGenerated: z.literal(true).default(true),
    unverified: z.boolean().optional(),
  }),
]);

/**
 * Parses a validated answer back out of the cache. The flags are optional so
 * that rows written before this phase existed — the demo seed's two warm rows —
 * still parse and render.
 */
export const groundedAskResponseSchema = z.object({
  interpretation: z.string(),
  matches: z.array(
    z.object({
      entryId: z.string().min(1),
      senseIndex: z.number().int().min(0),
      whyThisOne: z.string(),
    }),
  ),
  sayIt: z.array(
    z.object({
      tokens: z.array(groundedTokenSchema),
      en: z.string(),
      register: z.string(),
      unverified: z.boolean().default(false),
    }),
  ),
  notes: z.array(z.string()),
});

// ---------------------------------------------------------------------------
// Rendering — the only place hanzi and pinyin come from
// ---------------------------------------------------------------------------

/** One token as the UI draws it. `missing` means the entry could not be resolved. */
export interface RenderedToken {
  text: string;
  pinyin: string;
  entryId?: EntryId;
  aiGenerated: boolean;
  polyphone: boolean;
  unverified: boolean;
  missing: boolean;
}

export interface RenderedPhrase {
  tokens: RenderedToken[];
  /** The phrase itself, in the script it was rendered in (simplified by default). */
  zh: string;
  /** Syllable-marked pinyin, one group per token. */
  pinyin: string;
  en: string;
  register: string;
  unverified: boolean;
}

export type EntryLookup = (id: EntryId) => Entry | undefined;

/** Index a list of entries by id, for `renderPhrase`. */
export function entryLookup(entries: readonly Entry[]): EntryLookup {
  const map = new Map<EntryId, Entry>(entries.map((entry) => [entry.id, entry]));
  return (id) => map.get(id);
}

/**
 * Which characters a rendered token shows. `'simp'` unless the learner asked
 * for traditional in /settings — the same preference `cardFace` honours on the
 * front of a review card (`lib/srs/presentation.ts`), threaded here so a
 * traditional learner is not handed a traditional card front over simplified
 * sentences.
 *
 * It is a display choice and nothing else: the entry, its id and its reading
 * are the same row either way, so the cache, the filter and the segmenter are
 * all untouched by it. `ground()` renders in `'simp'` on purpose — what it
 * builds is re-segmented against the simplified dictionary.
 */
export type PhraseScript = 'simp' | 'trad';

/**
 * Render one validated phrase. Pure, and safe in the browser: the client calls
 * it with entries fetched from `/api/dict/entries`, which is what "cached
 * responses are re-resolved against the dictionary at render" means (§3.4).
 */
export function renderPhrase(
  phrase: Pick<GroundedSayIt, 'tokens' | 'en' | 'register'> & { unverified?: boolean },
  lookup: EntryLookup,
  script: PhraseScript = 'simp',
): RenderedPhrase {
  const tokens: RenderedToken[] = phrase.tokens.map((token) => {
    if (token.entryId === undefined) {
      return {
        text: token.text ?? '',
        pinyin: '',
        aiGenerated: true,
        polyphone: false,
        unverified: token.unverified ?? true,
        missing: false,
      };
    }
    const entry = lookup(token.entryId);
    return {
      text: (script === 'trad' ? entry?.trad : entry?.simp) ?? '',
      pinyin: entry?.pinyinMarked ?? '',
      entryId: token.entryId,
      aiGenerated: false,
      polyphone: token.polyphone ?? false,
      unverified: token.unverified ?? false,
      missing: entry === undefined,
    };
  });

  return {
    tokens,
    zh: tokens.map((token) => token.text).join(''),
    pinyin: tokens
      .map((token) => token.pinyin)
      .filter(Boolean)
      .join(' '),
    // Scrubbed here as well as in `ground`: a cache row written before the
    // prose rules existed is re-rendered through this function, and `en` is
    // what a phrase card keeps on its back.
    en: scrubProse(phrase.en),
    register: scrubProse(phrase.register),
    // The phrase-level flag and the token-level flags are OR-ed rather than
    // preferred one over the other: a cached row from before this phase carries
    // neither, and an entry that has since gone missing is a reason to warn.
    unverified:
      (phrase.unverified ?? false) || tokens.some((token) => token.unverified || token.missing),
  };
}

// ---------------------------------------------------------------------------
// Prose: no CJK
// ---------------------------------------------------------------------------

/**
 * Ideographs plus the CJK punctuation and fullwidth forms that travel with
 * them. `lib/dict/search.ts` owns the same question for the dictionary; this
 * one is deliberately wider, because a stray 。 left behind by a stripped run
 * reads as a typo.
 *
 * It covers the lookalikes as well as the ideographs: Kangxi radicals (⼀ is
 * not 一 but renders identically), the CJK Radicals Supplement, Bopomofo — a
 * plausible thing for a model to reach for when a learner mentions Taiwan —
 * the enclosed forms, and Extensions G/H.
 */
const CJK_RUN =
  /[　-〿⺀-⿟㐀-䶿一-鿿豈-﫿＀-￯㄀-ㄯㆠ-ㆿ㈀-㋿\u{20000}-\u{2a6df}\u{2a700}-\u{2ebef}\u{2f800}-\u{2fa1f}\u{30000}-\u{323af}]+/gu;

/** Cosmetic repair after a run has been cut out of a sentence. */
function tidy(text: string): string {
  return text
    .replace(/[“"'‘]\s*[”"'’]/g, '')
    .replace(/\(\s*\)|\[\s*\]/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/([([])\s+/g, '$1')
    .replace(/^[\s,;:—–-]+/, '')
    .trim();
}

/**
 * Take every CJK run out of a prose field and tidy the hole it leaves: the
 * model is not allowed to write a headword anywhere the dictionary did not.
 */
export function stripCjk(text: string): string {
  return tidy(text.replace(CJK_RUN, ''));
}

/**
 * Every syllable CC-CEDICT actually uses, ü folded to u (so `lü` and `lu` are
 * one key here — this set decides "is this pinyin", not "which reading").
 * Derived from `data/dict.json` once and frozen into the source, because this
 * module has to stay pure and browser-safe.
 */
const PINYIN_SYLLABLES = new Set(
  (
    'a ai an ang ao ba bai ban bang bao bei ben beng bi bia bian biang biao bie bin bing biu bo bu ' +
    'ca cai can cang cao ce cen ceng cha chai chan chang chao che chen cheng chi chong chou chu chua ' +
    'chuai chuan chuang chui chun chuo ci cong cou cu cuan cue cui cun cuo da dai dan dang dao de dei ' +
    'den deng di dia dian diao die ding diu dong dou du duan dui dun duo e ei en eng er fa fan fang ' +
    'fei fen feng fiao fo fou fu ga gai gan gang gao ge gei gen geng ging gong gou gu gua guai guan ' +
    'guang gui gun guo ha hai han hang hao he hei hen heng hm hng hong hou hu hua huai huan huang hui ' +
    'hun huo ji jia jian jiang jiao jie jin jing jiong jiu ju juan jue jun ka kai kan kang kao ke kei ' +
    'ken keng kong kou ku kua kuai kuan kuang kui kun kuo la lai lan lang lao le lei leng li lia lian ' +
    'liang liao lie lin ling liu lo long lou lu luan lue lun luo ma mai man mang mao me mei men meng mi ' +
    'mian miao mie min ming miu mo mou mu na nai nan nang nao ne nei nen neng ni nian niang niao nie ' +
    'nin ning niu nong nou nu nuan nue nun nuo o ou pa pai pan pang pao pei pen peng pi pian piao pie ' +
    'pin ping po pou pu pua qi qia qian qiang qiao qie qin qing qiong qiu qu quan que qun ran rang rao ' +
    're ren reng ri rong rou ru rua ruan rui run ruo sa sai san sang sao se sei sen seng sha shai shan ' +
    'shang shao she shei shen sheng shi shou shu shua shuai shuan shuang shui shun shuo si song sou su ' +
    'suan sui sun suo ta tai tan tang tao te tei teng ti tian tiao tie ting tong tou tu tuan tui tun ' +
    'tuo wa wai wan wang wei wen weng wo wu xi xia xian xiang xiao xie xin xing xiong xiu xu xuan xue ' +
    'xun ya yan yang yao ye yi yin ying yo yong you yu yuan yue yun za zai zan zang zao ze zei zen zeng ' +
    'zha zhai zhan zhang zhao zhe zhei zhen zheng zhi zhong zhou zhu zhua zhuai zhuan zhuang zhui zhun ' +
    'zhuo zi zong zou zu zuan zui zun zuo'
  ).split(' '),
);

/** The longest syllable in the set (`shuang`, `zhuang`). */
const MAX_SYLLABLE = 6;

const LATIN_WORD = /\p{L}+[1-5]?/gu;
const COMBINING = /[\u0300-\u036f]/;

/** The word with its tone stripped: `suíbiān` → `suibian`, `sui1` → `sui`. */
function toneless(word: string): string {
  return word
    .replace(/[1-5]$/, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/** Does this word claim a *reading* — a tone mark or a tone digit? */
function carriesTone(word: string): boolean {
  return /[1-5]$/.test(word) || COMBINING.test(word.normalize('NFD'));
}

/** Can the whole word be read as a sequence of pinyin syllables? */
function isSyllableRun(word: string): boolean {
  const text = toneless(word);
  if (text.length === 0) return false;
  const reachable = new Array<boolean>(text.length + 1).fill(false);
  reachable[0] = true;
  for (let at = 0; at < text.length; at += 1) {
    if (!reachable[at]) continue;
    for (let take = 1; take <= MAX_SYLLABLE && at + take <= text.length; take += 1) {
      if (PINYIN_SYLLABLES.has(text.slice(at, at + take))) reachable[at + take] = true;
    }
  }
  return reachable[text.length];
}

/**
 * Take model-written pinyin out of a prose field.
 *
 * `stripCjk` covers the hanzi; this covers the other half of the same claim. A
 * learner cannot detect a wrong tone — that is why they are asking (§1) — so
 * "read it as suíbiān" and "pronounced sui1 bian1" are exactly as dangerous as
 * an invented headword, and the pinyin the UI *does* show is rendered from the
 * dictionary row (`renderPhrase`). The prompt already forbids pinyin in prose;
 * this is the half that does not depend on the model obeying.
 *
 * The trigger is a tone (a mark or a trailing digit), never bare letters: half
 * the English language is a legal toneless syllable (`men`, `hen`, `long`) and
 * deleting those would shred the prose. A tone-bearing syllable run takes its
 * untoned neighbours with it, so `kán kan` goes whole rather than leaving `kan`
 * behind.
 */
export function stripPinyin(text: string): string {
  const words: { start: number; end: number; syllabic: boolean; toned: boolean }[] = [];
  for (const match of text.matchAll(LATIN_WORD)) {
    const word = match[0];
    const start = match.index ?? 0;
    words.push({
      start,
      end: start + word.length,
      syllabic: isSyllableRun(word),
      toned: carriesTone(word),
    });
  }

  const cuts: { start: number; end: number }[] = [];
  let run: typeof words = [];
  const close = (): void => {
    if (run.length > 0 && run.some((word) => word.toned)) {
      cuts.push({ start: run[0].start, end: run[run.length - 1].end });
    }
    run = [];
  };
  for (const word of words) {
    const previous = run[run.length - 1];
    // Only whitespace, an apostrophe or a hyphen may sit inside one run: a
    // comma or a full stop ends it, so a sentence is never swallowed whole.
    const joined = previous !== undefined && /^[\s'’-]*$/.test(text.slice(previous.end, word.start));
    if (!word.syllabic) {
      close();
      continue;
    }
    if (!joined) close();
    run.push(word);
  }
  close();

  let out = '';
  let cursor = 0;
  for (const cut of cuts) {
    out += text.slice(cursor, cut.start);
    cursor = cut.end;
  }
  out += text.slice(cursor);
  return tidy(out);
}

/** How much prose one field may carry. A provider is not a novelist. */
export const MAX_PROSE_CHARS = 2000;

/**
 * The whole prose contract in one call: no hanzi, no readings, and bounded.
 * Every prose field the model writes goes through it.
 */
export function scrubProse(text: string): string {
  return stripPinyin(stripCjk(text)).slice(0, MAX_PROSE_CHARS);
}

/** A note that lost its sentence to the scrubber has nothing left to say. */
function isSayable(note: string): boolean {
  return /\p{L}{3,}/u.test(note);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface GroundContext {
  /** The entries the route retrieved. A citation outside this set is dropped. */
  retrieved: readonly Entry[];
  /** `lib/dict/segment`, injected. Called on each rendered phrase. */
  segment: (text: string) => Token[];
  /** Any dictionary entry by id — the segmenter returns ids beyond `retrieved`. */
  entry?: EntryLookup;
  /** How many readings the dictionary has for a simplified headword. */
  readings?: (simp: string) => number;
}

/** The unvalidated answer, as a provider returns it. */
export interface RawAskResponse {
  interpretation: string;
  matches: { entryId: string; senseIndex: number; whyThisOne: string }[];
  sayIt: { tokens: ({ entryId?: string; text?: string })[]; en: string; register: string }[];
  notes: string[];
}

/**
 * A single character is weak evidence on its own: strung together, single
 * characters are how an invented word looks after segmentation. But an ordinary
 * sentence is also full of them, so the run rule fires only where the model was
 * *not* pointing at a dictionary row.
 *
 * PLAN.md §3.4 says "a run of ≥2 consecutive fallback single-chars"; taken
 * literally that catches nothing in the two cases the same paragraph demands be
 * flagged, because 随, 看, 绝 and 子 are all real headwords and segment as
 * `via: 'entry'`. So there are two run rules, not one:
 *
 *  - **Uncited singles** (a `{text}` token the segmenter split, a `via:
 *    'fallback'` character): a run of ≥2 is flagged unless every character in it
 *    is among the ~100 most frequent words. This is the plan's rule, widened
 *    from `fallback` to "the dictionary was not cited here".
 *  - **Cited singles**: a citation is a dictionary row, so a run of them is
 *    flagged only on the shape that says "compound", not on the shape that says
 *    "sentence" — a character repeated within two positions (随看随买, 绝绝子),
 *    minus the two reduplications Chinese actually forms that way (看看, 看一看).
 *
 * The earlier version of this file applied the frequency rule to cited runs as
 * well, which flagged 太贵了, 我爱你 and 我很累 — 12 of 30 everyday phrases —
 * and a warning that fires on 我 and 了 teaches a learner to ignore warnings.
 * Frequency cannot separate 随 (904) from 贵 (1957); repetition can.
 */
export const COMMON_SINGLE_RANK = 100;

/** A single-char token glossed only as a pointer to another word is not a word. */
const NOT_A_WORD_GLOSS = /^(used in|variant of|old variant of|erhua variant of|see |abbr\.)/i;

const MAX_MATCHES = 8;
const MAX_SAYIT = 4;
/** Notes are a footnote, not a chapter. */
const MAX_NOTES = 8;
/**
 * A phrase is a sentence somebody could say out loud.
 *
 * Over this length the phrase is **dropped, not trimmed**. Slicing it looks
 * like the safe move and is the opposite: a trimmed phrase still carries the
 * model's `en` for the whole sentence, so what reaches the screen is half a
 * sentence advertised as a complete one — and every rule below (a citation
 * outside the retrieved set, an uncited `{text}` run) would stop applying to
 * whatever sat past the cut. `lib/ai/examples.ts` states "shown whole or not at
 * all" as an absolute; this is where that is either true or a lie.
 */
export const MAX_PHRASE_TOKENS = 32;

export interface Span {
  start: number;
  end: number;
}

/** AA (看看) and A一A (看一看) are how Chinese reduplicates a verb, not invention. */
function isReduplication(run: readonly Token[]): boolean {
  if (run.length === 2 && run[0].text === run[1].text) return true;
  return run.length === 3 && run[1].text === '一' && run[0].text === run[2].text;
}

/** A character that comes back within two positions: 绝绝子, 随看随买. */
function hasNearRepeat(run: readonly Token[]): boolean {
  for (let i = 0; i < run.length; i += 1) {
    for (let j = i + 1; j <= i + 2 && j < run.length; j += 1) {
      if (run[i].text === run[j].text) return true;
    }
  }
  return false;
}

/**
 * Which character spans of a rendered phrase are not verifiably Chinese words.
 * `cited` are the spans the model cited by id — verified by construction, and
 * the reason an ordinary phrase built out of cited words is left alone.
 *
 * Exported for the unit tests, which assert on 随看随买 and 绝绝子 directly.
 */
export function unverifiedSpans(
  rendered: string,
  context: GroundContext,
  cited: readonly Span[] = [],
): Span[] {
  const lookup = context.entry ?? entryLookup(context.retrieved);
  const tokens = context.segment(rendered).filter((token) => token.kind === 'word');
  const spans: Span[] = [];

  const isSingle = (token: Token): boolean => [...token.text].length === 1;
  const isCited = (token: Token): boolean =>
    cited.some((span) => span.start === token.start && span.end === token.end);
  const firstEntry = (token: Token): Entry | undefined =>
    token.entryIds.length > 0 ? lookup(token.entryIds[0]) : undefined;

  let run: Token[] = [];
  let runCited = false;
  const closeRun = (): void => {
    if (run.length >= 2) {
      if (runCited) {
        if (hasNearRepeat(run) && !isReduplication(run)) {
          spans.push({ start: run[0].start, end: run[run.length - 1].end });
        }
      } else {
        const allCommon = run.every((token) => {
          const entry = firstEntry(token);
          return (
            entry !== undefined && (entry.freqRank ?? Number.MAX_SAFE_INTEGER) <= COMMON_SINGLE_RANK
          );
        });
        if (!allCommon) spans.push({ start: run[0].start, end: run[run.length - 1].end });
      }
    }
    run = [];
  };

  for (const token of tokens) {
    const previous = run[run.length - 1];
    // A run is characters standing next to each other. Punctuation between two
    // singles (dropped with the `text` tokens above) ends it.
    if (previous !== undefined && previous.end !== token.start) closeRun();

    // A hanzi the dictionary does not have at all: never verified.
    if (token.via === 'fallback') {
      spans.push({ start: token.start, end: token.end });
      if (isSingle(token)) {
        if (runCited) closeRun();
        runCited = false;
        run.push(token);
      } else {
        closeRun();
      }
      continue;
    }

    const entry = firstEntry(token);
    if (
      isSingle(token) &&
      entry &&
      entry.glosses.length === 1 &&
      NOT_A_WORD_GLOSS.test(entry.glosses[0])
    ) {
      spans.push({ start: token.start, end: token.end });
    }

    if (isSingle(token)) {
      const cite = isCited(token);
      // Citedness is what the two run rules differ on, so a run never mixes.
      if (run.length > 0 && cite !== runCited) closeRun();
      runCited = cite;
      run.push(token);
    } else {
      closeRun();
    }
  }
  closeRun();

  return spans;
}

/**
 * Validate an answer against the dictionary. Returns what the client may render
 * and what the cache may store; nothing that survives can put a character on
 * screen — or a reading in a sentence — that the dictionary did not supply.
 */
export function ground(response: RawAskResponse, context: GroundContext): GroundedAskResponse {
  const retrievedIds = new Set(context.retrieved.map((entry) => entry.id));
  const lookup = context.entry ?? entryLookup(context.retrieved);
  const readings = context.readings;

  const matches: GroundedMatch[] = [];
  const seenMatches = new Set<string>();
  for (const match of response.matches) {
    if (!retrievedIds.has(match.entryId)) continue;
    const entry = lookup(match.entryId);
    if (!entry) continue;
    if (!Number.isInteger(match.senseIndex)) continue;
    if (match.senseIndex < 0 || match.senseIndex >= entry.glosses.length) continue;
    // The panel keys on this pair, and two cards for one sense is not an answer.
    const key = `${match.entryId}#${match.senseIndex}`;
    if (seenMatches.has(key)) continue;
    seenMatches.add(key);
    matches.push({
      entryId: match.entryId,
      senseIndex: match.senseIndex,
      whyThisOne: scrubProse(match.whyThisOne),
    });
    if (matches.length >= MAX_MATCHES) break;
  }

  const sayIt: GroundedSayIt[] = [];
  for (const phrase of response.sayIt) {
    if (sayIt.length >= MAX_SAYIT) break;
    const tokens: GroundedToken[] = [];
    // A phrase longer than the cap is not shortened into one that fits: see
    // `MAX_PHRASE_TOKENS`. Nothing downstream could tell the difference between
    // a sentence the model wrote and the first 32 tokens of one.
    let usable = phrase.tokens.length <= MAX_PHRASE_TOKENS;

    for (const token of usable ? phrase.tokens : []) {
      if (token.entryId !== undefined) {
        // A citation outside the retrieved set is the failure mode this whole
        // file exists for. The phrase cannot be rendered without it, so the
        // phrase goes — a hole in the middle of a sentence teaches nothing.
        if (!retrievedIds.has(token.entryId)) {
          usable = false;
          break;
        }
        const entry = lookup(token.entryId);
        if (!entry) {
          usable = false;
          break;
        }
        const polyphone = (readings?.(entry.simp) ?? 0) > 1;
        tokens.push({ entryId: token.entryId, ...(polyphone ? { polyphone: true } : {}) });
        continue;
      }
      if (typeof token.text === 'string' && token.text.length > 0) {
        tokens.push({ text: token.text, aiGenerated: true, unverified: true });
        continue;
      }
      usable = false;
      break;
    }

    if (!usable || tokens.length === 0) continue;

    // `en` and `register` are prose the model wrote, and prose is where a
    // hallucinated headword or a wrong tone hides from every rule above: the
    // panel prints them as plain text and the phrase card keeps `en` on its
    // back. A phrase whose English gloss was nothing but hanzi has no English.
    const en = scrubProse(phrase.en);
    const register = scrubProse(phrase.register);
    if (en.length === 0) continue;

    // Re-segment what will actually be on screen, not what the model said.
    const rendered = renderPhrase({ tokens, en, register }, lookup);
    const cited: Span[] = [];
    let at = 0;
    for (const [i, token] of tokens.entries()) {
      const end = at + rendered.tokens[i].text.length;
      if (token.entryId !== undefined && end > at) cited.push({ start: at, end });
      at = end;
    }

    const spans = unverifiedSpans(rendered.zh, context, cited);
    if (spans.length > 0) {
      let cursor = 0;
      for (const [i, token] of tokens.entries()) {
        const start = cursor;
        const end = start + rendered.tokens[i].text.length;
        cursor = end;
        if (end === start) continue;
        if (spans.some((span) => span.start < end && span.end > start)) token.unverified = true;
      }
    }

    sayIt.push({
      tokens,
      en,
      register,
      unverified: tokens.some((token) => token.unverified === true),
    });
  }

  return {
    interpretation: scrubProse(response.interpretation),
    matches,
    sayIt,
    notes: response.notes.map(scrubProse).filter(isSayable).slice(0, MAX_NOTES),
  };
}
