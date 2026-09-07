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

import type { AskContext, LLMProvider, ParsedAskResponse, ProposedPhrases } from '@/lib/ai/provider';
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
}
