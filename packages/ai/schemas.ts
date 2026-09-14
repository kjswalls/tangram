/**
 * The ask contract — the wire shape between every client and the server, frozen.
 *
 * `docs/plans/backend.md` B2 designs it and says it lands as **the first commit
 * of that phase, alone**, because two sibling plans gate on the commit rather
 * than on the phase: `data.md` **D6** will not delete `app/api/dict/*` until the
 * client knows what it has to retrieve locally, and `core.md` **C7** designs the
 * ask panel's states against a module shaped by this file. `CLAUDE.md`'s
 * settle-first table names "the ask contract, frozen by `backend.md` B2's first
 * commit". This is that commit. **A builder who needs a change here stops,
 * writes the need into `HANDOFF.md`, and continues without it.**
 *
 * ## Why the shape is this shape
 *
 * After `data.md`, the **client** has the dictionary and the server does not
 * (`docs/STACK.md` §2.5, §5.5). Retrieval therefore happens in the browser, and
 * the model's phrase proposals are an *input* to retrieval rather than an output
 * of it — which is why the single `POST /api/ask` becomes two calls. A hanzi
 * query is still one round trip; an English question is two.
 *
 * Grounding moves with the dictionary. `ground()` is pure, it runs on the
 * client, and **the server never returns a grounded answer** — it returns a
 * schema-validated one and the client turns it into something renderable. That
 * is `PLAN.md` §3.4 unchanged, not weakened: every Chinese character and every
 * pinyin syllable a learner sees is still rendered from a cited dictionary row,
 * and the party doing the rendering is now the only party that has the rows.
 *
 * ## The rules this file encodes, each of which something else depends on
 *
 *  1. **`RetrievedEntry` is exactly what the prompt has always seen.**
 *     `entryLine()` in `prompts.ts` renders
 *     `id \t simp \t trad \t pinyinMarked[ HSK<band>] \t glosses` and reads
 *     nothing else off an entry. `hskBand` is in the list for that reason and
 *     dropping it would be a change to model behaviour smuggled in as a
 *     transport decision. The full `Entry` (`lib/types.ts`) has eleven more
 *     fields; it is **structurally assignable** to `RetrievedEntry`, so every
 *     existing caller that passes a real dictionary row keeps compiling.
 *     `apps/app/tests/unit/ai/contract.test.ts` asserts that assignability, in
 *     both directions, so the claim cannot quietly stop being true.
 *  2. **The model id is chosen by the server and is never read from a request.**
 *     There is no `model` field on any request type here, deliberately: a client
 *     that could name the model could name the most expensive one. `model` on a
 *     *response* is the server reporting what it used, for a log line and a
 *     badge. **It is NOT part of the cache key** — `cache-key.ts`'s
 *     `askCachePayload` folds in `promptVersion`, `provider`, `query`, the
 *     context key and `estimatedBand`, and nothing else, which is the same five
 *     `PLAN.md` §3.4 specifies. A sixth would orphan every row already written,
 *     including the two `lib/dev/seed.ts` pre-warms.
 *  3. **`cacheable` is not on the wire.** Today the server sets it when a
 *     schema-valid answer grounds to nothing and it substitutes a retrieval
 *     echo. After the flip the server cannot compute it, because the server no
 *     longer grounds — so the client owns the echo, the substitution and the
 *     decision not to cache it. The cache still stores the **grounded** response
 *     and the echoed fallback is still never cached, so rows written before the
 *     flip still parse and `AskCacheRow`'s licence invariant (ids and indexes
 *     only, never gloss text) still holds.
 *  4. **No response carries dictionary rows.** `entries` and `dictVersion` leave
 *     the responses for the same reason: the client already has both. They are
 *     what made the old bodies large, and removing them is most of the point.
 *
 * ## What is deliberately NOT here
 *
 * Zod schemas. `CLAUDE.md`'s rule is that the owner "lands the declarations
 * alone, first, with no implementation", and a validator is implementation: it
 * decides what a malformed request does, which is B2's remainder to write and
 * to test.
 *
 * Two deliberate readings of "declarations alone", both recorded in
 * `HANDOFF.md` rather than taken silently. The caps are `const` rather than
 * prose, because a cap with no number is not a contract — D6 and C7 both need
 * to know that 40 is 40. And `toRetrieved()` is here, six lines of pure
 * projection, because rule 1 without it is an invitation to ship the whole
 * dictionary row: a shape nobody can construct correctly is not frozen, it is
 * merely written down.
 *
 * Nothing in this file imports anything. That is not stylistic: a frozen shape
 * that imports from a package on the other side of the freeze can be changed
 * without touching the frozen file.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * 1–6 are HSK 3.0 bands; 7 stands for the band labelled "7–9".
 *
 * Declared here rather than imported. `HskBand` lives in `apps/app/lib/types.ts`
 * — a frozen file inside an **app**, and a package may not depend on an app.
 * The two definitions are held together by a type-level assertion in
 * `apps/app/tests/unit/ai/contract.test.ts`, which fails to compile if they
 * diverge. `PLAN.md` §3.1 is authoritative for the values.
 */
