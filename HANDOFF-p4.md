# HANDOFF — P4, grounded ask

Written by the Phase 4 builder on branch `p4`. Fold into `HANDOFF.md` at merge and delete
this file, as P1–P3 did.

Owned and delivered: `lib/ai/**`, `app/api/ask/route.ts`,
`components/lookup/ask-panel.tsx`, `tests/unit/ai/**`, `tests/e2e/p4/**`, plus the one
sanctioned edit to `components/lookup/lookup-panel.tsx` and the `TANGRAM_MODEL` note in
`.env.example`.

## The shape of it

```
POST /api/ask ──► search(query)                    ── the dictionary answers first
                  proposePhrases(query, context)   ── only for English / sentence input
                  segment(candidate) → token entries
                  mergeRetrieved(...)  ≤ 40        ── SEARCH_HEAD=16 reserved head
                  provider.answer(retrieved, profile, query, context)
                  askResponseSchema.safeParse      ── shape
                  ground(...)                      ── truth
              ──► { provider, promptVersion, dictVersion, response, entries, retrieved }

GET  /api/ask ──► { provider, promptVersion, model? }
```

`response` is the only thing the client caches: ids, indexes, flags and the model's prose,
never dictionary text. On a cache hit the panel refetches the cited entries from
`/api/dict/entries` and re-renders — which is what §3.4's "re-resolved against the
dictionary at render" means, and it is exercised by an e2e spec, not just asserted here.

**Module split, and why it matters.** `provider.ts` / `fake.ts` / `anthropic.ts` /
`prompts.ts` are **server-only** (the Anthropic SDK refuses to even construct in a
browser-like environment). `ground.ts` and `cache-key.ts` are **pure** — no dictionary, no
SDK, no `process.env` — and are the only two modules `ask-panel.tsx` imports. Import
`@/lib/ai` from the server; import those two by path from a client component. A future
`export *` of the barrel into a client component would drag the 35 MB dictionary loader and
the SDK into the browser bundle.

`provider.ts` ↔ `anthropic.ts`/`fake.ts` is a deliberate module cycle (the implementations
need the schemas and `ProviderError`). It is safe **only** because nothing in those files
evaluates a `provider.ts` binding at import time — that is why the tool schema in
`prompts.ts` is derived inside `answerTool()` rather than sitting in a top-level constant.
A `const TOOL = zodToJsonSchema(askResponseSchema)` there is a temporal-dead-zone crash on
first import, not a type error. Keep the derivation lazy.

## Decisions PLAN.md did not make

**The unverified rule is wider than §3.4's wording, on purpose.** The plan says "a run of
≥2 consecutive *fallback* single-chars". Taken literally that flags nothing in the two
cases the same paragraph demands be flagged: 随, 看, 绝 and 子 are all real CC-CEDICT
headwords, so 随看随买 and 绝绝子 segment into `via: 'entry'` tokens and no fallback
occurs. Implemented instead (`unverifiedSpans`, `lib/ai/ground.ts`):

1. any `via: 'fallback'` word token (a hanzi the dictionary does not have) — the plan's
   case, kept;
2. a single-char token whose only gloss is "used in …" / "variant of …" / "see …" — the
   plan's other case, kept;
