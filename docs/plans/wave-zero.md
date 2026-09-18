# Wave zero — the orchestrator's rulings

**Status:** settled 2026-09-13 by the orchestrator. Binding on all seven sibling documents.

The cross-document critic found sixteen issues in the plan set ([README.md](README.md) §"Unresolved
cross-document issues"). Two were blocking: **nobody owned the first commit**, and the set as written
**had no valid execution order**. This document is the missing owner. It settles every one of the
sixteen, and it is the deliverable of wave 0 in the build sequence.

Two things live here and nowhere else: the decisions that no plan could make because they span plans,
and the specification for the `CLAUDE.md` rewrite that every plan gates its first phase on.

Every ruling below is written as *the change that must appear in the named document*. A build session
reads its own plan; the plan has already been corrected. This document is the audit trail for why.

---

## 1. The repository layout — SETTLED

A single pnpm workspace. `web.md` W0 executes this; it is recorded here because five plans depend on
it and none owned it.

```
tangram/
  apps/app/        the Vite SPA — everything at the repo root today moves here wholesale
  apps/server/     the Hono service: AI proxy, accounts, sync            (backend.md B0)
  apps/site/       the Astro marketing site                              (web.md W7)
  packages/ai/     provider contract, grounding, prompts, cache-key — shared by app and server
  data/            generated dictionary artifacts — STAYS AT THE ROOT
  scripts/         build-data.ts and friends — STAYS AT THE ROOT
  docs/  PLAN.md  HANDOFF.md  CLAUDE.md      stay at the root
```

`data/` and `scripts/` stay at the root because three deployables consume `pnpm data`'s output.

> **Correction, from the session that executed W0.** An earlier version of this section claimed "no
> change needed to W0 for this ruling; it is confirmation." That was wrong, and the build session
> caught it. W0's Files list put `scripts/` *inside* the `git mv`, and its prose and path-arithmetic
> table both depended on having done so. The two documents described different trees. The ruling
> stands — `scripts/` stays at the workspace root, with this document and `STACK.md` §5 against W0's
> list — and the session paid the cost rather than dropping it: the four root scripts left the app's
> TypeScript and eslint projects, so the workspace root gained its own configs and the root build
> typechecks everything it typechecked before. `TANGRAM_DATA_DIR` is the authoritative mechanism;
> `lib/dict/load.ts`'s default is no longer working-directory-relative. See `HANDOFF.md` under W0.

`web.md` W0 also documents the trap this creates — `build-data.ts` resolves its own directory and
`load.ts` resolves the working directory, so a naive move relocates the artifact while every test
still passes — and its remedy (both honour `TANGRAM_DATA_DIR`; the root scripts set it to the
absolute workspace-root path) stands. No change needed to W0 for this ruling; it is confirmation.

## 2. The `CLAUDE.md` rewrite — SPECIFIED HERE, EXECUTED IN WAVE 0

All six plans gate their first phase on this and none contained it. The current `CLAUDE.md` describes
a Next.js app with a frozen-file rule written for parallel overnight builders in a single tree. Both
premises are gone. Rewrite it to say:

1. **What the app is now** — a single pnpm workspace, one React SPA built by Vite, wrapped by
   Capacitor for phones, an installed PWA on desktop, one prebuilt read-only SQLite dictionary, a
   small server for accounts, sync and the AI proxy. Point at `docs/STACK.md` as the decision record
   and `docs/plans/` as the build briefs.
2. **The commands**, corrected for the workspace. Until W1 lands, the app's build is still Next's;
   say so rather than documenting a state that does not exist yet.
3. **The frozen-file rule is REPLACED, not deleted.** Its purpose — stop two builders fighting over a
   shared surface — still holds, but the surfaces changed and the mechanism was a hand-written list
   that went stale. The new rule: *a shared surface is frozen by a types-only first commit in the plan
   that owns it, and every other plan gates on that commit rather than on the phase.* Three already
   work this way (`data.md` D1, `backend.md` B2, and §5 below); name them. A builder who needs a
   change to a frozen surface stops, writes it into `HANDOFF.md`, and continues without it — that part
   is unchanged and still not negotiable.
4. **The settle-first list**, replacing the old frozen-file list: `packages/ai/**` after §5's move,
   `lib/db/repository.ts` after §5's diff, `lib/db/schema.ts`, `lib/types.ts`, `lib/srs/params.ts`,
   the `DictStore`/`SqlRunner`/`DictStatus` declarations from `data.md` D1, and the ask contract from
   `backend.md` B2.
5. **What has NOT changed** and is still authoritative in `PLAN.md`: the data contract (§3.1), the
   schema rules (§3.3), the grounding contract (§3.4) and the licence boundary (§5). Say that the
   dictionary is ground truth and the model never emits a headword for display, because it is the
   product's core promise and a fresh session must not have to infer it.
6. **There are no users and no data.** Schema changes are free. Nothing in this repo is a migration
   plan.

## 3. Three files, one fate each — SETTLED (issue 2)

`data.md` D6 must **not** delete `scripts/smoke.ts`, `lib/server/route-inventory.ts` or
`tests/unit/server/routes.test.ts`. `web.md` W1 imports `discoverApiRoutes()` from the second, and the
guard exists because a route once shipped untraced and only a human opening the page noticed.

- **`web.md` W2 owns the final form of all three** and decides it. Its current disposition — smoke
  rewritten as a dependency-free CLI, route-inventory reduced to what the adapter and the coverage
  check still need, routes.test rewritten around the route table and host config — stands.
- **`data.md` D6** removes only the `/api/dict/*` **entries** from them. Its disposition table changes
  from "deleted, not trimmed" to "entries removed; the files are `web.md` W2's". Its acceptance
  criterion 2 loses the `node:fs` justification for deleting `route-inventory.ts`.
- **`backend.md` B2** is already correct and does not change.

## 4. The two phase splits — SETTLED (issues 3 and 5)

**`core.md` C5 splits into C5a and C5b.** C5a is the drag-select gallery harness alone, running in
desktop Chromium, touching **no production reader file**. C5b is the production rewrite
(`use-span-select.ts`, `hanzi-text.tsx`, `reader-text.tsx`, `lib/stores/reader.ts`). `ios.md` §4.4
requires this because I2 gates C5's production code while C5's harness gates I2; without the split the
two deadlock.

**`data.md` D5 splits into D5a and D5b.** D5a is the Android-runnable half and states its own hardware
precondition (an Android phone). D5b carries the iOS-only work and keeps D5's current precondition (a
Mac with Xcode 26 and a physical iOS 26 device). `android.md` A5 gates on **D5a only**.