export type HskBand = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** `trad|simp[pinyinNum]` — CC-CEDICT's natural key (`PLAN.md` §3.1). */
export type EntryId = string;

/** Which implementation answered. `fake` is the offline default. */
export type ProviderName = 'fake' | 'anthropic';

/** A suggested FSRS grade. The same 1–4 vocabulary as `StoredRating`. */
export type RecallGrade = 1 | 2 | 3 | 4;

/**
 * One dictionary row as the model sees it, and as the client now sends it.
 *
 * Six fields, and they are not a subset anyone chose: they are exactly what
 * `entryLine()` reads. See rule 1 above.
 */
export interface RetrievedEntry {
  id: EntryId;
  simp: string;
  trad: string;
  /** Marked pinyin, e.g. `dǎsuàn`. Derived, never model-authored. */
  pinyinMarked: string;
  hskBand?: HskBand;
  /** Glosses with `CL:` lines already removed. At most `MAX_GLOSSES_PER_ENTRY`. */
  glosses: string[];
}

/**
 * The six keys, as data, so a projection cannot drift from the interface.
 *
 * `satisfies` rather than a bare annotation: adding a seventh field to
 * `RetrievedEntry` without adding it here is then a compile error, which is the
 * guard `contract.test.ts`'s key count cannot give on its own.
 */
export const RETRIEVED_ENTRY_KEYS = [
  'id',
  'simp',
  'trad',
  'pinyinMarked',
  'hskBand',
  'glosses',
] as const satisfies readonly (keyof RetrievedEntry)[];

/**
 * Project a dictionary row down to what goes on the wire.
 *
 * `Entry` is structurally assignable to `RetrievedEntry` and that is the point
 * of the shape — but assignability is a compile-time fact and `JSON.stringify`
 * is not. This is what makes the wire shape true at runtime, and it is declared
 * here so the client, the server's own tests and any future native client call
 * one projection rather than three. `hskBand` is omitted rather than sent as
 * `undefined`, because `JSON.stringify` drops an undefined value anyway and a
 * key that is sometimes absent and sometimes `null` is two shapes.
 */
export function toRetrieved(entry: RetrievedEntry): RetrievedEntry {
  return {
    id: entry.id,
    simp: entry.simp,
    trad: entry.trad,
    pinyinMarked: entry.pinyinMarked,
    ...(entry.hskBand === undefined ? {} : { hskBand: entry.hskBand }),
    glosses: entry.glosses,
  };
}

/** The provenance an ask carries — a reader tap, a pasted line, a question. */
export interface AskContext {
  sentence?: string;
  question?: string;
  query?: string;
  /** Offset and length of the target inside `sentence`. */
  offset?: number;
  length?: number;
}

/** The learner snapshot that travels with an ask (`PLAN.md` §3.3, §3.4). */
export interface LearnerProfile {
  estimatedBand: HskBand;
  /** Simplified headwords the learner already knows, capped at `MAX_KNOWN_SAMPLE`. */
  knownSample: string[];
}

// ---------------------------------------------------------------------------
// The caps. Server-side validation is cost control once the client supplies the
// prompt's inputs, so every one of these is enforced at the edge by B2's zod
// schema. **Two behaviours, and the distinction is not cosmetic:** the counts
// and the byte caps REJECT with a 400, because a client that exceeded one has a
// bug; `MAX_SENTENCE_CHARS` TRUNCATES, because that is what `app/api/ask/route.ts`
// does today and the string it bounds is a reader selection the learner does not
// choose the length of.
// ---------------------------------------------------------------------------

