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
