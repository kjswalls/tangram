/**
 * The ask layer's barrel (PLAN.md §3.4).
 *
 * Two halves, and the split matters:
 *
 *  - **Server only** — `provider.ts`, `fake.ts`, `anthropic.ts`, `prompts.ts`.
 *    Importing any of them pulls the Anthropic SDK in, and `provider.ts` picks
 *    an implementation off `process.env`. `app/api/ask/route.ts` is the only
 *    consumer.
 *  - **Isomorphic** — `ground.ts` and `cache-key.ts` are pure: no dictionary,
 *    no SDK, no environment. `components/lookup/ask-panel.tsx` imports those
 *    two directly (not this barrel), which is what keeps the 35 MB dictionary
 *    loader and the SDK out of the browser bundle.
 *
 * So: import this file from the server, and the two pure modules by path from
 * the client.
 */

export * from '@/lib/ai/provider';
export * from '@/lib/ai/prompts';
export {
  FakeProvider,
  retrievalEcho,
  exampleEcho,
  recallEcho,
  recallWords,
  findDemo,
  ECHO_MATCHES,
  EXAMPLE_SENTENCE_COUNT,
} from '@/lib/ai/fake';
export { AnthropicProvider, DEFAULT_MODEL, MAX_TOKENS, REQUEST_TIMEOUT_MS } from '@/lib/ai/anthropic';
export * from '@/lib/ai/ground';
export * from '@/lib/ai/cache-key';
