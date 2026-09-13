# Tangram — build plan: the server (accounts, sync, and the AI proxy)

**Status:** plan, written 2026-09-13. Sibling plans: [`data.md`](data.md), [`core.md`](core.md),
[`web.md`](web.md), [`ios.md`](ios.md), [`android.md`](android.md).

**Read first:** [`docs/STACK.md`](../STACK.md) is the decision record this plan implements; it is not
re-argued here. §2.8 is the accounts/sync/BYOK decision, §5.5 is the open question this plan closes,
and §7 states plainly that **the audits scoped the client and never touched the server**. That is the
single most important thing to know before reading on: nothing below rests on a 2026-09-13
measurement, because no audit measured any of it. Where a fact is needed and nobody has established
it, this plan says so and names the check.

[`PLAN.md`](../../PLAN.md) remains authoritative for the data contract (§3.1), the schema rules
(§3.3), the grounding contract (§3.4) and the licence boundary (§5). The product decisions taken with
the owner supersede PLAN.md's UI wherever they conflict; §7 of that file is what puts accounts, sync
and BYOK on the map at all.

Two facts frame everything and are not repeated: **there are no users and no data** — nothing here is
a migration plan, the first account ever created will be the owner's, and the Dexie schema can change
freely — and the builder is **one person with AI assistance** who will also be the person paged when
this breaks at 2 a.m.

---

## 1. Goal

When this plan is done there is a deployed service that (a) holds an account, (b) replicates the
learner's cards, reviews, lists, texts and settings between that account's devices so that a phone
and a laptop are one deck and an evicted browser origin is a re-sync rather than a loss, and (c) is
the only place a model key ever exists, so every platform gets AI answers without a key touching a
browser or a device. None of that is true now: today `lib/db/dexie.ts` is the whole of persistence,
every device is an island, and the three model-backed routes run inside the Next app that
[`web.md`](web.md) is deleting.

## 2. Scope boundaries

**This plan owns:**

- The choice of platform and host, the `apps/server/` deployable, and its deploy/rollback procedure.
- The three model-backed routes — `/api/ask`, `/api/examples`, `/api/recall` — their new home, and
  the **new request contract** that STACK §5.5 leaves open (who holds the dictionary during
  grounding).
- Server-side ownership of `lib/server/access.ts` after [`web.md`](web.md) W4 splits it, plus the
  CORS allowlist for the app origins the sibling plans hand over.
- Accounts: sign-up, sign-in, session, sign-out, and the rule that the app stays fully usable signed
  out.
- The sync protocol: the Postgres schema, the row-level rules, the conflict policy, the change feed
  that `lib/db/repository.ts` grows, and the client engine that drives it.
- The schema corrections sync requires on the client side (`list_members`, `known_words`, and the
  hard delete in `unmarkKnown`).
- Key custody: encryption at rest, the threat model, rotation, revocation, and the honest statement
  of what BYOK does and does not protect.
- Per-account rate and size limits, and the operational surface: logs, backups, a restore drill, and
  the rewritten `docs/deploy.md`.

**This plan does not own, and must not start:**

| Not here | Owner | Why the seam is where it is |
|---|---|---|
| The Vite build, the router, the workspace layout, the client's API base and the gate's client half | [`web.md`](web.md) (W0, W1, W4) | This plan produces something behind a base URL. How the client reaches it, and the `?key=`→header exchange in the browser, are transport. |
| The **local** export/import (`lib/db/export.ts`, `lib/db/import.ts`) | [`web.md`](web.md) W5 | It ships before this plan does and must not wait for it. This plan adds an account-level export **over the same row shapes** and depends on W5's round-trip test; it does not rebuild it. See §5, B5. |
| The SQLite dictionary, `DictStore`, and the client-side retrieval helpers (`lib/ai/retrieve.ts`) | [`data.md`](data.md) (D2, D3, D6) | The contract flip in B2 consumes them. `data.md` D6 already names the async-`segment` adapter this plan needs. |
| Every screen, including the sign-in screen's visual design and the "backup is on" copy | [`core.md`](core.md) | This plan supplies the auth flow, the client modules and unstyled functional UI where a screen does not exist yet. That is named debt, not a design. |
| Capacitor projects and the WebView origin string | [`ios.md`](ios.md) I1, [`android.md`](android.md) A1 | Both plans already promise this plan exactly one fact: the origin their WebView runs from, for the CORS allowlist. |
| A second `Repository` implementation on `@capacitor-community/sqlite` (STACK §2.8 option 2) | [`ios.md`](ios.md) / [`android.md`](android.md), if it happens | This plan makes the change feed part of the interface, so a second implementation has to satisfy it. It does not write one. |
| List import (clipboard / Pleco / Anki) | its own task, per STACK §7 | |
| Audio tier 2 (cloud voice, cached per entry) | undecided, STACK §5.3 | It lands *on* this server when it lands. Deferred here; §7. |

## 3. What exists today

Read at `HEAD` of `claude/apps-ui-design-791zpq`. Everything below is a fact from the repo.

**There is no server.** There is no `apps/server/`, no auth, no user id in any type, no network
persistence, and no code anywhere that talks to a database it does not own. The word "Supabase"
appears in the repository three times — twice in a comment in `lib/db/dexie.ts` and `lib/db/schema.ts`
saying a rule exists so the swap stays a swap, once in `HANDOFF.md` — and never in an import.

**What plays the part of a server today** is Next route handlers inside the app:

| Path | What it does | Where it goes |
|---|---|---|
| `app/api/ask/route.ts` | The grounded ask pipeline: merged dictionary search, `proposePhrases`, `answer`, `ground()`, returns validated response + cited entries | B1, then reshaped in B2 |
| `app/api/examples/route.ts` | i+1 sentences for one card, grounded and then *filtered* against the known set | B1, then B2 |
| `app/api/recall/route.ts` | Reads a typed answer against an entry's glosses, suggests a 1–4 grade | B1, then B2 |
| `app/api/dict/{entries,hsk,search,segment,decomp}/route.ts` | The dictionary service | **Deleted** by `data.md` D6, not moved here |
| `middleware.ts` | The `?key=`→cookie exchange, and a pre-handler refusal on the three gated paths | Split by `web.md` W4; the refusal half arrives here |
| `lib/server/access.ts` | The whole of the gate. Imports nothing from `next/*`, on purpose | Moves here **unchanged** apart from W4's deleted cookie helpers |
| `lib/server/route-inventory.ts`, `scripts/smoke.ts` | "Every route is exercised over HTTP on a built server" | Half of the replacement is this plan's (§5, B1) |

