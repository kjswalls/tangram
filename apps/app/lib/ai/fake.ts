/**
 * `FakeProvider` (PLAN.md §3.4) — the default provider, and the only one that
 * has ever run in this container.
 *
 * It answers the demo set with canned prose and, for anything else, a
 * deterministic retrieval echo, so **no query ever renders an empty panel**.
 *
 * Two rules make the fake worth having rather than a stub:
 *
 *  - **It never invents an id.** Every citation is resolved at request time out
 *    of the entries the route retrieved, by simplified headword (and reading,
 *    where a polyphone would otherwise be ambiguous). A hard-coded
 *    `隨便|随便[sui2 bian4]` in a fixture would go stale the day the dictionary
 *    is rebuilt and would prove nothing about the pipeline; resolving it here
 *    means the demo exercises retrieval, grounding and rendering for real.
 *  - **A demo answer degrades to the echo.** If a word it wants is not in the
 *    retrieved set, the canned answer is abandoned rather than half-rendered.
 *
 * The prose is written to survive `stripCjk` — it contains no hanzi, because
 * grounding removes CJK runs from prose and a sentence built around one would
 * arrive at the panel with a hole in it.
 */

import type {
  AskContext,
  LLMProvider,
  ParsedAskResponse,
  ParsedExampleSentences,
  ParsedGradeRecall,
  ProposedPhrases,
} from '@/lib/ai/provider';
import type { Entry, LearnerProfile } from '@/lib/types';

/** How many entries the echo cites. */
export const ECHO_MATCHES = 5;

type Cite = (simp: string, pinyinNum?: string) => string | undefined;

interface DemoAnswer {
  /** Chinese the route should retrieve before `answer` runs. */
  candidates: string[];
  /** Returns undefined when a word it needs was not retrieved. */
  build: (cite: Cite) => ParsedAskResponse | undefined;
}

interface Demo {
  id: string;
  matches: (query: string, context: AskContext | undefined) => boolean;
  answer: DemoAnswer;
}

/**
 * Lowercased, tone marks and punctuation gone — "I'm" and "im" are one query,
 * and so are `dasuan`, `da3suan4` and `dǎsuàn` (§4, P1: tones are optional in
 * the box, so they have to be optional here too).
 */
function normalize(query: string): string {
  return query
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9　-鿿]+/gu, ' ')
    .trim();
}

function sentenceOf(context: AskContext | undefined): string {
  return context?.sentence ?? context?.question ?? '';
}

// ---------------------------------------------------------------------------
// The demo set (§3.4: an English sentence, a hanzi word in two contexts, a
// pinyin query, a reader tap)
// ---------------------------------------------------------------------------

