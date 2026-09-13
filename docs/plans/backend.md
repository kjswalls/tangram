# Tangram — build plan: the server (accounts, sync, and the AI proxy)

**Status:** plan, written 2026-09-13; corrected 2026-09-13 for the orchestrator's rulings in
[`wave-zero.md`](wave-zero.md), which are settled and binding on this document. Sibling plans:
[`data.md`](data.md), [`core.md`](core.md), [`web.md`](web.md), [`ios.md`](ios.md),
[`android.md`](android.md).

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
  that wave 0's `lib/db/repository.ts` diff declares and this plan implements, and the client engine
  that drives it.
- The schema corrections sync requires on the client side (`list_members`, `known_words`, the hard
  delete in `unmarkKnown`, and the whole-database clear in `resetAll`), and the natural-key merge
  rules the four stores with one need.
- The **client-side ask module** — the two round trips, the local `ground()` call, the cache
  read/write and the trustworthiness test that gates it — exposed as the interface `core.md`'s ask
  panel renders. Not the panel.
- Key custody: encryption at rest, the threat model, rotation, revocation, and the honest statement
  of what BYOK does and does not protect.
- Rate and size limits — per account, per shared secret and per IP — and the operational surface:
  logs, backups, a restore drill, and the server half of `docs/deploy.md` (`web.md` W2 owns the file
  and rewrites it first; this plan appends to what W2 leaves).

**This plan does not own, and must not start:**

| Not here | Owner | Why the seam is where it is |
|---|---|---|
| The Vite build, the router, the workspace layout, the client's API base and the gate's client half | [`web.md`](web.md) (W0, W1, W4) | This plan produces something behind a base URL. How the client reaches it, and the `?key=`→header exchange in the browser, are transport. |
| The **local** export/import (`lib/db/export.ts`, `lib/db/import.ts`) | [`web.md`](web.md) W5 | It ships before this plan does and must not wait for it. This plan adds an account-level export **over the same row shapes** and depends on W5's round-trip test; it does not rebuild it. W5's `exportAll`/`importAll` and this plan's five sync members are **one interface diff, landed in wave 0** ([`wave-zero.md`](wave-zero.md) §5), so neither plan widens `lib/db/repository.ts` itself. See §5, B5. |
| The SQLite dictionary, `DictStore`, and the client-side retrieval helpers (`packages/ai/retrieve.ts`) | [`data.md`](data.md) (D1–D4; **`retrieve.ts` lands in D3**, `data.md:674`, not in D6) | The contract flip in B2 consumes them. `data.md` D3 already names the async-`segment` adapter this plan needs, and D6 only deletes. |
| Every screen, including the sign-in screen's visual design and the "backup is on" copy | [`core.md`](core.md) | This plan supplies the auth flow, the client modules and unstyled functional UI where a screen does not exist yet. That is named debt, not a design. |
| **Every state of the ask panel** — thinking, offline, nothing-verifiable — and `components/lookup/ask-state.ts` | [`core.md`](core.md) C7 | `core.md:191` says it designs those states "against a client-side ask module whose shape C7 defines" and that B2 "fills `answered`". So B2 changes the **module**, not the panel's states, and touches `ask-panel.tsx` / `example-sentences.tsx` only at the call site. Neither plan may claim the other's half. |
| `tests/unit/server/routes.test.ts` and `docs/deploy.md` | [`web.md`](web.md) W2 rewrites both | Both were listed here as deletions or rewrites and both are W2's. This plan appends to what W2 produced; it does not delete a page-coverage guard it does not own. See B2 and B7. |
| Capacitor projects and the WebView origin string | [`ios.md`](ios.md) I1, [`android.md`](android.md) A1 | Both plans already promise this plan exactly one fact: the origin their WebView runs from, for the CORS allowlist. |
| A second `Repository` implementation on `@capacitor-community/sqlite` (STACK §2.8 option 2) | [`ios.md`](ios.md) / [`android.md`](android.md), if it happens | This plan makes the change feed part of the interface, so a second implementation has to satisfy it. It does not write one. |
| List import (clipboard / Pleco / Anki) | its own task, per STACK §7 | |
| Audio tier 2 (cloud voice, cached per entry) | undecided, STACK §5.3 | It lands *on* this server when it lands. Deferred here; §7. |

## 3. What exists today

Read at `HEAD` of `claude/apps-ui-design-791zpq`. Everything below is a fact from the repo.

**There is no server.** There is no `apps/server/`, no auth, no user id in any type, no network
persistence, and no code anywhere that talks to a database it does not own. "Supabase" appears only
in comments and prose — `lib/db/schema.ts:4` and `:42`, `lib/db/repository.ts:5`, two tests
(`tests/unit/srs/replay.test.ts:17`, `tests/unit/db/queries.test.ts:36`), plus `PLAN.md`, `CLAUDE.md`,
`MORNING.md`, `HANDOFF.md` and `docs/deploy.md` — always saying a rule exists so the swap stays a
swap, and **never in an import**. `PLAN.md:46` records the other half of that state and it is the
sentence §4 turns into a precondition: *"No Supabase project; Supabase MCP needs OAuth this session
can't run."* Nothing has been provisioned. Not a project, not a domain, not a host account.

**What plays the part of a server today** is Next route handlers inside the app:

| Path | What it does | Where it goes |
|---|---|---|
| `app/api/ask/route.ts` | The grounded ask pipeline: merged dictionary search, `proposePhrases`, `answer`, `ground()`, returns validated response + cited entries | B1, then reshaped in B2 |
| `app/api/examples/route.ts` | i+1 sentences for one card, grounded and then *filtered* against the known set | B1, then B2 |
| `app/api/recall/route.ts` | Reads a typed answer against an entry's glosses, suggests a 1–4 grade | B1, then B2 |
| `app/api/dict/{entries,hsk,search,segment,decomp}/route.ts` | The dictionary service | **Deleted** by `data.md` D6, not moved here |
| `middleware.ts` | The `?key=`→cookie exchange, and a pre-handler refusal on the three gated paths | Split by `web.md` W4; the refusal half arrives here |
| `lib/server/access.ts` | The whole of the gate. Imports nothing from `next/*`, on purpose | Moves here with **one function rewritten**, not unchanged — see below |
| `lib/server/route-inventory.ts`, `scripts/smoke.ts` | "Every route is exercised over HTTP on a built server" | Half of the replacement is this plan's (§5, B1) |

Three properties of that code make the move cheap, and they are facts rather than hopes. Every
handler has the signature `(request: Request) => Promise<Response>` with no Next types in the body —
`web.md` W1's dev adapter depends on the same thing. `lib/ai/**` (`provider.ts`, `anthropic.ts`,
`fake.ts`, `ground.ts`, `prompts.ts`, `examples.ts`, `recall.ts`, `deadline.ts`, `cache-key.ts`,
`index.ts`) is plain TypeScript with `zod` and `@anthropic-ai/sdk@0.124.0`; `selectProvider()`
(`lib/ai/provider.ts:208`) reads `TANGRAM_LLM_PROVIDER` and `ANTHROPIC_API_KEY` from a plain
`Record<string, string|undefined>`. And `lib/server/access.ts` was deliberately written free of
`next/*` so middleware, handlers and tests ran one implementation.

**Two corrections to that "cheap", because both cost a decision.** First, `lib/server/access.ts` does
not move unchanged. `web.md` W4's disposition table is the authority and it is a diff:
`constantTimeEqual`, `accessSecret`, `accessGateEnabled`, `isAuthorizedValue`,
`unauthorizedResponse`, `GATED_PATHS` and the two query-param constants move untouched;
`isAuthorizedRequest` — today `isAuthorizedValue(readCookie(request.headers.get('cookie'),
ACCESS_COOKIE), env)` at `lib/server/access.ts:131-136` — is **rewritten** to read
`request.headers.get(ACCESS_HEADER)`; `readCookie`, `accessCookie`, `clearAccessCookie`,
`ACCESS_COOKIE` and their constants are **deleted**. `requireAccess` keeps its signature and its
place as the first line of every gated handler. W4 names the header **`X-Tangram-Access`**
(`ACCESS_HEADER = 'x-tangram-access'`), carrying the secret verbatim; that name is the contract
between W4's client and this plan's server and B1 must not invent a second one.

Second, `lib/ai/**` is not uniformly free of the client's database. `lib/ai/examples.ts:47-48`
imports `type { Repository } from '@/lib/db/repository'` and `{ isPhraseSnapshot, type CardRow, type
SettingsRow } from '@/lib/db/schema'`, and `isPhraseSnapshot` (`lib/db/schema.ts:97`) is a **value**,
not a type, so it survives into the emitted JavaScript. Wave 0 moves those ten modules into
`packages/ai/**` as they stand ([`wave-zero.md`](wave-zero.md) §5), so the coupling arrives with them:
a shared `packages/ai` that both halves import drags `lib/db/schema.ts` — the file B4 edits — in with
it. **B1 breaks it**, and decides which way that goes; it must not be discovered by whoever runs
`tsc`.

**The dictionary is loaded into the server process today.** `docs/deploy.md` §5 measures it: a cold
instance takes ~2.3 s to answer `/api/ask` after the lazy indexes were added in Phase 8, and settles
at 171–267 MB RSS depending on which indexes the route woke. That cost is inherited by whatever runs
these handlers in B1 and is deleted in B2.

**The persistence seam.** `lib/db/repository.ts` is an interface of ~30 domain methods
(`addCardFromEntry`, `grade`, `listDue`, `addListMembers`, `getSettings`, `askCache.get/set`,
`resetAll`, …). `lib/db/dexie.ts` is the only implementation; `lib/db/get-db.ts` memoises it on
`globalThis` behind `'use client'`. STACK §1 is right that this is a *data-layer swap* seam and not a
sync seam: there is no change feed, no per-row version, no origin, no conflict policy. Wave 0's
types-only interface diff declares one and §5, B5 implements it.

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