Three properties of that code make the move cheap, and they are facts rather than hopes. Every
handler has the signature `(request: Request) => Promise<Response>` with no Next types in the body —
`web.md` W1's dev adapter depends on the same thing. `lib/ai/**` (`provider.ts`, `anthropic.ts`,
`fake.ts`, `ground.ts`, `prompts.ts`, `examples.ts`, `recall.ts`, `deadline.ts`, `cache-key.ts`) is
plain TypeScript with `zod` and `@anthropic-ai/sdk@0.124.0`; `selectProvider()`
(`lib/ai/provider.ts:208`) reads `TANGRAM_LLM_PROVIDER` and `ANTHROPIC_API_KEY` from a plain
`Record<string, string|undefined>`. And `lib/server/access.ts` was deliberately written free of
`next/*` so middleware, handlers and tests ran one implementation.

**The dictionary is loaded into the server process today.** `docs/deploy.md` §5 measures it: a cold
instance takes ~2.3 s to answer `/api/ask` after the lazy indexes were added in Phase 8, and settles
at 171–267 MB RSS depending on which indexes the route woke. That cost is inherited by whatever runs
these handlers in B1 and is deleted in B2.

**The persistence seam.** `lib/db/repository.ts` is an interface of ~30 domain methods
(`addCardFromEntry`, `grade`, `listDue`, `addListMembers`, `getSettings`, `askCache.get/set`,
`resetAll`, …). `lib/db/dexie.ts` is the only implementation; `lib/db/get-db.ts` memoises it on
`globalThis` behind `'use client'`. STACK §1 is right that this is a *data-layer swap* seam and not a
sync seam: there is no change feed, no per-row version, no origin, no conflict policy. §5, B5 is
where it grows one.

**What the schema actually guarantees, row by row.** This is the load-bearing part of §3 and it is
not what a skim of PLAN.md §3.3 suggests. `lib/db/schema.ts` defines `BaseRow` as
`{id, createdAt, updatedAt, deletedAt}` — and only four stores extend it:

| Store | `id` | `createdAt` | `updatedAt` | `deletedAt` | Delete semantics in `lib/db/dexie.ts` |
|---|---|---|---|---|---|
| `words` | uuid | yes | yes | yes | soft |
| `cards` | uuid | yes | yes | yes | soft |
| `lists` | uuid | yes | yes | yes | soft (`deleteList`, line 681) |
| `texts` | uuid | yes | yes | yes | soft |
| `reviews` | uuid | yes | **no** | **no** | append-only, never updated |
| `list_members` | uuid | yes | **no** | yes | soft (`removeListMembers`, line 700) |
| `known_words` | uuid | yes | **no** | **no** | **hard `.delete()`** (`unmarkKnown`, line 513) |
| `ask_cache` | content hash, **not a uuid** | yes | no | no | never deleted |
| `settings` | the literal `'singleton'`, **not a uuid** | yes | yes | no | never deleted |

Three of those rows are a problem for sync and each is named again in B4: `list_members` has a
tombstone but no `updatedAt` to resolve it against; `known_words` has neither, and `unmarkKnown`
**hard-deletes**, which under any replication scheme means the peer's surviving row resurrects it;
and `settings` is a singleton whose `introduced: Record<dayKey, number>` is a counter that
last-write-wins will silently clobber. None of this is a criticism of the original design — it was
built for one device — and all of it is free to fix, because there are no users and no data.

**What is already true and genuinely helps.** Card snapshots (`EntrySnapshot`, `PhraseSnapshot`) mean
a card renders without the dictionary, so sync never carries dictionary rows and two devices on
different `dictVersion`s are not in conflict. `reviews` is append-only and carries enough to replay:
`lib/srs/card.ts:149` `replayCard(reviews, settings)` rebuilds an `FsrsCardState` from the log, and
`tests/unit/srs/replay.test.ts` asserts it reproduces the stored card. Table names are the Dexie store
names verbatim (`known_words`, not `knownWords`) "so the same identifiers survive into SQL" — the
schema's own comment. And `lib/db` is importable under plain Node without throwing, which is what
lets the sync engine and the export be unit-tested in the container.

**One out-of-band write to know about.** `markKnown` (`lib/db/dexie.ts:473`) does not only insert a
`known_words` row; it rewrites the recognition card's FSRS state through `knownCardState`
(`lib/srs/states.ts:53`, applied at `dexie.ts:499`). So the stored card is *not* purely a function of
its review log, and a naive "recompute card state from the merged log" would quietly undo every
mark-known. B5 handles it explicitly.

**Config that already exists and should be reused rather than reinvented:** `.env.example` and
`docs/deploy.md` §3 define `ANTHROPIC_API_KEY`, `TANGRAM_LLM_PROVIDER`, `TANGRAM_MODEL`
(`DEFAULT_MODEL = 'claude-opus-5'`, `lib/ai/anthropic.ts:61`), `TANGRAM_ACCESS_SECRET`,
`TANGRAM_DATA_DIR`, and the four deadline overrides (`TANGRAM_ASK_ANSWER_TIMEOUT_MS` 30 000,
`TANGRAM_ASK_PROPOSE_TIMEOUT_MS` 8 000, `TANGRAM_EXAMPLES_TIMEOUT_MS` 20 000,
`TANGRAM_RECALL_TIMEOUT_MS` 15 000). `docs/deploy.md` §6 already warns that a platform function
timeout below 30 s kills `/api/ask` before its own deadline fires — that warning transfers to
whatever host B0 picks and is the first question to ask of it.

## 4. Dependencies

**Before this plan starts:**

1. **CLAUDE.md must be rewritten** (STACK §7). It is auto-loaded project instructions, it describes a
   Next-shaped command set, and its frozen-file list freezes `lib/db/schema.ts` and
   `lib/db/repository.ts` — the two files B4 and B5 must change. STACK §7 already rules that
   `lib/db/schema.ts` "is now editable"; the instructions have to say so too or every phase below
   fights them.
2. **The workspace layout must exist** — `web.md` W0's single pnpm workspace, into which this plan
   adds `apps/server/`. If that decision reverses, only the paths in this plan change.
3. **Two facts must be read from an unblocked network before B0 commits to a shape.** Neither was
   established by any audit. They are listed with their checks in §6, and B0's acceptance is what
   forces them: the provider's terms on third-party custody of end-user API keys, and the chosen
   host's function wall-clock/CPU limits against the 30 s ask deadline.

**Sibling-plan gates:**

| Phase | Needs |
|---|---|
| B0 | `web.md` W0 (the workspace). Nothing else; it runs in the container. |
| B1 | `web.md` W1 (the app builds under Vite and has a configurable API base) and W4 (the client sends the gate header, `lib/server/access.ts` has moved to a shared package). B1 is what lets `web.md` delete its dev/preview API adapter, so W1 must land first and the adapter must not be treated as a product. |
| B2 | `data.md` D2 and D3 (a `DictStore` the client can retrieve from) and D6's `lib/ai/retrieve.ts`. Without them the client cannot build the retrieved set and there is nothing to flip to. |
| B3 | B0. Independent of `data.md` and `core.md`; the sign-in screen may be unstyled. |
| B4, B5 | B3. B5 also wants `web.md` W5's export/import round-trip test, because it exercises the same row shapes. |
| B6 | B3, and a **yes** on the provider-terms check. A **no**, or an unclear answer, stops B6 and leaves the single-account shape in place (§5, B6). |
| B7 | Everything it hardens. |

