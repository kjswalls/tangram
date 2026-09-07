/**
 * The demo seed (PLAN.md §4 P3). `loadDemo()` builds the state the morning demo
 * needs in one call: HSK 1–2 declared known, eight cards carrying provenance
 * from every source there is, a backdated review history so the queue is not
 * empty, a paragraph to read, and two warm ask-cache rows.
 *
 * Everything comes from the real dictionary through an `EntrySource`, so the
 * seed is a description of a learner, not a fixture of invented Chinese. It
 * wipes first: a demo that lands on top of half a database is not a demo.
 */

import type { CardRow, Repository, SettingsRow } from '@/lib/db';
import { sha1Hex } from '@/lib/dev/sha1';
import { getEntrySource, type EntrySource } from '@/lib/lists/entry-source';
import { addCardTracked } from '@/lib/lists/looked-up';
import { ensureSystemLists } from '@/lib/lists/system-lists';
import { wordState } from '@/lib/srs/states';
import type { CardContext, ContextSource, Entry, EntryId, HskBand } from '@/lib/types';

const DAY_MS = 86_400_000;

export const DEMO_TEXT_TITLE = '我的一天';

/** ~150 characters of plain modern Chinese about a day, at roughly HSK 3. */
export const DEMO_PARAGRAPH =
  '我每天早上七点起床，先喝一杯水，然后去公园跑步。跑完步回家吃早饭，一般是鸡蛋和面包。' +
  '八点半我骑自行车去上班，路上大概要二十分钟。中午我和同事一起在公司附近的饭馆吃饭，' +
  '下午继续工作。晚上下班以后，我喜欢在家做饭，有时候也会跟朋友出去看电影。' +
  '周末我常常打扫房间、洗衣服，然后去超市买东西。';

/** Bands the demo learner has already been through. */
export const DEMO_KNOWN_BANDS: readonly HskBand[] = [1, 2];

/** The band the demo's own cards come from, so "known" and "studying" stay disjoint. */
export const DEMO_CARD_BAND: HskBand = 3;

interface DemoCardSpec {
  entryId: EntryId;
  source: ContextSource;
  /** Days ago and rating for each replayed review, oldest first. */
  reviews?: { daysAgo: number; rating: 1 | 2 | 3 | 4 }[];
  question?: string;
  query?: string;
}

/**
 * Ids are CC-CEDICT's natural key and stable across snapshots, so naming them
 * is safe; anything the dictionary no longer has is replaced by the next
 * band-3 word, which is what keeps the seed from ever producing zero cards.
 */
const DEMO_CARDS: readonly DemoCardSpec[] = [
  // Read in the paragraph below — the review back shows the sentence.
  { entryId: '跑步|跑步[pao3 bu4]', source: 'reader', reviews: [{ daysAgo: 12, rating: 3 }] },
  { entryId: '繼續|继续[ji4 xu4]', source: 'reader', reviews: [{ daysAgo: 10, rating: 3 }] },
  // Looked up by hand.
  { entryId: '大概|大概[da4 gai4]', source: 'lookup', query: '大概', reviews: [{ daysAgo: 6, rating: 2 }] },
  {
    entryId: '需要|需要[xu1 yao4]',
    source: 'lookup',
    query: 'xuyao',
    reviews: [
      { daysAgo: 240, rating: 4 },
      { daysAgo: 120, rating: 4 },
    ],
  },
  // Asked about.
  {
    entryId: '開始|开始[kai1 shi3]',
    source: 'ask',
    question: 'how do I say something is about to start?',
    reviews: [{ daysAgo: 30, rating: 4 }],
  },
  // Drawn from a list, never studied: these are today's new words.
  { entryId: '決定|决定[jue2 ding4]', source: 'list' },
  { entryId: '情況|情况[qing2 kuang4]', source: 'list' },
  { entryId: '世界|世界[shi4 jie4]', source: 'seed' },
];

