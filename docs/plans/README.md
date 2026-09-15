# Tangram — the build plan set

These eight documents are the whole brief for rebuilding Tangram on the stack decided in
[`docs/STACK.md`](../STACK.md). One is a decision record, one is the orchestrator's rulings, and six
are build plans, one per deliverable. The six plans were written in parallel by different authors
from the same three sources — the four technology audits of 2026-09-13, the product decisions taken
with the owner in the same week, and [`PLAN.md`](../../PLAN.md), which remains authoritative for the
data contract, the schema rules, the grounding contract and the licence boundary. Read STACK.md
before any plan; it says what was decided and why, and the plans cite it rather than re-arguing it.
Then read [`wave-zero.md`](wave-zero.md), which settles the sixteen places where the plans did not
meet. Each plan then states what exists in the repo today, what it depends on from its siblings, its
phases with executable acceptance criteria, and its risks. **Do not read any single plan as complete
on its own.** The seams between them are where the work is, and §"The settled cross-document issues"
below is the register of every seam that was found open, what it was settled as, and where the ruling
lives.

Two facts frame the whole set and are not repeated in each plan: **there are no users and no data**
— schema changes are free and nothing here is a migration plan — and the builder is one person
working with AI assistance.

## The documents

| # | Document | What it is |
|---|---|---|
| 0 | [`wave-zero.md`](wave-zero.md) | The orchestrator's rulings: the sixteen cross-document issues below, settled and binding; the `CLAUDE.md` rewrite specification; the repository layout; the two shared-surface decisions. Binding on all seven siblings where it and a plan disagree. |
| 1 | [`../STACK.md`](../STACK.md) | The stack decision record: Capacitor, Vite, SQLite dictionary, the known-unknowns register (#1–#20), the open decisions, the version pins. Supersedes PLAN.md §3. |
| 2 | [`web.md`](web.md) | The web shell: the pnpm workspace, Vite 8 + React Router 8, the service worker, PWA install and `persist()`, the access gate, fonts, dictionary delivery and the host, the Astro marketing site, the desktop decision. W0–W9. |
| 3 | [`data.md`](data.md) | The dictionary: `pnpm data` emits one read-only SQLite file, the `DictStore`/`SqlRunner` seam, the query layer port, per-platform delivery, retiring `app/api/dict/*`. D1–D4, D5a, D5b, D6. |
| 4 | [`core.md`](core.md) | The shared UI: design tokens, primitives, per-character ruby, the word and character sheets, drag-select, the speaker, the two shells, the merged practice queue, and the plain-language relabelling. C0–C4, C4a, C5a, C5b, C6–C9. |
| 5 | [`backend.md`](backend.md) | The server: the AI proxy, the new ask contract, accounts, the sync protocol and its schema corrections, BYOK key custody, limits and operations. B0–B7. |
| 6 | [`ios.md`](ios.md) | The Capacitor iOS app: the shared Capacitor surface, the crash check that the stack decision rests on, the bundled dictionary, native TTS, safe areas, signing, TestFlight, submission. I0–I8. |
| 7 | [`android.md`](android.md) | The Capacitor Android app: the native project, insets and the keyboard, the bundled Chinese font, native TTS and the no-Mandarin-voice question, the WebView floor, the AAB and Play. A0–A8. |

**Read them in that order.** STACK.md first, then `wave-zero.md`, then the four container-runnable
plans in the order their work lands (web, data, core, backend), then the two hardware-gated ones. A
reader who wants the *product* rather than the build should read `core.md` §1–§2 and the
product-decisions file first; a reader who wants to know what can start today should read `web.md` §4
and `data.md` §4.

## Suggested build sequence

The two phase splits the set needed — `core.md` C5a/C5b and `data.md` D5a/D5b — have been made in the
documents that own them, and `android.md` A1 no longer gates on `core.md` C7.

**Superseded 2026-09-14 by `wave-zero.md` §10b: the two mobile tracks ARE independent once
`android.md`'s gates name artifacts rather than phase ranges.** The paragraph below records why they
were not, and stands until that edit lands in `android.md`.

**The two mobile tracks are NOT independent, and an earlier version of this paragraph said they were.**
Freeing A1 freed only Android's first phase. A2 still gates on `core.md` C7, A4 on C6, and A6 on
C3–C6 — and that range contains **C5b**, which `core.md` hard-gates on `ios.md` I2 running on a
physical iOS 26 device. So A2, A4, A6, A7 and A8 all still route through Apple hardware. Treat the
Android track as blocked behind the iPhone from A2 onward until issue V1 in the verification register
below is settled. Scheduling it as unblocked is the single most expensive mistake available in this
document.

| Wave | Runs | May run in parallel with |
|---|---|---|
| **0** | [`wave-zero.md`](wave-zero.md)'s five deliverables: **(1)** the rulings document itself; **(2)** the sixteen rulings applied to the seven sibling documents; **(3)** the `CLAUDE.md` rewrite specified in its §2; **(4)** the `lib/db/repository.ts` interface diff in its §5, as a types-only commit, frozen after; **(5)** `packages/ai/` created and the ten existing `lib/ai/**` modules moved into it. | Nothing. Blocking everything. Deliverables 4 and 5 touch code and must land **before** `web.md` W0's `git mv`, or they move files that are themselves being moved. |
| **0b** | The three zero-dependency reading/measurement tasks: `core.md` C0's font-coverage script (register #9), `ios.md` I0's docs read (register #12), `android.md` A0 jobs one and two (registers #12, #15, #16) | Each other, and wave 1. None needs the repo to build. Start the Apple enrolment and the Play registration here — they are the longest non-hardware lead times in the set. |
| **1** | `web.md` **W0** — the `git mv` into `apps/app/` | Nothing. It relocates every path five plans write into. |
| **2** | `web.md` **W1** (atomic, the largest phase) | `data.md` **D1** → **D2** → **D3**. D1's first commit — the frozen `DictStore`/`SqlRunner`/`DictStatus` declarations — must land early in this wave; three plans gate on it. D3 writes `retrieve.ts` into the `packages/ai/` that wave 0 already created, so there is no gate between it and `backend.md` B1. |
| **3** | `core.md` **C0** → **C1** → **C2** → **C3** → **C4** | `web.md` **W2** → **W3** → **W4** (pull W4 forward: the access gate is down from W1 until it lands); `data.md` **D4**; `backend.md` **B0** → **B1**. Three tracks, all container-runnable. W2 now also carries the dictionary's web delivery, so it needs D1's artifact to exist. |
| **4** | `core.md` **C4a**, then `backend.md` **B2**'s first commit (the frozen contract), then `data.md` **D6** | `web.md` **W5** → **W6**; `backend.md` B2's remainder after C4a and D4. This is the wave that closes the D6/B2 gate; run the two first commits before anything that depends on them. |
| **5** | `core.md` **C5a** (the gallery harness, desktop Chromium) → `ios.md` **I0** → **I1** → **I2** (device) → `core.md` **C5b** → **C6** → **C7** → **C8** | `web.md` **W7**; `backend.md` **B3** → **B4** → **B5**; `android.md` **A1** as soon as I0 has landed the shared Capacitor surface — A1 boots whatever shell W1 produced and re-baselines its checklist at C7, so it does not wait for the reader chain. The reader chain is the critical path and everything on the right of it is independent of the reader. |
| **6** | `ios.md` **I3** (with `data.md` **D5b** — one device session, both documents open) → **I4** → **I5** → **I6** → **I7** → **I8** | `android.md` **A2** → **A3** → **A4** → **A5** (with `data.md` **D5a**, whose only hardware precondition is an Android phone) → **A6** → **A6a** → **A7** → **A8**. The two mobile plans are independent of each other after I0 settles the shared surface. Start Play's closed test the day A7 produces an AAB; it is a 14-day calendar gate. |
| **7** | `backend.md` **B6** (conditional) → **B7**; `web.md` **W8** → **W9** | `core.md` **C9**, only if the owner chooses the palette after a week of real study. |

Two scheduling notes that are easy to miss. The access gate does not exist between W1 and W4, so no
deployment may be made with `TANGRAM_ACCESS_SECRET` set in that window — or move W4 ahead of W2 and
W3. And every phase from I1 and A1 onward is blocked, not slow, without the hardware in STACK §4's
precondition table; if that hardware is not going to exist, say so and ship the web and desktop
product on its own rather than softening a register check.

---

## The settled cross-document issues

Sixteen issues were found by reading the seven plans together; each plan was internally coherent and
none of these was visible from inside one document. Two were blocking: nobody owned the first commit,
and the set as written had no valid execution order. **All sixteen are settled by
[`wave-zero.md`](wave-zero.md)** and the rulings have been applied to the plans that own them. The
statements are kept below so the audit trail survives — these were real, and one of them had already
fired in production once.

### 1. Nobody owns the first commit

All six plans gated their first phase on "CLAUDE.md rewritten", assigned it to "the orchestrator", and
no document contained it, its acceptance criteria or the settle-first list it was meant to carry. The
same was true of the workspace/repo-layout decision.

**Settled — wave-zero.md §1 and §2.** `wave-zero.md` is the missing owner and is itself wave 0's first
deliverable. §2 specifies the `CLAUDE.md` rewrite in six required parts, including the replacement for
the frozen-file rule — *a shared surface is frozen by a types-only first commit in the plan that owns
it, and every other plan gates on that commit rather than on the phase* — and the settle-first list
that replaces the stale hand-written one. §1 confirms the single pnpm workspace that `web.md` W0
executes, with `data/` and `scripts/` staying at the repo root because three deployables consume
`pnpm data`'s output.

### 2. Three plans give three different fates to the same three files

`scripts/smoke.ts`, `lib/server/route-inventory.ts` and `tests/unit/server/routes.test.ts`: `data.md`
D6 deleted all three, `web.md` W2 rewrote or reduced all three, and `backend.md` B2 called
`routes.test.ts` W2's file. `web.md` W1's dev/preview API adapter imports `discoverApiRoutes()` from
`route-inventory.ts`, so D6's deletion broke a module W1 depends on.

**Settled — wave-zero.md §3.** `web.md` W2 owns the final form of all three and its disposition
stands. `data.md` D6 removes only the `/api/dict/*` **entries** from them and loses the `node:fs`
justification for deleting `route-inventory.ts`. `backend.md` B2 was already correct and does not
change.

### 3. Android is transitively blocked on Apple hardware — twice, and `android.md` found only one

`android.md` A5 needed `data.md` D5, whose precondition demanded a Mac, an iOS device and an Android
phone in one session. Unflagged anywhere: `android.md` A1 gated on `core.md` C7, which sits behind
C5b, which `ios.md` I2 forbids landing before a physical iOS 26 device answers register #1 — putting
Android's first phase behind an iPhone.

**Settled — wave-zero.md §4.** `data.md` D5 is split into **D5a** (the Android-runnable half; its
precondition is an Android phone) and **D5b** (the iOS-only work, keeping the Mac-and-iPhone
precondition); A5 gates on D5a only. And `android.md` **A1 does not gate on `core.md` C7** — it boots
whatever shell `web.md` W1 produced and re-baselines its checklist at C7, exactly as `ios.md` I1
already does.

### 4. `ios.md` §2's "three contested surfaces" table misquotes `android.md` on all three rows

Config location, number of TTS adapters, adapter filename — `android.md` at `HEAD` already said what
`ios.md` recommended in all three cases, and `ios.md`'s unilateral adoption of
`lib/tts/capacitor-tts.ts` created the only genuine divergence in the set out of the misquote.

**Settled — wave-zero.md §11.** `ios.md` §2's table is deleted, along with I0's acceptance criterion 6,
which instructed a builder to edit three `android.md` lines that say the opposite of what it quoted.
`ios.md` adopts `android.md`'s three answers verbatim: `apps/app/capacitor.config.ts` with
`webDir: 'dist'`, one TTS adapter for two platforms, and the filename `lib/tts/capacitor.ts`.
**`android.md` does not change for this issue.**

### 5. Two phase splits are demanded by one document and absent from the other

`ios.md` §4.4 required `core.md` C5's drag-select harness to be separable from its production rewrite,
or I2 and C5 deadlock. `android.md` §4 required `data.md` D5's Android half. Both were written as "the
orchestrator must raise it"; nobody had.

**Settled — wave-zero.md §4.** Both splits are real phases now. **C5a** is the drag-select gallery
harness alone, desktop Chromium, touching no production reader file; **C5b** is the production rewrite
(`use-span-select.ts`, `hanzi-text.tsx`, `reader-text.tsx`, `lib/stores/reader.ts`). **D5a** and
**D5b** are as in issue 3. Each half carries its own builds, Files list and acceptance criteria.

### 6. Nobody builds the web delivery of the dictionary artifact

`data.md` D4 stated the requirement — content-addressed path, immutable caching, pre-compressed `.br`
under content negotiation — and correctly said `web.md` owned the host. No `web.md` phase copied
`data/dict-<schema>-<cedict>.sqlite`, `data/dict-manifest.json` or `data/decomp.json` into the app's
build output, so the web build ended up with a `DictStore`, an OPFS worker and no bytes to fetch.

**Settled — wave-zero.md §6.** `web.md` **W2** gains the copy step in its Files list and acceptance
criteria, plus the two host rules — `Cache-Control: public, max-age=31536000, immutable` on the
content-addressed path, and the `.br` under content negotiation. `decomp.json` gets a stated delivery
in the same phase.

### 7. `lib/db/repository.ts` and `lib/ai/**` are shared surfaces with no owner

`web.md` W5 and `backend.md` B5 each widened `Repository` independently, both saying "whichever lands
first, the other rebases". `lib/ai/**` was worse: `data.md` D3 created `lib/ai/retrieve.ts`,
`backend.md` B1 moved all ten existing modules to `packages/ai/**`, and B2 created
`lib/ai/ask-client.ts` — three plans, no gate between D3 and B1, no stated final layout.

**Settled — wave-zero.md §5.** `lib/db/repository.ts` gets **one** interface diff, landed in wave 0 as
a types-only commit and frozen after, carrying both plans' additions at once: `exportAll()` /
`importAll(payload)` (W5) and `changedSince(ms)` / `applyRemote(changes)` / `syncState()` /
`setSyncState(s)` / `resetAccount()` (B5). Both plans drop the rebase prose and gate on the commit.
`packages/ai/` is created in wave 0 and the ten `lib/ai/**` modules move there in the same commit —
not in B1, which loses the move and keeps the rest of its phase. `packages/ai/` holds the provider
contract, grounding, prompts, the cache key and D3's `retrieve.ts`; `apps/app/lib/ai/` holds only
`ask-client.ts`.

### 8. Three existing capabilities are dropped without any plan saying so

The reader's known / learning / new token colouring and its "Mark known" action; the tangram-pieces
session progress; the in-context gloss on a reader tap. None of the three was a decision to cut — they
fell between plans, and `lib/reader/**` was named by no plan in the set.

**Settled — wave-zero.md §7. All three reinstated.** `lib/reader/**` belongs to `core.md`: C4 and C5b
carry `tokenStates` onto `<HanziText>` and "Mark known" into the word sheet, each with its own
acceptance criterion, because PLAN.md §1's loop is *your known-word set shapes what you see next* and
the coloured passage is the only place a learner sees it. The tangram-pieces progress is `core.md`
**C8**. The in-context gloss is `core.md` **C4**, consuming the `context?` field `backend.md`'s
contract already carries.

### 9. List import has no plan

product-decisions §9 specifies it in detail — clipboard, Pleco, Anki, resolution, preview, bulk add —
and all six plans pushed it out of scope with the same sentence, *"its own task, per STACK §7"*, to a
seventh document that did not exist.

**Settled — wave-zero.md §8. Deferred, on the record.** v1 ships without it. The repository already
has `addListMembers(listId, entryIds[])`, so it is a clean later addition rather than a hole. Every
plan's "its own task" sentence stays; STACK §6 records that the task is deliberately not scheduled for
v1 rather than merely unwritten.

### 10. The Practice-queue merge has no phase

product-decisions §1's central claim is that learning new words, recognising them and writing them
become **one** session. That is queue composition, not shared UI. `core.md` §2 flagged it as a gap and
§8 said it *"lands here or nowhere"*, but C7 had no criterion for it and its Files list did not include
the three `lib/` modules.

**Settled — wave-zero.md §9.** `core.md` **C7** gains `lib/lists/today.ts`, `lib/lists/introduce.ts`
and `lib/srs/session.ts` in its Files list, and an acceptance criterion that one session serves new
words, recognition and writing from one queue.

### 11. `data/hsk.json` does not exist

`web.md` cited *"11,028 banded headwords in `data/hsk.json`"* twice as fact — W7 and R12 — and STACK
§5.7 said the same. `data.md` §6 had checked: no such file. `data/` holds `ATTRIBUTION.md`,
`COPYING-makemeahanzi`, `decomp.json` and `dict.json`.

**Settled — wave-zero.md §10, row 11.** HSK bands live on `Entry.hskBand`, and after D1 in
`entries.hsk_band`. Corrected in `web.md` W7 and R12 and in STACK §5.7.

### 12. Two edits are handed to `web.md` that `web.md` never accepted, and one blocks a phase

`viewport-fit=cover` in `apps/app/index.html`, without which every `env(safe-area-inset-*)` is zero:
`ios.md` I5 made the edit itself, `android.md` A2 handed it to `web.md` and gated on it — so A2 before
I5 was blocked on something that would not happen. Same pattern for the native gate on
`components/pwa/register-sw.tsx`.

**Settled — wave-zero.md §10, row 12.** Both go in `web.md` **W1**'s Files list. The hand-off prose is
deleted from `ios.md` I5 and `android.md` A1/A2.

### 13. `backend.md` assumes CI that `android.md` proves does not exist

`backend.md` B4 asserted its every-table-has-a-policy rule "by a query over `pg_policies` in CI";
`android.md` states repeatedly that there is no `.github/` directory and no sibling plan creates one,
and had already rewritten two of its own criteria as unit tests for that reason. `web.md` referred to
CI in three places.

**Settled — wave-zero.md §10, row 13.** There is no CI and v1 does not create one. B4's `pg_policies`
rule becomes a unit test under `tests/unit/`, and `web.md`'s three CI references get the same
treatment. Recorded as an open item in STACK §5.9 rather than silently dropped.

### 14. The static host for `apps/app` is unowned

`web.md` §4 blocked W2 on it and assigned it to "orchestrator / `backend.md`"; `backend.md` B0 chose a
host for `apps/server` and never mentioned a static host for the app. W2 had a fallback, which is fine
— but a fallback should be a decision, not the default that happens because nobody was asked.

**Settled — wave-zero.md §10, row 14.** The static host is **Vercel**, the same account as the existing
deployment described in `docs/deploy.md`. Recorded in `web.md` W2 and STACK §5.8.

### 15. A privacy policy and a support URL gate two store submissions and nobody writes them

App Store Connect requires both and Play's listing requires the privacy policy URL; `grep` over
`web.md` and `core.md` returned nothing, and W7's Astro site did not mention them. Two static pages, an
hour's work, and a blocked submission is a week.

**Settled — wave-zero.md §10, row 15.** `web.md` **W7** owns a privacy policy page and a support page
on the Astro site, with their exact URLs recorded for `ios.md` I8 and `android.md` A8 to cite.

### 16. Smaller inconsistencies, each a one-line fix

- **Two dictionary sizes circulate.** STACK §3 had ~47.2 MB raw / 15.4 MB brotli; `data.md` D1 measured
  the schema it actually specifies at 43.1 MB / 13.9 MB. **Settled — §10, row 16a: D1's measurement
  supersedes**, corrected in STACK §3, `web.md` W6 and `core.md` R4.
- **`core.md` is the only plan with no post-W0 path note.** **Settled — §10, row 16b:** `core.md` gains
  the note every other plan has — every path it writes is relative to `apps/app/`.
- **`core.md` cites a section of `data.md` that does not exist**, twice at C4a: "`data.md` §5.7 owns the
  resolution". **Settled — §10, row 16c: both citations become D3.**
- **`core.md` C2 and `ios.md` §4.3 give different answers to the same gate.** **Settled — §10, row 16d:
  `ios.md`'s reading governs.** I0–I3 consume nothing from `TTSProvider` and can run without C2;
  `core.md` C2's "must land before any mobile plan starts" is wrong and is corrected, and `android.md`
  A4 no longer quotes it — C2 gates A4 and nothing earlier.
- **The design canvas is a source no build session can open.** **Settled — §10, row 16e: the canvas is
  illustrative and the plans govern.** `core.md` §1 extracts the layout facts its phases depend on into
  its own text, so no phase depends on a source a build session cannot read.

---

## What was checked and found consistent

So the absence of a finding below is a statement rather than a gap in the reading.

- **The two gate cycles are broken identically on both sides.** `backend.md` B2's first commit (the
  frozen contract) versus its remainder, and `data.md` D6's gate on that commit rather than the phase,
  are described the same way in both documents. So is `data.md` D1's first commit — types only, frozen
  from then on — which `core.md` §4 and `ios.md` §4.3 both cite correctly as the thing they wait on.
- **`X-Tangram-Access`** is named identically in `web.md` W4 and `backend.md` §3/B1, including the
  symbol-by-symbol disposition of `lib/server/access.ts`, the deletion of `readCookie`, and the CORS
  preflight requirement that both plans separately insist on testing.
- **The 63 MB on-device dictionary budget** propagates correctly from `data.md` D5 into `ios.md` I3 and
  `android.md` A3/A5, with the register-#16 caveat on the packaged half intact in all three.
- **The licence boundary** — `decomp.json` never merged into the SQLite artifact, SQLCipher's BSD
  notice added, attribution rendered in `/settings` and on the device — is carried consistently by
  `data.md` D1/D5, `core.md` C4, `ios.md` I3, `android.md` A5/A8 and `backend.md`'s `AskCacheRow` rule.
- **What "tested" means on native** is settled the same way by both mobile plans: automated tests stay
  web-only, every native phase ends in a written manual device checklist, and both say so out loud
  rather than implying coverage that does not exist.
- **The audio tiers** agree across STACK §5.3, `android.md` A4's three-outcome table for register #7,
  `ios.md` §7 and `core.md` §7, including the escalation path if tier 3 becomes v1 scope and the
  licence question that must be answered before a tier-2 vendor is chosen.
- **"No users, no data"** holds in all seven documents; no plan contains a migration plan, and
  `backend.md` §7 ends by saying a document containing the word has misread it.
- **PLAN.md's existing capabilities** all have a home except the three in issue 8: spaced repetition
  (`core.md` C8 relabels, changes nothing about FSRS), grounded AI answers (`backend.md` B2 +
  `core.md` C7), the reader (`core.md` C3–C5, folded into Look up by C7), lists (`core.md` C7/C8),
  stats (`core.md` C8), the optimizer (`core.md` C8, hidden below 1,000 scorable reviews),
  text-to-speech (`core.md` C2/C6 + both mobile plans' adapters) and the service worker (`web.md` W3).

---

## What a build session does first

Before touching anything:

1. **Read [`../STACK.md`](../STACK.md).** It is the decision record. It says what was decided and why,
   and no plan re-argues it.
2. **Read [`wave-zero.md`](wave-zero.md).** It is the orchestrator's rulings, and it is **binding**:
   where it and a plan disagree, the ruling governs and the plan is stale. It also carries the two
   things that live nowhere else — the `CLAUDE.md` rewrite specification and the two shared-surface
   decisions.
3. **Read your own plan in full**, including its §4 dependency table, before running its first phase.
   The rulings have already been applied to it, so it should agree with wave-zero.md; if it does not,
   follow wave-zero.md and write the discrepancy into `HANDOFF.md`.

`CLAUDE.md` is auto-loaded and, until wave 0's deliverable 3 lands, still describes a Next.js app with
a frozen-file list written for a repo layout that no longer exists. A session that starts before that
rewrite will be fighting project instructions that freeze the files it must edit. Check whether wave 0
has landed before assuming otherwise.

---

## Verification register — open after the wave-zero pass

A verifier re-read all nine documents after the rulings were applied, walked each ruling on both
sides, and rebuilt the dependency graph. **The seams did not fully close.** These are open. They are
numbered V1–V8 so they do not collide with the settled register above.

| # | Finding | Blocks |
|---|---|---|
| **V1** | **SETTLED 2026-09-14 — see `wave-zero.md` §10b.** C7 is not gated on C5b; `core.md` §4 governs and this document's wave table was wrong. Android's A2/A4/A6 name the artifacts they need instead of phase ranges. Original finding: **the Android track is still behind Apple hardware from A2 onward.** Ruling 4 freed A1 only. `android.md` A2 gates on `core.md` C7, A4 on C6, A6 on C3–C6; that range contains C5b, which gates on `ios.md` I2 on a physical iOS 26 device. There is also an unreconciled disagreement about C7 itself: `core.md` §4 says register #1 gates "before C5b, and before nothing else here", while this document's wave 5 and `core.md` §8 both put C7 after C5b. **Cheapest close:** decide whether C7 may land before C5b, then rewrite A2/A4/A6's gate rows to name the specific artifacts they need — the `TabBar` primitive and the shell's inset variable, `lib/tts/sequence.ts`, the engine-feature list — instead of phase ranges that sweep C5b in. | the whole Android track |
| **V2** | Ruling 9 landed on `core.md` and, until it was patched by hand, not on `ios.md`, whose scope table still called the Practice-queue merge unassigned — and `core.md` cited that stale row back as evidence the gap was real. Patched in both. Re-check that no third document repeats it. | nothing now |
| **V3** | **Phase ids that dangle after the two splits.** `D5` is cited in `STACK.md` (twice) and this document (twice); the 63 MB budget now lives in D5a. `C5` is cited ten times in `android.md` — A6's entire floor argument rests on "reading C5" and "C5's committed degrade", which are now C5a — and twice in `ios.md`. A6's acceptance criterion 3 names a spec id that no longer exists. | A6, and anyone reading the budget |
| **V4** | **SETTLED 2026-09-14 — see `wave-zero.md` §10b ruling 4.** C0 follows W0. Original finding: **wave 0b contradicts `core.md` §4.** This document schedules `core.md` C0's font-coverage script in parallel with `web.md` W0, on the grounds that it needs no repo build. `core.md` requires the `git mv` before C0, and C0's prerequisite is a `package.json` + `pnpm-lock.yaml` edit — the same two files W0 is splitting into a root and an app manifest. Same shape, milder, for `ios.md` I0, which hard-gates on W0. | wave 0b as written |
| **V5** | **SETTLED 2026-09-15 — see `wave-zero.md` §5, "The declarations themselves".** The exact declarations are now in the ruling, `SyncedStore` is derived from `StoreName` in the wave-0 commit rather than by B4, and four sub-rulings (generic store parameters, the derived union, `ask_cache` in `Snapshot` but not in sync, `resetAccount` tombstones rather than drops) are recorded. Deliverable 4 is a transcription. Original finding: **wave 0's deliverable 4 is not executable from `wave-zero.md` alone.** The `Repository` diff is given as method names and callers with no signatures; the actual declarations live in `web.md` and `backend.md`. Worse, `backend.md` types the sync members against `SyncedStore`, defined by B4, many waves later — so wave 0 is asked to freeze a signature whose type is defined downstream, and no document says so. | wave 0 deliverable 4 |
| **V6** | **Wave 0's deliverable 5 names ten modules to move and zero importers.** Moving `lib/ai/**` to `packages/ai/` touches **33 files with 74 import sites** across the API routes, the lookup and review components, the dev seed, and sixteen test files. No document lists them or says they change in the same commit. Two further unstated points: the move lands before W0 creates `pnpm-workspace.yaml`, so `packages/` is briefly a bare directory reachable only through the `@/*` mapping; and `package.json` is on the current frozen list that deliverable 3 is meant to relax first. | wave 0 deliverable 5 |
| **V7** | Stale line-number cross-references created by the parallel edits: `backend.md` cites `core.md:191` twice and `data.md:145`; `data.md` cites `core.md` line 184 twice and `backend.md:180`. All point at prose that moved. Prefer section and phase ids over line numbers. | nothing, but it misleads |
| **V8** | Two of `data.md`'s "the other document is wrong" notes are now themselves wrong, because the document they corrected has since been corrected. | nothing, but it misleads |

**What this means for scheduling.** Wave 1 — `web.md` **W0**, the workspace move — is unaffected by
every finding above. It gates on nothing, nothing in it was touched by the rulings, and every other
plan waits on it. It is the only phase in the set that is unambiguously ready to build right now.
Everything else should wait on V1 and V4 at minimum, both of which need a human decision about
whether `core.md` C7 may land before C5b.