**`android.md` A1 does not gate on `core.md` C7.** It boots whatever shell `web.md` W1 produced and
re-baselines its checklist at C7, exactly as `ios.md` I1 already does. Without this, Android's first
phase waits on an iPhone, which contradicts android.md's own premise and STACK §4's claim that the two
mobile tracks are independent.

## 5. The two shared surfaces — SETTLED (issue 7)

**`lib/db/repository.ts` gets one interface diff, landed in wave 0 as a types-only commit, frozen
after.** It carries both plans' additions at once so neither has to rebase on the other:

| Method | Wanted by | For |
|---|---|---|
| `exportAll()` / `importAll(payload)` | `web.md` W5 | the local backup and its restore |
| `changedSince(ms)` | `backend.md` B5 | the outbound half of sync |
| `applyRemote(changes)` | `backend.md` B5 | the inbound half |
| `syncState()` / `setSyncState(s)` | `backend.md` B5 | the cursor and last-synced stamp |
| `resetAccount()` | `backend.md` B5 | sign-out and account deletion |

Both plans drop their "whichever lands first, the other rebases" prose and gate on this commit.

**The declarations themselves — SETTLED (register V5).** The table above names methods and callers
and no signatures, and V5 was right that deliverable 4 is not executable from it: a builder would
have to reconstruct the types from two sibling plans, one of which (`backend.md` B5) types the sync
members against a `SyncedStore` that **B4 defines, many waves later**. Freezing a signature whose
type is written downstream is not freezing anything. So the four types come with the diff, in
`lib/db/repository.ts`, and **B4 consumes `SyncedStore` rather than declaring it** — B4 keeps its
schema corrections, which add columns to Dexie *index strings* and are not type changes.

Transcribe this. It is the whole of deliverable 4, and nothing in it is a design decision left to
the builder:

```ts
/**
 * The eight stores that sync. Derived from `StoreName` rather than hand-listed,
 * so a store added to the schema is a type error here instead of a silent
 * omission from the change feed. `ask_cache` is excluded and stays excluded:
 * it is a cache keyed by a hash of the prompt, it holds entry ids and sense
 * indexes only, and re-deriving it costs one model call.
 */
export type SyncedStore = Exclude<StoreName, 'ask_cache'>;

/** The row shape each synced store carries on the row-level channel. */
export interface SyncedRow {
  words: WordRow;
  cards: CardRow;
  reviews: ReviewRow;
  lists: ListRow;
  list_members: ListMemberRow;
  known_words: KnownWordRow;
  texts: TextRow;
  settings: SettingsRow;
}

/** Where the last sync got to. One row, client-side. */
export interface SyncState {
  /**
   * The `t0` of the last successful push — taken *before* the read, so a row
   * written during a push is caught by the next one (`backend.md` B5).
   */
  lastPushedAt: number | null;
  /** The maximum `server_updated_at` the last pull saw, per store. */
  cursors: Partial<Record<SyncedStore, string>>;
  lastSyncedAt: number | null;
}

/** A whole-database dump. Versioned, because a restore outlives its writer. */
export interface Snapshot {
  /** This envelope's format version, bumped when the envelope changes. */
  format: 1;
  /** The `DB_VERSION` the dump was cut at. */
  dbVersion: number;
  createdAt: number;
  rows: { [S in SyncedStore]: SyncedRow[S][] } & { ask_cache: AskCacheRow[] };
}
```

and, on `Repository` itself:

```ts
/**
 * Every store, every row, **tombstones included**. With `importAll`, the only
 * two members allowed to see `deletedAt !== null` rows: a round trip that drops
 * soft-deleted rows resurrects deleted cards on the next sync.
 */
exportAll(): Promise<Snapshot>;

/**
 * Destructive by contract — this is restore, not merge. Merge is sync
 * (`changedSince`/`applyRemote`). Replaces the database wholesale.
 */
importAll(snapshot: Snapshot): Promise<void>;

/** Local writes to push. Not one key: see the change-feed table in `backend.md` B5. */
changedSince<S extends SyncedStore>(store: S, sinceMs: number): Promise<SyncedRow[S][]>;

/** Remote rows in, LWW plus B4's natural-key dedupe, one Dexie transaction per call. */
applyRemote<S extends SyncedStore>(store: S, rows: SyncedRow[S][]): Promise<void>;

syncState(): Promise<SyncState>;
setSyncState(patch: Partial<SyncState>): Promise<SyncState>;

/** Sign-out and account deletion. Tombstones and pushes; it does not drop the database. */
resetAccount(): Promise<void>;
```

Four things in that block are rulings, not transcription, and a builder should not relitigate them:

1. **`changedSince` and `applyRemote` are generic over the store.** B5's sketch returns a bare
   `Row[]`, which makes every call site cast. The mapped `SyncedRow` costs nothing at runtime and is
   what stops `applyRemote('cards', reviewRows)` compiling.
2. **`SyncedStore` is derived, not listed.** B5's prose says "the eight stores B4 lists"; a list in
   prose drifts from the schema. `Exclude<StoreName, 'ask_cache'>` cannot.
3. **`Snapshot.rows` includes `ask_cache`** even though it does not sync. Export is a backup of the
   database, and omitting the cache from a restore is a silent cache flush the learner did not ask
   for. It is the one place the two sets differ, which is why the type says so explicitly rather
   than reusing `SyncedStore` for both.
4. **`resetAccount()` does not drop the database.** B5 §1144 has it tombstone and push, so the reset
   reaches other devices; a local wipe is `resetAll` and is a different thing that B4 makes refuse
   while a session is live.

**The block above was typechecked against the real schema, not sketched.** Compiled under the
app's own `tsconfig.json` against `lib/db/schema.ts` as it stands, with three negative assertions
that all hold: `applyRemote('cards', reviewRows)` is an error, `changedSince('ask_cache', …)` is an
error, and `keyof SyncedRow` is exactly `SyncedStore` in both directions. If a later schema change
adds a store, `SyncedRow` fails to compile until someone decides whether it syncs — which is the
point of deriving the union.

**This is still a types-only commit.** `lib/db/dexie.ts` gets seven `throw new Error('not
implemented')` bodies — enough for `pnpm typecheck` to pass, and `web.md` W5 and `backend.md` B5
replace them. A stub that returns a plausible empty value instead of throwing is how a phase ships
a sync engine that silently syncs nothing, so it throws.

**`packages/ai/` is created in wave 0 and the existing ten `lib/ai/**` modules move there in the same
commit** — not in `backend.md` B1. Moving it in wave 0 removes the gate between `data.md` D3 and B1
entirely, because both then write into a location that already exists.

- `packages/ai/` holds the provider contract, grounding, prompts, the cache key, and `data.md` D3's
  `retrieve.ts` — anything the app and the server both need.
- `apps/app/lib/ai/` holds only `ask-client.ts` (`backend.md` B2), which is browser-side and calls the
  server.
- `backend.md` B1 loses the move and keeps the rest of its phase.

## 6. The dictionary's web delivery — ASSIGNED (issue 6)

`web.md` W2 gains, in its Files list and acceptance criteria: copying
`data/dict-<schema>-<cedict>.sqlite`, `data/dict-manifest.json` and `data/decomp.json` into the app's
build output, and two host rules — the content-addressed path served
`Cache-Control: public, max-age=31536000, immutable`, and the pre-compressed `.br` under content
negotiation. `data.md` D4 stated the requirement and correctly said web.md owned the host; nobody had
told web.md. `decomp.json` gets a stated delivery in the same phase.

## 7. Three capabilities that were being dropped — REINSTATED (issue 8)

None of these were a decision to cut. They fell between plans.

- **The reader's known / learning / new colouring, and "Mark known".** `lib/reader/**` belongs to
  **`core.md`**. C4 and C5b carry `tokenStates` onto `<HanziText>` and the "Mark known" action into
  the word sheet, each with its own acceptance criterion. This is PLAN.md §1's loop — *your known-word
  set shapes what you see next* — and the coloured passage is the only place a learner sees it.
- **The tangram-pieces session progress.** `core.md` C8. product-decisions §11 calls it the one
  playful element in the whole design; it appeared in no phase.
- **The in-context gloss on a reader tap.** `core.md` C4, consuming the `context?` field
  `backend.md`'s contract already carries. product-decisions §5 asks for one line on what the word
  means in *that* sentence.

## 8. List import — DEFERRED, ON THE RECORD (issue 9)

v1 ships without it. product-decisions §9 specifies it fully and the repository already has
`addListMembers(listId, entryIds[])`, so it is a clean later addition, not a hole. Every plan's
"its own task, per STACK §7" sentence stays; STACK §6 records that the task is deliberately not
scheduled for v1 rather than merely unwritten.

## 8a. §8 was ruled without knowing the importer was already written — CORRECTED 2026-09-18

§8 above says list import is "a clean later addition, not a hole." That is still the right call for
v1, but it was made on a false premise and the premise matters to whoever schedules it.