/** Sentence bounds per §3.5, so a reader card's context is the real sentence. */
export function sentenceAround(text: string, word: string): { sentence: string; offset: number } | null {
  const at = text.indexOf(word);
  if (at < 0) return null;
  const breaks = /[。！？；…\n.!?]/;
  let start = 0;
  for (let i = at; i > 0; i -= 1) {
    if (breaks.test(text[i - 1])) {
      start = i;
      break;
    }
  }
  let end = text.length;
  for (let i = at; i < text.length; i += 1) {
    if (breaks.test(text[i])) {
      end = i + 1;
      break;
    }
  }
  const sentence = text.slice(start, end).trim();
  return { sentence, offset: sentence.indexOf(word) };
}

export const DEMO_PROMPT_VERSION = 'v1';

/**
 * The plan's key is `sha1(promptVersion, provider, query, context, estimatedBand)`
 * (§3.4). Phase 4 owns the real derivation — when it lands, this should be
 * replaced by an import of it rather than kept in step by hand (HANDOFF-p3.md).
 */
export function demoAskCacheKey(input: {
  query: string;
  context?: string;
  estimatedBand: number;
  provider?: string;
  promptVersion?: string;
}): string {
  return sha1Hex(
    JSON.stringify([
      input.promptVersion ?? DEMO_PROMPT_VERSION,
      input.provider ?? 'fake',
      input.query,
      input.context ?? '',
      input.estimatedBand,
    ]),
  );
}

interface DemoAskEntry {
  query: string;
  context?: string;
  response: {
    interpretation: string;
    matches: { entryId: EntryId; senseIndex: number; whyThisOne: string }[];
    sayIt: { tokens: { entryId: EntryId }[]; en: string; register: string }[];
    notes: string[];
  };
}

/** Ids only, never gloss text — the cache must not redistribute the dictionary. */
const DEMO_ASK: readonly DemoAskEntry[] = [
  {
    query: "how do I say I'm just browsing",
    response: {
      interpretation:
        'In a shop, the natural reply to an assistant is that you are only looking, not that you are "browsing".',
      matches: [
        {
          entryId: '隨便|随便[sui2 bian4]',
          senseIndex: 0,
          whyThisOne: 'Carries the "no particular aim" sense the English sentence is doing.',
        },
      ],
      sayIt: [
        {
          tokens: [{ entryId: '我|我[wo3]' }, { entryId: '隨便|随便[sui2 bian4]' }, { entryId: '看看|看看[kan4 kan5]' }],
          en: 'I am just looking, thanks.',
          register: 'neutral, spoken',
        },
      ],
      notes: ['Doubling the verb is what makes it casual rather than curt.'],
    },
  },
  {
    query: '开始',
    context: '我们开始吧',
    response: {
      interpretation:
        'Here the word is the verb "to begin" with the speaker proposing that the group start now.',
      matches: [
        {
          entryId: '開始|开始[kai1 shi3]',
          senseIndex: 0,
          whyThisOne: 'The verb reading, not the noun "beginning", is what the particle at the end asks for.',
        },
      ],
      sayIt: [],
      notes: ['The final particle turns a statement into a suggestion.'],
    },
  },
];

export interface DemoSummary {
  cards: CardRow[];
  knownCount: number;
  dueCount: number;
  learningCount: number;
  newCount: number;
  textId: string;
  askCacheKeys: string[];
  settings: SettingsRow;
}

export interface DemoOptions {
  repo?: Repository;
  now?: number;
  source?: EntrySource;
  /** Wipe first. On by default — the demo is a known state, not an overlay. */
  reset?: boolean;
}

async function repository(explicit?: Repository): Promise<Repository> {
  if (explicit) return explicit;
  const { getRepository } = await import('@/lib/db/get-db');
  return getRepository();
}