const DEMOS: readonly Demo[] = [
  {
    id: 'just-browsing',
    matches: (query) => {
      const text = normalize(query);
      return (
        text.includes('just browsing') ||
        text.includes('just looking') ||
        (text.includes('browsing') && text.includes('say'))
      );
    },
    answer: {
      candidates: ['我随便看看', '我只是看看', '随便看看'],
      build: (cite) => {
        const wo = cite('我');
        const suibian = cite('随便');
        const kankan = cite('看看');
        const zhishi = cite('只是');
        if (!wo || !suibian || !kankan) return undefined;
        const sayIt = [
          {
            tokens: [{ entryId: wo }, { entryId: suibian }, { entryId: kankan }],
            en: 'I am just looking, thanks.',
            register: 'neutral, spoken',
          },
        ];
        if (zhishi) {
          sayIt.push({
            tokens: [{ entryId: wo }, { entryId: zhishi }, { entryId: kankan }],
            en: 'I am only looking.',
            register: 'neutral, slightly firmer',
          });
        }
        return {
          interpretation:
            'In a shop, the natural reply to an assistant is that you are only looking — not a translation of "browsing", which Chinese says with a casual doubled verb instead.',
          matches: [
            {
              entryId: suibian,
              senseIndex: 0,
              whyThisOne:
                'This is the "no particular aim" sense the English sentence is doing; the same word can mean careless, which is not what you want here.',
            },
            {
              entryId: kankan,
              senseIndex: 0,
              whyThisOne: 'The doubled verb is what makes a look brief and casual rather than an inspection.',
            },
          ],
          sayIt,
          notes: [
            'Doubling the verb is what makes it casual rather than curt.',
            'A shop assistant hears either line as polite; the first is the one you will hear back.',
          ],
        };
      },
    },
  },
  {
    id: 'kan-watch-over',
    matches: (query, context) => {
      const sentence = sentenceOf(context);
      return normalize(query) === '看' && /看着|看孩子|看住|看家/.test(sentence);
    },
    answer: {
      candidates: [],
      build: (cite) => {
        const kan1 = cite('看', 'kan1');
        const kan4 = cite('看', 'kan4');
        if (!kan1) return undefined;
        const matches = [
          {
            entryId: kan1,
            senseIndex: 0,
            whyThisOne:
              'Watching over someone is the first-tone reading — a different word from the one that means "to look at", and the sentence is asking for this one.',
          },
        ];
        if (kan4) {
          matches.push({
            entryId: kan4,
            senseIndex: 5,
            whyThisOne:
              'The fourth-tone reading carries a "look after" sense too, which is why the two are easy to confuse; the tone is what separates them.',
          });
        }
        return {
          interpretation:
            'Here the verb means to mind or watch over someone, so it takes the first tone rather than the everyday fourth-tone "look at".',
          matches,
          sayIt: [],
          notes: [
            'Same character, two readings, two words: the tone is the whole difference in meaning.',
          ],
        };
      },
    },
  },
  {
    id: 'kan-look-at',
    matches: (query, context) => normalize(query) === '看' && sentenceOf(context).length > 0,
    answer: {
      candidates: [],
      build: (cite) => {
        const kan4 = cite('看', 'kan4');
        if (!kan4) return undefined;
        return {
          interpretation:
            'This is the everyday fourth-tone verb: to look at something, here softened by the "have a quick look" ending that follows it.',
          matches: [
            {
              entryId: kan4,
              senseIndex: 0,
              whyThisOne:
                'The plain "to see, to look at" sense — the completed-action particle after it says a look was taken, not that anything was watched over.',
            },
          ],
          sayIt: [],
          notes: ['The measure phrase after the verb is what makes the look brief.'],
        };
      },
    },
  },
  {
    id: 'dasuan-pinyin',
    // `normalize` has already folded the tone marks away, so `dǎsuàn` arrives
    // here as `dasuan`.
    matches: (query) => ['dasuan', 'da3suan4'].includes(normalize(query).replace(/\s+/g, '')),
    answer: {
      candidates: ['我打算'],
      build: (cite) => {
        const dasuan = cite('打算');
        if (!dasuan) return undefined;
        const wo = cite('我');
        return {
          interpretation:
            'Typed as pinyin, this is the everyday verb for planning or intending to do something — it is also a noun, which is the sense a dictionary lists second.',
          matches: [
            {
              entryId: dasuan,
              senseIndex: 0,
              whyThisOne: 'The verb sense is the one a learner meets first: to plan, to intend to do something.',
            },
          ],
          sayIt: wo
            ? [
                {
                  tokens: [{ entryId: wo }, { entryId: dasuan }],
                  en: 'I plan to. / I intend to.',
                  register: 'neutral, spoken',
                },
              ]
            : [],
          notes: ['Tones are optional in the box: the toneless spelling finds the same word.'],
        };
      },
    },
  },
  {
    id: 'kaishi-reader-tap',
    matches: (query, context) => normalize(query) === '开始' && sentenceOf(context).length > 0,
    answer: {
      candidates: [],
      build: (cite) => {
        const kaishi = cite('开始');
        if (!kaishi) return undefined;
        return {
          interpretation:
            'Here the word is the verb "to begin", with the speaker proposing that the group start now rather than naming a beginning.',
          matches: [
            {
              entryId: kaishi,
              senseIndex: 0,
              whyThisOne:
                'The verb reading, not the noun "beginning", is what the suggestion particle at the end of the sentence asks for.',
            },
          ],
          sayIt: [],
          notes: ['The final particle turns a statement into a suggestion.'],
        };
      },
    },
  },
];

