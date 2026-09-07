/**
 * The ask cache key (PLAN.md §3.4): `sha1(promptVersion, provider, query,
 * context, estimatedBand)`.
 *
 * Two rules shape this file:
 *
 *  - **It runs in the browser.** The client checks `repo.askCache` *before*
 *    calling `/api/ask`, so the key has to be derivable without a server. Web
 *    Crypto's `crypto.subtle.digest('SHA-1', …)` does the work wherever it
 *    exists; `lib/dev/sha1.ts` (dependency-free, synchronous) is the fallback
 *    for the environments that do not expose `subtle` — jsdom under Vitest, and
 *    any page served over plain HTTP, where `crypto.subtle` is undefined.
 *  - **The demo seed calls it too.** `loadDemo` pre-warms two `ask_cache` rows
 *    and keys them through this function, so a warm row cannot become an orphan
 *    the panel never looks for. It used to carry its own copy of the formula
 *    (`demoAskCacheKey`), kept honest by a test; the merge of Phases 4–5 deleted
 *    the copy. The one thing the two still differ on is the *shape* of the
 *    context — the seed passes a bare string, the panel a `CardContext` — which
 *    `askContextKey` below flattens to the same value, pinned by a test.
 *
 * Nothing here imports the dictionary or a provider: the module has to stay
 * safe for a `'use client'` component to pull in.
 */

import { sha1Hex } from '@/lib/dev/sha1';
import type { AskContext } from '@/lib/ai/provider';

/**
 * Bumped whenever the prompts change what an answer looks like — every cached
 * row keyed on the old version is thereby retired without a migration.
 * `lib/dev/seed.ts` writes its warm rows under the same string.
 */
export const ASK_PROMPT_VERSION = 'v1';

export interface AskCacheKeyInput {
  query: string;
  /** The provenance the ask carried, or the plain string form of it. */
  context?: AskContext | string;
  estimatedBand: number;
  /** Which provider answered — a fake answer must not be served as a live one. */
  provider?: string;
  promptVersion?: string;
}

/**
 * The part of a context that changes the answer.
 *
 * Every field the prompt sees is in the key, and nothing else. `contextBlock`
 * (`lib/ai/prompts.ts`) sends the sentence, the question and the query, so a
 * key that collapsed to the first non-empty one of them would serve the answer
 * to `{sentence}` for an ask that also carried a different `question`. The
 * offset stays out: two taps on the same word in the same sentence are one
 * question, and the prompt's "target at offset N" only points at the word the
 * key already names.
 *
 * A bare string is the shape `lib/dev/seed.ts` stores its warm rows with, and
 * it means the sentence — which is what the seeded row is (a reader tap on
 * 开始). A test pins the two forms to the same digest.
 */
export function askContextKey(context: AskContext | string | undefined): string {
  if (context === undefined) return '';
  const parts =
    typeof context === 'string'
      ? [context, undefined, undefined]
      : [context.sentence, context.question, context.query];
  if (parts.every((part) => part === undefined || part === '')) return '';
  return JSON.stringify(parts.map((part) => part ?? null));
}

/** The exact string the digest is taken over. Exported so tests can pin it. */
export function askCachePayload(input: AskCacheKeyInput): string {
  return JSON.stringify([
    input.promptVersion ?? ASK_PROMPT_VERSION,
    input.provider ?? 'fake',
    input.query,
    askContextKey(input.context),
    input.estimatedBand,
  ]);
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * sha1 of the payload. Async because Web Crypto is; the synchronous fallback
 * produces the same digest, so a cache row written in one environment is found
 * in the other.
 */
export async function askCacheKey(input: AskCacheKeyInput): Promise<string> {
  const payload = askCachePayload(input);
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    try {
      return toHex(await subtle.digest('SHA-1', new TextEncoder().encode(payload)));
    } catch {
      // Some environments expose `subtle` but refuse SHA-1; fall through.
    }
  }
  return sha1Hex(payload);
}