/**
 * `PLAN.md` §3.4 caps the retrieved set at 40 entries.
 *
 * **Declared here and nowhere else.** `backend.md` B2 lists `RETRIEVED_CAP`
 * among the symbols moving into `packages/ai/retrieve.ts` (which `data.md` D3
 * owns). It must `import { RETRIEVED_CAP } from './schemas.ts'` rather than
 * redeclare it: two constants of the same name in one package is a value the
 * edge validator and the client's own `mergeRetrieved()` can disagree about
 * with nothing failing to compile. `SEARCH_HEAD` is the opposite case — it
 * shapes retrieval and never reaches the wire — so it stays in `retrieve.ts`.
 */
export const RETRIEVED_CAP = 40;
/** At most eight candidate phrases come back from `propose`. */
export const MAX_PROPOSED_PHRASES = 8;
/** How many dictionary rows an examples prompt may be built from. */
export const SUPPORT_CAP = 40;
/** How many headwords `profile.knownSample` may carry. */
export const MAX_KNOWN_SAMPLE = 200;
/** How many sentences one examples call may return, before the client's i+1 filter. */
export const MAX_EXAMPLE_SENTENCES = 4;
/** `query` and the recall `answer` are rejected above this; both are typed by a person. */
export const MAX_QUERY_CHARS = 400;
export const MAX_RECALL_ANSWER_CHARS = 400;
/**
 * Each of `AskContext`'s three strings — `sentence`, `question`, `query`.
 *
 * **Truncated, not rejected**, matching `app/api/ask/route.ts`'s `parseBody`,
 * which does `value.trim().slice(0, MAX_SENTENCE_CHARS)`. It matters: a reader
 * tap sets `context.sentence` from a sentence span, a pasted passage with no
 * sentence-final punctuation is one span, and rejecting it would turn a working
 * ask into an error on the one input path the learner does not control.
 */
export const MAX_SENTENCE_CHARS = 400;

/**
 * The byte caps. Counts alone do not bound a request: `retrieved` is 40 rows and
 * a row is a string array.
 *
 * `backend.md` B2 asks the edge for "a total body size cap" and B7 then writes
 * its limiter against "the body-size and entry-count caps B2 introduced". They
 * are numbers here because the **client** is the party assembling the payload,
 * and a cap it cannot see is a 400 it cannot avoid.
 *
 * The sizes follow what the dictionary actually holds: the longest CC-CEDICT
 * headword is well inside 24 characters, an `EntryId` is `trad|simp[pinyinNum]`,
 * and 40 entries × 12 glosses × 120 characters is ~60 KB before overhead.
 */
export const MAX_BODY_BYTES = 256 * 1024;
export const MAX_GLOSSES_PER_ENTRY = 12;
export const MAX_GLOSS_CHARS = 200;
export const MAX_HEADWORD_CHARS = 24;
export const MAX_ENTRY_ID_CHARS = 160;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * The paths, named so that no client hard-codes a second spelling of one.
 *
 * `/api/ask`, `/api/examples` and `/api/recall` keep their names so that
 * `GATED_PATHS` in `lib/server/access.ts` stays literally true (`backend.md` §4).
 * **`ASK_PROPOSE` and `ASK_ANSWER` are new and both sit UNDER `/api/ask`** — so
 * whatever matches a request against `GATED_PATHS` must match a path *prefix*,
 * not an exact string, or the two routes that actually spend the money are
 * ungated. Recorded here rather than in a phase's prose because the gate's
 * server half (`backend.md` B1) and its client half (`web.md` W4) are written by
 * different sessions and neither owns this file.
 */
export const ASK_INFO_PATH = '/api/ask';
export const ASK_PROPOSE_PATH = '/api/ask/propose';
export const ASK_ANSWER_PATH = '/api/ask/answer';
export const EXAMPLES_PATH = '/api/examples';
export const RECALL_PATH = '/api/recall';

/** Every path this contract covers, for a route table and for the gate. */
export const CONTRACT_PATHS = [
  ASK_INFO_PATH,
  ASK_PROPOSE_PATH,
  ASK_ANSWER_PATH,
  EXAMPLES_PATH,
  RECALL_PATH,
] as const;