**Four stores carry a natural key that `id` does not express**, and this is the part a whole-row
merge keyed on `id` alone gets wrong. `lists` has a **unique** Dexie index: `STORES_V2.lists` is
`'id, kind, owner, order, &systemKey'`, and `&` is a uniqueness constraint added in v2 "to stop two
open tabs creating the eight system lists twice" (`lib/db/schema.ts:25-26`). The other three are
enforced by code rather than by the database — `writeCard` (`lib/db/dexie.ts:217-231`) treats card
identity as `(entryId, senseIndex, direction)` and returns the existing card rather than making a
second; `ensureWord` keeps one `words` row per `entryId`; `markKnown` (`dexie.ts:473-482`) filters
against the `entryId`s already present, so there is one live `known_words` row per entry. Two
devices each running `ensureSystemLists` offline mint sixteen UUIDs for eight lists. B4 owes them a
merge rule, and the `lists` one is not optional: a naive apply raises `ConstraintError`, so the very
first two-device convergence test throws rather than failing an assertion.

**The change feed has no index on three stores and no column on a fourth.** `STORES_V1` indexes
`updatedAt` on `words`, `cards` and `texts` and nowhere else: `lists: 'id, kind, owner, order'`,
`list_members: 'id, listId, entryId, wordId, order, [listId+entryId]'`, `known_words: 'id, entryId'`.
And `reviews` has no `updatedAt` **column** at all (`lib/db/schema.ts:184-193`) — correct, since it is
append-only, but it means "what changed here since *t*" needs a different key there. B4 adds the
columns and the index declarations; B5 names the key per store.

**`resetAll` is the second hard delete, and it is the larger one.** `lib/db/dexie.ts:742` runs
`db.tables.map((table) => table.clear())` inside a transaction: every row of every table, no
tombstones. It is reachable from the product (`app/settings/settings-form.tsx:76` via
`lib/dev/seed.ts:325`), from the demo seeder (`lib/dev/seed.ts:195`, the first step of `loadDemo`) and
from two e2e helpers (`tests/e2e/c/helpers.ts:19`, `tests/e2e/integration.spec.ts:42`). Under sync a
clear is undone by the next pull, and `loadDemo` would push a synthetic learner's whole deck into the
real account. B4 owns the fix and B5 asserts it.

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

1. **CLAUDE.md must be rewritten** ([`wave-zero.md`](wave-zero.md) §2, STACK §7). It is auto-loaded
   project instructions, it describes a Next-shaped command set, and its frozen-file list freezes
   `lib/db/schema.ts` and `lib/db/repository.ts` — the two files B4 and B5 must change. The rewrite
   replaces that list with a settle-first one: `lib/db/schema.ts` is editable (STACK §7 already rules
   it so), and `lib/db/repository.ts` is frozen **after** wave 0's interface diff, which is the diff
   B5 implements against. The instructions have to say so or every phase below fights them.
2. **The workspace layout must exist** — `web.md` W0's single pnpm workspace, into which this plan
   adds `apps/server/`. If that decision reverses, only the paths in this plan change. Wave 0's two
   code commits land inside that layout and this plan consumes both: the `lib/db/repository.ts`
   interface diff (`changedSince`, `applyRemote`, `syncState`/`setSyncState`, `resetAccount`,
   plus `web.md` W5's `exportAll`/`importAll`), and `packages/ai/` with the ten existing `lib/ai/**`
   modules already moved into it. **Neither is a phase of this plan.** B1 does not move `lib/ai/**`
   and B5 does not widen `Repository`.
3. **Two facts must be read from an unblocked network before B0 commits to a shape.** Neither was
   established by any audit. They are listed with their checks in §6, and B0's acceptance is what
   forces them: the provider's terms on third-party custody of end-user API keys, and the chosen
   host's function wall-clock/CPU limits against the 30 s ask deadline.
4. **Infrastructure that no phase provisions and that the container does not contain.** From B0
   onward this plan's criteria are written against real services, and `PLAN.md:46` records that none
   of them exist. The owner has to bring five things, and a build session that starts B0 without them
   will write code it cannot execute:

   | Artefact | Needed by | Why it cannot be faked |
   |---|---|---|
   | A registered domain with DNS control for `api.` and `app.` | B0 | Every acceptance criterion from B0 on is a `curl` at a hostname, and B1's CORS test needs two real origins. |
   | A host account with billing enabled | B0 | B0 records the monthly cost from a real invoice or quote; a rollback drill needs two deploys. |
   | A Supabase project (or a Docker-capable machine on which `supabase start` runs) | B3–B6 | `docker ps` in this container returns `dial unix /var/run/docker.sock: connect: no such file or directory`. There is a docker **client** and no daemon, and `psql` with no local server. `supabase start` cannot run here. |
   | An SMTP sender for auth email, plus a test address whose inbox can be read | B3 | Sign-in is an emailed code. See B3: this is a deliverable with a cost and a deliverability surface, not a checkbox. |
   | Supabase CLI credentials (or MCP OAuth completed) | B4 | B4 applies migrations and reads the security advisors. |

**Container-runnable versus deploy-only.** Because of item 4, every acceptance criterion in §5 is one
of two kinds and a build session must know which before it starts a phase. **Container-runnable**
criteria are `pnpm lint`, `pnpm test`, `pnpm typecheck`, the Playwright suite against a local build,
and anything provable against `fake-indexeddb` or a fake provider — these gate the phase's commit in
the normal way. **Deploy-only** criteria need one of the five artefacts above; they are marked
*(deploy)* at the end of the line, they are executed by the owner against the real deployment, and
their result is written into `HANDOFF.md` with the date. A phase whose deploy-only criteria have not
been run is **not** done; it is committed and flagged, and the flag is a line in `HANDOFF.md` naming
what is outstanding. This is the honest shape for a solo developer whose build agent runs in a
sandbox, and pretending otherwise is how a criterion gets quietly reinterpreted at 2 a.m.

**Sibling-plan gates:**

| Phase | Needs |
|---|---|
| B0 | `web.md` W0 (the workspace) plus §4 item 4's domain, host account and Postgres decision. It otherwise runs in the container. |
| B1 | `web.md` W1 (the app builds under Vite and has a configurable API base) and W4 (the client sends `X-Tangram-Access`, `lib/server/access.ts` has moved to a shared package), plus wave 0's `packages/ai/` — B1 imports it and does not create it. B1 is what lets `web.md` delete its dev/preview API adapter, so W1 must land first and the adapter must not be treated as a product. |
| **B2, first commit** (the contract module, `packages/ai/schemas.ts`) | B1 and nothing else. It is a type declaration with nothing behind it, and freezing it is what unblocks `data.md` D6 and `core.md` C7. It must be a **separate commit**, landed early, precisely so the two gates below do not form a cycle. |
| **B2, the rest** (the rewrite and the deletion) | `data.md` **D1–D4** — D1's frozen interfaces, D2/D3's query layer, **D3's `packages/ai/retrieve.ts`** (`data.md:674` builds it there, not in D6; wave 0's `packages/ai/` is where it lands), and **D4's browser store**, without which B2's e2e criteria have no dictionary in a browser to render from. Plus `core.md` **C4a**, which re-points every `lib/dict/client.ts` consumer at `DictStore` — `data.md` §4 makes that a gate on D6 and this plan inherits it. |
| B3 | B0 for the server half (JWT verification); `web.md` **W0 and W1** for the client half, because B3 writes `apps/app/src/auth/**` and `apps/app/src/routes/account.tsx` and `apps/app/src/` does not exist until W1 creates it. Independent of `data.md` and `core.md`; the sign-in screen may be unstyled. |
| B4, B5 | B3, and §4 item 4's reachable Postgres. **B5 gates on wave 0's `lib/db/repository.ts` interface diff** — the types-only commit that declares `changedSince`, `applyRemote`, `syncState`/`setSyncState` and `resetAccount` alongside `web.md` W5's `exportAll`/`importAll` — and on W5's export/import round-trip test, because the account-level export is built over W5's serializer. |
| B6 | B3, and a **yes** on the provider-terms check. A **no**, or an unclear answer, stops B6 and leaves the single-account shape in place (§5, B6). |
| B7 | Everything it hardens, plus `web.md` W2, which rewrites `docs/deploy.md` first. |

**The B2 / D6 gate is a cycle only if B2 is treated as one thing.** `data.md` D6 will not delete the
dictionary routes until this plan's ask/answer contract is settled, and B2's rewrite cannot happen
until `data.md` has given the client a dictionary. Both plans resolve it the same way and the
resolution is load-bearing: **B2's first commit is the contract alone**, `data.md` D6 gates on *that
commit* rather than on the phase (`data.md:145`), and `retrieve.ts` lands in D3, inside wave 0's
`packages/ai/`. If a build session reads either gate as whole-phase, it deadlocks.

**What other plans may start against, and when.** The API base URL and path names are settle-first
(`/api/ask`, `/api/examples`, `/api/recall` keep their paths so `GATED_PATHS` in
`lib/server/access.ts` stays literally true). The **new ask/answer contract** is the other settle-first
surface named in STACK §7; it lands as the first commit of B2 and is frozen from then on, because
`core.md`'s ask module and `data.md`'s retrieval helpers both code against it. The two surfaces this
plan *shares* rather than owns — `lib/db/repository.ts` and `packages/ai/**` — are settled before any
phase here runs, by wave 0's two code commits (§4 item 2), and are frozen from then on.

## 5. Phases

Eight phases. B0–B2 are the AI proxy and are on `web.md`'s critical path — the moment the app ships as
a static SPA, three routes have nowhere to run. B3–B5 are accounts and sync and are the data-safety
half. B6–B7 are custody and operations. Each ends with `pnpm lint`, `pnpm test`, `pnpm typecheck`
(`web.md` W1 adds it and makes it a gate from W1 on), the phase's container-runnable specs green, an
adversarial review, and a commit — plus, where a phase has *(deploy)* criteria, either their result in
`HANDOFF.md` or a line naming which are outstanding.

**Two rules that hold across every phase.** First: **the app must work fully signed out.** Tangram is
local-first (PLAN.md §2); an account is backup and a key, not a login wall. Any phase that makes an
unauthenticated app worse than it is today has failed. Second: **no number for the running cost
appears in this document.** STACK §5.5 forbids it until the shape closes; B0 is where the number is
first recorded, in `HANDOFF.md`, from a real invoice or a real quote.