**What other plans may start against, and when.** The API base URL and path names are settle-first
(`/api/ask`, `/api/examples`, `/api/recall` keep their paths so `GATED_PATHS` in
`lib/server/access.ts` stays literally true). The **new ask/answer contract** is the other settle-first
surface named in STACK §7; it lands as the first commit of B2 and is frozen from then on, because
`core.md`'s ask panel and `data.md`'s retrieval helpers both code against it.

## 5. Phases

Eight phases. B0–B2 are the AI proxy and are on `web.md`'s critical path — the moment the app ships as
a static SPA, three routes have nowhere to run. B3–B5 are accounts and sync and are the data-safety
half. B6–B7 are custody and operations. Each ends with `pnpm lint`, `pnpm test`, the phase's specs
green, an adversarial review, and a commit.

**Two rules that hold across every phase.** First: **the app must work fully signed out.** Tangram is
local-first (PLAN.md §2); an account is backup and a key, not a login wall. Any phase that makes an
unauthenticated app worse than it is today has failed. Second: **no number for the running cost
appears in this document.** STACK §5.5 forbids it until the shape closes; B0 is where the number is
first recorded, in `HANDOFF.md`, from a real invoice or a real quote.

---

### B0 — Choose the shape, and deploy the smallest thing that answers

**Builds.** The decision STACK §5.5 leaves open, and a deployed `apps/server/` that returns its own
build id. Nothing else.

**The decision, and the reasoning that should not have to be re-derived.** STACK §5.5 frames the
choice as Hono/Node vs Supabase vs something else, and resolves one contradiction already: this is
**two components, not one** — a stateless AI proxy and a stateful part holding accounts, key custody
and sync. That resolution is what makes the recommendation possible.

**Recommendation: Supabase for the stateful half, one small Node service for the proxy.**

- *Accounts, Postgres and row-level security come from Supabase.* PLAN.md §3.3's schema rules were
  written for this swap; the alternative is a solo developer implementing sessions, email delivery,
  token refresh and password recovery, which is the largest pile of undifferentiated work in this
  entire document. Sync needs no server code at all under this shape: the client talks to PostgREST
  with the account's JWT and RLS does the enforcement (B4).
- *The proxy is a plain Node service* (Hono, or a bare `node:http` handler — the handlers are already
  `(Request) => Response`, so the framework is nearly irrelevant). It goes there because `lib/ai/**`
  is Node-shaped TypeScript against `@anthropic-ai/sdk@0.124.0` with a 30 s deadline, and porting it
  to a Deno edge runtime is unforced work with a runtime-limits question attached (§6). It verifies
  the Supabase JWT and holds the key; it stores nothing.

**The falsifier, stated up front:** if the host's function limits comfortably exceed the 30 s ask
deadline *and* `lib/ai/**` runs unmodified on Supabase Edge Functions, then the proxy belongs there
too and this becomes one deployable and one bill. That is a check, not an opinion (§6, row 2). Run it
in this phase. The reverse falsifier: if Supabase Auth turns out to cost more configuration than
writing sessions against the same Postgres, the whole thing collapses into one Node service — but do
not decide that on taste, decide it after B3.

