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
 *  - **It stays byte-compatible with `demoAskCacheKey`** in `lib/dev/seed.ts`,
 *    which implemented this description before Phase 4 existed. The demo seed
 *    pre-warms two `ask_cache` rows; if the two derivations disagree those rows
 *    are orphans instead of hits. `tests/unit/ai/cache-key.test.ts` pins the
 *    agreement, and HANDOFF-p4.md asks the merge to delete the placeholder in
 *    favour of `askCacheKey`.
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
 * The part of a context that changes the answer. The sentence a word was met in
 * does; the offset of the tap inside it does not, so two taps on the same word
 * in the same sentence share one cache row.
 */
export function askContextKey(context: AskContext | string | undefined): string {
  if (context === undefined) return '';
  if (typeof context === 'string') return context;
  return context.sentence ?? context.question ?? context.query ?? '';
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