3. **a run of ≥2 consecutive single-character tokens, unless every character in the run is
   among the ~100 most frequent words** (`COMMON_SINGLE_RANK`, on jieba's `freqRank`).

Rule 3 is what catches the invented compounds. The frequency escape hatch is what keeps it
off ordinary sentences: 我看了一下 is 我 (rank 8) · 看 (81) · 了 (1) · 一下 and is not
flagged, while 随 (904) and 绝 (1834) are. Unit-tested both ways. If a reviewer prefers the
literal reading of the plan, the rule is one exported constant and one function.

**A phrase citing an unretrieved id is dropped whole**, not rendered with a hole. Matches
are dropped individually, as the plan says; a sentence with a missing word teaches nothing.

**`{text}` tokens are always `unverified` as well as `aiGenerated`.** The plan flags them
as "AI-generated, not in dictionary"; both flags are the same claim from two directions, and
the UI needs the second one to warn at phrase level.

**Sense choice for 看.** The two demo contexts answer with *different entries* (kān vs kàn),
and the caretaking answer also carries a second match at `senseIndex 5` — kàn's own "to look
after" — so the pair differs by sense index as well as by reading, which is the confusion a
learner actually has. Pinned in `tests/unit/ai/fake.test.ts`.

**The cache key is byte-compatible with `demoAskCacheKey`.** `askCacheKey`
(`lib/ai/cache-key.ts`) hashes `JSON.stringify([promptVersion, provider, query, contextKey,
estimatedBand])`, exactly as P3's placeholder does, and `ASK_PROMPT_VERSION === 'v1' ===
DEMO_PROMPT_VERSION`. `tests/unit/ai/cache-key.test.ts` asserts the two agree on both demo
rows, so **the demo seed's two warm rows are real hits** rather than orphans. The context
part of the key is `sentence ?? question ?? query ?? ''` — offsets deliberately excluded, so
two taps on the same word in the same sentence are one question.

Web Crypto does the digest where `crypto.subtle` exists and `lib/dev/sha1.ts` does it
otherwise (jsdom, plain-HTTP pages). Both produce the same string; a test pins that too.

**The client needs `GET /api/ask` before it can look in the cache.** Provider and prompt
version are two of the five key parts and the client cannot guess them from
`settings.provider` (which is a preference, not what the server actually did). The handshake
is memoised per page load and also drives the offline badge, which has to be right even when
every answer on the page came from the cache.

**Retrieval had to be widened for English sentences.** P1's gloss index is an AND over
tokens, so `search("how do I say I'm just browsing")` returns exactly nothing. `mergedSearch`
therefore falls back to searching the individual words (≥3 letters, top 3 groups each) when
a non-CJK query matches nothing as a whole. Without it the retrieval echo has nothing to
echo and §3.4's "no query ever renders an empty panel" fails on the first real sentence
anybody types. The 40-entry cap also reserves a 16-entry head for the search so a broad
query cannot crowd out the proposed phrases the answer is built from (`mergeRetrieved`).

**`proposePhrases` failing is not an ask failing.** It is retrieval help; the route logs and
carries on with the dictionary search. Only `answer()` failing is a 502.

**Model.** `DEFAULT_MODEL = 'claude-opus-5'` (bare id, no date suffix), recorded in
`.env.example`. Structured output is a forced tool call (`tool_choice: {type:'tool'}`), which
that model family accepts; the input schema is derived from the zod schema by
`zodToJsonSchema` in `prompts.ts` — a deliberately narrow zod-3 walker that throws on a
construct it cannot express rather than emitting a lie to the model. No assistant prefill, no
`thinking` block, timeout in milliseconds, `maxRetries: 1`, errors mapped onto `ProviderError`.
**It has never made a live call from this container** and there is no key here.

## The one edit outside my paths

`components/lookup/lookup-panel.tsx` (frozen; the orchestrator sanctioned this single edit):
when no `ask` slot is passed, the panel now renders `<AskPanel query context />` itself, in a
region with **its own testid** (`lookup-ask`, not `lookup-ask-slot`), and only when the query
is non-empty. Consequences:

- `/lookup` and, later, P5's reader get the ask panel without either file being edited;
- a caller that passes `slots.ask` still wins, and still gets `lookup-ask-slot`;
- `tests/e2e/p1/lookup.spec.ts:125` and `tests/e2e/smoke.spec.ts:52`, which assert
  `lookup-ask-slot` has count 0 "until Phase 4 fills it", **still pass** — they are about the
  injected slot. Both assertions are now stale in intent; the merge may want to delete the two
  lines and their comments. I left them alone rather than spend my one edit outside my paths
  on them.

The panel asks about `LookupPanel`'s `query` prop, which on `/lookup` is the *typed* query
until a result is picked and the headword after that. That is the intended reading of "ask
about what the panel is showing", but it does mean picking a result re-asks. If that turns out
to be wrong, the fix is in `lookup-view.tsx` (P1's file), not here.

## Needs (for the merge / a later phase)

1. **Delete `demoAskCacheKey` from `lib/dev/seed.ts`** and import `askCacheKey` from
   `@/lib/ai/cache-key` instead (it is async; `loadDemo` is already async). The two agree
   today and a test says so, but one derivation is better than two. `lib/dev/seed.ts` is
   P3's file, so I did not touch it.
2. **The two stale `lookup-ask-slot` assertions** above.
3. **`addPhraseCard` cannot record a `dictVersion`** — the frozen repository signature takes
   none, and `lib/db/dexie.ts` stamps `'unknown'`. Word cards from this panel do carry the
   real snapshot version. Fixing it is a frozen-file change (a fourth argument, exactly as
   `addCardFromEntry` got one in Phase 0).
4. **Phrase cards do not join the "Looked up" list.** Membership is by `entryId` and a phrase
   has none; adding its cited words individually (the panel offers this) does join them.
5. **`getLearnerProfile` runs without `bandSizes`** in the panel, so `estimatedBand` is
   `settings.knownBand` rather than a measured band. Band sizes live in the dictionary on the
   server; a `/api/dict/hsk` count route or a field on the ask response would improve the
   profile — and would change the cache key, so it wants a `promptVersion` bump when it lands.

## Checks

| Check | Result |
|---|---|
| `npx tsc --noEmit` | pass |
| `pnpm lint` | pass |
| `pnpm test` | pass — 35 files, **344** tests (was 283; 61 added under `tests/unit/ai/`) |
| `pnpm build` | pass (Turbopack); `/api/ask` is `ƒ` (dynamic), as the dictionary routes are |
| `PORT=3004 pnpm e2e` | pass — **59/59** (was 55; 4 added under `tests/e2e/p4/`) |

`tests/unit/ai/{anthropic,provider,prompts,route}.test.ts` carry
`// @vitest-environment node`: the SDK refuses to construct under jsdom (it looks like a
browser, and a key in a browser is a leaked key), and the route handlers are server code.

No server is left running; port 3004 is free. `/home/user/v0-anchor`, `/home/user/tangram`
and the other worktrees were not touched.
