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
  /** The phrase itself, simplified. */
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
 * Render one validated phrase. Pure, and safe in the browser: the client calls
 * it with entries fetched from `/api/dict/entries`, which is what "cached
 * responses are re-resolved against the dictionary at render" means (§3.4).
 */
export function renderPhrase(
  phrase: Pick<GroundedSayIt, 'tokens' | 'en' | 'register'> & { unverified?: boolean },
  lookup: EntryLookup,
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
      text: entry?.simp ?? '',
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
    en: phrase.en,
    register: phrase.register,
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
 */
const CJK_RUN =
  /[　-〿㐀-䶿一-鿿豈-﫿＀-￯\u{20000}-\u{2a6df}\u{2a700}-\u{2ebef}\u{2f800}-\u{2fa1f}]+/gu;

/**
 * Take every CJK run out of a prose field and tidy the hole it leaves: the
 * model is not allowed to write a headword anywhere the dictionary did not.
 */
export function stripCjk(text: string): string {
  return text
    .replace(CJK_RUN, '')
    .replace(/[“"'‘]\s*[”"'’]/g, '')
    .replace(/\(\s*\)|\[\s*\]/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/([([])\s+/g, '$1')
    .trim();
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
 * characters are how an invented word (随看随买, 绝绝子) looks after
 * segmentation. But an ordinary sentence is also full of them (我看了一下), so
 * the flag only fires on a run of ≥2 singles that is *not* made entirely of the
 * most frequent grammatical words. jieba's rank is the measure: 我 is 8 and 了
 * is 1, while 随 is 904 and 绝 is 1834.
 *
 * PLAN.md §3.4 says "a run of ≥2 consecutive fallback single-chars"; taken
 * literally that catches nothing here, because 随, 看, 绝 and 子 are all real
 * headwords and segment as `via: 'entry'`. The rule is widened to consecutive
 * *single-character* tokens with the frequency escape hatch above; the plan's
 * fallback case is a subset of it. See HANDOFF-p4.md.
 */
export const COMMON_SINGLE_RANK = 100;

/** A single-char token glossed only as a pointer to another word is not a word. */
const NOT_A_WORD_GLOSS = /^(used in|variant of|old variant of|erhua variant of|see |abbr\.)/i;

const MAX_MATCHES = 8;
const MAX_SAYIT = 4;

interface Span {
  start: number;
  end: number;
}

/**
 * Which character spans of a rendered phrase are not verifiably Chinese words.
 * Exported for the unit tests, which assert on 随看随买 and 绝绝子 directly.
 */
export function unverifiedSpans(rendered: string, context: GroundContext): Span[] {
  const lookup = context.entry ?? entryLookup(context.retrieved);
  const tokens = context.segment(rendered).filter((token) => token.kind === 'word');
  const spans: Span[] = [];

  const isSingle = (token: Token): boolean => [...token.text].length === 1;
  const firstEntry = (token: Token): Entry | undefined =>
    token.entryIds.length > 0 ? lookup(token.entryIds[0]) : undefined;

  let run: Token[] = [];
  const closeRun = (): void => {
    if (run.length >= 2) {
      const allCommon = run.every((token) => {
        const entry = firstEntry(token);
        return entry !== undefined && (entry.freqRank ?? Number.MAX_SAFE_INTEGER) <= COMMON_SINGLE_RANK;
      });
      if (!allCommon) spans.push({ start: run[0].start, end: run[run.length - 1].end });
    }
    run = [];
  };

  for (const token of tokens) {
    // A hanzi the dictionary does not have at all: never verified.
    if (token.via === 'fallback') {
      spans.push({ start: token.start, end: token.end });
      run = isSingle(token) ? [...run, token] : [];
      continue;
    }
    const entry = firstEntry(token);
    if (isSingle(token) && entry && entry.glosses.length === 1 && NOT_A_WORD_GLOSS.test(entry.glosses[0])) {
      spans.push({ start: token.start, end: token.end });
    }
    if (isSingle(token)) run.push(token);
    else closeRun();
  }
  closeRun();

  return spans;
}

/**
 * Validate an answer against the dictionary. Returns what the client may render
 * and what the cache may store; nothing that survives can put a character on
 * screen that the dictionary did not supply.
 */
export function ground(response: RawAskResponse, context: GroundContext): GroundedAskResponse {
  const retrievedIds = new Set(context.retrieved.map((entry) => entry.id));
  const lookup = context.entry ?? entryLookup(context.retrieved);
  const readings = context.readings;

  const matches: GroundedMatch[] = [];
  for (const match of response.matches) {
    if (!retrievedIds.has(match.entryId)) continue;
    const entry = lookup(match.entryId);
    if (!entry) continue;
    if (!Number.isInteger(match.senseIndex)) continue;
    if (match.senseIndex < 0 || match.senseIndex >= entry.glosses.length) continue;
    matches.push({
      entryId: match.entryId,
      senseIndex: match.senseIndex,
      whyThisOne: stripCjk(match.whyThisOne),
    });
    if (matches.length >= MAX_MATCHES) break;
  }

  const sayIt: GroundedSayIt[] = [];
  for (const phrase of response.sayIt) {
    if (sayIt.length >= MAX_SAYIT) break;
    const tokens: GroundedToken[] = [];
    let usable = true;

    for (const token of phrase.tokens) {
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

    // Re-segment what will actually be on screen, not what the model said.
    const rendered = renderPhrase({ tokens, en: phrase.en, register: phrase.register }, lookup);
    const spans = unverifiedSpans(rendered.zh, context);
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
      en: phrase.en,
      register: phrase.register,
      unverified: tokens.some((token) => token.unverified === true),
    });
  }

  return {
    interpretation: stripCjk(response.interpretation),
    matches,
    sayIt,
    notes: response.notes.map(stripCjk).filter((note) => note.length > 0),
  };
}