// ---------------------------------------------------------------------------

function citeFrom(retrieved: readonly Entry[]): Cite {
  return (simp, pinyinNum) => {
    const candidates = retrieved.filter((entry) => entry.simp === simp);
    if (candidates.length === 0) return undefined;
    if (pinyinNum) {
      const exact = candidates.find((entry) => entry.pinyinNum.replace(/\s+/g, '') === pinyinNum.replace(/\s+/g, ''));
      if (exact) return exact.id;
      return undefined;
    }
    // Retrieval order is already frequency-first; prefer a real word over a
    // variant or a proper noun so a citation never lands on "surname Sui".
    const best =
      candidates.find((entry) => !entry.isVariant && !entry.properNoun) ?? candidates[0];
    return best.id;
  };
}

/**
 * The echo: the dictionary answering in its own voice. It is not a pretend
 * model answer and does not read like one — the panel's offline badge says as
 * much, and this prose agrees with it.
 *
 * It **names** the top entry rather than quoting it. The panel already renders
 * every match from the dictionary rows the route returns, so repeating the
 * glosses here would add nothing on screen — and this string is the one the
 * client writes into `ask_cache`, which §3.4 and §5 say holds ids and indexes,
 * never dictionary text. An echo that recited its glosses made every non-demo
 * query a cache row full of CC-CEDICT.
 */
export function retrievalEcho(retrieved: readonly Entry[]): ParsedAskResponse {
  const top = retrieved.slice(0, ECHO_MATCHES);
  if (top.length === 0) {
    return {
      interpretation:
        'Nothing in the dictionary matched that. Try fewer words, the hanzi itself, or the pinyin — tones optional.',
      matches: [],
      sayIt: [],
      notes: [
        'Offline dictionary mode: this panel is the dictionary’s own ranking, not a model reading your question.',
      ],
    };
  }

  return {
    interpretation:
      'Offline: the closest dictionary entries are listed below, best first. With a key set, this is where an answer about your own sentence would go.',
    matches: top.map((entry) => ({ entryId: entry.id, senseIndex: 0, whyThisOne: 'dictionary match' })),
    sayIt: [],
    notes: [
      'Offline dictionary mode: this panel is the dictionary’s own ranking, not a model reading your question.',
    ],
  };
}

/** Which demo, if any, this query belongs to. Exported for the unit tests. */
export function findDemo(query: string, context?: AskContext): Demo | undefined {
  return DEMOS.find((demo) => demo.matches(query, context));
}

export class FakeProvider implements LLMProvider {
  readonly name = 'fake' as const;

  async proposePhrases(query: string, context?: AskContext): Promise<ProposedPhrases> {
    return { candidates: [...(findDemo(query, context)?.answer.candidates ?? [])] };
  }

  async answer(
    retrieved: readonly Entry[],
    _profile: LearnerProfile,
    query: string,
    context?: AskContext,
  ): Promise<ParsedAskResponse> {
    const demo = findDemo(query, context);
    const canned = demo?.answer.build(citeFrom(retrieved));
    return canned ?? retrievalEcho(retrieved);
  }

  async exampleSentences(
    entry: Entry,
    profile: LearnerProfile,
    _senseIndex?: number,
    support?: readonly Entry[],
  ): Promise<ParsedExampleSentences> {
    // The sense does not change which words the echo can cite; a live provider
    // is what makes a sentence about one gloss rather than another.
    return exampleEcho(entry, profile, support ?? []);
  }

  async gradeRecall(entry: Entry, answer: string, senseIndex?: number): Promise<ParsedGradeRecall> {
    return recallEcho(entry, answer, senseIndex);
  }
}