// ---------------------------------------------------------------------------
// The answer shape. Validated against the schema, NOT grounded — grounding is
// the client's, and `GroundedAskResponse` (`ground.ts`) is a different type.
// ---------------------------------------------------------------------------

/**
 * A token in a phrase: either a cited dictionary entry, or the model's own
 * string, which the client flags as "AI-generated, not in dictionary" on that
 * token alone (`PLAN.md` §3.4).
 */
export type AskToken = { entryId: EntryId; text?: never } | { text: string; entryId?: never };

export interface AskMatch {
  entryId: EntryId;
  senseIndex: number;
  whyThisOne: string;
}

export interface AskSayIt {
  tokens: AskToken[];
  en: string;
  register: string;
}

/**
 * What a provider returns and the server passes through, unchanged in shape
 * from today's `askResponseSchema`. Ids and indexes plus the model's English
 * prose — never a headword.
 */
export interface AskResponse {
  interpretation: string;
  matches: AskMatch[];
  sayIt: AskSayIt[];
  notes: string[];
}

/**
 * One example sentence as the model returned it: **ungrounded, unfiltered**.
 *
 * The `Raw` prefix is load-bearing, not decoration. `apps/app/lib/ai/examples.ts`
 * already exports `ExampleSentence = GroundedSayIt` — the *grounded, filtered,
 * cache-safe* value, with `register` and `unverified` — and `examples.ts` is one
 * of the ten modules `wave-zero.md` §5 moves into this package. Two types of one
 * name in one package, meaning opposite things, on the same `sentences` field,
 * with `AskCache.set(key, response: unknown)` untyped underneath, is how the
 * ungrounded shape reaches `ask_cache` and the licence boundary with it.
 */
export interface RawExampleSentence {
  tokens: AskToken[];
  en: string;
}

// ---------------------------------------------------------------------------
// The handshake. Every response for a route whose answer is CACHED carries it,
// because the client cannot build a cache key without `provider` and
// `promptVersion` — and the offline badge has to be right even when every answer
// on the page came from the cache. `RecallResponse` deliberately does not; see
// its own note.
// ---------------------------------------------------------------------------

export interface ProviderInfo {
  provider: ProviderName;
  promptVersion: string;
  /** Present only for the live provider; the fake has no model. */
  model?: string;
}

/** `GET /api/ask` and `GET /api/examples` — unchanged from today. */
export type AskInfoResponse = ProviderInfo;

// ---------------------------------------------------------------------------
// POST /api/ask/propose — candidate phrases to retrieve entries for.
//
// The client skips this call entirely when `needsProposals(query)` is false: a
// headword needs no help, because the dictionary already answered it.
// ---------------------------------------------------------------------------

export interface AskProposeRequest {
  query: string;
  context?: AskContext;
}

export interface AskProposeResponse extends ProviderInfo {
  /** Chinese words or phrases, at most `MAX_PROPOSED_PHRASES`. Never displayed. */
  candidates: string[];
}

// ---------------------------------------------------------------------------
// POST /api/ask/answer — the answer, over entries the CLIENT retrieved.
// ---------------------------------------------------------------------------

export interface AskAnswerRequest {
  query: string;
  context?: AskContext;
  profile: LearnerProfile;
  /**
   * The CC-CEDICT snapshot the entries came from. **Optional, and optional on
   * purpose:** no phase in the plan set consumes it — B7's log line is "account
   * id, route, provider, latency, outcome, token counts" — and `ExamplesRequest`
   * and `RecallRequest` carry no equivalent, so requiring it here would 400 a
   * client for omitting data nobody reads. The mobile shells ship the same SPA
   * inside a WebView and update independently of this server, which is the case
   * a required-but-unused field breaks first.
   */
  dictVersion?: string;
  /** At most `RETRIEVED_CAP`. The model may cite nothing else. */
  retrieved: RetrievedEntry[];
}

export interface AskAnswerResponse extends ProviderInfo {
  /** Schema-validated, **not** grounded. The client grounds it. */
  response: AskResponse;
}

// ---------------------------------------------------------------------------
// POST /api/examples — i+1 sentences for one card.
//
// The grounding AND the i+1 filter run on the client after this returns. The
// route's old header argued the opposite — "the filter is the feature, and a
// filter that ran in the browser would be a promise the server had already
// broken" — and that argument was about a server that had the dictionary and a
// client that did not. After `data.md` the client is the only party that can run
// the filter, and the learner is not an adversary to their own flashcards.
// ---------------------------------------------------------------------------

