/**
 * The provider seam (PLAN.md §3.4).
 *
 * There is no Anthropic key in the build container, so the app is written
 * against an interface with two implementations: `FakeProvider`, which answers
 * from canned data plus a deterministic retrieval echo and is the default, and
 * `AnthropicProvider`, which is wired, unit-tested against a mocked HTTP layer
 * and never called live from here.
 *
 * **What a provider may and may not produce.** It selects, explains and
 * contextualises; it never emits a headword for display. Every piece of hanzi
 * or pinyin the UI shows is rendered by `lib/ai/ground.ts` from the dictionary
 * rows the model cited *by id* — a learner cannot detect a wrong tone, which is
 * the whole reason they are asking (§1, commitment 3).
 *
 * This module statically imports both implementations, so it is server-side
 * only. A client component that needs the answer *shape* imports
 * `lib/ai/ground.ts`, which is pure.
 *
 * The two implementations import back from here (the schemas, `ProviderError`),
 * which is a module cycle. It is safe because neither of them *evaluates* any
 * binding of this module at import time — the tool schema in `prompts.ts` is
 * derived inside a function for exactly that reason. Keep it that way: a
 * top-level `const TOOL = …askResponseSchema…` in `anthropic.ts` would be a
 * temporal-dead-zone crash on the first import, not a type error.
 */

import { z } from 'zod';

import { AnthropicProvider } from '@/lib/ai/anthropic';
import { FakeProvider } from '@/lib/ai/fake';
import type { Entry, LearnerProfile } from '@/lib/types';

/**
 * The provenance an ask carries. Structurally a `CardContext` minus the
 * bookkeeping the card layer adds, so a `CardContext` is accepted as one.
 */
export interface AskContext {
  /** The sentence the word was met in (a reader tap, a pasted line). */
  sentence?: string;
  /** The question that produced this ask. */
  question?: string;
  /** The query that produced this ask, when it differs from the ask itself. */
  query?: string;
  /** Offset and length of the target inside `sentence`. */
  offset?: number;
  length?: number;
}

/** At most eight candidate phrases, per §3.4. */
export const MAX_PROPOSED_PHRASES = 8;

export const askTokenSchema = z.union([
  z.object({ entryId: z.string().min(1) }),
  z.object({ text: z.string().min(1) }),
]);

export const askMatchSchema = z.object({
  entryId: z.string().min(1),
  senseIndex: z.number().int().min(0),
  whyThisOne: z.string(),
});

export const askSayItSchema = z.object({
  tokens: z.array(askTokenSchema).min(1),
  en: z.string(),
  register: z.string(),
});

/**
 * What a provider must return. Ids and indexes only: `matches[].entryId` has to
 * be in the retrieved set and `senseIndex` in range, and a `sayIt` phrase is a
 * list of cited entries (plus, where the model has no dictionary word for it, a
 * `{text}` token that is flagged as its own invention). `lib/ai/ground.ts`
 * enforces all of that; this schema only enforces the shape.
 */
export const askResponseSchema = z.object({
  interpretation: z.string(),
  matches: z.array(askMatchSchema),
  sayIt: z.array(askSayItSchema),
  notes: z.array(z.string()),
});

/**
 * One i+1 example sentence (PLAN.md §4, Phase 6 item 1). Same citation
 * discipline as `sayIt`: the model orders entry ids, and `lib/ai/ground.ts`
 * renders the hanzi and the reading from the dictionary rows behind them. A
 * `{text}` token is the model's own string and is flagged as such — the i+1
 * filter that runs above this drops a sentence it cannot vouch for.
 */
export const exampleSentenceSchema = z.object({
  tokens: z.array(askTokenSchema).min(1),
  en: z.string(),
});

export const exampleSentencesSchema = z.object({
  sentences: z.array(exampleSentenceSchema),
});

/** How many sentences one call may return, before the i+1 filter thins them. */
export const MAX_EXAMPLE_SENTENCES = 4;

/**
 * A suggested FSRS grade for a free-recall answer (PLAN.md §4, Phase 6 item 2).
 * `StoredRating` in `lib/db/schema.ts` is the same 1–4 vocabulary; this module
 * may not import the database layer, so the two agree by value rather than by
 * type. Nothing is ever submitted on the strength of this number — it
 * highlights a button the learner can override, which is the whole feature.
 */