**Paths, stated once so every Files block below can be read literally.** Every phase here runs after
`web.md` W0, which is a `git mv` of `app/`, `components/`, `lib/`, `public/`, `scripts/`, `tests/`,
`middleware.ts` and the configs into **`apps/app/`**, leaving only `data/`, `docs/`, `PLAN.md`,
`HANDOFF.md` and `CLAUDE.md` at the workspace root. So: **`lib/…`, `components/…`, `tests/…` and
`scripts/…` in the Files blocks below are relative to `apps/app/`** — `lib/db/schema.ts` means
`apps/app/lib/db/schema.ts` — while `apps/server/…`, `packages/…`, `docs/…`, `data/` and
`HANDOFF.md` are workspace-root paths and are written out in full. `apps/app/src/…` is W1's new
router tree and is written out in full too, because it does not exist under the old layout at all.
Files marked **(new)** do not exist today.

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
  `(Request) => Response`, so the framework is nearly irrelevant). It goes there because
  `packages/ai/**` is Node-shaped TypeScript against `@anthropic-ai/sdk@0.124.0` with a 30 s deadline,
  and porting it
  to a Deno edge runtime is unforced work with a runtime-limits question attached (§6). It verifies
  the Supabase JWT and holds the key. **It holds no learner content** — no cards, no reviews, no
  prompt text at rest. It is not, however, literally stateless: B6 gives it a `provider_keys` row to
  read and a `last_used_at` to stamp, and B7 gives it per-account and per-secret counters. Those
  writes go to the same Postgres through the service credential, which is the only durable store this
  plan puts behind the server, and B6 and B7 each say so where they need it. "Stateless" here means
  *no session affinity and no learner data*, which is what makes it safe to run more than one
  instance; it does not mean the process writes nothing.

**The falsifier, stated up front:** if the host's function limits comfortably exceed the 30 s ask
deadline *and* `packages/ai/**` runs unmodified on Supabase Edge Functions, then the proxy belongs
there too and this becomes one deployable and one bill. That is a check, not an opinion (§6, row 2).
Run it in this phase. The reverse falsifier: if Supabase Auth turns out to cost more configuration than
writing sessions against the same Postgres, the whole thing collapses into one Node service — but do
not decide that on taste, decide it after B3.