// ---------------------------------------------------------------------------
// Phase 6 item 1 — i+1 example sentences
// ---------------------------------------------------------------------------

/** How many sentences the offline echo offers when it has words to build with. */
export const EXAMPLE_SENTENCE_COUNT = 3;

/**
 * The prose beside each offline sentence. It says what it is rather than
 * pretending to be a translation, for the same reason `retrievalEcho` names the
 * top entries instead of quoting them: this string is what a caller writes into
 * `ask_cache`, and the cache holds no dictionary text (CLAUDE.md, §3.4).
 */
const EXAMPLE_LINES: readonly string[] = [
  'Offline: the word you are studying, beside one you already know. With a key set, a real sentence would stand here.',
  'Offline: a second pairing, drawn from the words the caller retrieved for you.',
  'Offline: a third pairing. The offline provider orders words; it does not compose Chinese.',
];

const EXAMPLE_ALONE =
  'Offline: nothing was retrieved to build a sentence from, so this is the word on its own.';

/** Known words lead, then the most frequent; the id breaks the last tie. */
function supportRank(entry: Entry, known: ReadonlySet<string>): number {
  const frequency = entry.freqRank ?? 500_000;
  return (known.has(entry.simp) ? 0 : 1_000_000) + frequency;
}

/**
 * The offline stand-in for i+1 sentences: the target entry plus the highest-
 * value words the caller retrieved, cited by id, one pairing per sentence.
 *
 * It is deliberately not pretending to write Chinese — the pairs are ordered
 * citations, and the panel's offline badge says as much. What it does
 * guarantee is the two things the pipeline above it needs: every token is an id
 * the caller supplied (so the i+1 filter and `ground()` have something real to
 * work on), and the result is **never empty** — a target entry with no support
 * still comes back as one single-token sentence.
 */
export function exampleEcho(
  entry: Entry,
  profile: LearnerProfile,
  support: readonly Entry[] = [],
): ParsedExampleSentences {
  const known = new Set(profile.knownSample);
  const seen = new Set<string>([entry.simp]);
  const pool: Entry[] = [];
  for (const candidate of [...support].sort(
    (a, b) => supportRank(a, known) - supportRank(b, known) || (a.id < b.id ? -1 : 1),
  )) {
    if (candidate.id === entry.id || seen.has(candidate.simp)) continue;
    if (candidate.properNoun || candidate.isVariant || candidate.surname) continue;
    seen.add(candidate.simp);
    pool.push(candidate);
    if (pool.length >= EXAMPLE_SENTENCE_COUNT) break;
  }

  if (pool.length === 0) {
    return { sentences: [{ tokens: [{ entryId: entry.id }], en: EXAMPLE_ALONE }] };
  }

  return {
    sentences: pool.map((word, index) => ({
      tokens: [{ entryId: word.id }, { entryId: entry.id }],
      en: EXAMPLE_LINES[index % EXAMPLE_LINES.length],
    })),
  };
}

// ---------------------------------------------------------------------------
// Phase 6 item 2 — free-recall grading
// ---------------------------------------------------------------------------

/**
 * Words that carry no meaning in a gloss. CC-CEDICT's own scaffolding
 * ("to …", "used in …", "sb"/"sth") is in here too, so "to plan" and "plan"
 * are the same answer.
 */
const RECALL_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'do', 'for', 'from', 'in', 'is', 'it', 'its',
  'of', 'on', 'one', 'or', 'sb', 'so', 'some', 'someone', 'something', 'sth', 'that', 'the',
  'this', 'to', 'used', 'with', 'you', 'your',
]);

/** Fold the endings an answer and a gloss are allowed to differ by. */
function stem(word: string): string {
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('es')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s')) return word.slice(0, -1);
  return word;
}

