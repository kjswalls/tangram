/**
 * What the three model routes answer with — the shapes, and nothing else.
 *
 * **This is not a new contract. It is the old one, given an address.** Until
 * `backend.md` B1 these five types were exported by the route modules
 * themselves (`app/api/ask/route.ts` and friends) and the ask panel, the card
 * back and the in-context gloss imported them from there. B1 moves the handlers
 * to `apps/server`, and an app component may not import a server module: the
 * type would be erased at emit, but the import would put `apps/server/src` in
 * the app's TypeScript project and its eslint scope, which is the coupling the
 * two-deployable split exists to avoid. So the declarations moved here, to the
 * side both halves can reach, and the handlers now have to satisfy them.
 *
 * **It is deliberately a dead end.** `backend.md` B2 replaces every shape below
 * with the frozen wire contract in `packages/ai/schemas.ts` — two calls for the
 * ask, `RetrievedEntry[]` travelling from the client, grounding on the client —
 * and deletes this file. Nothing here is frozen and nothing should be built on
 * it that is not already: B2's `schemas.ts` is the surface `data.md` D6 and
 * `core.md` C7 gate on, and a second contract module beside it would be exactly
 * the "two types of one name meaning opposite things" HANDOFF.md records the
 * contract review catching. The names are kept verbatim from the route modules
 * so that B1's diff stays a move.
 *
 * Types only. There is no runtime value in this file and there must not be one:
 * it is imported by the browser bundle and by the server.
 */
import type { ExampleSentence } from '@tangram/ai/examples';
import type { GroundedAskResponse } from '@tangram/ai/ground';
import type { ProviderName } from '@tangram/ai/provider';
import type { Entry, EntryId } from '@/lib/types';

// ---------------------------------------------------------------------------
// GET /api/ask, GET /api/examples — the handshake
// ---------------------------------------------------------------------------

/**
 * Which provider is active and under which prompt version.
 *
 * The client needs both *before* it calls, because they are two of the five
 * parts of the cache key — and the offline badge has to be right even when
 * every answer on the page came from the cache.
 */
export interface AskRouteInfo {
  provider: ProviderName;
  promptVersion: string;
  /** Present only for the live provider; the fake has no model. */
  model?: string;
}

/** The same handshake, under the examples prompt version. */
export type ExamplesRouteInfo = AskRouteInfo;

// ---------------------------------------------------------------------------
// POST /api/ask
// ---------------------------------------------------------------------------

export interface AskRouteResponse extends AskRouteInfo {
  query: string;
  /** The CC-CEDICT snapshot the entries came from; stamped onto any card added. */
  dictVersion: string;
  /** Validated: ids and indexes only. This is what the client caches. */
  response: GroundedAskResponse;
  /** Every entry the answer cites, so the client can render it without a round trip. */
  entries: Entry[];
  /** How many entries were retrieved for the model. Diagnostic only. */
  retrieved: number;
  /**
   * False when the answer is a stand-in the route built because the provider's
   * own answer did not survive grounding. The client must not cache it: the
   * next ask should reach the provider again rather than repeat the fallback
   * for as long as the row lives.
   */
  cacheable: boolean;
}

// ---------------------------------------------------------------------------
// POST /api/examples
// ---------------------------------------------------------------------------

export interface ExamplesRouteResponse extends ExamplesRouteInfo {
  entryId: EntryId;
  senseIndex?: number;
  /** The CC-CEDICT snapshot the entries came from. */
  dictVersion: string;
  /** Validated and filtered: ids and indexes only. This is what the client caches. */
  sentences: ExampleSentence[];
  /** Every entry the sentences cite, so the client can render without a round trip. */
  entries: Entry[];
  /** How many entries the prompt was allowed to build from. Diagnostic only. */
  support: number;
  /**
   * False when nothing survived the filter. An empty answer must not be cached:
   * it is a statement about how many words the learner knew today, and tomorrow
   * it would be wrong in the one direction the learner cannot fix.
   */
  cacheable: boolean;
}

// ---------------------------------------------------------------------------
// POST /api/recall
// ---------------------------------------------------------------------------

export interface RecallRouteResponse {
  suggested: 1 | 2 | 3 | 4;
  /** One line of plain prose. Scrubbed of CJK and pinyin. */
  why: string;
  provider: ProviderName;
}