**Also decided here, because later phases assume it:** the server lives at `api.<domain>` with the
app at `app.<domain>` (`web.md` W7's two-origin split); path names are preserved verbatim; the CORS
allowlist starts as `https://app.<domain>` plus the dev origin and gains the two WebView origins that
`ios.md` I1 and `android.md` A1 owe this plan.

**Files.** `apps/server/` **(new)** (`package.json`, `tsconfig.json`, `src/index.ts`,
`src/routes/health.ts`), `pnpm-workspace.yaml` (one line), `docs/deploy.md` (a **server** section
appended to whatever `web.md` W2 wrote — W2 owns that file and rewrites it for a static deployment;
B7 finishes the server half), `HANDOFF.md` (the decisions below).

**Acceptance criteria.**

- `pnpm --filter server build && pnpm --filter server start` works in the container, `curl
  localhost:$PORT/health` returns the git sha, and the root `pnpm test` and `pnpm lint` still pass
  with the new package in the workspace.
- *(deploy)* `curl https://api.<domain>/health` returns 200 with the git sha of the deploy, and a
  redeploy changes it. The point is that a deploy procedure exists and is repeatable, not that the
  route is interesting.
- *(deploy)* A rollback is written down and tried once: deploy a known-bad build, roll back,
  `/health` returns the previous sha. A rollback that has never been executed is not a rollback.
- **Recorded in `HANDOFF.md`, all six.** The first four are the shape; the last two are what stop a
  later phase discovering it has nowhere to run its own tests:
  1. The chosen shape and why.
  2. The host's documented maximum request duration, and whether it exceeds 30 s (§6, row 2).
  3. The answer to the provider-terms question (§6, row 1), with the URL and the date it was read.
  4. The monthly cost at zero traffic, from the host's own pricing page.
  5. **How B4's SQL tests and B5's two-client harness actually execute** — decided here, not when B4
     starts. The container has a docker client and no daemon, so `supabase start` is not available
     in it. The candidates are: a remote Supabase project or branch (record its cost, and record
     what it does to `pnpm test` running offline — a suite that needs the network cannot be a phase
     gate for a build agent in a sandbox, so those specs go behind a `TANGRAM_TEST_POSTGRES_URL`
     guard and skip loudly when it is unset); a docker-enabled machine the owner runs the suite on;
     or an in-process Postgres. Name one. A sync design whose isolation tests have nowhere to run is
     a sync design whose isolation was never tested.
  6. **The SMTP sender for B3's sign-in email**, or the explicit note that it is undecided and that
     B3 opens by choosing it. It carries a cost, a deliverability surface and a test-inbox problem,
     and no audit touched any of it.

---

### B1 — The three model routes move, contract unchanged

**Builds.** `/api/ask`, `/api/examples` and `/api/recall` answering from `api.<domain>`, byte-identical
in behaviour, with the gate in front of them. This phase deliberately changes **nothing** about what
the routes do, so that the review has one variable.

The handlers move as files. They import `packages/ai/**`, which **already exists**: wave 0 moved the
ten `lib/ai/**` modules there ([`wave-zero.md`](wave-zero.md) §5), and both the server and the client
import from it (`ground.ts` and `cache-key.ts` already run in the browser, and B2 needs more of it
to). **This phase does not move it and must not re-move it.** `lib/server/access.ts` arrives from
`web.md` W4 and `requireAccess(request)` stays the first line of every handler, for the reason its own
header gives — a gate that lives only in middleware is one config edit from being off, and the failure
mode is an invoice.

**Break the `lib/db` coupling here, before the server bundles the package.** §3 records it:
`packages/ai/examples.ts` (`lib/ai/examples.ts:47-48` at HEAD, before wave 0's move) imports
`Repository`, `CardRow`, `SettingsRow` and the runtime helper `isPhraseSnapshot` from `lib/db/**`.
Pulling `lib/db/schema.ts` into `packages/ai` would make the file B4 rewrites a dependency of the
server's bundle, which is the opposite of what a shared package
is for. **The recommendation is injection, matching what `ground.ts` already does with
`GroundContext`:** `examples.ts` takes the two schema helpers and the repository reads it needs as
arguments supplied by its caller, so `packages/ai` depends on `zod`, the SDK and `lib/types.ts` and
on nothing under `lib/db`. The alternative — extracting a `packages/schema` from `lib/db/schema.ts` —
is also acceptable, but it must be *chosen* in this phase and written into `HANDOFF.md`, because B4
edits that file and needs to know whether it is shared.

**Where the route tests live, and why they cannot follow the routes.** `tests/unit/ai/route.test.ts`,
`examples-route.test.ts`, `recall-route.test.ts` and `route-provider.test.ts` call `requireDictData`
and run against the real 124k-entry dictionary in `data/`. A server package that (after B2) ships no
`data/` cannot host them. They stay in `apps/app`'s suite for B1 — pointed at the moved handlers
through the workspace — and B2 says what becomes of each.

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
`packages/ai/**` (**not moved here — wave 0 did that; this phase edits it only to break the `lib/db`
coupling**), `packages/access/**` (moved `lib/server/access.ts`, `isAuthorizedRequest` rewritten by
W4), `apps/server/src/cors.ts` **(new)**, `apps/server/src/smoke.ts` **(new)**,
`apps/app/**` call sites already pointed at `VITE_API_BASE` by `web.md` W4, `docs/deploy.md` (the
server's env-var section), `web.md`'s `vite-plugins/api.ts` (its three model cases deleted),
`package.json` and `tests/unit/deps.test.ts` **if** this phase adds a runtime dependency — the deps
test asserts the loader table equals `package.json`'s `dependencies` exactly
(`tests/unit/deps.test.ts:36`), so a new package with no loader entry is a red suite. Hono, if B0
chose it, is one such package.

**Acceptance criteria.**

- With `TANGRAM_ACCESS_SECRET` set: each of the three paths **without** the `X-Tangram-Access` header
  is `401 {"error":"unauthorized"}` with no echo of what was sent; with the header, each answers. The
  five dictionary routes are **not** on this server at all, and requesting one is a 404, not a 401 —
  a gate that quietly widened is a broken PWA. Runnable against a locally started server; repeat it
  *(deploy)*.
- With `TANGRAM_ACCESS_SECRET` unset, everything is open and every existing test behaves exactly as
  before. This is rule 1 of `access.ts` and breaking it fails the phase. **Note what this rule is and
  is not:** it makes local development and the container suite work with no configuration, and it
  means an unset secret in production is an open till. B7 adds the limit that survives that mistake.
- Every test under `tests/unit/ai/**` passes **unmoved** except for import paths — all seventeen
  files, including the four route tests. The `lib/ai` → `packages/ai` half of that rewrite happened in
  wave 0; what changes here is the handlers' new home. Nothing about behaviour changes in this phase,
  so any assertion that needs editing is evidence that something did.
- **CORS, including the preflight.** A custom request header makes every cross-origin `POST` a
  preflighted request, so the allowlist is not one header. *(deploy, or against two local origins)*
  An `OPTIONS` to each gated path from `https://app.<domain>` returns the allowed methods **and
  `X-Tangram-Access` in `Access-Control-Allow-Headers`**; the same `OPTIONS` from an origin not on
  the allowlist returns no `Access-Control-Allow-Origin`; and a real cross-origin `POST` from the app
  origin succeeds. Assert the `POST` half with a Playwright spec from the app origin, not with
  `curl` — `curl` ignores CORS and will cheerfully tell you it works.
- *(deploy)* The full app works end to end against the deployed server: look up → ask → add a card →
  review → example sentences → free recall.
- **Recorded in `HANDOFF.md`:** the `packages/ai` / `lib/db` decision above; and *(deploy)* RSS after
  boot and after the first ask, time from process start to first successful ask, and whether the host
  keeps the process warm — if it scales to zero, the cold ask latency. Those three numbers are B2's
  justification.

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
                          retrieved: RetrievedEntry[] /* ≤40 */ }
  → { response: AskResponse /* schema-validated, NOT grounded */,
      provider, promptVersion, model? }

GET  /api/ask            → { provider, promptVersion, model? }        (unchanged handshake)

// packages/ai/schemas.ts — the frozen wire shape, and the six fields are not arbitrary.
type RetrievedEntry = {
  id: string; simp: string; trad: string; pinyinMarked: string;
  hskBand?: HskBand; glosses: string[];
};
```

**`hskBand` is in that list because the prompt already writes it, and dropping it would be a change
to model behaviour smuggled in as a transport decision.** `entryLine` (`lib/ai/prompts.ts:99-103`)
renders `${entry.id}\t${entry.simp}\t${entry.trad}\t${entry.pinyinMarked}${band}\t${glosses}`, where
`band` is `" HSK" + entry.hskBand` when the entry has one and the empty string otherwise
(`prompts.ts:101`). The same function feeds `/api/examples`' TARGET block (`prompts.ts:175`) and
`/api/recall`'s THE WORD block (`prompts.ts:191`). A five-field projection would silently change every prompt containing a banded
entry, in the one phase whose whole purpose is that the review has a single variable. Those six
fields are also **exactly** what `prompts.ts` reads off an entry — nothing else in the file touches
one — so `RetrievedEntry` is the honest name for what the model has always seen.

**The provider interface changes with it, and this is not optional.** `LLMProvider.answer` is typed
`answer(retrieved: readonly Entry[], …)` (`lib/ai/provider.ts:151-152`) and `Entry`
(`lib/types.ts:21-46`) has eleven more fields the server can no longer supply. So B2 changes the three
signatures that take entries — `answer`, `examples` (`provider.ts:169`, `:172`) and `gradeRecall`
(`provider.ts:179`) — from `Entry` to `RetrievedEntry`. `Entry` is structurally assignable to
`RetrievedEntry`, so every existing caller and every test that passes a real dictionary entry keeps
compiling; what stops compiling is a server that assumed it had a whole `Entry`, which is the point.
If a build session finds itself writing an adapter that fabricates the missing `Entry` fields, it has
taken the wrong branch.

The client skips `propose` when `needsProposals(query)` is false — that function is 4 lines in
`app/api/ask/route.ts` and moves to `packages/ai/retrieve.ts` with `mergedSearch`, `candidateEntries`,
`mergeRetrieved`, `RETRIEVED_CAP` and `SEARCH_HEAD` (`data.md` **D3** assigns that move, at
`data.md:674`). So a
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

**The empty-answer fallback moves to the client with `ground()`, and the cache rule moves with it.**
Today `app/api/ask/route.ts:344-359` sets `cacheable = false` and substitutes
`ground(retrievalEcho(retrieved), groundContext)` when a schema-valid answer grounds to nothing at
all — that is the mechanism behind PLAN.md §3.4's "no query ever renders an empty panel" and
product-decisions §5's third designed state, and `components/lookup/ask-panel.tsx:558-564` gates the
cache write on it (`body.cacheable !== false && info !== FALLBACK_INFO && body.provider ===
info.provider`). After the flip the server cannot compute it, because the server no longer grounds.
So: **the client owns `retrievalEcho`, the substitution, and the trustworthiness test**, `cacheable`
leaves the wire, and the rule is stated once here so nobody re-derives it wrongly — the cache stores
the **grounded** response, exactly as today, and the echoed fallback is **never** cached. Two
consequences follow and both are load-bearing. Rows written before the flip still parse, because the
cached shape is unchanged (which is what makes B2's last acceptance criterion meaningful, and what
keeps `lib/dev/seed.ts`'s two pre-warmed rows valid). And `AskCacheRow`'s licence invariant — its own
comment is "Ids and indexes only — never gloss text (CLAUDE.md, licence boundary)" — stays true,
because a grounded response is cited ids and an ungrounded one is model prose.

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

**Then delete — but only what this plan owns.** No `lib/dict/**` import remains in `apps/server/`;
no `data/` in its deploy artifact. `next.config.ts` and its `outputFileTracingIncludes` are
`web.md` W1's deletion, and `tests/unit/server/routes.test.ts` is **`web.md` W2's file**, rewritten
there "around the route table and the host config". That test is not only a tracing guard: it imports
`NAV_ITEMS` from `@/components/shell/nav` (`routes.test.ts:21`) and enforces "a route nobody
exercises" for the app's *pages*, which is `web.md`'s half of the smoke story. **So B2 removes the
API-route cases and the `next.config` import from it and leaves the page-coverage assertions
standing.** Deleting a guard this plan does not own is how a page ships with no smoke case.

**What the client half is, and what it is not.** B2 builds `lib/ai/ask-client.ts` **(new)** — the
**only** module left under `apps/app/lib/ai/` after wave 0's move, and browser-side because it calls
the server: the two round trips, the `needsProposals` skip, the retrieval call into
`packages/ai/retrieve.ts`, the awaited segmentation map, the local `ground()`, the fallback above and
the cache read/write. That module is the provider interface `core.md` C7 renders — `core.md:191` says
C7 "designs and tests [the three answer states] against a client-side ask module whose shape C7
defines" and that B2 "fills `answered`". **B2 therefore changes the module and the two call sites, and no state of the panel.**
If C7 has already landed, B2 wires `ask-client.ts` behind C7's `ask-state.ts`; if it has not, B2
leaves `ask-panel.tsx`'s existing rendering exactly as it found it.

**Files.** `apps/server/src/routes/{ask,examples,recall}.ts` (rewritten), `packages/ai/schemas.ts`
**(new — the frozen contract, and the first commit of this phase)**, `packages/ai/provider.ts`
(three signatures `Entry` → `RetrievedEntry`), `lib/ai/ask-client.ts` **(new)**,
`packages/ai/retrieve.ts` (from `data.md` **D3**), `components/lookup/ask-panel.tsx` and
`components/review/example-sentences.tsx` (**call sites only**), `tests/unit/ai/ground.test.ts` and
`attacks.test.ts` (unmoved), `tests/unit/ai/{route,examples-route,recall-route,route-provider}.test.ts`
(rewritten — see the criteria), `tests/unit/ai/ask-client.test.ts` **(new)**,
`tests/unit/server/routes.test.ts` (**`web.md` W2's file** — API cases removed, page coverage kept).

**Acceptance criteria.**

- The server's deploy artifact contains no `data/` and no `lib/dict/**`; `grep -rn "lib/dict"
  apps/server/src` returns nothing; the process boots and answers with `data/` absent from the disk.
- **`tests/unit/ai/ground.test.ts` and `tests/unit/ai/attacks.test.ts` pass with their assertions
  unchanged.** These are the grounding tests STACK §5.5 names as the check on the new contract, and
  they are unaffected by it because `ground()` is pure and moves without editing: the `随看随买` /
  `绝绝子` / `我随便看看` cases, the injected `'bogus'` id being dropped, and the
  wrong-pinyin-cannot-change-the-display case (PLAN.md §3.4). A diff to either file in this phase is
  a change to the product's core promise and has to be argued, not absorbed.
- **The four route tests are rewritten, and the criterion is what survives the rewrite.**
  `tests/unit/ai/route.test.ts` imports `{ GET, POST, mergeRetrieved, needsProposals, RETRIEVED_CAP,
  SEARCH_HEAD } from '@/app/api/ask/route'` (`route.test.ts:15`) and asserts on a response body this
  phase deletes — `body.entries` (`:64`, `:71`) and `body.dictVersion` (`:72`). Its retrieval
  assertions belong to `packages/ai/retrieve.ts` and its grounding assertions to the new client
  module, so they move to `tests/unit/dict/retrieve.test.ts` (`data.md` D3's file) and
  `tests/unit/ai/ask-client.test.ts`, and what is left is a server test over the two endpoints and
  the request schema. Same for `examples-route` and `recall-route`. The criterion: **no assertion is
  dropped, each one is named in the commit message with where it went**, and the union of the three
  new files still proves that no entry the caller did not supply can be cited.
- A prompt-output test pins the band: build a prompt from a `RetrievedEntry` with `hskBand: 3` and
  assert the line contains ` HSK3`, and from one without and assert it does not. If any prompt text
  does change in this phase, `ASK_PROMPT_VERSION` is bumped in the same commit — that is what it is
  for, and an unbumped prompt change silently poisons every cached answer.
- The client-side fallback is proven where it now lives: given a schema-valid answer that grounds to
  nothing, `ask-client` returns the `retrievalEcho` grounding **and does not write the cache**; given
  a normally grounded answer, it writes it. Unit-level, over a fake transport.
- An e2e spec proves the panel is never empty and never blocked: with the network to the API base
  refused, the dictionary card still renders and is addable, and `ask-client` reports `unavailable`.
  **How that state is drawn is `core.md` C7's** (the "Dictionary only — offline" chip,
  product-decisions §5's second designed state); this phase asserts the module's state, not the chip.
- *(deploy)* RSS after boot and after the first ask, compared against B1's recorded numbers. This is
  the phase's headline result and it should be a large fall.
- **Recorded in `HANDOFF.md`:** the serialized size of a 40-entry `retrieved` payload for a realistic
  English query, in KB, and the observed latency of the two-round-trip path on a throttled mobile
  profile. Nobody has measured either; if the payload is large enough to matter the lever is sending
  fewer glosses per entry, not fewer entries.
- The ask cache still hits: `askCacheKey` folds in `promptVersion`, `provider`, `query`, `context`
  and `estimatedBand`, and the cached value is still the grounded response, so a warm row written
  before the flip resolves after it. Assert it with a row written by the old shape.

---

### B3 — Accounts, and the rule that they are optional

**Builds.** Sign-up, sign-in, session, sign-out, and JWT verification on the proxy. No sync yet.

**Choose email one-time codes, not passwords.** A solo developer who ships passwords has also shipped
a reset flow, a rate limiter on that flow, and a support burden for the rest of the product's life.
An emailed six-digit code has none of that and works on a phone. OAuth providers are an app
registration per provider per platform and buy nothing at one user; §7.

**But email delivery is a deliverable of this phase, not a setting.** No audit established anything
about it, and calling it "one Supabase Auth setting" would be this plan asserting a fact it does not
have. **Open question, with its check:** whether the auth provider's built-in mail sender is usable
for this product's real sign-in traffic, or whether a custom SMTP sender is required — read the
provider's own auth-email documentation for its default sender's rate limit and its stated intended
use, from an unblocked network, and record the URL and the date. B0 records the answer if it is known
by then; otherwise this phase opens by finding it. Either way this phase **names the sender,
configures it, and writes it down** — the service, the sending domain, whatever DNS records it needed,
and its cost — in `docs/deploy.md` and `.env.example`. It is the second recurring cost in this
document after B0's, and the one most likely to go unnoticed until a code does not arrive.

**The headline criterion cannot be "an email arrives", because no build session can read an inbox.**
Split it. The **automatable** half uses the auth provider's own test-address mechanism — a fixed
address with a fixed code, configured for the project and named in `docs/deploy.md` — so the sign-in
flow is exercisable end to end in the container, against a local or remote project, without any mail
leaving it — there is no CI to run it in (`wave-zero.md` §10, ruling 13), so `pnpm test` and the
Playwright suite are where it runs. The **manual** half is one check the owner performs once per
environment and records: send a real code to a real address, note the delivery time and whether it
landed in spam. Do not let the automatable half stand in for the manual one; a test address proves
the flow and proves nothing at all about deliverability.

**What the JWT means to the proxy while B6 has not run, stated as a rule before it is asserted as a
test.** Between B1 and B6 — which may be the permanent state, since B6 is conditional — the
credential on the three model routes is `TANGRAM_ACCESS_SECRET` and nothing else, because there is no
per-account key to resolve and the app must work signed out. So: **the JWT is optional and verified
when present.** An absent `Authorization` header falls through to the gate; a present but invalid one
— expired, forged, or signed with the wrong key — is a `401` and never reaches a provider, because a
request that claims an identity and cannot prove it is not the same thing as a request that claims
none. Once B6 lands, an account with a stored key is resolved from the verified JWT and the gate
remains for accounts without one. Both branches are asserted below.

**What the app looks like signed out.** Exactly as it does now: every screen works, everything is
local, and there is one honest line where the account lives (Library, per product-decisions §1) that
says the deck exists only on this device. Signing in is presented as *turn on backup*, which is what
STACK §2.8 says it actually is. The proxy is the one exception and only once B6 lands: with a
server-held owner key the gate is the credential, and with per-account keys the JWT is.

**Three edges to get right now rather than discover later**, and the third is the one that used to be
missing from this plan:

1. **Local data, empty account** — a pure upload. Every id is a client-generated UUID, the account
   has no rows, and nothing can collide.
2. **Local data, a *different* account than the one `sync_state` last recorded** — refused. Offer
   export-then-reset instead. Merging one person's deck into another account is unrecoverable, and
   the check is one string comparison. Note that "reset" here is doing real work and B4 has to make
   it work: `resetAll` as it stands clears the local database with no tombstones, which under sync is
   undone by the next pull.
3. **Local data, the *same* account, which already has rows** — a merge, and the one case that is not
   a technicality. This is B5's job and B4's natural-key rules are what make it safe; B3's only
   obligation is not to pretend it is case 1. Two devices that each opened the app offline both ran
   `ensureSystemLists` and both hold eight `lists` rows with the same `systemKey` values and
   different UUIDs. That is a collision, `&systemKey` is a unique index, and §5, B4 resolves it.

**Files.** `apps/app/src/auth/**` **(new)** (client: session, the code exchange, the `user_id` record
in a new local `sync_state` store), `apps/server/src/auth.ts` **(new)** (JWT verification middleware),
`apps/app/src/routes/account.tsx` **(new — functional, unstyled; named debt against `core.md`)**,
`lib/db/schema.ts` (the `sync_state` store; a Dexie version bump, which is free), `.env.example` and
`docs/deploy.md` (the auth env vars and the SMTP sender), and — if the client half uses
`@supabase/supabase-js` rather than a hand-rolled fetch client and JWT verifier — `package.json` plus
`tests/unit/deps.test.ts`, whose loader table must equal `dependencies` exactly
(`tests/unit/deps.test.ts:36`). Name the choice in the commit; a dependency added without its loader
entry is a red suite for the next phase, not for this one.

**Acceptance criteria.**

- Sign up on browser A, sign out, sign in on browser B with the same address **using the configured
  test address and its fixed code**: the session is live in both and `user_id` is identical. No data
  moves yet — that is B5 — and the spec asserts that too, so nobody mistakes a session for sync.
- *(deploy, manual, once)* A real code is sent to a real address, arrives, and signs in. Record the
  delivery time and whether it landed in spam, in `HANDOFF.md`. This is the only criterion in this
  document that a human has to perform, and it is not optional: a sign-in nobody can complete is a
  product nobody can use.
- With the app signed out, the entire existing e2e suite passes unchanged (the Vite suite, post-W1).
  This is the "accounts are optional" rule and it is executable.
- **Both JWT branches.** A request to the proxy with **no** `Authorization` header behaves exactly as
  it did in B1 — the gate decides. A request with an expired JWT, and one signed with the wrong key,
  are each a `401` and neither reaches a provider. Three assertions, not one.
- Signing in with a `user_id` different from the one in `sync_state` shows the refusal and the export
  route out, proven by a unit test over the auth module rather than a screen.
- Session survives a reload and a restart of the app; sign-out clears it and leaves local data
  intact (assert a card is still there afterwards).

---

### B4 — The sync tables, the rules that make them safe, and the five schema corrections

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

**The five corrections** (all free — no users, no data):

1. `list_members` gains `updatedAt`. It already tombstones but has nothing to resolve two tombstone
   states against.
2. `known_words` gains `updatedAt` and `deletedAt`, and **`unmarkKnown` becomes a soft delete**
   (`lib/db/dexie.ts:513` currently calls `.delete()`). Under sync a hard delete is a resurrection
   bug: unmark on the phone, sync, and the laptop's surviving row marks it known again.
   `knownEntryIds()` and `markKnown`'s existing-row check both gain the tombstone filter.
3. **`updatedAt` joins the Dexie index strings** for `lists`, `list_members` and `known_words`, in the
   same version bump. Adding the column without the index makes the change feed a full table scan on
   three of the eight synced stores; an index is a declaration and IndexedDB rebuilds it from the
   rows already there, so it costs one line each. `words`, `cards` and `texts` already have it.
4. **`resetAll` gets a defined meaning under sync, and this is not a caveat — it is the correction
   this plan previously missed.** `lib/db/dexie.ts:742` clears every table with no tombstones, and it
   is wired to the settings screen, to `loadDemo` and to two e2e helpers (§3). Three things happen
   here. `resetAll` **refuses while a session exists** and says why, which is one guard and makes the
   local reset mean what it has always meant. `loadDemo` refuses on the same condition, for a
   stronger reason: it writes a synthetic learner's whole deck, and under sync that deck would be
   pushed to the real account. And "reset this account" — the export-then-reset route B3 offers, and
   the only reset that is meaningful once sync exists — becomes an explicit, separate operation:
   tombstone every row locally, push, clear the sync cursor. It is a `Repository` method, it is
   B5's to implement over B5's row-level channel, and B5 asserts it. Say plainly which of the two a
   given button calls; a screen that offers "reset" and means "local clear that comes back" is worse
   than one that offers nothing.
5. `settings` keeps `id: 'singleton'` locally but is keyed on `user_id` in Postgres. Its
   `introduced` map merges per day key by `max` — see the conflict policy below, and read the
   qualification there before assuming it matters as much as it looks like it does.

**The Postgres schema.** **One table per *synced* store** — eight of the ten. `ask_cache` is derived,
content-hash keyed and per-device (it does not sync; see the conflict table), and `sync_state` is the
local record of which account this device last talked to and where its cursor is, which is by
definition per-device. Neither gets a table, and a build session transcribing the schema should not
create one that B5 then has to assert is empty. The eight are: `words`, `cards`, `reviews`, `lists`,
`list_members`, `known_words`, `texts`, `settings`. Columns: `id uuid primary
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

**The LWW guard is a trigger, not client discipline, and the trigger has to `RETURN NULL`.** One
`tangram.lww_guard()` function, `before update for each row` on every mutable table:

```sql
create function tangram.lww_guard() returns trigger language plpgsql as $$
begin
  if new.updated_at < old.updated_at then
    return null;                    -- skip the row operation entirely
  end if;
  new.server_updated_at := now();   -- one function owns both
  return new;
end $$;
```

**`return old` would not work, and it is the natural thing to write.** In PostgreSQL a `BEFORE ROW`
trigger that returns a row lets the operation proceed *with that row's values*; only `RETURN NULL`
suppresses it. Returning `OLD` therefore still performs an UPDATE — a new row version, `AFTER`
triggers fired — and the returned row is what the next `BEFORE` trigger in the chain receives. If
`server_updated_at` were maintained by a *second* trigger, the consequence would be worse than
cosmetic: `BEFORE` row triggers fire in **alphabetical order by trigger name**, so a timestamp
trigger sorting after the guard would re-stamp `server_updated_at` on every rejected stale write, and
B5's pull is `server_updated_at > cursor`. Every device would then re-pull a row whose contents did
not change, forever, for a client whose clock lags. That is why the snippet above sets
`server_updated_at` inside `lww_guard()` itself: **one function, one trigger per table, no ordering
question to get right.** Name it `tangram_lww_guard` on every table so the name is uniform and a
second `BEFORE` trigger added later has to be deliberately named around it.

This makes last-write-wins a property of the database rather than a convention every client must
implement correctly, and it means a buggy or old client cannot walk back a newer row. `reviews` gets
no update or delete policy at all — insert-only, `on conflict (id) do nothing` — and therefore no
guard.

**Every table has a policy, and the guard is a unit test because there is no CI.** The rule for this
migration and every later one is: **a new table with no policy is a failed migration.** An earlier
draft asserted that with a `pg_policies` query in CI. There is no CI — no `.github/` directory exists
and no plan in this set creates one (`wave-zero.md` §10, ruling 13) — so this takes the same treatment
`android.md` gives its two: it is a **unit test under `tests/unit/`**, run by `pnpm test` like
everything else. `tests/unit/server/policies.test.ts` reads every file under
`apps/server/supabase/migrations/` and asserts that each `create table tangram.<x>` in them is matched
by `alter table tangram.<x> enable row level security` and by at least one `create policy … on
tangram.<x>`, with an explicit allowlist for the deliberate exceptions (`reviews` has no update or
delete policy; B6's `provider_keys` has no select policy) so an exception has to be written down to
pass. It needs no database and no network, which is the point: the discipline is enforced in the suite
a build session already runs. The live form of the same question — a `pg_policies` query against the
real schema — joins the SQL suite below, behind the `TANGRAM_TEST_POSTGRES_URL` guard B0 chose.

**The conflict policy, complete.** Write it down here so no phase invents its own:

| Table | Policy |
|---|---|
| `reviews` | Union by `id`. Append-only; never updated, never deleted. No conflict is possible. |
| `words`, `cards`, `lists`, `texts`, `list_members`, `known_words` | Whole-row last-write-wins on `updated_at`, tombstones included. A tombstone is a normal row and wins if it is newer. **Four of these also carry a natural key and need the dedupe below; `id` alone is not identity.** |
| `cards.fsrs` | LWW like the rest of the row, **then** recomputed if the merged review set for that card differs from what the local row was built from (B5). |
| `settings` | LWW per row, **except `introduced`**, which merges per day key by `max`. |
| `ask_cache`, `sync_state` | **Do not sync.** The first is derived, content-hash keyed, per-device and regenerable; the second is this device's record of which account it talks to and where its cursor is. Neither has a Postgres table. |

**Identity by `id` is not enough for four of these tables, and this is the rule that stops the first
two-device test from throwing.** §3 records the natural keys; here is what to do about them. Whole-row
LWW keyed on `id` merges two rows that are the same thing into two live rows: sixteen system lists,
or two recognition cards for one word with two separate schedules. So `applyRemote` — and the
Postgres schema — carry a **natural-key dedupe** alongside the LWW comparator:

| Store | Natural key | Enforced today by |
|---|---|---|
| `lists` | `systemKey`, for system lists only (a user list has none) | Dexie's **unique** `&systemKey` index (`STORES_V2`) |
| `cards` | `(entryId, senseIndex, direction)` for word cards | `writeCard`, `lib/db/dexie.ts:217-231` |
| `words` | `entryId` | `ensureWord` |
| `known_words` | `entryId`, among live rows | `markKnown`, `lib/db/dexie.ts:473-482` |

**The rule: lowest UUID wins.** It is deterministic, it needs no clock, and both devices reach the
same answer from the same data — which is the only property that matters. The loser is **tombstoned,
not deleted** (`deletedAt` set, `updatedAt` bumped), so the resolution itself replicates and the third
sync does not undo it. Rows that pointed at the loser are re-pointed at the winner in the same
transaction: `list_members.listId`, and `cards.wordId`. For `cards` the loser's `reviews` rows are
re-pointed too — `reviews.cardId` — because a review is a fact about a study event and discarding it
would change the learner's history; the winner is then recomputed by B5's rule over the union.

**Two consequences to state rather than discover.** First, **`&systemKey` cannot survive a naive
apply**: a pull that inserts a remote system list before the dedupe runs raises `ConstraintError` and
aborts the transaction. So `applyRemote('lists', rows)` dedupes *before* it writes, inside one Dexie
transaction, and the unique index stays — it is the assertion that the dedupe worked. Second, the
Postgres side carries the same constraint explicitly: `unique (user_id, system_key) where system_key
is not null and deleted_at is null` on `tangram.lists`, so a second device's push is refused at the
database rather than accepted and reconciled later. The client resolves, pushes the resolution, and
the constraint is what proves it resolved.

**The `introduced` exception, and an honest account of how much it buys.** `introduced[dayKey]` is a
counter the app writes on every new card, so under whole-row LWW the device that syncs last would
decide its value. **The reason that is not the visible bug it looks like** is
`lib/lists/queue.ts:158-166`, which already reconciles the stored counter against the cards
themselves: `const createdToday = all.filter(card => !isExplicitAdd(card) && card.createdAt >=
dayStart).length` and then `const chargedToday = Math.max(introducedToday, createdToday)`, with
`drawLimit = Math.max(0, newPerDay - chargedToday - backlog)`. `cards` sync. So after a merge that
brings both devices' seven cards, `createdToday` is 7 on both and the learner is charged 7 whatever
`settings.introduced` says. A doubled daily allowance cannot occur.

What `max` still buys is the case the floor cannot see: a card introduced today and then **deleted**
drops out of `createdToday`, and the stored counter is the only remaining record that the day was
charged for it. That is worth ten lines and it is why the exception stays — but write *that* reason
into the code, not the one about doubled allowances, and do not let a test assert the counter when
the observable is the draw limit.

**One thing `max` does not fix, and it is worth one line rather than a mechanism.** The day key is
the browser's local calendar day (`lib/srs/day.ts:13-25` shifts by `dayRollover` and then reads
`getFullYear`/`getMonth`/`getDate`), so two devices in different time zones can write **different
keys** for the same study session and `max` never meets them. The effect is bounded — at worst a
learner who flies gets one extra day's introductions once — and the alternative is storing a UTC
instant per introduction, which is a bigger change than the bug. Accept it, say so in the code, and
pin `TZ` in the test so the suite is not the thing that discovers it.

**Client clocks are the acknowledged weakness.** LWW on a client-supplied `updated_at` means a device
with a badly wrong clock wins or loses every conflict. This is accepted for now — one person, two
devices — and the symptom is diagnosable (a stale value that keeps coming back). The check and the
escalation are in §6.

**Files.** `apps/server/supabase/migrations/**` **(new — the schema, the trigger, the policies)**,
`lib/db/schema.ts` (`list_members.updatedAt`, `known_words.updatedAt`/`deletedAt`, the three
`updatedAt` index declarations, `sync_state`, a Dexie version bump and its upgrade block),
`lib/db/dexie.ts` (`unmarkKnown`, `knownEntryIds`, `markKnown`, the `resetAll` and `loadDemo`
guards), `lib/dev/seed.ts` (the `loadDemo` guard), `lib/db/repository.ts` (**doc comments only**, on
the changed delete semantics and on `resetAll`'s new precondition — the interface itself is wave 0's
frozen diff and B4 adds no member to it), `tests/unit/db/known-words.test.ts` **(new)**,
`tests/unit/db/reset.test.ts` **(new)**, `tests/unit/server/policies.test.ts` **(new — the
migration-policy guard; no CI exists to hold it)**.

**Acceptance criteria.** The SQL ones run wherever B0 decided they run (§4 item 4, B0 acceptance 5);
they are *(deploy)* if that answer was a remote project.

- **RLS is proven, not configured.** Two accounts, a row inserted by each: from A's JWT,
  `select * from tangram.cards` returns only A's row; an insert with `user_id` set to B's id is
  refused; an update of B's row is refused; a delete of B's row is refused. Nine assertions, one SQL
  test file. A sync design whose isolation was never executed is not a sync design.
- Supabase's own security advisors report no errors on the new schema (`get_advisors`, security
  lint). Warnings are recorded with a reason if they are accepted.
- **The policy guard runs in `pnpm test`, not in CI.** `tests/unit/server/policies.test.ts` passes over
  the migrations this phase writes, and fails when a table is added to a migration file with no
  `enable row level security` and no policy — assert that by adding such a table to a fixture, not to
  the real migration. The live `pg_policies` form of the same check runs with the SQL suite and is
  *(deploy)* on the same condition as the rest of it.
- **The LWW guard rejects rather than rewrites.** Update a row with an older `updated_at`, then
  assert three things: the user columns are unchanged, **`server_updated_at` is unchanged**, and the
  row does **not** appear in a pull taken from the pre-write cursor. The middle assertion is the one
  that separates `return null` from `return old`; without it the test passes against the broken
  implementation. Then update with a newer `updated_at` and assert it applies and that
  `server_updated_at` advanced.
- `reviews` refuses `update` and `delete` from a client JWT, and a duplicate insert of the same `id`
  is a no-op rather than an error.
- **The system-list constraint holds.** Insert eight system lists for one account, then attempt a
  second set with different UUIDs and the same `system_key` values: refused by
  `unique (user_id, system_key)`. Then tombstone one and re-insert it: accepted, because the partial
  index excludes tombstones.
- Client-side: `unmarkKnown` leaves a tombstone, `knownEntryIds()` excludes it, marking known again
  after unmarking produces one live row and not two, and the Dexie upgrade runs on a database created
  at each previous version (1, 2 and 3) without throwing.
- Client-side: `changedSince` reads through an index on all eight synced stores — assert it by
  checking the Dexie index strings, which is cheap and is the thing that actually regresses.
- Client-side: `resetAll` and `loadDemo` both refuse while a session exists, with a distinguishable
  error; both behave exactly as today with no session, so every existing e2e helper still works.
- `pnpm test` passes; the repository's own tests for lists and known-words still pass with the new
  columns.

---

### B5 — The sync engine, the change feed, and what recompute actually means

**Builds.** The client engine, the Dexie implementation of the sync members wave 0 declared, and the
account-level export.

**The seam widens, and this is the architectural cost of sync.** `lib/db/repository.ts` is a domain
API (`grade()`, `listDue()`, `addListMembers()`). Applying a remote row cannot go through it —
`grade()` would write a *new* review row for a review that already happened. So the interface carries
a narrow row-level channel alongside the domain one:

```ts
changedSince(store: SyncedStore, sinceMs: number): Promise<Row[]>;  // local writes to push
applyRemote(store: SyncedStore, rows: Row[]): Promise<void>;        // remote rows, LWW + dedupe
syncState(): Promise<SyncState>;                                    // the cursor and last-synced stamp
setSyncState(patch: Partial<SyncState>): Promise<SyncState>;
resetAccount(): Promise<void>;                                      // B4 correction 4
```

**Those five declarations are not this phase's to write.** They landed in wave 0's types-only
interface diff ([`wave-zero.md`](wave-zero.md) §5), alongside `web.md` W5's `exportAll`/`importAll`,
precisely so this plan and W5 never widen the same file twice; `lib/db/repository.ts` has been frozen
since. **B5 gates on that commit and implements the five in `lib/db/dexie.ts`.** If B5 finds it needs
a sixth member, that is a frozen-surface change: it stops, writes the need into `HANDOFF.md`, and
continues without it.

**`changedSince` does not have one key, and pretending it does is how it becomes a table scan.**
`SyncedStore` is the eight stores B4 lists, not `StoreName`, and the column each one filters on
differs:

| Store | Change-feed key | Indexed? |
|---|---|---|
| `words`, `cards`, `texts` | `updatedAt` | yes, in `STORES_V1` already |
| `lists`, `list_members`, `known_words` | `updatedAt` | yes, **after B4 correction 3 adds it to the index string** |
| `reviews` | **`createdAt`** — the store has no `updatedAt` column and must not grow one; it is append-only, so "changed since" and "created since" are the same question | needs `createdAt` added to `reviews`' index string in the same bump; today it is `'id, cardId, reviewedAt, [cardId+reviewedAt]'` |
| `settings` | one row; push it when its `updatedAt` is newer than `lastPushedAt` | trivially |

`applyRemote` is where B4's natural-key dedupe lives. It is not a bulk put: for the four stores with
a natural key it reads the affected rows, resolves lowest-UUID-wins, tombstones the losers, re-points
`list_members.listId`, `cards.wordId` and `reviews.cardId`, and writes the whole thing in one Dexie
transaction. For the other four it is a bulk put under the LWW comparator.

Say plainly what this is: the repository is no longer only a domain API, and any second
implementation — the `@capacitor-community/sqlite` one STACK §2.8 leaves open for mobile, or the
`tauri-plugin-sql` one §2.4 leaves open for desktop — must satisfy all five as well, plus W5's
`exportAll`/`importAll` from the same wave-0 diff. That is a real increase in what a swap costs, and
it is the price of sync being a property of the seam rather than a feature bolted to Dexie.

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
   result.
3. Then, **if the latest live `known_words` row for the card's entry** — latest by `createdAt`, among
   rows whose `deletedAt` is null — has a `createdAt` later than the last review's `reviewedAt`, apply
   `knownCardState(fsrs, thatCreatedAt)` (`lib/srs/states.ts:53`) on top, which is what `markKnown`
   does at `lib/db/dexie.ts:499`. Recognition cards only, matching `markKnown`'s own direction filter.

**Two things about that rule that are easy to get wrong, and both are decisions rather than details.**

*It is convergent, not reproductive.* `lib/srs/card.ts:143-146` is explicit: *"Pass the same settings
the grades were written under, or the replay is a replay of a different scheduler: the parameters are
an input to the result, not a detail of how it is computed."* But `settings` is itself an LWW-merged
row in B4's table, `requestRetention` / `shortTermSteps` / `fsrsWeights` included, so after a merge
the settings driving the recompute may be neither device's at the moment it graded. Both devices then
compute the *same* state, which is the property sync needs — but it is not the state either of them
had, and `tests/unit/srs/replay.test.ts` does not cover that case, so this plan must not lean on it.
The acceptance criterion below covers it instead. This is also the honest reason changing
`requestRetention` is a schedule change and not a preference: it always was, and sync only makes it
visible on two screens at once.

*Step 3 deliberately reproduces the local semantics, tombstones included.* After B4 makes
`unmarkKnown` a soft delete, an unmarked entry has a tombstoned `known_words` row and no live one, so
step 3 does not fire and the card keeps whatever `replayCard` produced. That is the same outcome a
single device gives — `unmarkKnown`'s own comment says "the cards `markKnown` pushed a year out are
deliberately left alone" — with one difference that has to be named: on a single device the card
keeps the year-long push because nothing recomputes it, whereas after a merge a recompute *does* run
and drops it. **The rule is: a recompute reproduces what a single device would show**, so if step 2
runs on a card whose latest `known_words` row is tombstoned, the year-long push is re-applied from
that tombstoned row's `createdAt` unless a review has happened since. Write that condition out; a
card silently becoming due because the other device graded something else is a schedule change no
single device can produce, and it is exactly the kind of thing a learner reports as "the app forgot".

Every parameter comes through `lib/srs/params.ts`, which CLAUDE.md makes the one construction site —
`replayCard` already goes through it, and the sync engine must not acquire a second one.

**The account-level export is a client function, not a server route.** An earlier draft of this plan
put a `GET /export` on the proxy. Do not build it. B0 defines the proxy as holding no learner content
and B4 says sync needs no server code at all — the client talks to PostgREST with the account's JWT
and RLS does the enforcement — so a route that reads every table for an account would give that
service either a forwarded JWT it has no other use for or, worse, the service credential, and would
put every learner's whole deck behind one process. The client already has RLS-scoped read access to
exactly the rows the export contains. So: **`exportAccount()` in `lib/sync/export.ts`** pulls every
synced store from PostgREST and hands the rows to `web.md` W5's serializer, producing a byte-identical
file to the local export. Two reads of the same rows, one format, one importer, no new blast radius.
If the two serializers ever diverge, a test says so. **If this plan slips, W5's local export is the
entire safety net and must ship anyway** — that is the point of STACK §2.8's export-first framing and
of `ios.md`/`android.md` reusing it.

**Files.** `lib/sync/{engine,cursor,mapping,conflicts,export}.ts` **(all new)**, `lib/db/dexie.ts`
(the implementation of wave 0's five sync members), `lib/srs/recompute.ts` **(new)**,
`apps/app/src/routes/account.tsx` (sync status, last-synced, manual sync, and the two resets B4
distinguished), `tests/unit/sync/**` **(new)**, `tests/e2e/sync/**`
**(new)**, and `package.json` + `tests/unit/deps.test.ts` if the PostgREST calls go through
`@supabase/supabase-js` rather than `fetch` (see B3).

**Acceptance criteria.** These are the phase. The harness is two repositories over `fake-indexeddb`
and one Postgres reached the way B0 decided (§4 item 4); every criterion that needs the Postgres is
*(deploy)* if that answer was a remote project, and the harness skips loudly rather than silently
when `TANGRAM_TEST_POSTGRES_URL` is unset.

- **Two clients converge.** Make disjoint edits on both offline, sync both, and every table is
  row-identical in both — tombstones included.
- **The system lists converge to eight, not sixteen.** Both devices open the app offline for the
  first time, both run `ensureSystemLists`, both sync. Assert: eight live `lists` rows, eight
  tombstoned ones, both devices agree on which UUID won, no `ConstraintError` was raised, and every
  `list_members` row points at a live list. This is the test the natural-key rule exists for and it
  is the first one to write, because a naive implementation throws here rather than failing an
  assertion.
- **One card per (entry, sense, direction).** Add the same word on both devices offline, sync: one
  live card, one tombstone, and the survivor's review log is the union of both devices' reviews.
- **Delete replicates.** Delete a list on A, sync both, the list is gone on B and does not come back
  after a third sync. Same for a card, and same for `unmarkKnown` (which is the case B4's correction
  exists for).
- **Reviews union.** Grade the same card on both devices while offline, sync: both hold the union of
  review rows, and each card's `fsrs` equals `replayCard(merged)` with the known-words rule applied.
  Assert the state on both devices is equal to each other **and** to a third replay computed
  independently in the test.
- **Recompute under merged settings is convergent.** Grade on A under one `requestRetention` and on B
  under another, sync, and assert both devices agree with each other **and** with a third independent
  replay computed under the *merged* settings — not with either device's pre-merge card. This is the
  case `tests/unit/srs/replay.test.ts` does not cover and the one the recompute rule is honest about.
- **Mark-known survives a merge.** Mark known on A after B's last review, sync, and the card on B is
  not due — i.e. step 3 of the recompute rule ran. Then the tombstone case: mark known on A, unmark on
  A, grade once on B, sync, and assert the card's due date is what a single device would show.
- **The daily cap converges, and the assertion is the observable.** Introduce 3 new cards on A and 4
  on B on the same day key, sync, and assert on `buildQueue`: `chargedToday` is 7 and `drawLimit` is
  `newPerDay - 7` on **both** devices. Do **not** assert `settings.introduced[key]`, which
  `queue.ts:163`'s `Math.max(introducedToday, createdToday)` overrides anyway. Then the case `max`
  actually covers: introduce 4 on B, delete one, sync, and `chargedToday` is still 7. Pin `TZ` in the
  test — the day key is local (`lib/srs/day.ts:13-25`) and a suite that runs in two zones is testing
  the wrong thing.
- **`ask_cache` and `sync_state` do not sync.** Assert it, so nobody adds them later by symmetry, and
  assert there is no `tangram.ask_cache` table to add them to.
- **Reset means something.** With a session live: `resetAll` refuses (B4); `resetAccount()` tombstones
  every row, pushes, and after two further syncs the deck is still empty on both devices. Without a
  session, `resetAll` behaves exactly as it does today.
- **Interrupted sync is safe.** Kill the process mid-push and mid-pull; on the next run the result is
  the same converged state. Every apply is idempotent, and this is the test that proves it.
- **Signed out, nothing happens.** With no session, no request leaves the app and every existing e2e
  spec passes.
- `exportAccount()` returns rows that `web.md` W5's importer accepts, round-tripped into an empty
  local database with tombstones preserved, and byte-identical to W5's local export of the same
  deck.

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

**The scheme, if it runs: direct encryption under a versioned master key.** A 32-byte master key
lives in the host's secret store as an environment variable, never in Postgres. Each account's
provider key is encrypted with AES-256-GCM **directly under the master**, stored as
`{ciphertext, iv, tag, key_version}` in a `tangram.provider_keys` table that **has no select policy at
all** — the client cannot read it back under any JWT. `key_version` selects which master decrypts.
Writing goes through the proxy, which holds the service credential; the client sends the key once over
TLS and never sees it again. What the client *can* read is a fingerprint row: the last four
characters, the creation date, and the last-used date.

**This is deliberately not envelope encryption, and the difference is one stored column.** Envelope
encryption means a per-account data key, encrypted under the master and **stored beside the
ciphertext** — without that wrapped DEK the per-account key is unrecoverable and the row cannot be
decrypted at all, so a four-column tuple with no `wrapped_dek` is not an envelope scheme however it is
described. A DEK layer buys re-wrapping instead of re-encrypting at rotation time, which matters at a
scale this product does not have (one account, then perhaps ten). Direct encryption is the smaller
correct thing; if the account count ever makes rotation expensive, add `wrapped_dek`, `dek_iv` and
`dek_tag` then, which is a schema change and free until there is data.

Rotation therefore **re-encrypts**: generate a new master, bump `key_version`, decrypt each row with
the old master and re-encrypt with the new, retire the old. Revocation is a delete plus a line telling
the learner to revoke the key at the provider, because a key we have deleted is still a live key. Both
runbooks must exist before this phase is called done — a custody scheme with no rotation path is a
custody scheme with one key forever.

**The proxy's durable state starts here, and B0's "holds no learner content" is what stays true.**
Reading `provider_keys`, stamping `last_used_at` and B7's counters are all writes through the service
credential to the same Postgres. That is the credential whose compromise the threat model below is
about; it is not a second database and it holds no cards, reviews or prompts.

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
- Ciphertext round-trips: encrypt, **restart the process**, decrypt, and the model call succeeds —
  which is only possible because everything needed to decrypt is either in the row or in the
  environment. A wrong master key fails closed with a clear server-side error and a generic
  client-side one.
- Rotation: rotate the master key, re-encrypt every row, `key_version` advances, every stored key
  still works, and the old master no longer decrypts anything. Run it once for real in this phase.
- Removing a key: the row is gone and the account falls back to **the fallback B7 states** — the
  owner's key behind the shared secret, exactly as before B6 — and the app says so in words rather
  than failing. (B7 owns that policy; this criterion asserts whichever one B7 wrote, and if B7 has not
  run yet, it asserts the pre-B6 behaviour, which is the same thing.)
- A grep proves no key material reaches a log: assert that the logger redacts, with a test that logs
  an object containing a key-shaped string and inspects the output.
- The account screen carries the four "does not protect" statements in the learner's language, and
  the provider's spend-limit advice at the point of pasting.

---

### B7 — Operating it: limits, logs, backups, and the runbook

**Builds.** The things that decide whether one person can run this without it becoming a second job.

- **Limits that work without an account, and this is the part that matters most.** Between B1 and B6
  — which may be the permanent state, since B6 is conditional on an answer that may be no — every
  model request is anonymous, authorised only by `TANGRAM_ACCESS_SECRET`, and billed to the owner's
  key. Per-account limits are keyed on an identity those requests do not have. So the limiter has
  **three keys and the tightest one wins**: per account when a verified JWT is present, per secret
  always, and per IP always. Requests per minute and per day for each, plus the body-size and
  entry-count caps B2 introduced. Return `429` with a `Retry-After`, and make the client's copy say
  what happened rather than "something went wrong".
- **Where the counters live, said out loud.** A per-day counter and B6's `last_used_at` are durable
  state, and B0's proxy may run as more than one instance. In-process counters would neither persist
  across a restart nor agree across instances, which turns "100 requests a day" into "100 per
  instance per deploy". They go in Postgres — `tangram.rate_limits`, keyed by
  `(scope, key, window_start)`, written through the same service credential B6 already gives the
  proxy — unless B0 recorded that the host runs exactly one always-warm instance, in which case an
  in-process counter is acceptable **and B0's record is the justification**. Decide from B0's note,
  not from convenience.
- **The fallback policy B6 defers to this phase.** An account with no stored provider key uses the
  owner's key from the server's environment, behind the shared-secret gate, under the per-secret and
  per-IP limits — exactly the pre-B6 behaviour. The fake provider is a development setting
  (`TANGRAM_LLM_PROVIDER`) and is never a production fallback: silently answering with a fake is worse
  than answering with an error.
- **Logs that are useful and safe.** Structured, one line per request: account id, route, provider,
  latency, outcome, token counts if the SDK reports them. Never the key, never the full prompt, never
  the learner's query by default — that last one is the tempting mistake, because query text is what
  you want when debugging, and it is also the learner's study history. If a debug mode logs queries,
  it is opt-in and it is time-bounded.
- **Backups and a restore drill.** Postgres point-in-time recovery, whatever the host offers, plus
  one executed restore into a scratch project with a screenshot or a log in `HANDOFF.md`. An untested
  backup is a hope.
- **`docs/deploy.md` completed, not rewritten.** `web.md` W2 owns that file and rewrites it for a
  static deployment; B0 appended a server section and B3 and B6 added env vars to it. **This phase
  runs after W2** and finishes the server half: the env vars for each deployable, the master key, the
  SMTP sender, the rollback, the smoke commands, the restore drill and the after-deploy checklist.
  Its §6 warning — function timeout versus the 30 s ask deadline — carries over verbatim and applies
  to the new host. If W2 has not landed, this phase waits; two plans rewriting one file in an
  undefined order is how a deploy document ends up describing a deployment nobody has.
- **A monitoring floor.** Not an observability stack: an uptime check on `/health`, an alert on 5xx
  rate, and a monthly glance at spend. Anything more is a project.

**Acceptance criteria.**

- Exceeding the per-minute limit returns `429` with `Retry-After`, the app shows the real reason, and
  a normal study session never hits it (assert the limit is above a measured session's request rate,
  and record that rate).
- **The signed-out path is limited too.** With no `Authorization` header at all, the per-secret and
  per-IP limits still fire. This is the criterion that says the phase did its job, because the
  account-keyed limit is the easy half and the anonymous traffic is the half that spends money.
- *(deploy)* **The limit holds across instances**, or the single-instance assumption is recorded.
  Drive the limit from two concurrent clients against the deployed server and assert one 429; if B0
  recorded exactly one always-warm instance, assert that instead and cite B0's note.
- A synthetic request carrying a key-shaped string appears redacted in the logs.
- *(deploy)* A restore drill is executed and recorded in `HANDOFF.md` with the date, the target, and
  the elapsed time.
- *(deploy)* `pnpm --filter server smoke --base-url <production>` passes against the deployed server,
  and the after-deploy checklist in `docs/deploy.md` is walked once by hand.
- `docs/deploy.md`, **as W2 left it plus this plan's sections**, contains no Next-specific instruction
  and no reference to a route this plan or `data.md` deleted.

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
| **No environment can run B4's SQL tests or B5's two-client harness.** The container has a docker client and no daemon (`docker ps` → `dial unix /var/run/docker.sock: connect: no such file or directory`) and `psql` with no local server; `PLAN.md:46` records that Supabase MCP could not authenticate either. | B4 starts and the isolation suite has nowhere to run, so it is written and never executed. | **Check, and it is B0's, not B4's:** B0 acceptance item 5 forces the answer into `HANDOFF.md` before B4 begins — a remote project or branch with its cost, a docker-capable machine, or an in-process Postgres. The specs sit behind `TANGRAM_TEST_POSTGRES_URL` and skip loudly, never silently, so an unrun suite is visible in the output rather than green by absence. |
| **Sign-in email does not arrive, or lands in spam.** Wholly unaudited; no sender is chosen and the built-in one's production suitability is an open question (B3). | The manual delivery check in B3 fails, or a code takes minutes. | B3 makes the sender a named deliverable with its own cost line, splits the criterion into an automatable test-address half and one manual delivery check, and records the delivery time. The fallback if delivery is bad is a different sender, not a different auth method — the OTP decision does not depend on which SMTP relay carries it. |
| **A cold-starting proxy makes the first ask of a session slow.** Unmeasured; depends on B0's host. | B1's recorded cold ask latency is bad enough to be felt. | Measured in B1 and again in B2 (the dictionary's removal should dominate). Levers: keep one instance warm, or accept it because the dictionary card renders first anyway and the ask panel is asynchronous by design. |
| **The 40-entry `retrieved` payload is too large on a mobile connection (#none — nobody measured it).** | B2's recorded payload size or throttled latency is poor. | Measured in B2. Lever: send fewer glosses per entry rather than fewer entries — PLAN.md §3.4 says the prompt sees `id, simp, trad, pinyinMarked, glosses`, and glosses are 20% of `dict.json`'s bytes (`docs/deploy.md` §5's field breakdown). |
| **Register #3 — whether ITP's seven-day eviction applies to WKWebView inside a native app.** Unanswered on Apple's own forums. | Learner data disappears from a mobile app that has not been opened in a week. | **This plan is the mitigation** and STACK §4's own suggested answer is "cheapest answer is to not need it: get account sync working early". Until B5 ships, the cover is `web.md` W5's local export and, on native, STACK §2.8's option 2 (a `@capacitor-community/sqlite` `Repository`). **If B5 slips, neither of those may slip with it.** |
| **Register #13 — `navigator.storage.persist()` in Safari for a non-installed site.** | A browser tab loses its cards. | Same: sync is the durable answer, install and `persist()` are `web.md` W5's, and the export is the floor. |
| **RLS is misconfigured and one account can read another's rows.** The classic Supabase failure. | B4's isolation test passes but an advisor warns, or a later migration adds a table without a policy. | B4's nine-assertion isolation test plus the security advisor run, and a rule for every later migration: **a new table with no policy is a failed migration**, asserted by `tests/unit/server/policies.test.ts` over the migration files rather than by discipline. **There is no CI and v1 does not create one** (`wave-zero.md` §10, ruling 13), so the guard is a unit test that `pnpm test` runs; the live `pg_policies` query is the same rule against the real schema, behind `TANGRAM_TEST_POSTGRES_URL`. |
| **A local reset is silently undone, or a demo deck is pushed to the real account.** `resetAll` (`lib/db/dexie.ts:742`) hard-clears every table with no tombstones and is wired to the settings screen, `loadDemo` and two e2e helpers. | Someone resets, syncs, and their deck comes back; or `loadDemo` runs while signed in. | B4 correction 4: `resetAll` and `loadDemo` refuse while a session exists, and "reset this account" becomes a separate tombstone-and-push operation that B5 implements and asserts. Discovered late, this is the failure that makes B3's "offer export-then-reset instead" a remedy that does not work. |
| **The seam widens and the mobile/desktop `Repository` implementations become expensive.** STACK §2.8 and §2.4 both leave a second implementation open. | `ios.md` or a Tauri phase discovers it must implement `changedSince`/`applyRemote`/`syncState`/`setSyncState`/`resetAccount` too. | Stated here so it is not discovered: wave 0's interface diff makes those five part of the interface and B5 implements them. Keep them narrow — five members, row-level, no domain logic — precisely so a second implementation is a day and not a week. |
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
- **A reset that reaches other devices in real time.** `resetAccount()` tombstones and pushes; a
  second device learns about it on its next pull, like everything else. There is no "wipe my other
  phone now", and at one learner there does not need to be.
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