/** The meaning-bearing words of a piece of English, stemmed and deduped. */
export function recallWords(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!raw || RECALL_STOP_WORDS.has(raw)) continue;
    const word = stem(raw);
    if (word.length < 2 || seen.has(word)) continue;
    seen.add(word);
    out.push(word);
  }
  return out;
}

/**
 * One CC-CEDICT gloss is often a run of synonyms — "nearby; neighboring", "to
 * continue; to proceed with; to go on with". Each one is a complete answer on
 * its own, so they are scored separately: a learner who says "nearby" has
 * recalled 附近, and marking that 1-of-2 ("the gist is there", a 3) is the
 * grader under-reading a right answer. Scoring the whole run only makes sense
 * for a learner who lists every synonym in the dictionary.
 */
function synonyms(gloss: string): string[] {
  const parts = gloss
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : [gloss];
}

/** The glosses a grade is judged against: the chosen sense, or all of them. */
function gradedGlosses(entry: Entry, senseIndex?: number): string[] {
  if (
    senseIndex !== undefined &&
    Number.isInteger(senseIndex) &&
    senseIndex >= 0 &&
    senseIndex < entry.glosses.length
  ) {
    return [entry.glosses[senseIndex]];
  }
  return [...entry.glosses];
}

/**
 * The offline grade: how much of one gloss the answer actually covers, mapped
 * onto FSRS's 1–4.
 *
 * The score is the **best** single gloss rather than an average over all of
 * them, because an entry with eight senses is not eight things the learner
 * failed to say — recalling one of them is recalling the word. `why` counts
 * words; it never quotes the gloss, so nothing a caller caches from this
 * carries dictionary text, and it is plain ASCII prose, so the no-CJK rule
 * holds by construction.
 */
export function recallEcho(entry: Entry, answer: string, senseIndex?: number): ParsedGradeRecall {
  const said = new Set(recallWords(answer));
  const glosses = gradedGlosses(entry, senseIndex);

  let bestMatched = 0;
  let bestTotal = 0;
  let bestShare = 0;
  for (const gloss of glosses) {
    for (const meaning of synonyms(gloss)) {
      const words = recallWords(meaning);
      if (words.length === 0) continue;
      const matched = words.filter((word) => said.has(word)).length;
      const share = matched / words.length;
      // A longer meaning breaks a tie: covering 3 of 3 words says more than
      // covering 1 of 1, and both are a share of one.
      if (share > bestShare || (share === bestShare && matched > bestMatched) || bestTotal === 0) {
        bestShare = share;
        bestMatched = matched;
        bestTotal = words.length;
      }
    }
  }

  if (answer.trim().length === 0) {
    return {
      suggested: 1,
      why: 'Offline check: there was nothing typed to compare against this card, so it reads as a blank.',
    };
  }
  // Something *was* typed, and none of it is an English word this counter can
  // weigh: hanzi, pinyin, punctuation. Saying "nothing typed" here was a
  // statement about the learner that was simply false — it is what a
  // production card's near miss used to be told before that direction stopped
  // being routed here at all (lib/srs/direction.ts).
  if (said.size === 0) {
    return {
      suggested: 1,
      why: 'Offline check: none of what you typed is English the offline grader can weigh against this card, and it only counts word overlap. Grade it yourself.',
    };
  }
  if (bestTotal === 0 || bestMatched === 0) {
    return {
      suggested: 1,
      why: 'Offline check: none of the words you typed appear in the sense this card is about. Grade it yourself if the wording was just different.',
    };
  }

  const counted = `Offline check: your answer covers ${bestMatched} of the ${bestTotal} meaning-carrying words in the closest meaning this card lists`;
  if (bestShare >= 2 / 3) {
    return { suggested: 4, why: `${counted} — that reads as recalled.` };
  }
  if (bestShare >= 1 / 3) {
    return { suggested: 3, why: `${counted} — the gist is there.` };
  }
  return {
    suggested: 2,
    why: `${counted} — a thread of it came back, not the sense itself. This is word overlap, not understanding: override it if you had the meaning.`,
  };
}