**The importer exists.** `main` carries commit `abe6793`, *"List importer: paste, Pleco and Anki
exports resolved against the dictionary"* — **14 files, 1,654 insertions**, landed after the
migration branch forked at `c852314` and therefore never seen by any plan in this set. It is not in
the workspace tree: there is no `Pleco` outside plan documents and no `apps/app/lib/lists/import/`.
Nobody dropped it; the fork simply predates it, and eight commits kept accruing on a branch the
build had stopped reading.

Found while diagnosing a Vercel build failure, because `main` was still the pre-migration Next.js
repository and had to be looked at.

**What ports and what does not.** Roughly two thirds is pure and should move almost unchanged:

| From `abe6793` | Fate |
|---|---|
| `lib/lists/import/parse.ts` (342) + `tests/unit/lists/import-parse.test.ts` (173) | Pure text: paste, Pleco and Anki export shapes. Ports as-is |
| `lib/lists/import/resolve.ts` (188) + its test (138) | Ports; its dependency does not |
| `components/lists/import-list.tsx` (343) | Ports as a component; its data call changes |
| `lib/dict/resolve.ts` (102) + `tests/unit/dict/resolve.test.ts` (105) | **Rewrite.** Reads `getDictIndex()` — the in-heap JSON index that `data.md` D1–D4 replaced with SQLite. The *rule* it documents (hanzi matches exactly against both scripts, else tone-exact pinyin then toneless, else nothing) is the valuable part and survives; the implementation becomes a `DictStore` query |
| `app/api/dict/resolve/route.ts` (56) + `lib/dict/client.ts` (28) | **Delete.** There are no Next route handlers, and since D6 the client queries the dictionary in-process. The round trip these exist to make is gone |
| `tests/e2e/p3/import-list.spec.ts` (85) | Ports; rehomed, and it joins the census in `tests/unit/shell/tab-routes.test.ts` |

**The ruling, as first written.** *Still deferred for v1 — §8 stands.* **Reversed by the owner the
same day**, on being shown that the code exists: *"we should keep the list importer."* §8 and the
first half of this section are superseded on that point. It is scheduled; §8b is the seam it needs.
Whoever builds it starts from `git show abe6793`, reachable forever through the merge that made the
workspace tree `main`'s.

**The process failure, since it is the second of its kind.** The provenance note at the foot of this
file says a ruling is landed only when it reaches the branch builders cut from. This is the same
failure pointed the other way: **work landed on a branch the build had stopped reading, and no one
compared the two trees for eleven weeks.** A fork is not a cutover. The cutover is the merge.

## 8b. `DictStore.resolve` — a frozen surface widened, deliberately — SETTLED 2026-09-18

Keeping the importer needs one thing no build session is allowed to do: `DictStore` is frozen by
`data.md` D1's first commit, and the importer cannot be built on what is there.

**Why not `search`.** `search` ranks *across* headwords and pages at `SEARCH_PAGE_SIZE` (50). That is
exactly right for a person typing and exactly wrong for a 300-line paste, where every line needs its
own candidate set and `打` must not become 打算. `wordsContaining` can be abused into the hanzi half
— take every headword containing the first character and filter — but it has its own `limit`, it
costs a posting-list decode per word, and there is no pinyin equivalent at all. `entries` needs
`EntryId`s, which is what the importer is trying to find. There is no existing member that answers
the question.

**Why bulk.** On the OPFS worker and the Capacitor bridge a per-word call makes a paste hundreds of
round trips. `data.md` D6 already refused to serialise an HSK band whole for the same reason.

**The declaration, landed alone and first** (`lib/dict/store.ts`), with `ResolveVia`, `ResolvedWord`
and `ResolveResult` beside it:

```ts
resolve(
  words: readonly string[],
  options?: { signal?: AbortSignal },
): Promise<ResolveResult>;
```

`signal` rides in the options rather than as a third parameter, for the same reason `SearchOptions`
carries it: the arity of a frozen member is part of the freeze.

**`SqliteDictStore.resolve` throws.** Not `{ dictVersion, results: [] }` — that type-checks, passes
any shape assertion, and ships an importer that finds nothing in every paste, which reads on screen
as a broken dictionary rather than as missing code. Same reasoning as wave 0 §5's five `Repository`
members, and the same kind of guard: `tests/unit/dict/resolve-frozen.test.ts`. That guard was
mutation-tested — replacing the throw with an empty result fails two of its three cases — because a
freeze nobody can falsify is a freeze that has already thawed.

**The caps are settled too, and they are not in `store.ts`.** `RESOLVE_MAX_WORDS` (1,000) and
`RESOLVE_MAX_WORD_CHARS` (200) come over from `abe6793` unchanged, because a port that picks its own
numbers silently changes how a large paste is batched. They live in `lib/dict/resolve.ts`, not beside
the declaration they belong to, because `store.ts` is a **types-only** module: 
`tests/unit/dict/store-contract.test.ts` asserts it emits nothing at runtime, so importing the
dictionary's contract can never pull code into a browser bundle. Two `export const`s were enough to
break that, and putting them there is exactly what this session did — the test caught it on the
first full run. Worth recording, because the invariant is not obvious from reading the file.