export const RECALL_GRADES = [1, 2, 3, 4] as const;
export type RecallGrade = (typeof RECALL_GRADES)[number];

export const recallGradeSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
]);

/** `why` is plain English prose: no hanzi, no pinyin — the same rule as `notes`. */
export const gradeRecallSchema = z.object({
  suggested: recallGradeSchema,
  why: z.string(),
});

export type ParsedExampleSentence = z.infer<typeof exampleSentenceSchema>;
export type ParsedExampleSentences = z.infer<typeof exampleSentencesSchema>;
export type ParsedGradeRecall = z.infer<typeof gradeRecallSchema>;

export type ParsedAskToken = z.infer<typeof askTokenSchema>;
export type ParsedAskMatch = z.infer<typeof askMatchSchema>;
export type ParsedAskSayIt = z.infer<typeof askSayItSchema>;
export type ParsedAskResponse = z.infer<typeof askResponseSchema>;

export type ProviderName = 'fake' | 'anthropic';

export interface ProposedPhrases {
  /** Chinese words or phrases to retrieve dictionary entries for. */
  candidates: string[];
}

export interface LLMProvider {
  readonly name: ProviderName;
  /**
   * Candidate Chinese phrases for an English or sentence-shaped query. They are
   * not shown to anyone: the route segments them and unions the token entries
   * into the retrieved set, so the model can only cite words the dictionary has.
   */
  proposePhrases(query: string, context?: AskContext): Promise<ProposedPhrases>;
  /** The answer itself, over entries the caller retrieved. */
  answer(
    retrieved: readonly Entry[],
    profile: LearnerProfile,
    query: string,
    context?: AskContext,
  ): Promise<ParsedAskResponse>;
  /**
   * i+1 example sentences for one entry (Phase 6 item 1).
   *
   * `senseIndex` names the gloss the card is about, when it has one. `support`
   * is the pool the sentence may be built from — the caller retrieves it (the
   * learner's known words, and whatever else it wants offered) and the model
   * may cite nothing else: a citation the caller never supplied is dropped
   * upstream, exactly as in `answer`. It is the last argument because it is the
   * one a bare "show me a sentence" call can leave out; a provider given none
   * can still cite the target entry, so an empty result is never the answer.
   */
  exampleSentences(
    entry: Entry,
    profile: LearnerProfile,
    senseIndex?: number,
    support?: readonly Entry[],
  ): Promise<ParsedExampleSentences>;
  /**
   * Read a typed free-recall answer against an entry and suggest a grade
   * (Phase 6 item 2). The answer is the learner's own words in English; the
   * provider judges it against the entry's glosses and says why in prose.
   */
  gradeRecall(entry: Entry, answer: string, senseIndex?: number): Promise<ParsedGradeRecall>;
}

/** A provider failure that the route turns into a 502 rather than a crash. */
export class ProviderError extends Error {
  override readonly name = 'ProviderError';
  readonly provider: ProviderName;
  readonly status?: number;

  constructor(provider: ProviderName, message: string, status?: number) {
    super(message);
    this.provider = provider;
    if (status !== undefined) this.status = status;
  }
}

export interface ProviderEnv {
  /** `process.env` is the caller in production; tests pass a literal. */
  [key: string]: string | undefined;
  TANGRAM_LLM_PROVIDER?: string | undefined;
  ANTHROPIC_API_KEY?: string | undefined;
  TANGRAM_MODEL?: string | undefined;
}

/**
 * `AnthropicProvider` only when the app is explicitly asked for it *and* a key
 * is present. Either half missing is the fake — a half-configured live provider
 * that 401s on every ask is worse than an offline answer that works.
 */
export function selectProvider(env: ProviderEnv = process.env): LLMProvider {
  const wanted = env.TANGRAM_LLM_PROVIDER?.trim().toLowerCase();
  const key = env.ANTHROPIC_API_KEY?.trim();
  if (wanted === 'anthropic' && key) {
    return new AnthropicProvider({ apiKey: key, ...(env.TANGRAM_MODEL?.trim() ? { model: env.TANGRAM_MODEL.trim() } : {}) });
  }
  return new FakeProvider();
}