export async function loadDemo(options: DemoOptions = {}): Promise<DemoSummary> {
  const repo = await repository(options.repo);
  const now = options.now ?? Date.now();
  const source = options.source ?? getEntrySource();

  if (options.reset !== false) await repo.resetAll();
  await ensureSystemLists(repo);

  // 1. HSK 1–2 are known: the demo learner did not start from zero.
  const knownIds: EntryId[] = [];
  for (const band of DEMO_KNOWN_BANDS) {
    for (const entry of await source.band(band)) knownIds.push(entry.id);
  }
  await repo.markKnown(knownIds);

  // 2. Eight cards, each carrying where it came from.
  const wanted = DEMO_CARDS.map((spec) => spec.entryId);
  const found = new Map<EntryId, Entry>(
    (await source.entries(wanted)).map((entry) => [entry.id, entry]),
  );
  const spares = (await source.band(DEMO_CARD_BAND)).filter(
    (entry) => !found.has(entry.id) && entry.simp.length >= 2 && !entry.isVariant && !entry.properNoun,
  );

  const cards: CardRow[] = [];
  for (const spec of DEMO_CARDS) {
    const entry = found.get(spec.entryId) ?? spares.shift();
    if (!entry) continue;
    const context = demoContext(spec, entry, now);
    const card = await addCardTracked(repo, entry, context, undefined, undefined);
    cards.push(card);

    // 3. Backdated grades, replayed through the repository so the review rows
    //    are real history rather than a hand-written FSRS state.
    for (const review of spec.reviews ?? []) {
      const outcome = await repo.grade(card.id, review.rating, now - review.daysAgo * DAY_MS);
      cards[cards.length - 1] = outcome.card;
    }
  }

  // 4. Something to read.
  const text = await repo.saveText({ title: DEMO_TEXT_TITLE, body: DEMO_PARAGRAPH });

  // 5. Two warm ask-cache rows.
  const askCacheKeys: string[] = [];
  for (const entry of DEMO_ASK) {
    const key = demoAskCacheKey({
      query: entry.query,
      ...(entry.context === undefined ? {} : { context: entry.context }),
      estimatedBand: DEMO_KNOWN_BANDS[DEMO_KNOWN_BANDS.length - 1],
    });
    await repo.askCache.set(key, entry.response);
    askCacheKeys.push(key);
  }

  const settings = await repo.getSettings();
  const live = await repo.allCards();
  const known = new Set(await repo.knownEntryIds());
  const due = await repo.listDue(now);
  const learningCount = live.filter(
    (card) =>
      wordState({
        card: card.fsrs,
        known: card.entryId ? known.has(card.entryId) : false,
        ...(cardBand(card) === undefined ? {} : { hskBand: cardBand(card) }),
        knownBand: settings.knownBand,
      }) === 'learning',
  ).length;

  return {
    cards: live,
    knownCount: known.size,
    dueCount: due.length,
    learningCount,
    newCount: live.filter((card) => card.fsrs.state === 0).length,
    textId: text.id,
    askCacheKeys,
    settings,
  };
}

function cardBand(card: CardRow): HskBand | undefined {
  const snapshot = card.snapshot as { hskBand?: HskBand };
  return snapshot.hskBand;
}

function demoContext(spec: DemoCardSpec, entry: Entry, now: number): CardContext {
  const base = { source: spec.source, addedAt: now } satisfies CardContext;
  if (spec.source === 'reader') {
    const found = sentenceAround(DEMO_PARAGRAPH, entry.simp);
    if (found && found.offset >= 0) {
      return { ...base, sentence: found.sentence, offset: found.offset, length: entry.simp.length };
    }
    return { ...base, sentence: DEMO_PARAGRAPH.slice(0, 40) };
  }
  if (spec.source === 'ask') return { ...base, question: spec.question ?? `what does ${entry.simp} mean?` };
  if (spec.source === 'lookup') return { ...base, query: spec.query ?? entry.simp };
  return base;
}

/** The `/settings` reset. Wipes every table, including the settings row. */
export async function resetAll(repo?: Repository): Promise<void> {
  await (await repository(repo)).resetAll();
}
