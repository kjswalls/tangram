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