**What this costs everyone else:** eight fakes gained a throwing `resolve`. None of them call it.

**What the porting phase owns:** `SqliteDictStore.resolve` for real, the parsers and their 311 lines
of tests moved almost unchanged, the picker UI, the Library wiring, and the e2e spec — which also
joins the census in `tests/unit/shell/tab-routes.test.ts`. It does **not** own this signature.

## 9. The Practice-queue merge — ASSIGNED (issue 10)

`core.md` C7 gains `lib/lists/today.ts`, `lib/lists/introduce.ts` and `lib/srs/session.ts` in its
Files list, and an acceptance criterion that one session serves new words, recognition and writing
from one queue. This is product-decisions §1's central claim; without it C7 ships a Practice tab that
still introduces new words on a different screen from the one that reviews them.

## 10. Everything else — SETTLED (issues 11 to 16)

| # | Ruling | Documents to change |
|---|---|---|
| 11 | **`data/hsk.json` does not exist.** HSK bands live on `Entry.hskBand`, and after D1 in `entries.hsk_band`. | `web.md` W7 and R12; STACK §5.7 |
| 12 | **`viewport-fit=cover` and the native `register-sw.tsx` gate both go in `web.md` W1's Files list.** Delete the hand-off prose from `ios.md` I5 and `android.md` A1/A2. | `web.md`, `ios.md`, `android.md` |
| 13 | **There is no CI and v1 does not create one.** `backend.md` B4's `pg_policies` rule becomes a unit test under `tests/unit/`, exactly as `android.md` already does for its two. `web.md`'s three CI references get the same treatment. Recorded as an open item in STACK §5, not silently dropped. | `backend.md`, `web.md`, STACK |
| 14 | **The static host for `apps/app` is Vercel**, the same account as the existing deployment described in `docs/deploy.md`. A decision, not W2's fallback. | `web.md` W2; STACK §5 |
| 15 | **`web.md` W7 owns a privacy policy page and a support page** on the Astro site, with their URLs recorded. Both store submissions are blocked without them and they are an hour's work. | `web.md` W7; `ios.md` I8; `android.md` A8 |
| 16a | **`data.md` D1's measured 43.1 MB raw / 13.9 MB brotli supersedes** STACK §3's 47.2 / 15.4. | STACK §3; `web.md` W6; `core.md` R4 |
| 16b | **`core.md` gains the post-W0 path note** every other plan has: every path it writes is relative to `apps/app/`. | `core.md` |
| 16c | **`core.md`'s two citations of "`data.md` §5.7" become D3.** No §5.7 exists. | `core.md` C4a |
| 16d | **`ios.md`'s reading of the C2 gate governs:** I0–I3 consume nothing from `TTSProvider` and can run without it. `core.md` C2's "must land before any mobile plan starts" is wrong. | `core.md` C2; `android.md` A4 |
| 16e | **The design canvas is illustrative; the plans govern.** `core.md` extracts the layout facts its phases depend on into its own text so no phase depends on a source a build session cannot open. | `core.md` §1 |

## 10a. The access gate matches by PREFIX — SETTLED (raised by the server build session)

The session building `backend.md` B0–B2 stopped and asked which plan owns how the access gate matches,
and it was right to. The answer has a security consequence.

The gate's path list is `['/api/ask', '/api/examples', '/api/recall']`, and the only code that ever
matched a request against it was the middleware `web.md` W1 deleted:

```ts
GATED_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`))
```

A **prefix** match. `web.md` W4's disposition table lists the path list as "unchanged, moved" and says
nothing about matching; `backend.md` B1 inherits the same silence. B2 then adds `/api/ask/propose` and
`/api/ask/answer` — **the two routes that actually spend money**. An exact-string gate leaves both of
them open while `TANGRAM_ACCESS_SECRET` is set and every existing test passes.

**Rulings.**

1. **The match is by prefix**, exactly as the deleted middleware did it. This is not a preference; an
   exact match is a silent authentication bypass on the only two routes with a bill attached.
2. **The enforcing gate is server-side and belongs to `backend.md` B1**, because that is where the
   three routes now live. `web.md` W4 owns only the client half — sending the header — and its
   disposition table should say so rather than implying it owns the check.
3. **The rule lives in the frozen ask contract and is asserted by the contract test**, which is what
   the build session did on its own initiative and is the right call: the contract is the one artifact
   both halves share, and neither W4's owner nor B1's owns the other's test file.
4. **The assertion must name `/api/ask/propose` and `/api/ask/answer` explicitly**, not just the three
   parent paths. A test that only proves the parents are gated is the test that would have passed
   while both children were open.

This is the second time in this build that a config-shaped change matched fewer things than it looked
like it matched, with every local gate green — the first was the dictionary tracing globs in W0. Both
were caught by an adversarial reviewer rather than by a test, and in both cases the fix included a new
test that can catch the next one.

## 10b. V1 — the phone shell is NOT behind an iPhone — SETTLED

The verification register's V1 asked whether `core.md` C7 may land before C5b, because the answer
decides whether the whole Android track waits on Apple hardware. **It may. C7 is not gated on C5b.**

**Why the gate exists, and why it is right.** `ios.md` I2 answers register #1 on a physical iOS 26
device: the reported WKWebView crash against `-webkit-user-select: none` during touch. That property
is how drag-select stops the ruby annotations being swept into the selection, so it is load-bearing.
C5a builds the prototype in a harness touching no production file, I2 runs against that harness, and
C5b — the production rewrite — waits for the answer. That ordering stands and is not reopened.

**What was wrong was the inheritance, not the gate.** `android.md` A2, A4 and A6 gated on *ranges* of
core phases (C7; C6; C3–C6), and those ranges contain C5b. So Android's second phase — which needs a
tab bar and a CSS variable — transitively waited on an iPhone. That was nobody's intent and
contradicts both `android.md`'s own premise and STACK §4.

**And the two documents disagreed.** `core.md` §4 already says register #1 gates *"Before C5b, and
before nothing else here."* `README.md`'s wave 5 put C7 after C5b anyway, and §8's disposition table
implied it. Read against what C7 actually builds — the three-tab shell, the wide breakpoint, the
Practice queue merge, `components/shell/**` — none of it consumes C5b. The only real coupling is that
C7 assembles the Look up tab around a reader C5b later rewrites: rework to sequence sensibly, not a
dependency.

**Rulings.**

1. **`core.md` §4 governs.** C7 may land before C5b. `README.md`'s wave table is corrected, not §4.
2. **`android.md` A2, A4 and A6 stop gating on phase ranges** and name the artifacts they need: the
   `TabBar` primitive and the shell's inset CSS variable (A2), `lib/tts/sequence.ts` (A4), the engine
   feature list C5a measured (A6). None of those is C5b.
3. **Prefer C7 after C5b when both are free**, to avoid assembling the Look up tab twice — a
   preference for the scheduler, never a gate another plan may inherit.
4. **V4 falls out with it.** Wave 0b stops claiming `core.md` C0 runs in parallel with `web.md` W0.
   C0 edits the manifest W0 is splitting. C0 follows W0.

## 10c. The two shells — SETTLED by the owner (2026-09-14)

- **Wide-screen web gets the PAGE shell**, not the command palette.
- **The desktop application gets the PALETTE, with the global hotkey** — which was always the
  palette's only real justification, since a browser tab cannot summon itself.
- **The desktop application is deferred.** `core.md` C9 (the palette) and `web.md`'s Tauri work go
  with it. The installed PWA remains the desktop story until someone asks for the hotkey.
- **The default theme is Inkstone** — the warm paper ground, ink text and vermillion accent already
  specified as the visual language. The dark variant is optional and not the default.

This resolves the tension the design session left open: the palette earns its keep only where the
hotkey exists, so it ships with the application and the web keeps the shell that suits a browser.

## 10d. Register #1 — the WKWebView crash is RESOLVED from the source — SETTLED 2026-09-15

`ios.md` I2's device check gates `core.md` C5b, and STACK register #1 records the whole iOS decision
as resting on it. The iOS audit could not read the report (egress-blocked) and correctly filed it
unverified. It has now been read directly:
[Apple Developer Forums thread 797368](https://developer.apple.com/forums/thread/797368).

**Three independent reasons the risk is low, not one.**

1. **It is fixed.** The thread confirms the crash is resolved in **iOS 26 beta 7**. Shipping iOS 26
   does not have it.
2. **It does not reproduce when the app is built with Xcode 26** — which this project is *required*
   to use anyway, since Xcode 26 has been mandatory for App Store submissions since 28 April 2026 and
   Capacitor 8 requires it.
3. **The crash is in a code path this design deliberately bypasses.** The stack trace names
   `UIEditMenuInteraction` and `_UIEditMenuContentPresentation` — the native edit-menu callout. The
   trigger is the native selection gesture: double tap, hold the second tap, then drag. Both mobile
   audits already concluded that native selection is unusable here because it sweeps the `<rt>` pinyin
   into the selection, so C5a's design replaces it with Pointer Events and `caretRangeFromPoint`. The
   gesture that crashes is the one we do not implement.

**Ruling: the gate is downgraded, not removed.**

- **`core.md` C5b is UNBLOCKED.** It no longer waits on a physical device. Build it.
- **`ios.md` I2 stays, and moves to a pre-TestFlight check** rather than a pre-C5b one. It is minutes
  of work on a real handset and it is still the only way to be certain. Run it before anything reaches
  a tester, not before code is written.
- **Register #1 is downgraded from blocking to verify-before-ship** in STACK §4 and in the
  known-unknowns register.
- **What to actually test when a device exists**, now that the trigger is known: double tap the
  passage, hold, and drag. Also confirm the app is built with Xcode 26. If it somehow crashes anyway,
  the first thing to try is disabling native text interaction on the web view configuration
  (`textInteractionEnabled = NO`), which costs nothing here because the design does not use native
  text interaction.

**Why this was worth resolving rather than assuming.** Assuming it fine and being wrong would not have
cost C5b alone — the fallback in `core.md` R2 is a native reader screen and a Core Text ruby engine,
which is the exact cost choosing Capacitor was meant to avoid. The prior was already that a beta crash
in a property this widely used would have been fixed, but "probably fine" and "read the thread" are
different things, and the thread was three minutes away.

## 10e. `MAX_GLOSS_CANDIDATES` stays at 5,000 — SETTLED 2026-09-15 (raised by the D4 build session)

`data.md` D4's criterion 2 — *"if any interactive query exceeds 50 ms, stop and report rather than
proceeding"* — fired. `search('to')` and `search('the')` measure **89–100 ms** in wasm; every other
interactive call is under 15 ms. D4 correctly declined to pull the one lever that would work, because
the cap is `data.md` **D3's** and D3 requires any change to say what to and why. The session stopped
and asked. This is the answer.

**The cap stays at 5,000.** The trade is not the one it looks like, and the measurement that decides
it was not in either plan. Posting-list sizes over the built artifact, from
`fts5vocab(gloss_fts, 'row')`:

| cap | gloss tokens it binds |
|---|---|
| 5,000 | **8** |
| 3,000 | 14 |
| 2,000 | 26 |
| 1,000 | **52** |

The eight at 5,000 are `to` (31,561), `of` (20,839), `a` (15,969), `in` (13,978), `the` (12,447),
`and` (8,706), `idiom` (5,926), `or` (5,506) — English function words, plus one CC-CEDICT gloss
marker. Nobody searches a Chinese dictionary for "of". The forty-four that a cap of 1,000 would newly
bind are content words a learner actually types: `bird`, `city`, `county`, `china`, `chinese`, `name`,
`specie`, `taiwan`, `district`, `old`, `time`. D3's three stated consequences — a low-frequency
tier-0 match falling outside the cap, a capped `SearchResult.total`, earlier `nextCursor` termination
— are free on `of` and are a worse dictionary on `bird`. **Lowering the cap spends ranking quality on
real searches to buy 50 ms on eight queries nobody makes.**

**5,000 is not arbitrary, and the reason is now written down** — it sits on a natural boundary in this
artifact, between `or` at 5,506 and `for` at 4,918: the last function word and the first content word.
D3 did not record that, so the constant read as a round number somebody picked. It is in
`lib/dict/query/gloss.ts` now.

**The exemption is permanent, not provisional.** D4 pinned the two queries by name in
`tests/e2e/d/dict-wasm.spec.ts` at a 200 ms ceiling, with every *other* interactive query still failing
the suite at 50 ms. That pin stays. It is a measured exemption for two degenerate queries, not a hole.

**The untried lever, named so it is not rediscovered.** D4's own table shows the cost is per-row,
per-column marshalling — rowid-only at `LIMIT 5000` is 10 ms, the full projection 46–51 ms — so a
two-pass query (pass 1 selects only what `glossTier` reads; pass 2 fetches the full projection for the
survivors) would close the breach with **no ranking change at all**. It is unowned and it is **not
obviously a win**: `glosses` is plausibly most of the payload, and if it is, pass 1 costs nearly what
the single pass costs today. Measure it before believing it.

## 10f. The non-CJK headwords `DictStore.search` cannot match — SETTLED 2026-09-16

`data.md` D6 recorded that `readingsOf()` reaches "every row under this simplified headword" through
`DictStore.search`, which routes on `hasCjk()`, so a headword with no CJK goes down the
English/pinyin path and never matches itself exactly. It then did the right thing: closing it needs
a `bySimp`-shaped question on `DictStore`, which `data.md` D1's first commit froze, so the need went
into `HANDOFF.md` and the build continued without it. That routing is correct and stands.

**Two corrections to the entry, and the second one is the finding.** Measured against the built
artifact with the repository's own `CJK_PATTERN` from `lib/dict/rank.ts`, not a regex written for
the occasion:

- **It is 74 entries and 72 distinct headwords, not 274.** The figure does not reproduce under any
  reading — 63 if you require both `simp` and `trad`, 156 if you count headwords merely *containing*
  a non-CJK character. Cite 74.
- **`OK` is not one of them.** CC-CEDICT has no bare `OK` headword; `卡拉OK` has CJK and resolves
  fine, as D6 says. `ACG` and `3Q` are real examples and the entry is right about those.

**What the 72 actually are**, which changes the disposition: acronyms (`ACG`, `VCR`, `PK`, `PUA`),
numerals used as slang (`110`, `119`, `996`, `421`, `88`), Suzhou numerals (`〡`–`〩`), Japanese era
marks (`㍻㍼㍽㍾`), bopomofo (`ㄅㄧㄤˋ`, `ㄏㄤ`), `□` placeholders — **and seven characters in CJK
Unified Ideographs Extension G** (`𰦭` U+309AD, `𰻝` U+30EDD, `𱃲` U+310F2, `𱅒` U+31152, `𱇏` U+311CF,
`𱉝` U+3125D, `𱌶` U+31336).

**The ruling, in two parts.**

1. **The acronyms, numerals and symbols are accepted as lost for v1.** 65-odd headwords out of
   124,188, none of them a word an example sentence leans on, and `readingsOf`'s own doc comment
   already says the `headwords` pool is lossy by design (it skips any headword with more than one
   reading). Adding `headword(simp)` to `DictStore` would unfreeze a surface that two native runners
   nobody has built yet must then implement. **The need stays recorded for whoever unfreezes
   `DictStore` for another reason** — `entries_simp` already indexes it, so it is cheap when the
   surface next opens. It is not worth opening the surface on its own.
2. **The Extension G characters are a different defect and are not accepted.** They are Chinese, and
   they are misrouted because `CJK_PATTERN` covers Ext A, Ext B (U+20000–U+2A6DF), Ext C–F
   (U+2A700–U+2EBEF) and compat, and **has no range for Ext G (U+30000–U+3134F)**. It is not a
   `DictStore` shape question at all, so D6 filed it under a frozen surface it does not belong to.

> **Correction, made the same day by the author of this section.** Two things above were wrong when
> first written, and a third was already known to the repository.
>
> - **It is twelve entries, not seven.** Eleven single-character Ext G headwords plus `𱌶𱌹`. I
>   listed seven codepoints from a truncated read of my own output. Seventeen headwords contain an
>   Ext G character in total; the other five (`土𱇏鱼`, `𬶂𱇏鱼`, `𰻝𰻝面`, `𱉝𫛡`, `𱉵𬸩`) also carry a
>   URO character, so they pass `hasCjk` already and are not affected.
> - **Ext H and Ext I are irrelevant here.** This artifact contains **zero** headwords in either
>   block, so naming them as missing ranges was padding. Ext G is the whole of it.
> - **`lib/dict/rank.ts` already says all of this**, in the doc comment directly above
>   `CJK_PATTERN`: it names the U+2EBEF stop, names Ext G and H as uncovered, counts *twelve*
>   single-character headwords — which is right and my seven was not — and says **"widening it is a
>   behavioural change to segmentation and search routing and is nobody's yet"**. So "a one-line
>   change plus a test" was wrong too. Widening the pattern re-routes any text containing those
>   characters from the English path to the CJK path, which changes segmentation, and it wants
>   `data.md`'s differential oracle run against it rather than a drive-by edit.

**Owner for part 2: a `data.md` phase, not the next passer-by.** The fix is correct in direction and
small in diff, but it is a segmentation change and D1's author was right to flag it as one. Not
urgent, not blocking, and a learner reaching an Ext G character is rare. It is recorded here so the
next session finds the measurement instead of the 274-shaped note.

## 11. `ios.md`'s contested-surfaces table — DELETE IT (issue 4)

`android.md` is correct on all three rows and `ios.md` misquotes it on all three. Verified at HEAD:
android.md already adopts `apps/app/capacitor.config.ts` with `webDir: 'dist'`; A4 says "one file for
two platforms and this phase does not create a second one"; and the filename is `lib/tts/capacitor.ts`
in seven places, not `capacitor-tts.ts`.

`ios.md` §2's table goes, along with I0's acceptance criterion 6, which instructs a builder to edit
three `android.md` lines that say the opposite of what it quotes. `ios.md` adopts android.md's three
answers verbatim. **`android.md` does not change for this issue.** ios.md's unilateral "adopts
android.md's filename, `lib/tts/capacitor-tts.ts`" was the only genuine divergence in the set, and it
was manufactured by the misquote.

---

## What wave 0 actually ships

1. This document.
2. The sixteen rulings applied to the seven sibling documents.
3. The `CLAUDE.md` rewrite in §2.
4. The `lib/db/repository.ts` interface diff in §5, as a types-only commit.
5. `packages/ai/` created and the ten `lib/ai/**` modules moved into it.

Items 4 and 5 touch code, and both must land **before** `web.md` W0's `git mv`, or they will be moving
files that are themselves being moved. If W0 has already run, they land at the post-W0 paths instead.

> **Items 4 and 5 are NOT executable as written.** A verification pass found both underspecified — see
> [README.md](README.md) V5 and V6. Item 4 gives the `Repository` diff as method names with no
> signatures, and one of its types is defined by a phase many waves downstream. Item 5 names ten
> modules to move and none of the 33 files with 74 import sites that would break. Both need a pass
> before a session runs them. Item 3, the `CLAUDE.md` rewrite, is unaffected and is executable.
Nothing else in wave 0 touches code.

After that, the build sequence in [README.md](README.md) is executable as written.

---

## Provenance note — why §10a, §10b and §10c arrived late

The Android session building A0–A3 caught a process failure worth recording, because it is the kind
that repeats.

`claude/build-web-shell` was cut from the planning branch at `d494e88`. Every ruling after that —
§10a (the access gate's prefix match), §10b (V1: C7 is not gated on C5b) and §10c (the two shells and
the Inkstone default) — was committed to the planning branch **only**. Three build sessions were then
briefed with those rulings in their prompts and worked from them correctly, while the binding document
in their own tree ended at row 16e and carried none of them.

`ios.md` I0 reported it first. Nothing landed. `core.md` C0 then implemented §10c in `tokens.css` and
cited it by number, so the repository briefly contained code justified by a ruling the rulings document
did not carry. The Android session reported it again, correctly identified the gate-row rewrite as the
unresolved half of register **V1**, and asked for someone with authority over this file to land both.

Both are now merged into `claude/integration` and reach every branch cut from it afterwards.

**The rule this implies, for whoever orchestrates next:** a ruling is not landed when it is written on
the branch the plans live on. It is landed when it reaches the branch the builders are cutting from.
Relaying a ruling in a session prompt is how you unblock a session today; merging it forward is how the
next session does not have to be told. Do both, in that order, and never only the first.