export interface ExamplesRequest {
  /** The card's word. */
  entry: RetrievedEntry;
  /** Which gloss the card is about, when it has one. */
  senseIndex?: number;
  profile: LearnerProfile;
  /**
   * The pool the sentence may be built from, at most `SUPPORT_CAP`, already
   * chosen and frequency-ordered by the client. A bare request with an empty
   * pool is legal: it declares nothing, so nothing but the target may be cited.
   */
  support: RetrievedEntry[];
}

export interface ExamplesResponse extends ProviderInfo {
  /**
   * Schema-validated and **unfiltered**, at most `MAX_EXAMPLE_SENTENCES`. The
   * client grounds each one and drops every sentence citing anything outside
   * the target and the known set — which is why there is no `cacheable` here
   * either: whether an empty result is worth caching is a statement about how
   * many words the learner knew today, and only the client knows that.
   */
  sentences: RawExampleSentence[];
}

// ---------------------------------------------------------------------------
// POST /api/recall — read a typed answer and suggest a grade.
//
// The route that flips least. It needs the entry's glosses, which the client now
// sends; everything else is as it was. `why` is scrubbed of CJK and pinyin ON
// THE SERVER and is scrubbed again on the client: that one is not a rendering
// concern — it is what stops an unchecked reading reaching the card front — and
// it costs nothing to do it where the model output is first seen.
// ---------------------------------------------------------------------------

/**
 * Named for the endpoint rather than `RecallRequest`, which
 * `apps/app/lib/ai/recall.ts` already exports as the injectable *fetch seam*
 * (`(input, options) => Promise<RecallSuggestion | null>`), consumed as a prop
 * type by `components/review/recall-input.tsx` and as a return type by
 * `lib/srs/direction.ts`. `recall.ts` moves into this package under
 * `wave-zero.md` §5, and B2's remainder has to edit it — so the one file that
 * must import this type is the one file that already exports that name.
 */
export interface RecallGradeRequest {
  entry: RetrievedEntry;
  senseIndex?: number;
  /** The learner's own words, at most `MAX_RECALL_ANSWER_CHARS`. */
  answer: string;
}

/**
 * Carries `provider` but **not** `promptVersion`, and that is a decision rather
 * than an omission: free-recall grading is uncached by design.
 * `cache-key.ts` records `RECALL_PROMPT_VERSION` and `recallCacheKey` as
 * "reserved and unused" because a recall row's payload is the model's `why`, and
 * a live model explaining a grade quotes the gloss — which `ask_cache` may not
 * hold (`CLAUDE.md`, the licence boundary). Adding `promptVersion` here is the
 * first half of caching recall; do not do it.
 */
export interface RecallResponse {
  suggested: RecallGrade;
  /** One line of plain English prose. Scrubbed of CJK and pinyin. */
  why: string;
  provider: ProviderName;
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

/**
 * Every error body the three routes may return, and the list is closed.
 *
 * `dict-data-missing` is **not** here and must not come back: after B2 the
 * server has no dictionary, so it cannot have a missing one. The client's own
 * missing-dictionary banner is `data.md`'s (`DictStatus`), and a server that
 * still answered `503 {error:'dict-data-missing'}` would be telling the browser
 * about a file the browser owns.
 */
export type ContractErrorCode =
  /** The gate refused it. No echo of what was sent. */
  | 'unauthorized'
  /** The body did not parse, or exceeded a cap above. */
  | 'bad-request'
  /** The provider threw, timed out, or the transport failed. */
  | 'provider-failed'
  /** The provider answered, and the answer did not match the schema. */
  | 'provider-invalid'
  /**
   * A per-account, per-secret or per-IP limit was hit. **`backend.md` B7's**,
   * and it is in the union now rather than when B7 runs: B7's acceptance
   * criterion is "returns `429` with `Retry-After`, the app shows the real
   * reason", and a client that can only branch on `error` cannot show a real
   * reason for a code that is not in the union it was designed against. The
   * `Retry-After` value is a header, not a body field.
   */
  | 'rate-limited';

export interface ContractErrorBody {
  error: ContractErrorCode;
  /** Safe to show a learner. Never carries a key, a header or a stack. */
  hint?: string;
}
