# Tangram — the build plan set

These seven documents are the whole brief for rebuilding Tangram on the stack decided in
[`docs/STACK.md`](../STACK.md). One of them is a decision record and six are build plans, one per
deliverable. They were written in parallel by different authors from the same three sources — the
four technology audits of 2026-09-13, the product decisions taken with the owner in the same week,
and [`PLAN.md`](../../PLAN.md), which remains authoritative for the data contract, the schema rules,
the grounding contract and the licence boundary. Read STACK.md before any plan; it says what was
decided and why, and the plans cite it rather than re-arguing it. Each plan then states what exists
in the repo today, what it depends on from its siblings, its phases with executable acceptance
criteria, and its risks. **Do not read any single plan as complete on its own.** The seams between
them are where the work is, and §"Unresolved cross-document issues" below lists the places where the
seams do not currently meet. A human has to settle those before the corresponding phases run; every
one of them names the document and the line that would have to change.

Two facts frame the whole set and are not repeated in each plan: **there are no users and no data**
— schema changes are free and nothing here is a migration plan — and the builder is one person
working with AI assistance.

## The documents

| # | Document | What it is |
|---|---|---|
| 1 | [`../STACK.md`](../STACK.md) | The stack decision record: Capacitor, Vite, SQLite dictionary, the known-unknowns register (#1–#20), the open decisions, the version pins. Supersedes PLAN.md §3. |
| 2 | [`web.md`](web.md) | The web shell: the pnpm workspace, Vite 8 + React Router 8, the service worker, PWA install and `persist()`, the access gate, fonts, the Astro marketing site, the desktop decision. W0–W9. |
| 3 | [`data.md`](data.md) | The dictionary: `pnpm data` emits one read-only SQLite file, the `DictStore`/`SqlRunner` seam, the query layer port, per-platform delivery, retiring `app/api/dict/*`. D1–D6. |
| 4 | [`core.md`](core.md) | The shared UI: design tokens, primitives, per-character ruby, the word and character sheets, drag-select, the speaker, the two shells, and the plain-language relabelling. C0–C9 plus C4a. |
| 5 | [`backend.md`](backend.md) | The server: the AI proxy, the new ask contract, accounts, the sync protocol and its schema corrections, BYOK key custody, limits and operations. B0–B7. |
| 6 | [`ios.md`](ios.md) | The Capacitor iOS app: the shared Capacitor surface, the crash check that the stack decision rests on, the bundled dictionary, native TTS, safe areas, signing, TestFlight, submission. I0–I8. |
| 7 | [`android.md`](android.md) | The Capacitor Android app: the native project, insets and the keyboard, the bundled Chinese font, native TTS and the no-Mandarin-voice question, the WebView floor, the AAB and Play. A0–A8. |

**Read them in that order.** STACK.md first, then the four container-runnable plans in the order
their work lands (web, data, core, backend), then the two hardware-gated ones. A reader who wants
the *product* rather than the build should read `core.md` §1–§2 and the product-decisions file
first; a reader who wants to know what can start today should read `web.md` §4 and `data.md` §4.

## Suggested build sequence

The plans are executable in a valid order — there is no true cycle — but only after the three phase
splits in issue 5 below are actually made in the documents that own them. The waves below assume
they have been.

| Wave | Runs | May run in parallel with |
|---|---|---|
| **0** | The CLAUDE.md rewrite and the settle-first decisions no plan owns (issues 1, 5, 7, 14) | Nothing. One commit, blocking everything. |
| **0b** | The three zero-dependency reading/measurement tasks: `core.md` C0's font-coverage script (register #9), `ios.md` I0's docs read (register #12), `android.md` A0 jobs one and two (registers #12, #15, #16) | Each other, and wave 1. None needs the repo to build. Start the Apple enrolment and the Play registration here — they are the longest non-hardware lead times in the set. |
| **1** | `web.md` **W0** — the `git mv` into `apps/app/` | Nothing. It relocates every path five plans write into. |
| **2** | `web.md` **W1** (atomic, the largest phase) | `data.md` **D1** → **D2** → **D3**. D1's first commit — the frozen `DictStore`/`SqlRunner`/`DictStatus` declarations — must land early in this wave; three plans gate on it. |
| **3** | `core.md` **C0** → **C1** → **C2** → **C3** → **C4** | `web.md` **W2** → **W3** → **W4** (pull W4 forward: the access gate is down from W1 until it lands); `data.md` **D4**; `backend.md` **B0** → **B1**. Three tracks, all container-runnable. |
| **4** | `core.md` **C4a**, then `backend.md` **B2**'s first commit (the frozen contract), then `data.md` **D6** | `web.md` **W5** → **W6**; `backend.md` B2's remainder after C4a and D4. This is the wave that closes the D6/B2 gate; run the two first commits before anything that depends on them. |
| **5** | `core.md` **C5a** (the gallery harness, desktop Chromium) → `ios.md` **I0** → **I1** → **I2** (device) → `core.md` **C5b** → **C6** → **C7** → **C8** | `web.md` **W7**; `backend.md` **B3** → **B4** → **B5**. The reader chain is the critical path and everything on the right of it is independent of the reader. |
| **6** | `ios.md` **I3** (with `data.md` **D5**) → **I4** → **I5** → **I6** → **I7** → **I8** | `android.md` **A1** → **A2** → **A3** → **A4** → **A5** (with D5's Android half) → **A6** → **A6a** → **A7** → **A8**. The two mobile plans are independent of each other after I0 settles the shared surface — **provided issue 3 is fixed.** Start Play's closed test the day A7 produces an AAB; it is a 14-day calendar gate. |
| **7** | `backend.md` **B6** (conditional) → **B7**; `web.md` **W8** → **W9** | `core.md` **C9**, only if the owner chooses the palette after a week of real study. |

Two scheduling notes that are easy to miss. The access gate does not exist between W1 and W4, so no
deployment may be made with `TANGRAM_ACCESS_SECRET` set in that window — or move W4 ahead of W2 and
W3. And every phase from I1 and A1 onward is blocked, not slow, without the hardware in STACK §4's
precondition table; if that hardware is not going to exist, say so and ship the web and desktop
product on its own rather than softening a register check.

---

## Unresolved cross-document issues

In priority order. Each names the documents and the specific text that would have to change. These
are problems that only appear when the seven are read together; each plan is internally coherent.

### 1. Nobody owns the first commit

All six plans gate their first phase on "CLAUDE.md rewritten", and all six assign it to "the
orchestrator". STACK §7 says rewriting it is the first task of the migration. There is no seventh
document and no phase anywhere with that deliverable, its acceptance criteria, or the new
settle-first list it is supposed to contain. The same is true of the workspace/repo-layout decision
(`data.md` §4 dependency 2, `core.md` §4, `web.md` W0 assumes it, `backend.md` §4 item 2). **A build
session starting from this set has nothing to run first.** Give wave 0 an owner and a written
deliverable, or the first phase that runs will be fighting auto-loaded project instructions that
freeze the files it must edit.

### 2. Three plans give three different fates to the same three files

`scripts/smoke.ts`, `lib/server/route-inventory.ts` and `tests/unit/server/routes.test.ts`:

- `data.md` D6's disposition table: **"deleted, not trimmed"**, all three, and acceptance criterion 2
  justifies deleting `route-inventory.ts` outright because it imports `node:fs`.
- `web.md` W2's Files list: `scripts/smoke.ts` **rewritten** and kept as a dependency-free CLI for
  the deploy checklist; `route-inventory.ts` **reduced to what the adapter and the coverage check
  still need**; `routes.test.ts` **rewritten** around the route table and the host config.
- `backend.md` B2: `routes.test.ts` is **"`web.md` W2's file"** — API cases removed, page-coverage
  assertions kept, and deleting a guard this plan does not own "is how a page ships with no smoke
  case".

`web.md` W1's dev/preview API adapter *imports* `discoverApiRoutes()` from `route-inventory.ts`, so
D6's deletion breaks a module W1 depends on and W2 keeps. Settle one fate per file and write it into
all three documents; the risk this guard exists for (a route shipping untraced, found only by a human
opening the page) already fired once.

### 3. Android is transitively blocked on Apple hardware — twice, and `android.md` found only one

`android.md` §4 flags the first: A5 needs `data.md` D5, and D5 opens *"This phase cannot start
without a Mac with Xcode 26, a physical iOS 26 device and at least one Android phone"*, folding
iOS-only registers #20 and #6 into the same session. It asks the orchestrator to split D5 into an
Android-runnable half. **`data.md` has not been split.**

The second is not flagged anywhere. `android.md` A1 gates on `core.md` **C7**. C7 sits after C5 in
core.md's sequence, and `ios.md` I2 states that **no `core.md` C5b production file may land before a
physical iOS 26 device answers register #1**. So the Android app's *first* phase cannot start until
an iPhone has run the WKWebView crash check — which contradicts android.md's premise that its phases
"do not need a Mac" and STACK §4's advice that the two mobile tracks are independent. The fix is
cheap and `ios.md` already models it: I1 explicitly does **not** gate on C7 and puts whatever shell
W1 produced on the device, re-baselining its checklist at C7. Either A1 does the same, or `core.md`
states that C6 and C7 do not depend on C5b.

### 4. `ios.md` §2's "three contested surfaces" table misquotes `android.md` on all three rows

Verified against `android.md` at `HEAD`:

| Row | `ios.md` says `android.md` wants | `android.md` actually says |
|---|---|---|
| Config location | root-level `capacitor.config.ts`, `webDir: 'apps/app/dist'` | §2 line 79: **`apps/app/capacitor.config.ts` with `webDir: 'dist'`** — already ios.md's own recommendation, adopted verbatim, "this plan has no better argument and does not offer one" |
| Number of TTS adapters | **two** | A4: **"This is one file for two platforms and this phase does not create a second one."** ios.md misread "so both adapters agree", which is about the Web Speech and Capacitor adapters sharing the voice predicates |
| Adapter filename | `lib/tts/capacitor-tts.ts` | **`lib/tts/capacitor.ts`**, in seven places (§2, A4, the Files lists, the path note in §5) |

Two consequences. `ios.md` I0's acceptance criterion 6 requires editing three named `android.md`
lines that say the opposite of what ios.md quotes — a build session will go looking for them and not
find them. And ios.md's one unilateral resolution — "this plan adopts `android.md`'s filename,
`lib/tts/capacitor-tts.ts`, unconditionally" — **creates the only genuine divergence in the set**,
because that is not android.md's filename. Pick one spelling, fix it in both files, and delete
ios.md's conflict table; the disagreement it describes was already resolved in android.md's favour
before either document shipped.

### 5. Two phase splits are demanded by one document and absent from the other

Without them, the set has no valid execution order:

- **`core.md` C5a / C5b.** `ios.md` §4.4 requires the drag-select prototype to be a separable
  deliverable — the gallery harness alone, no production reader file touched — because I2 gates C5's
  production code and C5's harness gates I2. `core.md` C5 is one phase whose Files list is the
  production rewrite (`use-span-select.ts`, `hanzi-text.tsx`, `reader-text.tsx`,
  `lib/stores/reader.ts`) with "build the prototype first, in this phase" inside it.
- **`data.md` D5's Android half.** Issue 3 above.

Both are written as "the orchestrator must raise it with the other plan's owner". Nobody has. Note
that the pattern *does* work when both sides state it: `backend.md` B2's first commit versus its
remainder is described identically in `backend.md` §4 and `data.md` D6, and that is what stops the
B2/D6 gate from being a deadlock. Do the same for these two.

### 6. Nobody builds the web delivery of the dictionary artifact

`data.md` D4 requires the `.sqlite` to be served at a content-addressed path with
`Cache-Control: public, max-age=31536000, immutable` and a pre-compressed `.br` under content
negotiation, and says *"`web.md` owns the host; this plan owns the requirement."* `web.md` W2's host
config has exactly three requirements — SPA fallback, the manifest content type, and the three
`/sw.js` headers — and none of them is the dictionary. No `web.md` phase copies
`data/dict-<schema>-<cedict>.sqlite`, `data/dict-manifest.json` or `data/decomp.json` out of the
workspace root into `apps/app/dist/` or onto the host; `decomp.json` appears in `web.md` only in
prose about licences and in W0's list of what `build-data.ts` writes. The web build therefore ends
up with a `DictStore`, an OPFS worker and a `fetch`, and no bytes to fetch. Add the copy step and the
two host rules to a named `web.md` phase (W2 is the natural home), and give `decomp.json` a stated
delivery there too — STACK §2.2 leaves it open and `data.md` D4 only says how it is consumed.

### 7. `lib/db/repository.ts` and `lib/ai/**` are shared surfaces with no owner

`web.md` §2 states it plainly: *"No sibling plan claims it and CLAUDE.md freezes it."* Two plans then
widen the same file independently — `web.md` W5 adds `exportAll`/`importAll` for the local backup,
`backend.md` B5 adds `changedSince`/`applyRemote`/`syncState`/`resetAccount` for sync — and both say
"whichever lands first, the other rebases". `lib/ai/**` is worse: `data.md` D3 creates
`lib/ai/retrieve.ts`, `backend.md` B1 moves all ten existing `lib/ai/**` modules to `packages/ai/**`,
and `backend.md` B2 creates `lib/ai/ask-client.ts` — three plans, no gate between D3 and B1, and no
document states the final layout. Settle both in wave 0: one interface diff for `Repository`, and one
sentence saying which `lib/ai` modules end up in `packages/ai/` and which stay in `apps/app/lib/ai/`.

### 8. Three existing capabilities are dropped without any plan saying so

- **The reader's known / learning / new token colouring, and "Mark known".** `lib/reader/states.ts`
  exports `tokenStates`, consumed by `components/reader/reader-screen.tsx:44`; `reader-lookup.tsx:129`
  is the "Mark known" action that writes `known_words` and recolours immediately. `core.md` C5 deletes
  `reader-text.tsx`, C4 deletes `reader-lookup.tsx` into the word sheet, and the word sheet's stated
  content is "its senses and an Add". `lib/reader/**` is named by **no plan in the set**. This is not
  a minor affordance: PLAN.md §1's loop diagram is *"your known-word set shapes what you see next"*,
  and the coloured passage is the only place a learner sees it. Either `core.md` C4/C5 carries the
  state model and the action onto `<HanziText>` and the word sheet, or a plan says out loud that the
  known-set feedback is being cut.
- **The tangram-pieces session progress.** product-decisions §11: *"The seven tangram pieces are the
  ONE playful element: they fill as a practice session progresses, so a finished day is a finished
  square."* It appears in no phase of any plan. `core.md` C0 lands the palette and C7/C8 land the
  Practice screen; neither mentions it.
- **The in-context gloss on a reader tap.** product-decisions §5: a tap while reading shows the same
  content in a bottom sheet *"plus one line on what the word means in THAT sentence"*. `backend.md`'s
  contract carries `context?` through `/api/ask/propose` and `/api/ask/answer`, so the wire supports
  it, but no plan builds or specifies the line. (The other half of that sentence — the sentence
  travelling onto the card — already exists as `contextFor()` and `core.md` C4 preserves it.)

### 9. List import has no plan

product-decisions §9 specifies it in detail: clipboard (one word per line, hanzi or pinyin), Pleco
tab-separated export, Anki text export, resolution against the dictionary, a preview with unmatched
lines and a reading picker for polyphones, then one bulk add through the existing
`addListMembers(listId, entryIds[])`. All six plans push it out of scope with the same sentence —
*"its own task, per STACK §7"* — and the seventh document that would be that task does not exist.
Either write it or record that v1 ships without it.

### 10. The Practice-queue merge has no phase

product-decisions §1's central claim is that learning new words, recognising them and writing them
become **one** session. That is queue composition — `lib/lists/today.ts`, `lib/lists/introduce.ts`,
`lib/srs/session.ts` — not shared UI. `core.md` §2 flags it as a gap the orchestrator must close
before C7 and §8 says it *"lands here or nowhere"* in `screens/practice.tsx`, but C7 has no criterion
for it, its Files list does not include the three `lib/` modules, and `ios.md` §2 repeats the flag
from its side. Without it, C7 ships a Practice tab that still introduces new words on a different
screen from the one that reviews them, and C8 only relabels it.

### 11. `data/hsk.json` does not exist

`web.md` cites *"11,028 banded headwords in `data/hsk.json`"* twice as fact — W7 and R12 — and STACK
§5.7 says the same. `data.md` §6 checked and states: **"No such file exists."** HSK bands live on
`Entry.hskBand` inside `dict.json`, and after D1 in `entries.hsk_band`. Confirmed against the repo:
`data/` holds `ATTRIBUTION.md`, `COPYING-makemeahanzi`, `decomp.json` and `dict.json`. The fallback
cut that decides STACK §5.7's indexable word pages is currently written against a file nobody
generates. Correct the two `web.md` lines.

### 12. Two edits are handed to `web.md` that `web.md` never accepted, and one blocks a phase

- **`viewport-fit=cover` in `apps/app/index.html`.** Without it every `env(safe-area-inset-*)` is
  zero. `ios.md` I5 checked (`grep -n -i 'viewport-fit' web.md` returns nothing), concluded W1 will
  never carry it, and makes the one-attribute edit itself. `android.md` A2 does the opposite: its
  Files list says *"`apps/app/index.html` is named for `web.md` and not edited here"* and its gate is
  *"`web.md` W1 must have taken the `viewport-fit=cover` edit A2 hands it."* **If A2 runs before I5,
  it is blocked on something that will not happen.**
- **The native gate on `components/pwa/register-sw.tsx`.** Same pattern: `ios.md` I1 makes the edit,
  `android.md` A1 hands it to `web.md` "if I1 has not already made it" and then asserts it anyway.
  `web.md` mentions the file only to change `process.env.NODE_ENV` to `import.meta.env.PROD`.

Both are one line. Put them in `web.md` W1's Files list and delete the hand-off prose from both
mobile plans, or make A2 mirror I5.

### 13. `backend.md` assumes CI that `android.md` proves does not exist

`backend.md` B4's rule for every later migration: *"a new table with no policy is a failed migration,
asserted by a query over `pg_policies` in CI rather than by discipline."* `android.md` states
repeatedly that **there is no `.github/` directory and no sibling plan creates one**, and rewrites two
of its own acceptance criteria (A1's SDK-level assertion, A7's secret grep) as unit tests under
`tests/unit/` for exactly that reason. `web.md` also refers to CI in three places. Either name the
plan and phase that creates CI, or apply android.md's treatment to backend.md's rule.

### 14. The static host for `apps/app` is unowned

`web.md` §4 blocks W2 on it and assigns it to *"orchestrator / `backend.md`"*. `backend.md` B0 chooses
a host for `apps/server` and never mentions a static host for the app. W2 has a documented fallback
(commit `vercel.json` as a placeholder and record it), which is fine — but the fallback should be a
decision, not the default that happens because nobody was asked.

### 15. A privacy policy and a support URL gate two store submissions and nobody writes them

`ios.md` §4.3 and I8 flag it: App Store Connect requires both, `grep -n -i 'privacy policy\|support
URL' web.md core.md` returns nothing, and W7's Astro site at the apex — the only plausible host in
the set — does not mention them. `android.md` A8's Play listing needs a privacy policy URL too, and
its Data safety form needs re-answering the moment `backend.md` lands accounts. Two static pages, an
hour's work, and a blocked submission is a week.

### 16. Smaller inconsistencies, each a one-line fix

- **Two dictionary sizes circulate.** STACK §3 has ~47.2 MB raw / 15.4 MB brotli; `data.md` D1
  measured the schema it actually specifies at **43.1 MB raw / 13.9 MB brotli** and says it supersedes.
  `ios.md` and `android.md` correctly use data.md's derived 63 MB on-device figure with its register-#16
  caveat, but `web.md` W6 and `core.md` R4 still quote "~15 MB brotli". Re-point them at `data.md` D1.
- **`core.md` is the only plan with no post-W0 path note.** `data.md`, `web.md`, `ios.md`,
  `android.md` and `backend.md` all state that every path they write is relative to `apps/app/`.
  `core.md` requires W0 before C0 and then writes `app/globals.css`, `app/layout.tsx` and
  `components/**` throughout — paths that do not exist by the time C0 runs.
- **`core.md` cites a section of `data.md` that does not exist.** Twice, at C4a, for the
  synchronous-`GroundContext.segment` / async-`DictStore` resolution: *"`data.md` §5.7 owns the
  resolution."* `data.md` §3 says explicitly that §5 has six phases and no §5.7, and that the material
  is in **D3**. `backend.md` B2 has it right.
- **`core.md` C2 and `ios.md` §4.3 give different answers to the same gate.** core.md: *"C2 must land
  before any mobile plan starts."* ios.md: *"This plan's reading governs here: I0–I3 consume nothing
  from `TTSProvider` and can run without it."* `android.md` A4 quotes the stricter version. Pick one.
- **The design canvas is a source no build session can open.** product-decisions links it and
  `core.md` §1 points at it as "every screen in this plan on real pixels". `ios.md` I5 hits the
  consequence — whether the tab bar is at the bottom *"is on the design canvas, which a fresh session
  cannot read"* — and converts it into a decision I5 records. No plan owns reconciling the built
  screens against the canvas, and no phase's adversarial review references it. Either extract the
  layout facts the plans depend on into `core.md`, or say the canvas is illustrative and the plans
  govern.

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