**Also decided here, because later phases assume it:** the server lives at `api.<domain>` with the
app at `app.<domain>` (`web.md` W7's two-origin split); path names are preserved verbatim; the CORS
allowlist starts as `https://app.<domain>` plus the dev origin and gains the two WebView origins that
`ios.md` I1 and `android.md` A1 owe this plan.

**Files.** `apps/server/` (`package.json`, `tsconfig.json`, `src/index.ts`, `src/routes/health.ts`),
`pnpm-workspace.yaml` (one line), `docs/deploy.md` (rewritten header naming two deployables),
`HANDOFF.md` (the decision, the host, the cost).

**Acceptance criteria.**

- `curl https://api.<domain>/health` returns 200 with the git sha of the deploy, and a redeploy
  changes it. The point is that a deploy procedure exists and is repeatable, not that the route is
  interesting.
- `pnpm --filter server build && pnpm --filter server start` works in the container, and the root
  `pnpm test` and `pnpm lint` still pass with the new package in the workspace.
- **Recorded in `HANDOFF.md`, all four:** the chosen shape and why; the host's documented maximum
  request duration and whether it exceeds 30 s; the answer to the provider-terms question (§6, row 1)
  including the URL and the date it was read; and the monthly cost at zero traffic, from the host's
  own pricing page.
- A rollback is written down and tried once: deploy a known-bad build, roll back, `/health` returns
  the previous sha. A rollback that has never been executed is not a rollback.

---

### B1 — The three model routes move, contract unchanged

**Builds.** `/api/ask`, `/api/examples` and `/api/recall` answering from `api.<domain>`, byte-identical
in behaviour, with the gate in front of them. This phase deliberately changes **nothing** about what
the routes do, so that the review has one variable.

The handlers move as files. `lib/ai/**` moves into a shared workspace package (both the server and
the client import from it: `ground.ts` and `cache-key.ts` already run in the browser, and B2 needs
more of it to). `lib/server/access.ts` arrives from `web.md` W4 and `requireAccess(request)` stays the
first line of every handler, for the reason its own header gives — a gate that lives only in
middleware is one config edit from being off, and the failure mode is an invoice.

**The dictionary comes with them, on purpose and temporarily.** These handlers read `lib/dict/**` and
`data/dict.json`; B2 is what removes that, and B2 is gated on `data.md`. So B1's server loads the
dictionary at boot exactly as today. A long-running process is the *favourable* case for that cost —
`docs/deploy.md` §5 measures ~2.3 s and 171–267 MB RSS per process, paid once instead of per
lambda-instance — but it sets a memory floor for the host, and if the host scales to zero it is paid
again on every cold start. **Measure both and record them**; they are the numbers that justify B2.

Also here, the replacement for half of `pnpm smoke`: `scripts/smoke.ts` and
`lib/server/route-inventory.ts` walk every route of a built server, and STACK §7 flags that nothing
yet replaces them. `web.md` W2 owns the static-host half. This plan owns the API half: a
`pnpm --filter server smoke --base-url <url> --key <secret>` that hits every route the server
declares and fails on any non-2xx, derived from a route table module rather than a hand-written list,
so a route added without a smoke case is a test failure.

**Files.** `apps/server/src/routes/{ask,examples,recall}.ts` (moved, not rewritten),
`packages/ai/**` (moved `lib/ai/**`), `packages/access/**` (moved `lib/server/access.ts`),
`apps/server/src/cors.ts`, `apps/server/src/smoke.ts`, `apps/app/**` call sites already pointed at
`VITE_API_BASE` by `web.md` W4, `docs/deploy.md` §3 (env vars, now on two deployables),
`web.md`'s `vite-plugins/api.ts` (its three model cases deleted).

**Acceptance criteria.**

- Against the deployed server with `TANGRAM_ACCESS_SECRET` set: each of the three paths without the
  header is `401 {"error":"unauthorized"}` with no echo of what was sent; with the header, each
  answers. The five dictionary routes are **not** on this server at all, and requesting one is a 404,
  not a 401 — a gate that quietly widened is a broken PWA.
- With `TANGRAM_ACCESS_SECRET` unset, everything is open and every existing test behaves exactly as
  before. This is rule 1 of `access.ts` and breaking it fails the phase.
- Every test under `tests/unit/ai/**` passes **unmoved** except for import paths. These tests encode
  the grounding contract; a change to one of them in this phase is a change to the product's core
  promise and needs to be argued, not absorbed.
- CORS: a browser request from `https://app.<domain>` succeeds; one from an origin not on the
  allowlist is refused by the browser and the response carries no `Access-Control-Allow-Origin`.
  Assert with a Playwright spec from the app origin, not with `curl` — `curl` ignores CORS and will
  cheerfully tell you it works.
- The full app works end to end against the deployed server: look up → ask → add a card → review →
  example sentences → free recall.
- **Recorded in `HANDOFF.md`:** RSS after boot and after the first ask; time from process start to
  first successful ask; whether the host keeps the process warm and, if it scales to zero, the cold
  ask latency. These three numbers are B2's justification.

---

### B2 — The contract flip: the client retrieves, the server stops holding the dictionary

**Builds.** The new request contract STACK §5.5 recommends and leaves undesigned, and the deletion of
the server's dictionary. This is the phase with a real design in it, and the one that must be settled
before `core.md`'s ask panel and `data.md` D6 can finish.

**Why the flip.** After `data.md`, the client has the dictionary and the server does not. The
alternative — the server keeping its own copy of the SQLite file — re-imports the cold-start and
memory problem that §2.2 of STACK claims the move deletes. And the client is the only party that can
render the answer anyway: PLAN.md §1's third commitment is that hanzi and tone marks are rendered
from cited dictionary rows, never from model output.

**The contract.** `POST /api/ask` becomes two calls, because retrieval now happens on the client and
the model's phrase proposals are an *input* to retrieval:

```
POST /api/ask/propose   { query, context? }
  → { candidates: string[] /* ≤8 */, provider, promptVersion, model? }

POST /api/ask/answer    { query, context?, profile, dictVersion,
                          retrieved: { id, simp, trad, pinyinMarked, glosses }[] /* ≤40 */ }
  → { response: AskResponse /* schema-validated, NOT grounded */,
      provider, promptVersion, model? }

GET  /api/ask            → { provider, promptVersion, model? }        (unchanged handshake)
```

The client skips `propose` when `needsProposals(query)` is false — that function is 4 lines in
`app/api/ask/route.ts` and moves to `lib/ai/retrieve.ts` with `mergedSearch`, `candidateEntries`,
`mergeRetrieved`, `RETRIEVED_CAP` and `SEARCH_HEAD` (`data.md` D6 already assigns that move). So a
hanzi query is one round trip, as today; an English question is two. **The second round trip is
invisible** because the dictionary card renders immediately and independently and the ask panel fills
a slot asynchronously — PLAN.md §3.4's last paragraph and product-decisions §5's "while the AI is
thinking the dictionary card is already there" are the same rule, and this phase must not break it.

`ground()` moves to the client. It is pure and it is where the answer becomes renderable. One real
mismatch, already diagnosed by `data.md` D6: `GroundContext.segment` is synchronous and
`DictStore.segment` is not. The fix is the caller's, not `ground.ts`'s — await the segmentations for
each rendered phrase up front into a `Map<string, Token[]>` and pass `(text) => map.get(text) ?? []`,
and resolve `entry`/`readings` from the same awaited batch. **Do not make `ground.ts` async**; its
tests are the encoding of the product promise and churning them to chase a signature is how a promise
gets weakened by accident.

`/api/examples` flips the same way: the client sends the target entry and the support pool (already
capped at `SUPPORT_CAP` = 40), the server returns schema-validated sentences, and `groundExamples()`
plus the i+1 filter run on the client. **State this plainly rather than letting it slide**, because
the route's own header currently argues the opposite: *"step 3 is why this is a route at all rather
than a client-side fetch: the filter is the feature, and a filter that ran in the browser would be a
promise the server had already broken."* That argument was about a server that had the dictionary and
a client that did not. After `data.md` the client is the only party that can run the filter, and the
learner is not an adversary to their own flashcards. Rewrite the header to say what is now true; do
not leave a comment asserting a boundary that no longer exists.

`/api/recall` flips least: it needs the entry's glosses, which the client now sends. The
CJK-scrubbing of `why` (`scrubProse`) **stays on the server**, because that one is not a rendering
concern — it is what stops an unchecked reading reaching the card front — and it costs nothing to
keep it where the model output is first seen. Do it in both places.

**What the server keeps, and it is now the reason the server validates anything.** Once the client
supplies the prompt's inputs, server-side validation stops being hygiene and becomes cost control. A
zod schema at the edge enforces: at most 40 retrieved entries, at most 200 `knownSample` words, the
existing 400-character caps on `query` and `sentence`, a total body size cap, and — most importantly
— **the model id is chosen by the server and never read from the request**. A client that could name
the model could name the most expensive one.

**Then delete.** No `lib/dict/**` import remains in `apps/server/`; no `data/` in its deploy artifact;
`next.config.ts`'s `outputFileTracingIncludes` and the test that guards it
(`tests/unit/server/routes.test.ts`) go in the same commit as the thing they guarded, which is
`web.md` W1's stated rule.

**Files.** `apps/server/src/routes/{ask,examples,recall}.ts` (rewritten), `packages/ai/schemas.ts`
(the request schemas, shared by client and server), `lib/ai/retrieve.ts` (from `data.md` D6),
`components/lookup/ask-panel.tsx` and `components/review/example-sentences.tsx` (call sites and
client-side grounding), `tests/unit/ai/**` (unchanged assertions, new call shape),
`next.config.ts` and `tests/unit/server/routes.test.ts` (deleted).

**Acceptance criteria.**

- The server's deploy artifact contains no `data/` and no `lib/dict/**`; `grep -rn "lib/dict"
  apps/server/src` returns nothing; the process boots and answers with `data/` absent from the disk.
- RSS after boot and after the first ask, compared against B1's recorded numbers. This is the phase's
  headline result and it should be a large fall.
- **Every grounding test in `tests/unit/ai/**` passes with its assertions unchanged.** STACK §5.5
  names this as the check that says whether the new contract still holds. Specifically: the
  `随看随买` / `绝绝子` / `我随便看看` cases, the injected `'bogus'` id being dropped, and the
  wrong-pinyin-cannot-change-the-display case (PLAN.md §3.4).
- An e2e spec proves the panel is never empty and never blocked: with the network to `api.<domain>`
  refused, the dictionary card still renders and is addable, and the panel shows the offline chip
  (product-decisions §5's second designed state).
- **Recorded in `HANDOFF.md`:** the serialized size of a 40-entry `retrieved` payload for a realistic
  English query, in KB, and the observed latency of the two-round-trip path on a throttled mobile
  profile. Nobody has measured either; if the payload is large enough to matter the lever is sending
  fewer glosses per entry, not fewer entries.
- The ask cache still hits: `askCacheKey` folds in `promptVersion`, `provider`, `query`, `context`
  and `estimatedBand` and none of those change here, so a warm row from before the flip must still
  resolve. If the prompt changes, `ASK_PROMPT_VERSION` is bumped — that is what it is for.

---

### B3 — Accounts, and the rule that they are optional

**Builds.** Sign-up, sign-in, session, sign-out, and JWT verification on the proxy. No sync yet.

**Choose email one-time codes, not passwords.** A solo developer who ships passwords has also shipped
a reset flow, a rate limiter on that flow, and a support burden for the rest of the product's life.
An emailed six-digit code has none of that, works on a phone, and is one Supabase Auth setting. OAuth
providers are an app registration per provider per platform and buy nothing at one user; §7.

**What the app looks like signed out.** Exactly as it does now: every screen works, everything is
local, and there is one honest line where the account lives (Library, per product-decisions §1) that
says the deck exists only on this device. Signing in is presented as *turn on backup*, which is what
STACK §2.8 says it actually is. The proxy is the one exception and only once B6 lands: with a
server-held owner key the gate is the credential, and with per-account keys the JWT is.

**Two edges to get right now rather than discover later.** Signing in with local data present and an
empty account is a pure upload — no merge problem, because every id is a client-generated UUID and
nothing collides. Signing in with local data present and a **different** account than the one
`sync_state` last recorded is refused: offer export-then-reset instead. Merging one person's deck
into another account is unrecoverable, and the check is one string comparison.

**Files.** `apps/app/src/auth/**` (client: session, the code exchange, the `user_id` record in a new
local `sync_state` store), `apps/server/src/auth.ts` (JWT verification middleware),
`apps/app/src/routes/account.tsx` (functional, unstyled — named debt against `core.md`),
`lib/db/schema.ts` (the `sync_state` store; a Dexie version bump, which is free), `.env.example`.

**Acceptance criteria.**

- Sign up on browser A, sign out, sign in on browser B with the same address: the session is live in
  both and `user_id` is identical. No data moves yet — that is B5 — and the spec asserts that too, so
  nobody mistakes a session for sync.
- With the app signed out, the entire existing e2e suite passes unchanged. This is the "accounts are
  optional" rule and it is executable.
- A request to the proxy with an expired or forged JWT is a 401 and does not reach a provider.
  Forged: sign a token with the wrong key and assert the failure.
- Signing in with a `user_id` different from the one in `sync_state` shows the refusal and the export
  route out, proven by a unit test over the auth module rather than a screen.
- Session survives a reload and a restart of the app; sign-out clears it and leaves local data
  intact (assert a card is still there afterwards).

---

### B4 — The sync tables, the rules that make them safe, and the three schema corrections

**Builds.** The Postgres schema, the RLS policies, the LWW guard, and the client-side schema fixes
sync requires. No client engine yet — this phase is provable entirely in SQL, which is exactly why it
is its own phase.

**Which of PLAN.md §3.3's rules the design relies on.** Stating this is a requirement of the plan and
not a courtesy, because each rule maps to a specific thing that would otherwise have to be built:

| Rule | What it buys | What breaks without it |
|---|---|---|
| Client-generated `id: string` (`crypto.randomUUID()`, Dexie `'id'`, never `'++id'`) | Push is an idempotent upsert keyed by `id`; two devices creating rows offline never collide; no id remapping table | An autoincrement key means the same integer names two different cards on two devices, and every FK has to be rewritten on arrival |
| `updatedAt` epoch ms on every mutable row | The LWW comparator, and the "what changed here since last push" query | There is no way to ask a local store what changed, short of hashing every row |
| Nullable `deletedAt`, soft delete, `list*` filters tombstones | A delete replicates as a row; a peer cannot resurrect it | A hard delete is invisible to replication and the peer's copy comes back on the next pull |
| FKs are UUID strings with indexes | Rows may arrive in any order | Referential enforcement forces ordered application, which forces a transaction protocol |
| Card and phrase `snapshot`s | Sync never carries dictionary rows; two devices on different `dictVersion`s are not in conflict | Cards would have to be resolved against a dictionary the server does not have |
| `reviews` append-only | The one table that merges with no policy at all: union by `id` | The core study record would need conflict resolution |
| Table names verbatim (`known_words`) | The Postgres schema is a transcription, not a translation | A mapping layer nobody wants to maintain |

**The three corrections** (all free — no users, no data):

1. `list_members` gains `updatedAt`. It already tombstones but has nothing to resolve two tombstone
   states against.
2. `known_words` gains `updatedAt` and `deletedAt`, and **`unmarkKnown` becomes a soft delete**
   (`lib/db/dexie.ts:513` currently calls `.delete()`). This is the one place in the codebase that
   violates the schema's own soft-delete rule, and under sync it is a resurrection bug: unmark on the
   phone, sync, and the laptop's row marks it known again. `knownEntryIds()` and `markKnown`'s
   existing-row check both gain the tombstone filter.
3. `settings` keeps `id: 'singleton'` locally but is keyed on `user_id` in Postgres, and
   `introduced` is exempted from LWW — see the conflict policy below.

**The Postgres schema.** One table per Dexie store, in a `tangram` schema. Columns: `id uuid primary
key` (`settings`: `user_id uuid primary key`), `user_id uuid not null references auth.users(id) on
delete cascade`, the row's indexed scalars promoted to real columns (`entry_id`, `card_id`,
`list_id`, `due`, `direction`, `kind`, `reviewed_at`, …), everything structural as `jsonb`
(`snapshot`, `fsrs`, `context`, `log`, `before`, `introduced`), `created_at bigint`, `updated_at
bigint` (**the client's epoch ms, stored verbatim** — it is the LWW comparator and it must be the same
clock the client compares locally), `deleted_at bigint null`, and `server_updated_at timestamptz not
null default now()` maintained by a trigger. Index `(user_id, server_updated_at)` on every table —
that is the pull query and there is only one.

**No foreign keys between synced tables.** They would force arrival order, and rule 4 above is
precisely the licence not to need it. A `cards` row that arrives before its `words` row is renderable
from its own snapshot. The only FK is to `auth.users`.

**The LWW guard is a trigger, not client discipline.** One `tangram.lww_guard()` function on every
table: `before update`, return `OLD` unchanged when `NEW.updated_at < OLD.updated_at`. This makes
last-write-wins a property of the database rather than a convention every client must implement
correctly, and it means a buggy or old client cannot walk back a newer row. `reviews` gets no update
or delete policy at all — insert-only, `on conflict (id) do nothing`.

**The conflict policy, complete.** Write it down here so no phase invents its own:

| Table | Policy |
|---|---|
| `reviews` | Union by `id`. Append-only; never updated, never deleted. No conflict is possible. |
| `words`, `cards`, `lists`, `texts`, `list_members`, `known_words` | Whole-row last-write-wins on `updated_at`, tombstones included. A tombstone is a normal row and wins if it is newer. |
| `cards.fsrs` | LWW like the rest of the row, **then** recomputed if the merged review set for that card differs from what the local row was built from (B5). |
| `settings` | LWW per row, **except `introduced`**, which merges per day key by `max`. |
| `ask_cache` | **Does not sync.** It is derived, content-hash keyed, per-device, and regenerable. |

The `introduced` exception earns its place: every other settings column is a preference the learner
changes rarely, but `introduced[dayKey]` is a counter the app writes on every new card. Under
whole-row LWW, studying on two devices in one day means the device that syncs last decides how many
new cards you did — the visible bug is a doubled daily allowance, or a reset one. `max` per key is
correct for a single learner and is about ten lines.

**Client clocks are the acknowledged weakness.** LWW on a client-supplied `updated_at` means a device
with a badly wrong clock wins or loses every conflict. This is accepted for now — one person, two
devices — and the symptom is diagnosable (a stale value that keeps coming back). The check and the
escalation are in §6.

**Files.** `apps/server/supabase/migrations/**` (the schema, the trigger, the policies),
`lib/db/schema.ts` (`list_members.updatedAt`, `known_words.updatedAt`/`deletedAt`, `sync_state`, a
Dexie version bump and its upgrade block), `lib/db/dexie.ts` (`unmarkKnown`, `knownEntryIds`,
`markKnown`), `lib/db/repository.ts` (doc comment on the changed delete semantics),
`tests/unit/db/known-words.test.ts`.

**Acceptance criteria.**

- **RLS is proven, not configured.** Two accounts, a row inserted by each: from A's JWT,
  `select * from tangram.cards` returns only A's row; an insert with `user_id` set to B's id is
  refused; an update of B's row is refused; a delete of B's row is refused. Nine assertions, one SQL
  test file. A sync design whose isolation was never executed is not a sync design.
- Supabase's own security advisors report no errors on the new schema (`get_advisors`, security
  lint). Warnings are recorded with a reason if they are accepted.
- The LWW guard: update a row with an older `updated_at`; the stored row is unchanged and the
  statement does not error. Update with a newer one; it applies.
- `reviews` refuses `update` and `delete` from a client JWT, and a duplicate insert of the same `id`
  is a no-op rather than an error.
- Client-side: `unmarkKnown` leaves a tombstone, `knownEntryIds()` excludes it, marking known again
  after unmarking produces one live row and not two, and the Dexie upgrade runs on a database created
  at the previous version without throwing.
- `pnpm test` passes; the repository's own tests for lists and known-words still pass with the new
  columns.

---

### B5 — The sync engine, the change feed, and what recompute actually means

**Builds.** The client engine, the repository members it needs, and the account-level export.

**The seam widens, and this is the architectural cost of sync.** `lib/db/repository.ts` is a domain
API (`grade()`, `listDue()`, `addListMembers()`). Applying a remote row cannot go through it —
`grade()` would write a *new* review row for a review that already happened. So the interface gains a
narrow row-level channel alongside the domain one:

```ts
changedSince(store: StoreName, sinceMs: number): Promise<Row[]>;   // local writes to push
applyRemote(store: StoreName, rows: Row[]): Promise<void>;         // remote rows, LWW, no domain logic
syncState: { get(): Promise<SyncState>; set(patch: Partial<SyncState>): Promise<SyncState> };
```

Say plainly what this is: the repository is no longer only a domain API, and any second
implementation — the `@capacitor-community/sqlite` one STACK §2.8 leaves open for mobile, or the
`tauri-plugin-sql` one §2.4 leaves open for desktop — must satisfy these three as well. That is a real
increase in what a swap costs, and it is the price of sync being a property of the seam rather than a
feature bolted to Dexie.

**The loop.** `push()` reads `changedSince(store, lastPushedAt)` for each synced store and upserts to
PostgREST; on success it records `lastPushedAt = t0`, the timestamp taken *before* the read, so a row
written during the push is caught next time. `pull()` selects `server_updated_at > cursor` per store,
applies through `applyRemote`, and advances the cursor to the maximum `server_updated_at` seen —
minus a one-second overlap, because commits are not ordered by the clock they stamp and re-applying a
row is free when every apply is an idempotent LWW upsert.

**When it runs:** on sign-in, on app foreground, after a debounce following any local write, and on a
manual "sync now". **Not** a live subscription. Realtime is a second failure mode for a benefit
nobody asked for at one user; §7.

**Recompute, precisely.** STACK §5.5's recommendation is "recompute derived card state from the
merged log rather than replicating it". Follow it, but not blindly, because §3 above found the reason:
`markKnown` writes FSRS state out of band. The rule:

1. After a pull that touched `reviews` or `cards`, for each affected card, compare the local review
   count with the merged one. **If they are equal, do nothing** — the common case (one device, brief
   offline) costs zero.
2. If they differ, `replayCard(mergedReviewsForCard, settings)` (`lib/srs/card.ts:149`) and write the
   result. `tests/unit/srs/replay.test.ts` already asserts replay reproduces the stored card, so this
   is a use of an existing, tested guarantee rather than a new scheduler.
3. Then, if a live `known_words` row for the card's entry has `createdAt` later than the last review's
   `reviewedAt`, apply `knownCardState(fsrs, thatCreatedAt)` (`lib/srs/states.ts:53`) on top — which
   is exactly what `markKnown` does at `lib/db/dexie.ts:499`. Recognition cards only, matching
   `markKnown`'s own direction filter.

This is deterministic on both devices from the merged data, which is the property that makes it
convergent. Every parameter comes through `lib/srs/params.ts`, which CLAUDE.md makes the one
construction site — `replayCard` already goes through it, and the sync engine must not acquire a
second one.

**The export the server owes.** `web.md` W5 ships the local export/import over the repository's row
shapes; this phase adds the account-level one — a `GET /export` that returns every row for the
account in the same JSON shape, so a learner can leave with their data and so a corrupted local store
can be rebuilt from the server without the app. It reuses W5's serializer; if the two ever diverge, a
test says so. **If this plan slips, W5's local export is the entire safety net and must ship anyway** —
that is the point of STACK §2.8's export-first framing and of `ios.md`/`android.md` reusing it.

**Files.** `lib/sync/{engine,cursor,mapping,conflicts}.ts`, `lib/db/repository.ts` (the three
additions), `lib/db/dexie.ts` (their implementation), `lib/srs/recompute.ts`,
`apps/server/src/routes/export.ts`, `apps/app/src/routes/account.tsx` (sync status, last-synced,
manual sync), `tests/unit/sync/**`, `tests/e2e/sync/**`.

**Acceptance criteria.** These are the phase, and they are all executable.

- **Two clients converge.** A unit-level harness with two repositories over `fake-indexeddb` and one
  Postgres (a local Supabase, or a branch): make disjoint edits on both offline, sync both, and every
  table is row-identical in both — tombstones included.
- **Delete replicates.** Delete a list on A, sync both, the list is gone on B and does not come back
  after a third sync. Same for a card, and same for `unmarkKnown` (which is the case B4's correction
  exists for).
- **Reviews union.** Grade the same card on both devices while offline, sync: both hold the union of
  review rows, and each card's `fsrs` equals `replayCard(merged)` with the known-words rule applied.
  Assert the state on both devices is equal to each other **and** to a third replay computed
  independently in the test.
- **Mark-known survives a merge.** Mark known on A after B's last review, sync, and the card on B is
  not due — i.e. step 3 of the recompute rule ran.
- **`introduced` merges by max.** Introduce 3 new cards on A and 4 on B on the same day key, sync:
  both read 4, not 3 and not 7. (4 is the honest answer for a single learner: the counter is a cap on
  a day's introductions, not a sum of them. Write the reasoning into the code, because the next reader
  will assume it is a bug.)
- **`ask_cache` does not sync.** Assert it, so nobody adds it later by symmetry.
- **Interrupted sync is safe.** Kill the process mid-push and mid-pull; on the next run the result is
  the same converged state. Every apply is idempotent, and this is the test that proves it.
- **Signed out, nothing happens.** With no session, no request leaves the app and every existing e2e
  spec passes.
- `GET /export` returns rows that `web.md` W5's importer accepts, round-tripped into an empty local
  database, with tombstones preserved.

---

### B6 — BYOK: custody, and the honest threat model

**Builds.** Per-account storage of the learner's own provider key, encrypted at rest, and the
user-facing statement of what that does and does not mean.

**This phase is conditional and the condition is not technical.** STACK §2.8 and §5.5 both record an
unanswered question: **whether the provider's terms permit a third party to store and use end-user
API keys on their behalf.** No audit established it. B0's acceptance requires reading the answer. If
the answer is no, or unclear, **B6 does not run**, and the product ships in the shape it is already
in: one account, the owner's own key in the server's environment, nobody else's credentials anywhere.
That shape needs no custody at all, and STACK §2.8 explicitly names it as the real situation until
someone other than the owner wants to use the app.

**The scheme, if it runs.** Envelope encryption. A 32-byte master key lives in the host's secret store
as an environment variable, never in Postgres. Each account's provider key is encrypted with
AES-256-GCM under a per-account data key wrapped by the master, stored as
`{ciphertext, iv, tag, key_version}` in a `tangram.provider_keys` table that **has no select policy at
all** — the client cannot read it back under any JWT. Writing goes through the proxy, which holds the
service credential; the client sends the key once over TLS and never sees it again. What the client
*can* read is a fingerprint row: the last four characters, the creation date, and the last-used date.

Rotation is a `key_version` column and a re-encrypt job; revocation is a delete plus a line telling
the learner to revoke the key at the provider, because a key we have deleted is still a live key.
Both must exist before this phase is called done — a custody scheme with no rotation path is a
custody scheme with one key forever.

**What BYOK protects, stated exactly:**

- It protects the *owner's* wallet. Nobody's inference is billed to him, which is the entire reason
  "free with a cap" was ruled out (product-decisions §7).
- It protects the key from the *client*: the Anthropic TypeScript SDK only permits browser calls
  behind an explicitly-named dangerous flag, because a key on a page is exposed to everything on that
  page. Server-side custody is what removes that exposure, and it is why the web version can have AI
  at all (STACK §2.8).
- Encryption at rest protects against a database dump: a stolen backup, a leaked Postgres credential,
  a disposed disk.

**What it does not protect, and this must appear in the UI and not only here:**

- **It does not protect the key from the operator.** The proxy decrypts to use it; the master key is
  in the running process. Anyone with the host account can read any key. There is no design in which
  a server that *uses* a key cannot *see* it, and any copy that suggests otherwise is a lie.
- **A compromised proxy is a compromised key**, and also a compromised prompt stream. Encryption at
  rest is irrelevant to that case.
- **It does not cap spend.** The mitigations are the provider's own spend limits (tell the learner to
  set one and to use a dedicated key for this app, in the UI, at the moment they paste it) and B7's
  per-account rate limits.
- **It makes a solo developer the custodian of strangers' billing credentials**, which is a
  credential target worth attacking and an incident-response obligation. STACK §2.8's correction of
  its own earlier "costs nothing extra" is the sentence to keep in mind.

**Files.** `apps/server/src/keys/{store,crypto,rotate}.ts`, a migration for
`tangram.provider_keys`, `apps/server/src/routes/{ask,examples,recall}.ts` (key resolution per
account), `apps/app/src/routes/account.tsx` (paste, fingerprint, remove, and the plain-language
statement above), `docs/deploy.md` (master key handling, rotation runbook), `.env.example`.

**Acceptance criteria.**

- A key stored through the API cannot be read back by any client call: assert a select under the
  account's own JWT returns zero rows, and that the fingerprint endpoint returns only the last four
  characters and the dates.
- Ciphertext round-trips: encrypt, restart the process, decrypt, and the model call succeeds. A
  wrong master key fails closed with a clear server-side error and a generic client-side one.
- Rotation: rotate the master key, re-encrypt, every stored key still works, and the old master no
  longer decrypts anything. Run it once for real in this phase.
- Removing a key: the row is gone, the account falls back to whatever the server's default is (the
  fake provider, or nothing, depending on B7's policy), and the app says which.
- A grep proves no key material reaches a log: assert that the logger redacts, with a test that logs
  an object containing a key-shaped string and inspects the output.
- The account screen carries the four "does not protect" statements in the learner's language, and
  the provider's spend-limit advice at the point of pasting.

---

### B7 — Operating it: limits, logs, backups, and the runbook

**Builds.** The things that decide whether one person can run this without it becoming a second job.

- **Per-account limits** on the three model routes: requests per minute and per day, and the body-size
  and entry-count caps B2 introduced. Return `429` with a `Retry-After`, and make the client's copy
  say what happened rather than "something went wrong".
- **Logs that are useful and safe.** Structured, one line per request: account id, route, provider,
  latency, outcome, token counts if the SDK reports them. Never the key, never the full prompt, never
  the learner's query by default — that last one is the tempting mistake, because query text is what
  you want when debugging, and it is also the learner's study history. If a debug mode logs queries,
  it is opt-in and it is time-bounded.
- **Backups and a restore drill.** Postgres point-in-time recovery, whatever the host offers, plus
  one executed restore into a scratch project with a screenshot or a log in `HANDOFF.md`. An untested
  backup is a hope.
- **`docs/deploy.md` rewritten** for two deployables. It currently documents a single Vercel project
  serving Next; it must become: the app's static host (`web.md` W2 owns that half), the server, the
  env vars for each, the master key, the rollback, the smoke commands, and the after-deploy checklist.
  Its §6 warning — function timeout versus the 30 s ask deadline — carries over verbatim and applies
  to the new host.
- **A monitoring floor.** Not an observability stack: an uptime check on `/health`, an alert on 5xx
  rate, and a monthly glance at spend. Anything more is a project.

**Acceptance criteria.**

- Exceeding the per-minute limit returns `429` with `Retry-After`, the app shows the real reason, and
  a normal study session never hits it (assert the limit is above a measured session's request rate,
  and record that rate).
- A synthetic request carrying a key-shaped string appears redacted in the logs.
- A restore drill is executed and recorded in `HANDOFF.md` with the date, the target, and the elapsed
  time.
- `pnpm --filter server smoke --base-url <production>` passes against the deployed server, and the
  after-deploy checklist in `docs/deploy.md` is walked once by hand.
- `docs/deploy.md` contains no Next-specific instruction and no reference to a route this plan or
  `data.md` deleted.

---

## 6. Risks

Each row: the trigger that says it is happening, and the mitigation. **STACK §4's register does not
cover this plan** — the audits scoped the client — so the first four rows are this plan's own open
facts, stated as risks rather than dressed up as findings, and the last three are register entries
that this plan is the mitigation *for*.

| Risk | Trigger | Mitigation / the check that settles it |
|---|---|---|
| **The provider's terms may not permit third-party custody of end-user API keys.** Unestablished by any audit; STACK §2.8 and §5.5 both flag it. | B0's read of the terms says no, or is ambiguous. | **Check:** read the provider's terms of service and API/commercial terms from an unblocked network in B0; record the URL and the date in `HANDOFF.md`. If no or unclear: B6 does not run, the server holds the owner's own key in its environment (which is what `.env.example` already describes), and the product is single-account until the answer changes. Nothing else in this plan depends on it. |
| **The host's function limits may be below the 30 s ask deadline.** `docs/deploy.md` §6 already documents this failure on Vercel; the new host is unaudited. | A long ask returns a platform error instead of the route's own 502, or is truncated. | **Check:** read the chosen host's documented maximum request duration in B0 and deploy a function that sleeps to just under 30 s. If it cannot: lower `TANGRAM_ASK_ANSWER_TIMEOUT_MS` (it exists for exactly this and needs no rebuild), or pick a host that can. Decide before B1, not after. |
| **Client-clock skew corrupts LWW.** `updated_at` is client epoch ms. | A value keeps reverting after sync, or a device's edits never win. | Accepted for one learner with two devices; the symptom is diagnosable. **The escalation, if it happens:** stop comparing wall clocks and adopt a per-row counter incremented on write, compared with `server_updated_at` as the tiebreak. That is a schema change and it is free while there is no data — so if it is going to happen, it is cheaper before B5 ships than after. |
| **A cold-starting proxy makes the first ask of a session slow.** Unmeasured; depends on B0's host. | B1's recorded cold ask latency is bad enough to be felt. | Measured in B1 and again in B2 (the dictionary's removal should dominate). Levers: keep one instance warm, or accept it because the dictionary card renders first anyway and the ask panel is asynchronous by design. |
| **The 40-entry `retrieved` payload is too large on a mobile connection (#none — nobody measured it).** | B2's recorded payload size or throttled latency is poor. | Measured in B2. Lever: send fewer glosses per entry rather than fewer entries — PLAN.md §3.4 says the prompt sees `id, simp, trad, pinyinMarked, glosses`, and glosses are 20% of `dict.json`'s bytes (`docs/deploy.md` §5's field breakdown). |
| **Register #3 — whether ITP's seven-day eviction applies to WKWebView inside a native app.** Unanswered on Apple's own forums. | Learner data disappears from a mobile app that has not been opened in a week. | **This plan is the mitigation** and STACK §4's own suggested answer is "cheapest answer is to not need it: get account sync working early". Until B5 ships, the cover is `web.md` W5's local export and, on native, STACK §2.8's option 2 (a `@capacitor-community/sqlite` `Repository`). **If B5 slips, neither of those may slip with it.** |
| **Register #13 — `navigator.storage.persist()` in Safari for a non-installed site.** | A browser tab loses its cards. | Same: sync is the durable answer, install and `persist()` are `web.md` W5's, and the export is the floor. |
| **RLS is misconfigured and one account can read another's rows.** The classic Supabase failure. | B4's isolation test passes but an advisor warns, or a later migration adds a table without a policy. | B4's nine-assertion isolation test plus the security advisor run, and a rule for every later migration: **a new table with no policy is a failed migration**, asserted by a query over `pg_policies` in CI rather than by discipline. |
| **The seam widens and the mobile/desktop `Repository` implementations become expensive.** STACK §2.8 and §2.4 both leave a second implementation open. | `ios.md` or a Tauri phase discovers it must implement `changedSince`/`applyRemote`/`syncState` too. | Stated here so it is not discovered: B5 makes those three part of the interface. Keep them narrow — three members, row-level, no domain logic — precisely so a second implementation is a day and not a week. |
| **Two components, two bills, two deploy procedures.** | The solo developer stops deploying because it is annoying. | B0 records the cost and the procedure and tries a rollback once; B7's checklist is one page. If it is still annoying after B7, the collapse-to-one-service option (B0's second falsifier) is still open and the code does not care. |

## 7. Out of scope for v1

- **Realtime sync.** Poll on foreground, on sign-in, and after a debounced local write. A live
  subscription is a second failure mode and a second reconnection story for a benefit one person with
  two devices cannot perceive.
- **CRDTs, operational transform, or any merge cleverness.** STACK §5.5's instruction is explicit —
  write down append-only reviews, recomputed card state and last-write-wins, and "revisit only when it
  visibly fails". The trigger for revisiting is a real conflict a real learner noticed, not a
  hypothetical.
- **Sharing anything between accounts** — shared lists, decks, a social layer. Every RLS policy in B4
  is `user_id = auth.uid()`, and it stays that way.
- **OAuth providers, and passwords.** An emailed code covers the case; §5, B3.
- **Subscriptions and billing.** STACK §5.4's recommendation stands: do not design for it, do not
  build anything that makes it hard. B7's per-account metering is the only thing a later subscription
  would need, and it is being built anyway for abuse control.
- **A server-side dictionary.** B2 removes it deliberately. If STACK §5.7's indexable per-word pages
  happen, they are Astro's static build against `pnpm data`'s output, not a query against this server.
- **Audio tier 2 (cloud voice, cached per entry).** It belongs on this server when it happens — STACK
  §5.3 says it "should follow the server, not precede it" — and it carries an unresolved licence
  question (whether the vendor's terms permit redistributing generated audio inside a shipped app)
  that must be answered *before* the vendor is chosen.
- **Self-hosting, multi-tenant onboarding, an admin surface.** One account exists. When a tenth does,
  revisit.
- **Migrations.** There are no users and no data. If a phase below produces a document with the word
  "migration" in it, it has misread this plan.
