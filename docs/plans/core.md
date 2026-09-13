# Tangram — build plan: the shared UI core

**Status:** plan, written 2026-09-13. Sibling plans: [`data.md`](data.md), [`web.md`](web.md),
[`ios.md`](ios.md), [`android.md`](android.md), [`backend.md`](backend.md).

**Read first:** [`docs/STACK.md`](../STACK.md) is the decision record this plan is built on and it is
not re-argued here — where this plan says "because §2.1", go and read §2.1. [`PLAN.md`](../../PLAN.md)
remains authoritative for the data contract (§3.1), the schema (§3.3) and the grounding contract
(§3.4). The product decisions taken with the owner supersede PLAN.md's UI wherever they conflict, and
the design canvas showing every screen in this plan on real pixels is linked from
product-decisions §10.

Two facts frame everything below and are not repeated: **there are no users and no data** (schema
changes are free; nothing here is a migration plan), and the builder is **one person with AI
assistance**.

---

## 1. Goal

When this plan is done there is one React component layer, built on a token layer that encodes the
settled visual language, that renders identically inside a phone three-tab shell and a wide-screen
shell — and every surface that shows Chinese does the three live-hanzi things Pleco does: pinyin
above every character, every character tappable down to its decomposition, and every block speakable
including a hold-to-slow character-by-character mode. The UI contains no spaced-repetition jargon:
two verbs, a shelf, Today as a sentence, and four grade buttons a beginner can read. None of that is
true now — the app is seven Next routes of token-granular text with no ruby anywhere, a
fire-and-forget speaker button, and a jade-and-white token set that is not the settled palette.

## 2. Scope boundaries

**This plan owns:**

- The design token layer and its migration out of the current `app/globals.css`, including the type
  stack and the font-coverage check that decides it.
- `components/ui/**` — the primitives, extended with the ones the new screens need.
- The two shells and the rule that the screens inside them are identical, plus the mechanical check
  that enforces the rule.
- The live-hanzi primitives: per-character ruby, the word sheet and the character sheet, the
  hand-rolled drag-to-select-a-span interaction, and the speaker control with hold-to-slow.
- The `TTSProvider` interface (a settle-first shared surface, STACK §7) and its **web** adapter.
- The relabelling work: the two-verb information architecture, Today as a sentence, the four renamed
  grade buttons, plain-language stats, the learner level, hiding the optimizer.
- **Re-pointing every existing consumer of `lib/dict/client.ts` at `data.md`'s `DictStore` /
  `DecompStore`** (C4a). `data.md` §3 names the seven modules and `data.md` D6 is gated on this plan
  having done it.
- **Drawing the dictionary's four states** — `absent`, `preparing` (determinate), `ready`, `failed` —
  and the first-launch copy progress with its low-storage failure path (C4a). `data.md` D4/D5 own the
  *state model*; three sibling plans (`data.md` D4/D5, `ios.md` I3, `android.md` A5) say this plan
  owns the *screens*, and `ios.md` records that none of them exist in any screen today.
- **The ask panel's three answer states** (product-decisions §5): thinking, no-AI-reachable, and
  nothing-verifiable (C7).
- The disposition of every existing file under `components/` — the table is §8, one row per file.

**This plan does not own, and must not start:**

| Not here | Owner | Why the seam is where it is |
|---|---|---|
| The SQLite dictionary, the `DictStore` **interface and implementations**, the status *model*, moving `lib/dict/pinyin.ts` and the segmenter DP to the client, the `pnpm data` artifact path | `data.md` | Every hanzi component takes data as props or through `DictStore`; none of them opens a database. C4a re-points the callers and draws the states; it does not implement the store. |
| The Vite + React Router migration, the build, the service worker, PWA install and `persist()`, the Astro marketing site, **web font delivery** (`unicode-range` subsets, first-load budget) | `web.md` | This plan names the font families and the coverage requirement; how bytes reach a browser is a build decision. |
| Capacitor projects, the **native** TTS adapters, safe-area insets, fonts inside the app package, every device-only register check | `ios.md`, `android.md` | This plan widens `TTSProvider`; the mobile plans implement it against `@capacitor-community/text-to-speech`. |
| The server, accounts, sync, BYOK key custody, the new `/api/ask` request contract | `backend.md` (it exists — `docs/plans/backend.md`) | The ask panel's three answer states are **built here, in C7**, against the client-side ask module. The wire contract behind it is `backend.md` B2's settle-first surface; `backend.md` §2 says every screen, including its own sign-in screen, is this plan's. |
| List import (clipboard / Pleco / Anki) | its own task, per STACK §7 | Scoped separately by product-decisions §9. |

**One gap the orchestrator has to close before C7.** product-decisions §1 merges new-word
introduction into a single Practice session. That is queue *composition* — `lib/lists/today.ts`,
`lib/lists/introduce.ts`, `lib/srs/session.ts` — not shared UI, and **no sibling plan names it**
(`ios.md` §2 flags the same gap from its side). This plan relabels and re-homes the existing review
session; it does not merge the queues. **C7 is the deadline, not C8**: C7 is the phase that builds the
Practice tab, and its criterion that a screen renders identically in both shells says nothing about
whether that screen is one session or two. Without the merge, C7 ships a Practice tab that still
introduces new words on a different screen from the one that reviews them, and C8 only relabels it.

## 3. What exists today

Read at `HEAD` of `claude/apps-ui-design-791zpq`.

**Tokens.** `app/globals.css` is `@import "tailwindcss"` plus ten CSS custom properties on `:root`
(`--background: #fbfaf7`, `--surface: #ffffff`, `--foreground: #1a1917`, `--muted: #6d6a63`,
`--border: #e7e3dc`, `--accent: #0f766e`, `--accent-soft: #d7ece8`, `--accent-foreground`,
`--warning: #92400e`, `--warning-soft: #fdf0d5`), a `@media (prefers-color-scheme: dark)` block that
redefines all ten, a `@theme inline` block mapping each to a Tailwind 4 `--color-*`, two font stacks
(`--font-sans` system UI, `--font-hanzi` "Noto Serif SC" first with system CJK fallbacks — **no font
file is bundled; every stack is a system-font gamble today**), a `body` rule, a `.hanzi` utility
(serif CJK stack, `line-height: 1.35`, `letter-spacing: 0.01em`) and a `:focus-visible` outline. One
accent, jade. There is **no** vermillion, no gold, no radius scale, no spacing scale, no
`data-theme` attribute, and no explicit-choice theme override — dark is `prefers-color-scheme` only.
`components/stats/chart-tokens.tsx` already documents that the UI palette fails data-viz gates and
carries its own chart palette.

**Primitives.** Exactly four, all thin and all sound: `components/ui/button.tsx` (variants
`primary | secondary | ghost`, sizes `sm | md | lg`), `card.tsx` (a `<section>` with an optional
title/aside header), `badge.tsx` (tones `neutral | accent | warning`), `input.tsx`. `lib/cn.ts` is
the one class joiner (clsx). There is no sheet, no tab bar, no chip, no field, no empty state, no
dialog.

**Shell.** `components/shell/nav.ts` declares **seven** routes (`/`, `/lookup`, `/review`, `/read`,
`/lists`, `/stats`, `/settings`) and is read by the nav, the smoke spec and the phase notes.
`site-header.tsx` is a wrapping header row; `nav-link.tsx` uses `next/link` + `usePathname`;
`page-header.tsx` is one h1 plus a line; `data-banner.tsx` HEADs `/api/dict/hsk?band=1` and shows a
warning strip on 503; `test-hooks.tsx` exposes the repository on `window.__tangram` for e2e.
`app/layout.tsx` composes them and sets `<html lang="en">`. **Every navigational component imports
`next/*`** — eight files, ten import lines outside `app/api/**`, which `web.md` W1 counts as nine
files and eleven sites over the whole tree — but that is a statement about `HEAD`, not about what
this plan does: `web.md` W1 owns the whole `next/*` swap and §4 requires it before C1, so by the time
any phase here writes a component the imports are already React Router's.

**Screens.** `components/` holds **47 files**; §8 dispositions every one of them.
`app/(today)/today-view.tsx` renders **two** number tiles (`today-due-count` at line 105,
`today-new-count` at line 112) plus a direction split line at line 119 that is rendered **only when
`split.production > 0`** — the shape product-decisions §2 explicitly rejects.
`components/lookup/**` (5 files; `ask-panel.tsx` is 813 lines and already implements the grounded
answer, `entry-detail.tsx` the reading picker and Add, `lookup-panel.tsx` is a frozen file),
`components/review/**` (**9** files; `grade-bar.tsx` renders `Again · Hard · Good · Easy` from
`GradeOption.label`, already a 2-col grid on phones, already carrying the **real** previewed
interval from `fsrs.repeat()`), `components/reader/**` (6 files), `components/lists/**` (7 files),
`components/stats/**` (7 files, four panels), `components/shell/**` (6 files),
`components/ui/**` (4 files), `components/settings/optimizer-panel.tsx` (414 lines),
`components/tts/speak-button.tsx`, `components/pwa/register-sw.tsx`.

**The dictionary's data source, today.** Seven modules read the dictionary over HTTP through
`lib/dict/client.ts` (`fetchEntries`/`fetchEntriesResponse`, `fetchSearch`, `fetchSegment`,
`fetchDecomp`, `fetchHskResponse`): `components/lookup/lookup-view.tsx`,
`components/lookup/entry-detail.tsx`, `components/lookup/ask-panel.tsx`,
`components/reader/reader-lookup.tsx`, `components/review/example-sentences.tsx`,
`lib/stores/reader.ts` (line 23, `fetchSegment`) and `lib/lists/entry-source.ts`. That is `data.md`
§3's list verbatim, and `data.md` D6 will not delete the routes until this plan has re-pointed all
seven. C4a is that work.

**The reader, precisely — this is what C3–C5 replace.** `components/reader/reader-text.tsx` renders
one `<button data-token-index>` per **word** token, with a single delegated `onClick` on the
container (deliberate: a 2,000-character text is ~1,300 tokens). Tokens whose `kind` is not `'word'`
— punctuation, Latin runs, whitespace — render as `<span data-testid="reader-text-run">` with **no
index at all** and are never tapped or coloured (lines 55–78). `lib/stores/reader.ts` models a span
as `selected` / `spanEnd` **token** indexes, with `extend()` growing it by whole adjacent word tokens
and `spanOf()` slicing the body by token boundaries. Selection is therefore token-granular in both
the DOM and the store, and product rules 1–2 make both character-granular: this is a rewrite of the
data model, not an addition to it (STACK §2.1). C5 has to say what happens to the untappable runs,
because in a character-index model every character in the body has an index whether or not it is
Chinese.

**Hanzi rendering.** `grep -rn 'ruby\|<rt'` over the repo returns **nothing**. Pinyin is almost
everywhere a whole-word string from `Entry.pinyinMarked`, produced by `toMarked()` in
`lib/dict/pinyin.ts`, which runs syllables together with orthographic apostrophes (`Xi1 an1` →
`Xī'ān`). The one exception, and the closest prior art to rule 1, is
`components/review/example-sentences.tsx` lines 345–367: it already renders **per-token** hanzi in a
`flex-col` with `token.pinyin` in a `text-xs` span *underneath* each token, and already carries a
polyphone hint. Rule 1 rewrites that from token granularity to character granularity and moves the
reading above — it is not new plumbing.

**There is no function that aligns syllables to characters**, which is exactly what per-character
ruby needs. `markSyllable()` (one numbered syllable → one marked syllable) is exported and is the
building block; `isNumberedSyllable()` at `lib/dict/pinyin.ts:76` is **declared without `export`** and
is module-private today. `Entry.pinyinNum` (`lib/types.ts:27`) is space-separated (`da3 suan4`) and
also carries `·`, `,`, Latin runs (`3C`, `OK`) and CC-CEDICT's `xx5` no-known-reading placeholder,
for which `UNKNOWN_SYLLABLE` and `hasUnknownReading()` already exist (`pinyin.ts:68`, `:71`) and
`markSyllable()` deliberately returns the empty string.

**TTS.** `lib/tts/provider.ts` is three members — `readonly name`, `available(): Promise<boolean>`,
`speak(text, {lang?, rate?}): Promise<void>` — and its own header says `speak` resolves once the
utterance is *queued*. No `stop()`, no utterance identity, no events.
`lib/tts/speech-synthesis.ts` is a careful Web Speech implementation (voice ranking, Cantonese
refused, `voiceschanged` with a 500 ms timeout, `cancel()` before every `speak`).
`components/tts/speak-button.tsx` renders pending / ready / unavailable and calls `speak(text, {rate:
0.9})`. Nothing can stop, sequence or track speech.

**Settings.** `SettingsRow` in `lib/db/schema.ts` has `spineStartBand: 3` in `DEFAULT_SETTINGS`, no
pinyin-visibility field, and `getSettings()` merges defaults under the stored row so a new optional
field needs no Dexie version bump. `lib/srs/card.ts` holds `RATING_LABELS = {1:'Again', 2:'Hard',
3:'Good', 4:'Easy'}`, consumed by `gradeOptions()` in `lib/srs/session.ts` and by
`components/review/recall-input.tsx`.

**Tests.** `tests/unit/**` (vitest, jsdom) mirrors `lib/` and has a `tts/` and a `reader/` directory
already. `tests/e2e/**` is **29 files** in per-phase directories `p1`–`p6` **and `a`, `b`, `c`, `d`**,
plus top-level `full-loop`, `integration` and `smoke` specs. **22 of the 29 navigate to a route by
path** (`page.goto('/…')`) — that is the number C7 has to migrate, and it includes `full-loop`,
`integration`, `smoke`, `p1/lookup`, `p2/review`, `p3/{lists,seed,today}`, `p4/ask`, `p5/reader`,
`p6/{tts,pwa}`, `a/examples`, `b/{production,recall}`, `c/{phrase-front,stats,sw-version}` and three
helper modules. Playwright drives the container's Chromium at `/opt/pw-browsers/chromium`.

## 4. Dependencies

| Needs | From | State it must be in |
|---|---|---|
| CLAUDE.md rewritten | orchestrator, per STACK §7 | **Before C0.** It is the first commit of the migration, not a phase. The frozen surfaces this plan actually edits — unfreeze exactly these — are `app/globals.css` (C0), `app/layout.tsx` (C0 rule 2 changes `<html lang="en">`), `components/ui/**` (C0, C1), `lib/db/schema.ts` (C3 adds `pinyinDisplay`; C8 changes `DEFAULT_SETTINGS.spineStartBand`), `eslint.config.mjs` (C7's `no-restricted-imports` rule — CLAUDE.md's frozen list ends with the configs) and `components/lookup/lookup-panel.tsx` (C3 switches its `hanzi` headword at line 67 to `<HanziText>`). **`lib/types.ts` is not on that list**: the alignment work reads `Entry.pinyinNum`, which already exists at line 27, and no phase here changes the `Entry` shape. (`data.md` D1 does need `lib/types.ts` unfrozen, for its own reasons.) |
| Vite + React Router 8 skeleton building and serving | `web.md`, its first phase | **Before C1.** C0 is CSS and a script and can land under either build. Everything from C1 on writes components that must not import `next/*`, and the gallery route in C1 needs a router. |
| Repo/workspace layout decided | orchestrator, STACK §7 | Before C0 — it decides whether these paths gain an `src/` or a package prefix. This plan writes today's paths and expects `web.md` to relocate them once, mechanically. |
| `DictStore` / `DecompStore` interfaces and the `DictStatus` union, **frozen** | `data.md`, **the first commit of D1** | Before C4. `data.md` §4 says explicitly that these land as D1's first commit and are frozen from then on, and that this plan "may code against `DictStore` from that commit, with the in-Node implementation from D2/D3 as its test double". C4 needs the signature, not the SQLite file; **C4a needs the frozen `DictStatus` union**, because it draws its four states. Until D1's first commit, components may read through today's `lib/dict/client.ts`. |
| `decomp.json` delivery decided | `data.md` (STACK §2.2 leaves it open) | Before C4 ships. The character sheet is the only consumer. |
| A `DictStore` test double runnable in the container | `data.md` D2/D3 (in-Node SQLite) | Before C4a's e2e specs. C4a's `preparing` / `failed` / `absent` fixtures need a store whose status can be driven from a test; if D2/D3 have not landed, C4a builds against a hand-written fake that implements the same frozen interface and the real one is swapped in later. |
| The ask/answer request contract | `backend.md`, **the first commit of B2** | Before C7's three answer states are *wired*, not before they are *drawn*. The states are reachability and grounding facts — thinking, unreachable, nothing-verifiable — so C7 designs and tests them against a client-side ask module whose shape C7 defines (§C7); B2 fills in the wire format. |
| Nothing from `ios.md` / `android.md` | — | This whole plan runs in the Linux container against desktop Chromium. That is deliberate: STACK §4 says everything web and desktop proceeds without hardware, and **the mobile plans depend on this one**, not the other way round. |
| A cmap parser and the candidate font binaries | C0 adds them; see C0 | **Before C0's script runs.** Neither exists in this container today: `fc-list` shows no Noto Serif SC, Noto Sans SC, Newsreader or DM Sans (the only CJK faces installed are WenQuanYi Zen Hei and IPA Gothic), `package.json` has no font-parsing dependency, and `python3 -c "import fontTools"` fails. C0 must acquire both, and that is a `package.json` edit. |

The one hard ordering constraint inside this plan: **C2 (`TTSProvider`) must land before any mobile
plan starts**, because two adapters implement it and STACK §7 lists it as settle-first.

## 5. Phases

Every phase ends the way PLAN.md §4 says, in full: **`pnpm lint`, `pnpm test`, `pnpm build`, the
phase's e2e specs green; an adversarial review panel of three lenses — correctness, data integrity,
and UX-as-Kirby-would-use-it with screenshots from the e2e specs — whose confirmed findings are fixed
before the phase commits; a commit.** `pnpm build` is not ceremony here: today it is `pnpm data:ensure
&& next build && pnpm sw`, and it is the step that catches a token stylesheet that compiles under dev
and fails Tailwind's production pass, which C0 can do. `web.md` W1 redefines what `pnpm build` runs
once the Vite skeleton lands; the gate is whatever `pnpm build` means at that commit, and it stays in
the gate.

Each phase below adds acceptance criteria that are executable or observable. Where a criterion is a
*measurement nobody has taken*, it says so and names the number to record rather than pretending a
threshold was validated.

There are eleven phases: C0–C9 plus **C4a**, which sits between C4 and C5. C4a is lettered rather than
numbered because `ios.md`, `android.md` and `data.md` all cite this plan's phases by name and
renumbering would silently invalidate their dependency tables.

---

### C0 — The token layer, and the font question it depends on

**Builds.** The settled visual language (product-decisions §11) as a two-tier token system, plus the
one script that decides the hanzi stack.

Tier 1 is raw palette values; tier 2 is semantic tokens that components use. Components never
reference tier 1 and never write a hex. The tiers exist so the dark variant and the (open, §5.1)
dark palette shell are a token swap rather than a second design.

Semantic tokens to define, with the settled light values:

| Token | Light value | Role |
|---|---|---|
| `--paper` | `#f8f4ec` | page ground |
| `--surface` | `#fffdf9` | cards |
| `--ink` | `#1c1a17` | body text |
| `--muted` | `#7a7469` | secondary text |
| `--border` | `#e0d8ca` | the 1px card border — cards use borders, not shadows |
| `--practice` / `--practice-soft` | `#b93a26` / **open, see below** | vermillion; Practice and the **single** primary action |
| `--lookup` / `--lookup-soft` | `#0f766e` / `#d9ece6` | jade; Look up and "learning" states |
| `--new` / `--new-soft` | `#8a6414` / `#f3ead3` | gold; "new" |
| `--radius-sm/md/lg` | 12 / 16 / 24 px | product-decisions §11 gives the 12–24 range |

**`--practice-soft` is the one settled-palette gap and it is the owner's call, not the builder's.**
product-decisions §11 gives a soft tint for jade (`#d9ece6`) and gold (`#f3ead3`) and none for
vermillion. C0 must land *a* value, because the token is referenced and the first acceptance criterion
requires every semantic token to be defined on bare `:root`. The constraint, so the choice is not
arbitrary: it is a chip/badge **background** carrying `--ink` text, so it must clear WCAG AA against
`--ink` at that role and sit at the same lightness distance from `#b93a26` that `#d9ece6` sits from
`#0f766e`. The builder proposes one value that satisfies the constraint, renders it in C1's gallery
next to the other two chips, and the owner confirms or replaces it in C0's UX review. Record the
decision in `HANDOFF.md`.

Type: `--font-display` Newsreader, `--font-ui` DM Sans, `--font-hanzi` Noto Serif SC — each with a
real fallback stack, because until `web.md` and the mobile plans ship font files these are all
system-font gambles and the app must still look deliberate.

**Three structural rules, not styling opinions.**

1. Theme has **three** states, not two. Define the complete light palette on bare `:root`; redefine
   only the changed tokens under `@media (prefers-color-scheme: dark)` guarded as
   `:root:not([data-theme="light"])`; redefine them again under `:root[data-theme="dark"]`. Today's
   stylesheet has no explicit-choice path at all.

   **Say precisely what "light as the default" means, because the two readings conflict.** With
   `data-theme` unset — the state every first-time visitor is in — the rules above render *dark* on a
   dark-preferring device. That is correct and intended: an unset `data-theme` means "follow the
   system", which is the web's own default and what the current stylesheet already does. STACK §5.1's
   "ship light as the default" is a recommendation about **the command-palette shell's chrome** (§5.1
   is the open decision "does the palette wear light or dark"), not an instruction to ignore
   `prefers-color-scheme`. So: the app follows the system when unset; the *palette's* own default is
   light; the token layer makes either a swap. Write that sentence into the stylesheet's header, and
   test the unset case as a fifth combination, because it is the default and the four-combination
   spec never exercises it.
2. `lang="zh-Hans"` goes on the root element and a `lang` attribute goes on every hanzi run. Han
   unification means a device in a Japanese locale renders Japanese glyph forms without it, and an
   Android WebView regression in builds 139–140 stopped synthesising CJK bold without it (STACK
   §2.1, register #8). This costs nothing now and is unfixable later by CSS alone.
3. The chart palette in `components/stats/chart-tokens.tsx` stays a separate palette and is
   re-derived from the new accents, not from the old jade. Do not merge it into the UI tokens; the
   file's own header explains why.

**The font-coverage check** (register #9, and STACK §4 says run it first because it needs no
hardware). A script that extracts the distinct character set from the `simp` and `trad` headwords of
`data/dict.json` and reports coverage against the cmap of each candidate face and weight. Slim Noto
subsets are 0.7–1.4 MB and the audit's expectation is that they will **not** cover 124k CC-CEDICT
headwords; full SC faces are 4.5–9 MB *per weight*. The result decides `--font-hanzi` and is an
input to `web.md`'s first-load budget and to both mobile plans' package size.

**Two prerequisites the script does not have, and must acquire in this phase.** Neither exists in
this container — verified, not assumed: `fc-list : family file` shows no Noto Serif SC, Noto Sans SC,
Newsreader or DM Sans (the installed CJK faces are WenQuanYi Zen Hei and IPA Gothic, neither of them
a candidate); `package.json` has no font-parsing dependency; `python3 -c "import fontTools"` fails.

1. **The font binaries.** Get them from the upstream release the licence names, vendor them under a
   gitignored `vendor/fonts/<family>/` with the release tag and URL recorded in `HANDOFF.md`, and
   commit the family's licence file next to them the way `data/COPYING-makemeahanzi` is committed.
   Noto and the two Latin families are SIL OFL; the OFL requires the licence to travel with the
   binaries, so this is a shipping requirement, not tidiness. A fetch script (`pnpm font:fetch`) is
   preferable to committing megabytes; either way the coverage script must fail with a clear message
   when a candidate binary is absent rather than silently reporting zero coverage.
2. **A cmap parser.** This is a dependency add and the plan says so rather than pretending otherwise:
   `fontkit` or `opentype.js` under `devDependencies` (the script is build-time only; nothing ships
   it). `pnpm-lock.yaml` changes, which CLAUDE.md's rewritten frozen-file rule must permit for this
   one phase. If a Python path is preferred, `fonttools` is the equivalent and the same statement
   applies. Pin the exact version in `docs/data-sources.md` alongside the other pins.

**The decision rule, because "100% coverage" is not one.** The audit *expects* the slim subsets to
fall short, so a script that exits non-zero below 100% would be a permanently failing command with no
guidance in it. What the script actually reports, and what the phase decides on:

- per-face coverage of the headword character set, with the uncovered count and a sample;
- the **union coverage of each declared fallback stack** as a whole — a face that misses 400 rare
  characters is fine if the next face in `--font-hanzi` has them, and that is the number that decides
  whether a reader sees tofu;
- for the uncovered residue of the chosen stack, each character's **frequency rank** from the jieba
  frequency already carried in `dict.json`, because 400 uncovered hapax legomena and 400 uncovered
  HSK-1 characters are different facts.

The script exits non-zero when the **stack** leaves characters uncovered; per-face shortfalls are
reported, not failed.

**Files.** `app/globals.css` (split into a tokens block and a base block; `web.md` relocates the
file once). `app/layout.tsx` (rule 2's `lang`). `components/stats/chart-tokens.tsx`. New:
`scripts/font-coverage.ts`, optionally `scripts/font-fetch.ts`, and `pnpm font:coverage` /
`pnpm font:fetch` scripts. `package.json` + `pnpm-lock.yaml` (the cmap parser).
`docs/data-sources.md` (the pin). `components/ui/**` only where a hardcoded colour has to become a
token.

**Acceptance criteria.**

- `pnpm font:coverage` prints per-face coverage, per-stack union coverage, and the uncovered residue
  with frequency ranks; it exits non-zero only when a declared stack leaves a character uncovered.
  Its full output is pasted into `HANDOFF.md`. **This is the phase's headline deliverable** — the
  number is currently unknown and three plans need it — and it is not reachable until the two
  prerequisites above are done, so do them first.
- **The values are the point, so assert the values.** `tests/unit/ui/tokens.test.ts` asserts the
  computed light-theme value of every semantic token against product-decisions §11's hexes
  (`--paper: #f8f4ec`, `--surface: #fffdf9`, `--ink: #1c1a17`, `--muted: #7a7469`,
  `--border: #e0d8ca`, `--practice: #b93a26`, `--lookup: #0f766e`, `--lookup-soft: #d9ece6`,
  `--new: #8a6414`, `--new-soft: #f3ead3`). Without this, a stylesheet that ships the old jade
  palette passes every structural check.
- The same test asserts the structure: every semantic token is defined on bare `:root`; every token
  redefined in the dark blocks also exists in the light block; both a `prefers-color-scheme` block
  and a `[data-theme="dark"]` block exist and define the same token set.
- **The tiering is enforced, not just described.** The test asserts that every `--color-*` mapping in
  `@theme inline` resolves to a tier-2 semantic token, and that no tier-1 palette variable is
  referenced anywhere outside the tokens block. This is the criterion that discriminates: it fails on
  a component reaching past the semantic tier, which is R8's actual failure mode.
- `grep -rnE '#[0-9a-fA-F]{3,8}' components/ | grep -v chart-tokens` returns nothing. **Note that this
  already returns nothing at `HEAD`** — no component hardcodes a hex today. It is a regression guard
  worth keeping and it is *not* evidence that C0 happened; the two criteria above are.
- Toggling `document.documentElement.dataset.theme` between `light` and `dark` in a Playwright spec
  changes the computed `background-color` of `body` in both directions, under both
  `prefers-color-scheme` emulations — **and a fifth case with `data-theme` unset under each
  emulation**, asserting the app follows the system, which is the default state and the one rule 1
  had to disambiguate.
- Existing e2e specs still pass. The screens look different; nothing is broken.

---

### C1 — Primitives and a gallery to review them in

**Builds.** The component set the new screens need, and the surface on which every later phase is
reviewed.

Keep and retune: `Button` (add a `grade` shape — a two-line, auto-height button, since the grade bar
already builds one by hand with `h-auto flex-col`), `Card` (border, not shadow; the new radii),
`Badge`, `Input`. Add: `Sheet` (bottom sheet on phones, side panel at wide widths — the reader tap,
the word sheet and the character sheet all need it, and there is no dialog primitive today),
`TabBar` (the phone shell's three tabs, thumb-reachable, safe-area aware), `Chip` (the "AI" and
"Dictionary only — offline" chips product-decisions §5 requires), `Field` (label + control + help +
error), `EmptyState`, `Skeleton`.

**A gallery route** at `/gallery`, listing every primitive in every variant, both themes, at both
breakpoints. It is not decoration: it is what makes each later phase reviewable without driving the
whole app, and it is where the adversarial review looks first. Alongside the primitives it carries
the **composite states that are otherwise only reachable by breaking something**, and those are named
here so no later phase can quietly skip them:

- the dictionary's four states from `data.md`'s `DictStatus` union — `absent`, `preparing` with a
  determinate bar driven by `received`/`total`, `ready`, and `failed` with each of its four `reason`
  values — plus the native first-launch copy progress and its low-storage failure screen (C4a builds
  the real screens; C1 builds them as gallery entries against a stubbed status);
- the ask panel's three answer states from product-decisions §5 — thinking (dictionary card present
  and addable), no-AI-reachable (the quiet "Dictionary only — offline" chip), and nothing-verifiable
  (C7 builds the real ones).

**Excluding it from production is decided here, not delegated.** `web.md` never mentions a gallery,
and `web.md` W2 builds `pnpm smoke` to request *every* entry in `src/routes.tsx` and to **fail when a
route is added with no case** — so a route that must exist in the e2e build and not in production is
exactly the case that machinery is built to reject. The mechanism: the gallery's route entry is added
to `src/routes.tsx` inside an `import.meta.env.DEV` guard (Vite statically replaces it, so the whole
subtree tree-shakes out of a production bundle), and `pnpm e2e` runs against a dev-mode server or a
build with `--mode development`, whichever `web.md` W1 settles. Write the exemption into `HANDOFF.md`
as a thing `web.md` W2 must honour: `pnpm smoke` derives its cases from the production route table,
which by construction has no `/gallery` in it, so there is nothing to exempt — but W2 must not "fix"
the missing case by adding one.

**Files.** `components/ui/{button,card,badge,input,sheet,tab-bar,chip,field,empty-state,skeleton}.tsx`,
`components/gallery/**`, one route module (dev-guarded).

**Acceptance criteria.**

- Playwright spec `tests/e2e/core/gallery.spec.ts` loads `/gallery` at 390×844 and 1280×800, in both
  themes, and screenshots each section. **No horizontal scroll at 390px** (assert
  `document.documentElement.scrollWidth <= clientWidth`) and a side gutter of at least 16px.
- **A production build serves no `/gallery`**: build with the production mode `web.md` uses, serve
  `dist/`, request `/gallery`, and assert it does not render the gallery — and assert no gallery
  module name appears in the built asset manifest. The negative case has to be tested or the guard
  rots.
- The gallery renders all four `DictStatus` states and all three ask states, each with a stable test
  id, so C4a's and C7's specs can be written against the same ids.
- Every interactive primitive is reachable by Tab and shows the `:focus-visible` ring; a spec walks
  the gallery with keyboard only and asserts focus never lands on something invisible.
- `Sheet` traps focus while open, closes on Escape and on backdrop press, restores focus to the
  opener, and sets `aria-modal`. Unit-tested in `tests/unit/ui/sheet.test.tsx`.
- Unit tests cover each variant map exactly as `button.tsx`'s current shape allows (render, assert
  the class contract), so a later refactor cannot silently drop a variant.

---

### C2 — `TTSProvider`, widened; and the block speaker

**Builds.** The shared audio seam, before anything else uses it. STACK §2.1 is blunt that the audits
called this "one adapter" and were describing the shape, not the interface.

`lib/tts/provider.ts` gains, at minimum:

- `stop(): void` — nothing can cancel speech today except the implicit `cancel()` inside `speak`.
- **Utterance identity**: `speak()` returns a handle (or takes an id), so a per-character sequence
  started at C6 can be cancelled mid-flight without cancelling something newer.
- An **event surface**: subscribe to `start` / `end` / `boundary` per utterance, where `boundary`
  carries character offsets. The native plugin forwards `onRangeStart` (`AVSpeechSynthesizer`'s
  `willSpeakRangeOfSpeechString`; Android's `UtteranceProgressListener.onRangeStart`, API 26+).
- `voices()` / a voice preference, so tier 2 (cloud voice) and the mobile plugin can expose choices
  without a second interface.

**State the fallback in the interface's own documentation**, because two of the three engines cannot
be relied on for boundaries: WebKit's Web Speech boundary events are unreliable, and
`window.speechSynthesis` is reported **undefined** in the Android WebView (register #19 — the issue
id came from a search snippet and is a five-second check on a device). The rule, identical on native
and web: **when boundary events are absent, drive the highlight off per-character utterance
`start`** — one utterance per character. Encode that as a capability flag on the provider
(`supportsBoundary: boolean`) so consumers branch on a declared capability rather than on a
`typeof`.

Also in this phase: `SpeakButton` v2 — one speaker per hanzi **block** (headword, phrase, example,
card face), per product rule 3, not one per character. Tap plays, tap again stops. The pending /
ready / unavailable triad and its visible reason survive verbatim; they are the only states this
container can observe and the reason they are visible text rather than a `title` is written in the
current file's header.

**Files.** `lib/tts/provider.ts`, `lib/tts/speech-synthesis.ts`, new `lib/tts/sequence.ts` (the
per-character queue, used at C6), `components/tts/speak-button.tsx`,
`tests/unit/tts/**`.

**Acceptance criteria.**

- `tests/unit/tts/provider.test.ts` drives a fake provider through: speak → stop → speak, asserting
  the first utterance is cancelled and the second is not; two overlapping sequences, asserting
  cancelling the older does not stop the newer.
- The Web Speech adapter's existing behaviour is unchanged where it was right: voice ranking,
  Cantonese refusal, the memoised `voiceschanged` wait. Its existing unit tests pass unmodified or
  the diff explains each change.
- With `supportsBoundary: false` injected, `lib/tts/sequence.ts` still produces one highlight
  transition per character (from `start` events) — unit-tested with a fake clock, no audio.
- An e2e spec asserts the disabled state and its visible reason in headless Chromium, which has no
  voices. This is the only audio assertion this container can make and it stays.
- `HANDOFF.md` records the final interface verbatim, because `ios.md` and `android.md` implement it.

---

### C3 — Per-character ruby, and the alignment nobody has written

**Builds.** `<HanziText>`, the component every Chinese run in the app renders through, and the
alignment function it needs.

**The alignment is the hard part and it is not in the audits.** `Entry.pinyinNum` is a space-
separated syllable list; the app has `markSyllable()` for one syllable and `toMarked()` for a whole
word, and **nothing that maps syllable *k* to character *k***. The naive zip is right most of the
time and wrong in ways a learner cannot detect:

- Latin runs — `AA制`, `3C`, `卡拉OK` — where one token spans several characters or none.
- CC-CEDICT's `·` (name separator) and `,` (proverb clause separator) tokens, which are punctuation
  in the reading and either absent from or present in the headword.
- Erhua `r5`, which is a syllable and also a character (儿) — sometimes both, sometimes not.
- **CC-CEDICT's `xx5` no-known-reading placeholder** (々, ㍻, 込). This is the one hazard that produces
  a *silently empty* annotation rather than a visibly wrong one, and it is the one a count check
  cannot catch: `xx5` is a syllable, so a one-character headword with reading `xx5` zips perfectly,
  reports `mode: 'aligned'`, and renders a character under a blank `<rt>`. `markSyllable()` returns
  the empty string for it deliberately — its comment says rendering it as "xx" "would put a fake
  pinyin under a headword" — and `hasUnknownReading()` at `lib/dict/pinyin.ts:71` already detects it,
  including the partially-unknown case where only some syllables are `xx5`.
- Any entry where the syllable count simply does not equal the character count.

So: `lib/hanzi/align.ts` exports `alignReading(headword, pinyinNum) → { chars: {char, syllable?}[],
mode: 'aligned' | 'fallback' }`. It aligns greedily character-by-syllable, skipping punctuation
tokens, and **when counts disagree it returns `mode: 'fallback'`** and the caller renders one ruby
annotation over the whole run (`<ruby>打算<rt>dǎsuàn</rt></ruby>`) rather than guessing. A wrong
per-character reading is worse than a correct word-level one.

**`hasUnknownReading()` true forces `mode: 'fallback'` before the count check runs, and the fallback
for this case renders no `<rt>` at all** — not an empty one. An empty annotation reserves the ruby
band and teaches nothing; no annotation says honestly that the dictionary has no reading. That
applies to partial unknowns too: one `xx5` among four real syllables still means the entry cannot be
aligned character-by-character with any confidence.

**Two constraints on how the readings are derived, both easy to violate by accident.** First,
`isNumberedSyllable()` is `function isNumberedSyllable(...)` at `lib/dict/pinyin.ts:76` with **no
`export`** — it is used only inside that module. C3 exports it. That is a one-line change to a file
`data.md` §5 D2 explicitly calls "**unchanged**", so agree the export with `data.md` before making it
and note it in `HANDOFF.md`; the change is additive and does not touch the module's purity, which is
the property D2 cares about. Second, **`pinyin-pro@^3.29.3` is an installed runtime dependency
(`package.json`) whose whole purpose is hanzi→pinyin per character, and it is deliberately unused at
runtime.** `HANDOFF.md`'s "Derived pinyin" section records the decision — `lib/dict/pinyin.ts` is
hand-rolled so the same code runs in the build, the server and the browser — and PLAN.md §3.4's
grounding contract requires every rendered reading to come from the cited entry, not from a second
dataset that might disagree with it. Today `pinyin-pro` is referenced only by
`tests/unit/deps.test.ts`. Per-character readings come from the entry's own `pinyinNum`. Do not reach
for the library; a fresh session that greps for a solution will find it in `dependencies` and this
sentence is the reason not to use it.

`<HanziText>` then renders **one `<ruby>` element per character** — mono-ruby, `ruby-position:
over`. Per-character pairs are one glyph wide, so they wrap naturally in any Chromium version
(AUDIT 2 states this without qualification). **The WebKit half carries a floor:** unprefixed
`ruby-position` shipped in Safari **18.2** (AUDIT 1; STACK §6's floors table), and `ios.md` register
#12 records that Capacitor 8's stated iOS 15 minimum is itself a search-snippet fact. The practical
risk is cosmetic — `over` is the engine default for horizontal text, so an engine that ignores the
declaration lays it out the same way — but the floor should be written down rather than rediscovered.
Hand the "do we also emit `-webkit-ruby-position`" question to `ios.md` alongside its
deployment-target decision in register #12; do not add the prefix speculatively.

`rt { user-select: none }` so a copy excludes the pinyin. **This is sourced for WebKit only** —
AUDIT 1 says WebKit stopped copying `user-select: none` content in Safari 16.4 (bug 80159) and STACK
§6 records it as a WebKit floor. **No audit establishes Blink's behaviour**, and Blink is what this
container tests. The criterion below therefore records what Chromium does rather than asserting an
outcome.

Each character carries `data-char-index`; the container keeps **one delegated handler**, as
`reader-text.tsx` does today, because a pasted passage is hundreds of characters and a handler per
character is hundreds of closures per recolour.

**Pinyin visibility becomes a setting**, and the middle state needs specifying because it collides
with rule 2. `SettingsRow.pinyinDisplay: 'always' | 'tap' | 'never'`, default `'always'`
(product-decisions §4 rule 1; the learner is a beginner). Optional field, merged by `getSettings()`,
**no Dexie version bump** — `STORES_V1.settings` indexes `id` only. The one exception the product
states: it never hides pinyin on a practice card's **answer** side, so the component takes an explicit
`force` prop the card back sets.

`'tap'` — "Only when I tap" — has to coexist with rule 2, where a tap on a word opens the word sheet.
One tap cannot mean both. The resolution, and it is a decision this plan makes rather than an open
question: **`'tap'` reveals the reading for the tapped word's characters and opens the sheet in the
same gesture.** The sheet is where the learner reads the entry anyway, and it always shows the
reading; revealing the ruby underneath it means that when the sheet closes, the word the learner just
looked at keeps its pinyin. Concretely:

- default state: no `<rt>` is rendered anywhere, and the ruby band is **not** reserved (no layout
  shift on reveal — this is why it must be specified now: reserving the band changes the line box);
- one tap on a word: the sheet opens (rule 2, unchanged) **and** that word's characters gain their
  `<rt>`, persisted for the life of the rendered passage, not to the database;
- a second tap on a character inside it: the character sheet opens (rule 2, unchanged) — the reveal
  has already happened and does not re-fire;
- what dismisses it: nothing per-word. The revealed set clears when the passage unmounts or the
  learner navigates away. There is no "hide it again" gesture, because a learner who wants pinyin
  gone has the `'never'` setting.

Layout-shift-free reveal is the constraint that makes this cheap: because `mode` and the aligned
syllables are already computed, revealing is a class toggle on an already-rendered `<ruby>`, not a
re-render. The ruby band is reserved only when at least one word in the passage is revealed; a
passage with nothing revealed is a plain line of hanzi.

Word-vs-character grouping: characters are grouped into word spans (`data-token-index` survives as a
grouping attribute) so that a tap resolves to a word by default, per rule 2. The DOM's unit is the
character; the token becomes a grouping over characters.

**Files.** New `lib/hanzi/align.ts`, `components/hanzi/hanzi-text.tsx`, `components/hanzi/ruby.css`
(or the token stylesheet). `lib/dict/pinyin.ts` (export `isNumberedSyllable`). `lib/db/schema.ts`
(`pinyinDisplay` + default).

**Every `.hanzi` call site, with the phase that owns it.** `<HanziText>` is billed as "the component
every Chinese run renders through", so the list has to be exhaustive or the claim is false in the
build. There are **30 rendering sites across 16 files** (`grep -rn 'className="[^"]*\bhanzi\b'
components/`). `grep -rln hanzi components/` returns 20 files; the extra four —
`production-list-toggle.tsx`, `review-session.tsx`, `recall-input.tsx`, `tts/speak-button.tsx` —
match the word only in prose and are not call sites.

| Call site | Phase | Note |
|---|---|---|
| `review/review-card.tsx` :108 :111 :165 :201 | **C3** | card faces, both sides; `force` on the answer face |
| `review/production-card.tsx` :169 :173 :216 | **C3** | same |
| `review/phrase-face.tsx` :50 :69 | **C3** | same |
| `review/example-sentences.tsx` :362 | **C3** | **named explicitly by product-decisions §4** ("example sentences", no exceptions). Already renders per-*token* hanzi in a `flex-col` with `token.pinyin` underneath: the change is token→character granularity and moving the reading above, not new plumbing. The polyphone `title` hint survives. |
| `review/context-line.tsx` :25 | **C3** | the sentence a card carries; a Chinese run like any other |
| `lookup/entry-detail.tsx` :90 :193 :232 :235 :238 | **C3** | headword, traditional variant, the per-character decomposition strip |
| `lookup/search-results.tsx` :62 :83 | **C3** | result rows and classifiers |
| `lookup/ask-panel.tsx` :207 :364 | **C3** | cited entries and the model's phrase cards |
| `lookup/lookup-panel.tsx` :67 :74 | **C3** | the `<h2>` headword and the provenance line. **CLAUDE.md freezes this file individually**; §4's dependency row unfreezes it. The switch is mechanical — it renders `Entry` data it already has — and the frozen-file rule existed to stop parallel builders colliding on it, which no longer applies. |
| `lists/word-search.tsx` :76 | **C3** | search-result rows inside a list |
| `lists/list-detail.tsx` :201 | **C3** | list member rows |
| `reader/reader-lookup.tsx` :188 | **C4** | folded into the word sheet by C4; switched there, not here |
| `reader/reader-text.tsx` :106 | **C5** | replaced wholesale by `<HanziText>` |
| `reader/reader-screen.tsx` :123 | **C5** | the saved-text title row, above the reader it wraps |
| `reader/text-composer.tsx` :69 :111 | **out of scope, with a reason** | :69 is a `<textarea>` — ruby cannot render inside a form control and the learner is typing, not reading. :111 is a saved-text title in a picker list. Both keep the `.hanzi` type utility and get no ruby. Say so in the commit so a later reader does not think they were missed. |
| `shell/site-header.tsx` :12 | **out of scope, with a reason** | 七巧板 is the wordmark, not content. C7 rewrites this file for the tab shell; the wordmark stays plain. |

`components/reader/reader-text.tsx` is **not** switched here — C5 replaces it — and `reader-lookup.tsx`
waits for C4 for the same reason.

**Acceptance criteria.**

- `tests/unit/hanzi/align.test.ts` covers, by name: `打算` (clean 2/2), `一点儿` (erhua), `AA制`,
  `卡拉OK`, `3C`, an entry with `·`, an entry with `，`, **a `xx5` entry (々 or 込) asserting
  `mode: 'fallback'` and zero annotations rather than an aligned run of empty ones**, **a
  partially-unknown reading asserting the same**, and at least one deliberate count mismatch —
  asserting `mode: 'fallback'` rather than a wrong pairing. Add a property test over a sample of
  real `data/dict.json` entries asserting that `mode: 'aligned'` implies every character got a
  **non-empty** syllable and no syllable was dropped — non-empty is what makes the `xx5` case fail
  the property instead of passing it — and **record the fallback rate over the whole dictionary in
  `HANDOFF.md`**. If that rate is above a few percent the alignment rule needs another pass before
  C5 builds on it.
- Playwright, **recorded not asserted**: build a `Range` over a rendered passage, copy it, and write
  into `HANDOFF.md` whether Chromium's clipboard string contains the `<rt>` text. The
  copy-excludes-`user-select: none`-content behaviour is sourced for **WebKit only** (Safari 16.4,
  bug 80159); no audit establishes Blink's, and a programmatic `Range` over `user-select: none`
  content is exactly the untested case. If Chromium does exclude it, promote this to an assertion in
  the same commit and say so. Note that this criterion is about the C3 DOM, where the passage is
  selectable; **C5 puts `user-select: none` on the whole passage and takes the clipboard over
  explicitly**, so this criterion is retired when C5 lands and C5's replaces it.
- At 390px, a 200-character passage wraps with no horizontal scroll and no ruby annotation clipped:
  assert every `<rt>`'s bounding box is inside its container's.
- `pinyinDisplay: 'never'` hides every `<rt>` **except** on a card answer face, asserted in a unit
  test.
- **`pinyinDisplay: 'tap'` has its own criteria**, because it is the state the product asked for and
  the one with a collision in it. Unit: with `'tap'`, a freshly rendered passage contains no `<rt>`;
  after a tap on a word, exactly that word's characters have `<rt>` and the rest of the passage does
  not; a second tap does not duplicate or clear them. e2e: the same tap both reveals the reading and
  opens the word sheet (one gesture, two effects), and the passage's line height is unchanged between
  "nothing revealed" and "nothing revealed after a reveal was undone by unmount" — the
  no-layout-shift property.
- `'always'` is the value a fresh database reads, asserted against `DEFAULT_SETTINGS`.
- **Record, do not assert:** layout time for a 500-character passage in desktop Chromium. Nobody has
  measured this (register #1). Write the number into `HANDOFF.md`; a budget can be set once there is
  a number.

---

### C4 — The word sheet and the character sheet

**Builds.** Product rule 2's tap behaviour, on the `Sheet` primitive: tap a word → the word opens
with its senses and an Add; tap again, or tap a character inside the word → that single character
opens with its own reading, meanings, decomposition, and the words the learner already has
containing it.

The word sheet is largely the existing `EntryDetail` re-homed: it already does the thing that
matters most, which is refusing to pick a reading for a polyphone on the learner's behalf. Keep that
behaviour and its tests.

The character sheet is new. Its content: the character in `<HanziText>` at display size, its own
speaker, its readings and glosses (a single-character dictionary lookup), its decomposition from
`data/decomp.json`, and a list of the learner's own cards containing it. The last one needs no
repository change — `allCards()` exists and a solo learner's deck is small enough to filter in the
client; do **not** add a repository method for it. Whether the same panel can search the *whole*
dictionary for words containing the character is STACK §5.6 (the optional `chars` table) and is
`data.md`'s call, not this plan's; build the panel so that list is a prop.

**The licence rule is load-bearing here and this is the only screen that touches it.**
`data/decomp.json` is Make Me a Hanzi, LGPL-3.0-or-later. It is displayed and **never** enters a card
snapshot, `dict.json`, or a model prompt (CLAUDE.md, PLAN.md §5). `lib/dict/decomp.ts` already says
so in its header; the character sheet must not be the place that quietly breaks it.

**Where the data comes from in this phase.** C4 codes against the `DictStore` / `DecompStore`
signatures frozen by `data.md` D1's first commit, but it does **not** have to be the phase that
re-points the existing callers — that is C4a, immediately after. If D1's first commit has landed,
write the two new sheets against the interface directly and let C4a catch up the older callers; if it
has not, the sheets read through `lib/dict/client.ts` like everything else and C4a converts them with
the rest. Either way the sheets take the store as an injected dependency, never as an import of a
module-level singleton, because C4a and the mobile plans swap the implementation underneath them.

**Files.** `components/hanzi/word-sheet.tsx`, `components/hanzi/char-sheet.tsx`,
`components/lookup/entry-detail.tsx` (re-homed), `components/reader/reader-lookup.tsx` (folded into
the sheet).

**Acceptance criteria.**

- e2e: from a rendered passage, tap a two-character word → word sheet with both senses and an Add;
  tap one character inside it → character sheet with a decomposition block; press Escape → focus
  returns to the character that was tapped.
- A unit test asserts no code path writes any field of a `DecompEntry` into a `CardSnapshot` — walk
  the import graph the way `lib/server/route-inventory.ts` walks routes, or assert on the snapshot
  builder's output for a card added from the character sheet.
- Adding from the character sheet produces a card with the correct `senseIndex` and a `CardContext`
  whose `source` is the surface it came from — the existing `contextFor()` contract, unbroken.
- At 390px the sheet covers the lower two thirds and the tapped character is still visible above it.
  (`reader-text.tsx` already implements a `SHEET_SAFE_TOP` scroll-into-view for exactly this; carry
  the behaviour, not the code.)

---

### C4a — The `DictStore` cutover, and the four states the dictionary can be in

**Why this is a phase and not a footnote.** `data.md` D6 — the phase that deletes
`app/api/dict/**` — is gated verbatim on "`core.md` must have re-pointed every consumer in §3 at
`DictStore`", and `data.md` §3 names those consumers. Separately, three sibling plans (`data.md`
D4 and D5, `ios.md` I3, `android.md` A5) each say this plan draws the dictionary's readiness screens,
and `ios.md` records that **they do not exist in any screen today**. Neither piece of work belongs to
any C-phase above, and without this phase two plans would each be waiting for the other.

It sits after C4 because the character sheet is the last new consumer to appear (it reads
`DecompStore`), and before C5 because C5 rewrites `lib/stores/reader.ts` — better that it inherit a
`DictStore` caller than that C4a rewrite a file C5 is about to rewrite again.

**Part one: re-point the seven callers.** Every module that imports `lib/dict/client.ts` moves to
`DictStore` / `DecompStore`. From `data.md` §3, verified at `HEAD`:

| Module | Uses today | Becomes |
|---|---|---|
| `components/lookup/lookup-view.tsx` | `fetchSearch`, `DictRequestError` | `store.search()`; `DictRequestError.dataMissing` becomes `store.status` |
| `components/lookup/entry-detail.tsx` | `fetchDecomp` | `decompStore.decompose()` |
| `components/lookup/ask-panel.tsx` | `fetchEntriesResponse` | `store.entries()` |
| `components/reader/reader-lookup.tsx` | `fetchEntriesResponse`, `fetchSearch` | `store.entries()`, `store.search()` — by C4a this file is folded into the word sheet, so the edit lands in `components/hanzi/word-sheet.tsx` |
| `components/review/example-sentences.tsx` | `fetchEntriesResponse` | `store.entries()` |
| `lib/stores/reader.ts` (line 23) | `fetchSegment` | `store.segment()` |
| `lib/lists/entry-source.ts` | `fetchEntriesResponse`, `fetchHskResponse`, `fetchSearch` | `store.entries()`, `store.hskBand()`, `store.search()` |

**One API shape actually changes and `lib/lists/entry-source.ts` absorbs it.** `data.md` states it
plainly: "`hskBand` gains `limit`/`offset` because it now crosses a bridge instead of a socket;
`lib/lists/entry-source.ts` is the consumer to fix." Today the route returns a band; the store returns
a page. The spine builder is the caller, so it pages: request a window, and request the next window
when the introduction queue needs more, rather than pulling a whole band into memory. Whatever page
size is chosen, write it and the reasoning into `HANDOFF.md`, because it is the first place a
low-end device will feel the bridge.

**Two things must not change while the plumbing does.** `lib/ai/ground.ts`'s `GroundContext` is
already injectable — `data.md` notes it takes `{retrieved, segment, entry?, readings?}` and imports no
`lib/dict`. But it also notes the catch: **`segment` there is synchronous `(text) => Token[]` and a
`DictStore` is async** (`data.md` §5.7 owns the resolution). C4a must not paper over that with a
blocking wrapper; if §5.7's answer has not landed, the ask panel keeps its current retrieval path and
C4a records which caller is still on `lib/dict/client.ts` and why. And the grounding tests in
`tests/unit/ai/**` must pass with their assertions unchanged — that is `backend.md` B2's stated check
and it is equally the check here.

**Part two: draw the four states.** `data.md` D1 freezes `DictStatus` as
`absent | preparing{received?,total?} | ready{version} | failed{reason,message}` with `reason` one of
`download | import | storage | corrupt`. C1 has them as gallery entries against a stub; C4a makes
them real screens driven by `store.status` and `store.subscribe()`.

- **`absent`** — nothing on device yet. On web this is the first visit: an explicit "get the
  dictionary" affordance stating the size, because `data.md` measures the artifact at 13.9 MB brotli
  over 43.1 MB raw and a silent 14 MB download on a metered connection is a hostile default.
- **`preparing`** — a **determinate** bar from `received`/`total`. `data.md` D4 says it emits those
  fields "so `core.md` can show a determinate bar", so an indeterminate spinner here is a defect, not
  a simplification. It must survive a reload: import is idempotent and keyed by the artifact filename,
  so a re-entered `preparing` is normal.
- **`ready`** — the state with no screen. It is the absence of a banner.
- **`failed`** — four distinguishable reasons, and the app **keeps working without a dictionary**
  (`data.md` D4: "the app runs without a dictionary; `core.md` must have that state drawn"). Practice,
  lists and stats are the learner's own data and are unaffected; lookup and the reader are what
  degrade. `storage` gets its own copy, because it is the one the learner can act on. Each reason
  offers a retry, since a retry is a re-download of the same content-addressed file.

This **replaces `components/shell/data-banner.tsx` one-for-one** — `data.md` D4 says so — which
retires R11 rather than mitigating it. The banner's `HEAD /api/dict/hsk?band=1` probe is deleted, not
rewritten.

**Part three: the native first-launch copy.** `ios.md` register #18 and `android.md` A5 both require a
visible one-time progress state for `copyFromAssets()` of a ~43 MB file, with a designed low-storage
failure path, and both say this plan draws them. They are the same two components as `preparing` and
`failed{reason:'storage'}` with different copy, so build them as one component parameterised by
source (download vs. asset copy) rather than two. The mobile plans prove them on hardware; this phase
proves they render.

**Files.** `components/dict/dict-status.tsx` (the four states, one component),
`components/dict/dict-gate.tsx` (what a lookup surface renders when the store is not `ready`),
`components/shell/data-banner.tsx` (**deleted**), the seven modules in the table above,
`lib/lists/entry-source.ts` (paging), `tests/unit/dict/**`, `tests/e2e/core/dict-states.spec.ts`.

**Acceptance criteria.**

- `grep -rn "lib/dict/client" --include=*.ts --include=*.tsx .` returns nothing outside
  `lib/dict/client.ts` itself, and `grep -rn "api/dict" components/ lib/` returns nothing. This is the
  exact evidence `data.md` D6 is waiting for; paste both greps into `HANDOFF.md`.
- e2e fixtures for `absent`, `preparing` (asserting the bar's `value`/`max` move, not merely that a
  bar exists), `ready`, and `failed` for each of the four reasons. Driving them needs a store whose
  status a test can set — `data.md` D2/D3's in-Node implementation, or the hand-written fake §4 allows.
- With the store in `failed`, a spec starts and completes a practice review and adds a word to a list.
  The learner's own data is untouched by a missing dictionary and the UI must prove it.
- Every grounding test in `tests/unit/ai/**` passes with its assertions unchanged.
- `lib/lists/entry-source.ts` builds the same spine from `hskBand(band, {limit, offset})` as it does
  from today's whole-band fetch — a differential test, since the introduction order is the thing a
  learner would notice breaking.
- The commit names any caller still on `lib/dict/client.ts` and why (the `GroundContext.segment`
  synchronicity question is the only one anticipated).

---

### C5 — Drag to select a span

**This is the riskiest single piece of UI in the project and it gets its own phase, its own
prototype, and a fallback that ships if it fails.** Both mobile audits reached the same conclusion
independently: the platform's own text selection is unusable here because it sweeps the `<rt>`
pinyin into the selection and the clipboard, its precision degrades from characters to lines as the
selection grows, and its handles and callout menu fight the dictionary UI.

**The design** (STACK §2.1, identical on all three platforms): `user-select: none` on the passage,
Pointer Events, hit-test every `pointermove` with `document.caretRangeFromPoint` —
WebKit-proprietary, ancient in Blink, present everywhere — with `caretPositionFromPoint` preferred
where available (Chrome 128+; WebKit landed it behind a flag in late 2024 and **whether it is
default-on in Safari 26 is unverified**, register #2 — feature-detect and log which path was taken).
Paint the span with the **CSS Custom Highlight API** (Chrome 105+, Safari 17.2+) so there is **no DOM
mutation per pointer move**. Release → look up exactly that span.

**`touch-action` is dynamic, and the two audits do not say the same thing here.** AUDIT 1 (iOS) says
"Pointer Events on the reader container with `touch-action: none`"; AUDIT 2 (Android) says
"`user-select: none` on the passage, `touch-action` handling **on pointer-down**". STACK §2.1
flattened both into the iOS wording, and a static `touch-action: none` on the container is exactly
the declaration that stops the browser panning that element — it would break page scrolling on the
one screen made of a long scrolling passage. AUDIT 2's version is the one that works, so this plan
takes it:

1. The passage rests at **`touch-action: pan-y`**. A vertical drag is the browser's; it scrolls, and
   the app never sees it.
2. On `pointerdown`, record the origin and do nothing else — no capture, no `preventDefault`.
3. On `pointermove`, discriminate the axis. Once the gesture is unambiguously horizontal or
   intra-line, call `setPointerCapture`, `preventDefault()` the move, and begin selecting. Because
   `pan-y` already gave vertical scrolling to the browser, the browser will have taken the gesture
   before this point if it was vertical, and the app's move handler stops firing — which is the
   behaviour that makes the criterion below satisfiable.
4. Setting `touch-action: none` on the element for the duration of a captured drag is optional and
   belongs after capture, never before it.

**The axis-discrimination threshold is a value to record, not a value to assume.** No audit measured
one. Start from whatever the prototype shows separates a deliberate horizontal sweep from the
horizontal drift in a thumb's vertical scroll on a 390px-wide passage — a few CSS pixels of
horizontal travel before vertical travel exceeds it is the usual shape — measure it in the prototype
with both mouse and touch emulation, and write the number and how it was chosen into `HANDOFF.md`
after C5. `ios.md` and `android.md` re-check it on hardware, where thumbs are less precise than
Playwright.

**The app owns the clipboard for a drag span, because nothing else can.** `user-select: none` on the
passage means there is no native selection to copy, and a `Highlight` registered in `CSS.highlights`
is a *styling* construct: it does not alter `document.getSelection()` and does not participate in
copy. So a `Cmd/Ctrl+C` with a span active would put nothing on the clipboard unless this phase
handles it. It does: a `copy` event handler on the passage that, when a span is active, calls
`preventDefault()` and writes `spanOf(from, to)` — hanzi only, no `<rt>` text, because the app is
choosing the string rather than the engine deriving it. On touch, where there is no `Cmd+C`, the span
gets an explicit **Copy** affordance next to the lookup result in the sheet. This is a small addition
and it is in the file list below rather than assumed.

**Untappable runs get indexes too.** Today's `reader-text.tsx` gives a `data-token-index` only to
`kind === 'word'` tokens; punctuation, Latin and whitespace render as bare
`<span data-testid="reader-text-run">`. In a character-index model **every character in the body has
an index**, including those, because `spanOf()` now slices the body string by character offsets and a
span that crosses a comma has to contain the comma. So: every character gets an index and is a valid
span *interior*; only Chinese characters are valid **tap** targets and valid span *endpoints*. A drag
that starts or ends on a run of punctuation snaps inward to the nearest Chinese character; a drag
across one passes through it. The `data-testid="reader-text-run"` hook stays, so the specs that use
it keep working.

**Build the prototype first, in this phase, before the production component.** Register entry #1
says neither audit ran this combination — one `<ruby>` per character, `caretRangeFromPoint` on every
`pointermove`, Custom Highlight API over a DOM whose text nodes are interleaved with `<rt>`
annotations — and that its pointer latency and layout cost are unmeasured. **It is fully testable in
desktop Chromium, in this container, with no hardware**, which is the single biggest advantage this
plan has: Playwright's `mouse.down/move/up` and its touch emulation drive it directly. Prototype in
the gallery, measure, then build.

**The span model changes with it.** `lib/stores/reader.ts`'s `selected` / `spanEnd` become
**character** indexes; `spanOf()` slices the body by character offsets; `extend()` either goes or
becomes the fallback's mechanism. This is the data-model rewrite STACK §2.1 warns about — plan for
it rather than discovering it.

**The fallback, specified now and not later.** If the highlight cannot be made to land only on base
characters, or the measured pointer path is unusable, or (on the mobile plans) iOS refuses:
**tap-the-first-character, then tap "…to here" on the last** — which is the current `extend()` model
generalised to characters, needs no `caretRangeFromPoint`, no Custom Highlight API and no
`pointermove` at all, and paints with a class on the already-per-character DOM. Ship it as the
automatic degrade when either API is missing, feature-detected at runtime, so the fallback is
exercised in normal operation rather than being dead code discovered in a crisis.

**Files.** `components/hanzi/use-span-select.ts`, `components/hanzi/span-clipboard.ts` (the `copy`
handler and the Copy affordance), `components/hanzi/hanzi-text.tsx` (drag integration),
`components/reader/reader-text.tsx` (replaced by `<HanziText>`), `components/reader/reader-screen.tsx`
(its `.hanzi` title row, per C3's table), `components/reader/use-reader-index.ts` (it indexes tokens
today and must index characters), `lib/stores/reader.ts` (character-granular span model),
`components/gallery/**` (the prototype stays, as the harness).

**Acceptance criteria.**

- Playwright, desktop Chromium: press on character 3 of a rendered passage, move across characters
  4–7, release → the reported span is exactly characters 3–7 and the lookup fires with that string.
  Repeat backwards (press on 7, drag to 3) → the same span. Repeat with touch emulation.
- Drag across a line break → the span is contiguous in the source string, not in visual order.
- **The highlight never covers an `<rt>`**: assert that every range in the highlight registry
  resolves to a text node whose parent is not an `<rt>`.
- **Copying with a span active puts exactly the span's hanzi on the clipboard** — the app's own `copy`
  handler, asserted against `spanOf()`'s string, with no `<rt>` text and no leading or trailing
  punctuation beyond what the span contains. With **no** span active, a copy over the passage yields
  nothing, because `user-select: none` is doing its job; assert that too, so the two paths are
  distinguished rather than conflated. This criterion replaces C3's record-what-Chromium-does
  criterion, which was written against a selectable passage that no longer exists after this phase.
- The touch Copy affordance appears with a span and writes the same string.
- **Scrolling is not broken**: a vertical drag that starts on the passage still scrolls the page, at
  390px under touch emulation, with the passage taller than the viewport. This is satisfiable
  precisely because the passage rests at `touch-action: pan-y` and only takes the pointer after the
  axis is known — a static `touch-action: none` would fail it, which is why the design above says
  what it says.
- A near-vertical drag with a few pixels of horizontal drift scrolls and does **not** start a
  selection; a horizontal drag of the same magnitude does. The threshold that separates them is
  recorded in `HANDOFF.md`, not asserted as a validated number.
- **Measure and record in `HANDOFF.md`**, over a 500-character passage: `pointermove` handler time
  (p50/p95) and dropped frames during a full-width drag. The budget is one frame (16.7 ms) for the
  whole move → highlight update; **no audit measured this**, so the first run sets the baseline and
  the review judges it.
- With `caretRangeFromPoint` and `caretPositionFromPoint` both stubbed out, the fallback engages and
  a separate spec asserts tap-then-tap-to-here produces the same span. This spec must exist and pass
  in the same run as the drag spec.

---

### C6 — The speaker control, completed: hold to slow

**Builds.** Product rule 3's remaining half, on top of C2's interface and C3's per-character DOM: one
speaker per hanzi block; **hold** the speaker → 0.6× playback, character by character, each
character lit as it plays; **tap a character** → hear that syllable alone.

The mechanism is `lib/tts/sequence.ts` from C2: enqueue **one utterance per character** and advance
the highlight on each utterance's `start`. Do this even where boundary events exist — the Android
audit is explicit that range events are engine-dependent and the STACK record adopts per-character
utterances as the rule, not the fallback. The highlight reuses C5's Custom Highlight API painting
with a different highlight name, so the "currently speaking" mark and the "selected span" mark
compose instead of fighting.

Hold detection needs a real threshold and a way out. **The threshold is a starting value to be tuned,
not a specified one**: no audit measured it, product-decisions §4 rule 3 says only "Hold the speaker →
0.6x", and nothing in the repo sets one. Start from the platform's own long-press conventions — the
same convention a native long-press uses on each platform, which is the number a learner's hand
already expects — tune it in the gallery against a real hold-and-release, and record the value chosen
and why in `HANDOFF.md` after C6. `ios.md` and `android.md` re-check it on hardware. Releasing stops
the sequence. The control must be keyboard- and screen-reader-reachable (a long-press is not an
accessible affordance on its own — pair it with a visible control or a modifier key, and say which in
the component's header).

**Files.** `components/hanzi/speak-control.tsx`, `lib/tts/sequence.ts`, `components/hanzi/hanzi-text.tsx`.

**Acceptance criteria.**

- Unit, with a fake provider and fake timers: holding produces N utterances for an N-character
  block, at the configured rate, each with the correct text; releasing mid-sequence cancels the
  remainder and issues no further utterances; a new tap during a sequence cancels the old one.
- Unit: with `supportsBoundary: false`, the highlight still advances once per character.
- e2e in headless Chromium (no voices): the control renders, the hold gesture is recognised, and the
  visible reason for unavailability is shown. Audio itself cannot be asserted here and the spec must
  say so rather than pretending.
- Tapping a single character calls `speak` with exactly that character.
- Keyboard path: the block speaker is reachable and activatable by keyboard, and slow mode has a
  non-gesture trigger.

---

### C7 — The two shells, and the rule that the screens are identical

**Builds.** The phone three-tab shell, the wide-screen shell, and the mechanical enforcement that a
screen cannot tell which one it is in.

Three tabs replace seven routes (product-decisions §1): **Look up** (dictionary + AI answer + pasted
texts — `/read` merges in here), **Practice** (one session), **Library** (lists, saved texts,
progress, settings, level). `components/shell/nav.ts` — which the nav, the smoke spec and the phase
notes all read — becomes a three-entry tab model. `web.md` wires the route table; this plan defines
the tabs and their labels.

The phone shell is a bottom tab bar (thumb reach, safe-area aware — `android.md` owns the actual
inset plugin, this shell owns the CSS variable it consumes). The wide shell is the same three
destinations at a wider breakpoint (~720px, per product-decisions §10), which is close to free
because it is the same screens in a wider container.

**The `next/*` migration is not this phase's work and must not be re-done here.** §4 requires
`web.md`'s first phase before C1, and `web.md` W1 owns "the eleven `next/*` import sites: `next/link`
→ React Router's `Link`; `usePathname` → `useLocation()`; `useRouter().push` in `list-detail.tsx` →
`useNavigate()`". §3's statement that every navigational component imports `next/*` is true at `HEAD`
and false by the time C1 starts. What C7 does to `site-header.tsx` and `nav-link.tsx` is the **tab
model** rewrite, on top of whatever router W1 left there.

**The Look up tab's three answer states** (product-decisions §5), because this is the phase that
assembles that tab out of `/lookup` and `/read` and nothing above it owns them. The happy path exists
in `ask-panel.tsx`'s 813 lines; the other two are what make the grounding promise visible:

- **Thinking.** The dictionary card is rendered and **addable** before the model returns; the AI
  answer streams in beneath it under an "AI" chip. The answer never blocks the add.
- **No AI reachable.** A quiet `Chip` reading "Dictionary only — offline", and everything else works.
  This is a reachability fact, not a wire-format fact: the client-side ask module exposes it as a
  state (`unavailable`, with a reason the chip does not have to show), so the state is renderable and
  testable before `backend.md` B2 settles the contract.
- **Nothing verifiable.** When the answer contained nothing that could be checked against a cited
  dictionary row, say so and show nothing — an `EmptyState`, not an empty answer body. This is the
  visible face of PLAN.md §3.4, and it is distinct from "no answer": one is the model saying nothing
  useful, the other is grounding rejecting everything it said.

The shape C7 needs from the ask module is small and C7 defines it: a discriminated state of
`idle | thinking | answered | unavailable | ungrounded`, plus the grounded entries. `backend.md` B2
supplies what fills `answered`; it does not change the other four.

**The enforcement is the deliverable, not the two shells.** Screens live in `components/screens/**`
and take everything they need as props or from stores; they import nothing from
`components/shell/**` and nothing from the router. Navigation is handed down (a `navigate` prop or a
tiny context the shell provides), so a screen rendered inside a palette row behaves exactly as it
does inside a tab. Without this rule, C9 is impossible and the two shells drift into two designs.

**Files.** `components/shell/nav.ts` (→ tabs), `components/shell/phone-shell.tsx`,
`components/shell/wide-shell.tsx`, `components/shell/site-header.tsx` (rewritten for the tab model),
`nav-link.tsx`, `page-header.tsx`, `components/lookup/ask-panel.tsx` and a new
`components/lookup/ask-state.ts` (the three answer states), `components/screens/**` (see §8 for which
file becomes which screen), `eslint.config.mjs` (the import rule), and **`tests/e2e/**` — the suite
migration is this phase's work and is sized in the criteria below**. `data-banner.tsx` is not here:
C4a deleted it.

**Acceptance criteria.**

- An eslint `no-restricted-imports` rule forbids `components/shell/**` and router imports inside
  `components/screens/**`, and `pnpm lint` fails when it is violated. A unit test walking the import
  graph is an acceptable substitute if the eslint rule proves awkward; one of the two must exist.
- e2e: the same practice card, the same lookup result and the same library row render at 390px and
  1280px with the same test ids and the same text; the spec asserts equality of the extracted text
  content between the two widths, not just that both render.
- Tab state survives navigation away and back; the bottom bar shows the active tab with
  `aria-current="page"`.
- **The suite migrates, with a number in it.** All 29 files under `tests/e2e/**` run green against
  the three-tab IA, and the **22 that navigate by path** either navigate to a tab or reach their
  screen through one. `web.md` W1's criterion requires the seven-route suite green immediately before
  this phase deletes those routes, so the migration is a C7 commit, not a C7 side effect. Per-route
  specs become per-tab specs; nothing is deleted merely because its route is gone. Directories `a`,
  `b`, `c`, `d` are in scope alongside `p1`–`p6`.
- The old seven-route nav is gone and no spec references a removed route.
- **Three e2e fixtures for the three answer states**: (1) with the model call held open, the
  dictionary card renders and its Add is enabled, and a card can be added while the answer is still
  pending; (2) with the ask module forced to `unavailable`, the "Dictionary only — offline" chip is
  present and a lookup still returns dictionary results; (3) with an answer whose every proposal
  fails grounding, the panel says nothing could be checked and renders no phrase cards — and, per
  product-decisions §5, the real words inside the rejected phrases are still addable.

---

### C8 — Plain language: two verbs, a sentence, four buttons, honest stats

**Builds.** The relabelling. Nothing about FSRS changes — ratings 1–4 and every scheduling behaviour
are untouched — only what the learner reads.

**Today becomes a sentence.** The three number tiles in `app/(today)/today-view.tsx` (which
product-decisions §2 says were tried and rejected because they were the most prominent thing on
screen and are not the most important thing) become one sentence: "8 words to practice, 5 new words
to learn, and 2 to write from memory. About six minutes." The lookup box leads the screen; Practice
is stated beneath it. The counts already exist in `TodaySummary` from `lib/lists/today.ts` and the
direction split in `countByDirection`. **The time estimate does not exist and must not be invented**:
derive it from the learner's own median seconds-per-review once there are reviews
(`allReviewsChronological()` has the timestamps), and fall back to one named constant before that,
with the constant and its provenance written in the code. Round it; never show a false precision.

**The four grade buttons.** `RATING_LABELS` in `lib/srs/card.ts` becomes `1: 'Forgot it'`,
`2: 'Barely remembered'`, `3: 'Got it'`, `4: 'Instant'`. "Got it" is the filled primary button —
which means the primary variant on the grade bar is now **vermillion**, the single primary action.
There is **no coaching line** ("be honest" etc.); it was explicitly rejected. The subtitle stays the
**real** previewed interval from `gradeOptions()` — the product decision's table shows "1 min / 6 min
/ 3 days / 8 days" as illustrations of what the scheduler produces, and hardcoding them would be a
regression from what `grade-bar.tsx` already does correctly. The 2×2 grid on phones already exists;
keep it, and re-check it at 390px with the longer labels ("Barely remembered" is the constraint).

**Other renames.** Nav "Review" → "Practice"; the two card directions become "Recognise" and
"Write". A recognise card shows "Do you remember it?" and a "Show the answer" button **before** the
grade bar, so the order of operations is legible to a first-time user. A write card shows the
meaning, an input and "Check", then suggests a grade the learner can override —
`components/review/recall-input.tsx` already implements suggest-don't-press and its ring-plus-word
cue; relabel it, do not rewrite it.

**Learner level.** `DEFAULT_SETTINGS.spineStartBand` moves from `3` to `1`
(`lib/db/schema.ts`, unfrozen by §4's dependency row — it was frozen to protect data that does not
exist). The bottom of Library shows "Your level: Just starting — new words come from HSK 1, easiest
first," with a Change button. The HSK band model is unchanged; only its presentation is.

**The pinyin control, which C3 created and no phase yet exposed.** product-decisions §4 rule 1
requires "One setting in Library with three states — Always (the default while starting) / Only when
I tap / Never". C3 added `SettingsRow.pinyinDisplay` and specified what each value does to the
rendering; C8 is where the learner can reach it, because C8 owns Library. Three plainly-worded
options, no jargon, and a one-line explanation of the middle one ("tap a word to see how it sounds")
since it is the one that is not self-evident. It writes the same field C3 reads.

**Stats, in plain English, behind Library.** "How well it's sticking" (retention), "What's coming
up" (workload), "How many words are solid" (maturity).

**The calibration chart is an open decision, and this phase is where it closes.** STACK §5.2 sits
under "Open decisions — genuinely unsettled" and ends with an instruction, not a verdict: "**To
decide:** try to write the panel's one-sentence explanation for a beginner. If it cannot be written,
it does not ship." product-decisions §6 is equally provisional — "**Consider cutting** the calibration
chart from v1". Nobody has recorded an attempt. So C8 runs the test rather than assuming its outcome,
and **the owner writes the sentence or declines to, not the builder**: if a one-sentence beginner
explanation exists, the panel is relabelled with it and stays; if the owner cannot write one, the
panel is cut. Either way the answer goes in the commit message and in `HANDOFF.md`.

If it is cut, be accurate about the edit, because "delete the chart component" is not the whole of it.
STACK §5.2 names four files and this plan names all four: `components/stats/calibration-chart.tsx`
(the panel, 371 lines), `components/stats/stats-view.tsx` (which renders it), `lib/stats/summary.ts`
(which computes `summary.calibration`), and **`lib/stats/calibration.ts` with its re-export from
`lib/stats/index.ts` line 3 (`export * from '@/lib/stats/calibration';`)** — whether that re-export
survives is part of the same decision. Leaving the maths computed-and-unread is defensible on its own
terms — it is cheap and the panel may come back — **but not on the grounds that the optimizer needs
it**: across `dataset.ts`, `loss.ts`, `optimize.ts` and `previous.ts`, `lib/fsrs-optimize/**`'s only
*cross-module internal* imports are `@/lib/srs/params` and `@/lib/db/schema` (it also imports
`ts-fsrs` and its own siblings, so a naive grep will not come back clean). The real relationship is
narrower and is recorded in a comment in `lib/fsrs-optimize/dataset.ts`: scorability and calibration
measure elapsed time from the same timestamp. Decide, and write which in the commit.

**Hide the optimizer entirely until it can run** (it needs ≥1,000 scorable reviews) rather than
showing a disabled button for months. `components/settings/optimizer-panel.tsx` already knows the
threshold; the change is that the surface is absent, not disabled, below it.

**Files.** `lib/srs/card.ts`, `lib/db/schema.ts`, `app/(today)/today-view.tsx` (→
`components/screens/today.tsx`), `components/review/{grade-bar,review-card,production-card,recall-input}.tsx`,
`components/shell/nav.ts`, `components/stats/**`, `components/settings/optimizer-panel.tsx`,
`components/screens/library.tsx`.

**Acceptance criteria.**

- A jargon grep over `components/screens`, `components/review` and `components/stats` — the terms
  are `again`, `hard`, `good`, `easy`, `SRS`, `spaced repetition`, `interval`, `ease`, `retention`,
  `FSRS`, `due`, `new cards` — is reviewed line by line, and every surviving hit is either not
  learner-visible or justified in the commit message. This is a review gate, not a passing grep: the
  rule is "no SRS jargon anywhere in the UI" and only a human reading can judge it.
- Unit: `RATING_LABELS` has the four new strings and `gradeOptions()` still returns the scheduler's
  real interval for each — a test that the subtitle for rating 1 on a fresh card is a *minutes*
  string under `shortTermSteps: true`, not a hardcoded "1 min".
- e2e at 390px: the four grade buttons render in a 2×2 grid with no text clipping and no horizontal
  scroll; "Got it" is the only filled button on the screen.
- e2e: Today renders one sentence containing the counts and a duration, and **neither number tile**
  (`today-due-count` at line 105 and `today-new-count` at line 112 are the only two; the conditional
  `today-direction-split` line goes with them). If those test ids survive as spans inside the
  sentence, say so in the spec.
- e2e: the Library pinyin control offers exactly three options, and switching between them changes
  what a rendered passage shows — `always` renders every `<rt>`, `never` renders none, `tap` renders
  none until a word is tapped. One spec, three assertions, driving the real setting.
- e2e: a recognise card shows "Show the answer" before any grade button is reachable; the grade bar
  is not in the accessibility tree until the answer is shown.
- With a fresh database, `/library` shows "Your level: Just starting" and `spineStartBand` reads 1.
- The optimizer surface is absent below 1,000 scorable reviews and present above it — two e2e
  fixtures.
- The calibration decision is recorded: either the panel carries a one-sentence beginner explanation
  written by the owner and a test asserts that sentence renders, or the panel is gone and no test
  references it. A phase that ships neither has not run the test STACK §5.2 asked for.

---

### C9 — The command palette (gated, and honest about what it is worth)

**Status: build only after C7 has been used for a week of real study** (STACK §5.1's test) **and the
owner has chosen it.** product-decisions §10 marks the desktop shell explicitly undecided; STACK
§2.4 states plainly that **the palette is not a v1 goal**, because its whole point is being
summonable, summoning needs a global hotkey, and no browser can register one (Chromium issue
40749250). A palette inside a browser tab is a search box with ambitions. The global hotkey arrives
with Tauri or not at all, and Tauri is deferred.

**If it is built**, it is a *mode over the same screens*, which is what C7's enforcement bought: a
floating panel that is the home screen, Practice as the first row with Enter to start, typing looks a
word up in place, Cmd+Enter adds it, Tab asks the whole question; during a session it shrinks to a
slim Cmd+K bar at the top so a mid-session lookup does not lose the learner's place. The default
theme question (light vs. the dark a Raycast-style panel conventionally wears) is open — C0's
three-state theme layer is what makes it a swap.

**Acceptance criteria.**

- The palette renders the **same** screen components as the tab shell: a spec asserts the practice
  card's extracted text is identical in both shells, as C7's spec does across breakpoints.
- Keyboard-only: open, type, arrow, Enter, Cmd+Enter, Escape — all without a pointer.
- The palette adds no new state store; it drives the same stores the tab shell drives.
- The commit says explicitly whether the global hotkey exists. If it does not, the release notes say
  the palette is in-app only.

---

## 6. Risks

Each risk names the trigger that would tell you it is happening. The first four are audit items that
were explicitly **not verified** and that this plan depends on.

**R1 — The per-character reader combination is unmeasured (register #1).** Neither audit ran one
`<ruby>` per character + `caretRangeFromPoint` per `pointermove` + Custom Highlight API over a DOM
interleaved with `<rt>` nodes; each recommended the pieces separately.
*Trigger:* C3's recorded layout time or C5's recorded `pointermove` p95 comes back high, or the
highlight visibly lags the finger on a few-hundred-character passage.
*Check that settles it:* C5's prototype, in desktop Chromium, in this container — measure before
building the production component. *Mitigation:* C5's tap-then-tap fallback, which needs neither
API; and the highlight can be coarsened to per-character class toggling if the Highlight API is the
cost.

**R2 — The iOS 26 WKWebView crash with `-webkit-user-select: none` during touch (register #1).** One
Apple forum thread, resolution unknown. The CSS is load-bearing on iOS for suppressing native
selection.
*Trigger:* the reader crashes the WebView on a real iOS 26 device.
*Check:* run the same prototype on a physical iOS 26 device — `ios.md` owns it, but this plan's
prototype is the artifact that answers it, so **build the prototype so it can be loaded standalone**.
*Mitigation:* if it reproduces with no CSS workaround, the reader screen is the first candidate for
the native `UIViewController` boundary (STACK §2.1) — and that paragraph is explicit that the blast
radius is one screen but the cost is a Core Text ruby engine, so read it before assuming an easy
exit.

**R3 — `caretPositionFromPoint` may not be default-on in Safari 26 (register #2).**
*Trigger:* the feature detection logs the proprietary path on iOS.
*Check:* feature-detect at runtime, log which path was taken, read the log on a real device.
*Mitigation:* nothing fatal — `caretRangeFromPoint` is present in every WKWebView and ancient in
Blink. Write the code to prefer the standard and fall back, which C5 requires anyway.

**R4 — Font coverage and the web first-load budget (register #9).** Slim Noto subsets are 0.7–1.4 MB
and the audit expects them not to cover 124k CC-CEDICT headwords; full faces are 4.5–9 MB per
weight, and the settled visual language asks for three families.
*Trigger:* C0's coverage script reports uncovered characters, or `web.md`'s budget sums to something
indefensible on top of the ~15 MB brotli dictionary.
*Check:* `pnpm font:coverage`, in C0, first, because it needs no hardware.
*Mitigation:* on native it is package bytes and nobody notices; on web, `unicode-range`-split
subsets so a page downloads only the blocks it renders (`web.md` owns the delivery).

**R5 — Syllable-to-character alignment is wrong in ways a beginner cannot detect.** This is not an
audit item; it comes from reading `lib/dict/pinyin.ts`, which has no per-character alignment at all.
A wrong per-character reading is a silent teaching error, and the whole product promise is that
hanzi and tone marks are rendered from cited dictionary data.
*Trigger:* C3's recorded fallback rate over the whole dictionary is high, or a spot-check of
polysyllabic entries shows drift.
*Check:* the property test over real `data/dict.json` entries in C3, plus the recorded rate.
*Mitigation:* the explicit `mode: 'fallback'` — render word-level ruby rather than guess.

**R6 — Boundary events are unreliable or absent (register #19; WebKit's are documented unreliable;
`window.speechSynthesis` is reported undefined in the Android WebView).**
*Trigger:* the slow-mode highlight does not advance, or advances at the wrong time, on a device.
*Check:* `typeof window.speechSynthesis` in the Capacitor Android WebView — five seconds, in
`android.md`'s first phase.
*Mitigation:* already the design — one utterance per character, highlight on `start`, declared as
`supportsBoundary: false`. C2 unit-tests that path, so it is exercised before any device sees it.

**R7 — The two shells drift into two designs.** The classic failure of "phone shell plus desktop
shell", and the thing that makes C9 impossible.
*Trigger:* a screen imports from `components/shell/**`, or a spec has different assertions at the
two breakpoints.
*Check:* C7's lint rule and the same-text-at-both-widths spec, running in CI from C7 onward.
*Mitigation:* the rule is mechanical, so keep it mechanical; never grant an exception without moving
the shared thing into a prop.

**R8 — The token migration turns into a redesign.** Ten tokens become thirty, every component
changes, and three phases of unrelated regressions arrive at once.
*Trigger:* C0's diff touches screen components beyond hex-to-token substitutions.
*Mitigation:* C0 is a rename plus a palette swap plus one script. Screens change in C7/C8, behind
their own review.

**R9 — The three AI states get skipped.** product-decisions §5 requires three designed states — the
dictionary card is present and addable while the AI is thinking; a quiet "Dictionary only — offline"
chip when no AI is reachable; and an explicit "nothing here could be checked" when the answer had
nothing verifiable. The happy path is the easy one and the other two are what make the grounding
promise visible.
*Trigger:* C1 ships without a `Chip` and an `EmptyState`, or C7's review only exercises a successful
answer.
*Mitigation:* they are **built work, not a caveat** — gallery entries in C1 against a stubbed state,
real screens and three named e2e fixtures in C7, against the `idle | thinking | answered | unavailable
| ungrounded` shape C7 defines. `ask-panel.tsx` is 813 lines and already implements the happy path —
audit it before rewriting it. They do **not** wait on `backend.md`: B2 fills `answered` and changes
none of the other four.

**R10 — The default theme decision (STACK §5.1) arrives after the components are written.**
*Trigger:* anyone hardcodes a light-only assumption (a shadow, a hex, an image with a white matte).
*Mitigation:* C0's three-state theme layer plus the no-raw-hex grep. Ship light as the default and
leave the palette's dark variant a token swap.

**R11 — `data.md` and this plan deadlock on the dictionary seam.** `data.md` D6 will not delete
`app/api/dict/**` until this plan has re-pointed all seven consumers; this plan's screens cannot
render the store's states until `DictStatus` is frozen. Left implicit, each plan waits for the other.
*Trigger:* C7 approaches with `data-banner.tsx` still probing `HEAD /api/dict/hsk?band=1`, or `data.md`
D6 is blocked with no core.md phase named against it.
*Check:* the two greps in C4a's criteria — `lib/dict/client` and `api/dict` — pasted into `HANDOFF.md`.
*Mitigation:* **C4a exists and is that work.** The ordering is settled by `data.md`'s own rule that the
interfaces land as D1's first commit and are frozen from then on, so C4a needs D1's first commit and
nothing later. `data-banner.tsx` is deleted, not rewritten.

**R12 — the ruby `<rt>` copy behaviour is sourced for WebKit only.** AUDIT 1 and STACK §6 both record
`user-select: none` exclusion from copy as a **Safari 16.4** fact; no audit establishes Blink's, and
Blink is the only engine this container can test.
*Trigger:* C3's recorded Chromium copy string contains the pinyin.
*Check:* C3's record-don't-assert criterion, in the container, at no cost.
*Mitigation:* C5 makes the question moot for the reader by taking the clipboard over explicitly. If
Chromium turns out to include `<rt>` text and a surface outside the reader still relies on native
selection, that surface gets the same explicit `copy` handler.

## 7. Out of scope for v1

- **The global hotkey**, and therefore the palette as a *summonable* surface. It needs Tauri, which
  needs ~$120/year of Windows signing plus a three-target CI pipeline and three rendering engines to
  test, and STACK §2.4 sequences it after a week of real use says Cmd+K is a reflex. C9 can ship an
  in-app palette; it cannot ship the thing that makes a palette a palette.
- **Audio tiers 2 and 3** — cloud voice caching, and the ~1,300-syllable recorded set. Tier 1 (device
  voice) is what C2 and C6 build against. Tier 3 has moved from "nice to have" to "likely necessary"
  because a no-GMS Android device may report no Mandarin voice at all, but that is register #7 and a
  production project (or a licence question about generating it from a tier-2 vendor), not shared UI.
  `TTSProvider` must not make either tier hard to add — that is the only requirement this plan
  carries.
- **The calibration chart** (STACK §5.2) — **provisionally, and this is the one item on this list that
  is still open.** Its audience is someone tuning FSRS and the product's rule is no SRS jargon, which
  is why STACK recommends cutting it and product-decisions §6 says "consider cutting". But STACK's
  test — write the panel's one-sentence beginner explanation; if it cannot be written, it does not
  ship — **has not been attempted by anyone**, and no source records an outcome. C8 runs it, the owner
  writes the sentence or declines, and this bullet becomes a fact or is deleted at that commit.
- **The optimizer as a visible surface**, until ≥1,000 scorable reviews exist. Hidden, not disabled.
- **The curriculum verb** — a guided path that speaks a sentence, records the learner repeating it,
  and scores the pronunciation. Scoring needs a bought API (Azure or iFlytek). Design the home so a
  third verb can slot in; do not build it. The cheap half (listen and repeat, no scoring) is
  available whenever wanted, since TTS and i+1 sentences already exist.
- **List import** (clipboard, Pleco tab-separated, Anki text; `.apkg` never). Its own task.
  `addListMembers(listId, entryIds[])` already exists.
- **Native-feeling motion.** Plain CSS and View Transitions only; no animation library. No audit
  found a divergence between stacks here, so there is nothing to buy.
- **Indexable per-word app pages** (STACK §5.7). If they happen they are static Astro pages built
  from the same `pnpm data` output at the apex domain, and the app does not change — which is
  exactly why this plan does nothing about them.

## 8. Disposition of every existing `components/` file

§2 claims this as a deliverable, so here it is: all **47** files under `components/` at `HEAD` of
`claude/apps-ui-design-791zpq`, one row each, with the phase that touches them. "Screen" means the
file becomes or folds into a module under `components/screens/**` in C7, which is what makes C7
estimatable. Nothing on this list is unaccounted for; where a file survives untouched, that is stated
rather than implied.

| File | Disposition | Phase |
|---|---|---|
| `lists/create-list-form.tsx` | keep; token/primitive pass, folds into the Library screen | C0, C7 |
| `lists/list-card.tsx` | keep; token/primitive pass, folds into Library | C0, C7 |
| `lists/list-detail.tsx` | keep; `<HanziText>` at :201, `DictStore`, folds into Library | C3, C4a, C7 |
| `lists/lists-view.tsx` | folds into `screens/library.tsx` as the lists section | C7 |
| `lists/production-list-toggle.tsx` | **keep, relabelled.** 191 lines of "Write" direction UI, and product-decisions §1 is explicit that production "is NOT a fourth verb — it is a direction inside Practice", so it has a home in a three-tab IA: a per-list switch inside list detail in Library, worded "Also practice writing these from memory" instead of "meaning → hanzi". The behaviour is unchanged. | C7, C8 |
| `lists/word-search.tsx` | keep; `<HanziText>` at :76, `DictStore` | C3, C4a, C7 |
| `lists/word-state.tsx` | keep unchanged apart from the token pass | C0 |
| `lookup/ask-panel.tsx` | keep; `<HanziText>` at :207 :364, `DictStore`, the three answer states | C3, C4a, C7 |
| `lookup/entry-detail.tsx` | keep as the body of the **word sheet**; `<HanziText>`, `DecompStore` | C3, C4, C4a |
| `lookup/lookup-panel.tsx` | keep; **frozen file, unfrozen by §4**; `<HanziText>` at :67 :74; folds into the Look up screen | C3, C7 |
| `lookup/lookup-view.tsx` | becomes `screens/look-up.tsx`; `DictStore` | C4a, C7 |
| `lookup/search-results.tsx` | keep; `<HanziText>` at :62 :83 | C3 |
| `pwa/register-sw.tsx` | **out of scope.** `web.md` owns the service worker and PWA install. | — |
| `reader/reader-lookup.tsx` | **deleted**, folded into the word sheet | C4 |
| `reader/reader-screen.tsx` | keep; `.hanzi` title row at :123; folds into the Look up tab when `/read` merges in | C5, C7 |
| `reader/reader-text.tsx` | **deleted**, replaced by `<HanziText>` with the character-granular span model | C5 |
| `reader/reader-view.tsx` | folds into the Look up screen's pasted-text view | C7 |
| `reader/text-composer.tsx` | keep; `.hanzi` at :69 (a `<textarea>`) and :111 (a picker title) stay **plain, no ruby** — see C3's table for why; re-homed into Look up | C7 |
| `reader/use-reader-index.ts` | rewritten with the span model: it indexes tokens today and must index characters | C5 |
| `review/add-reverse.tsx` | keep; relabelled ("Write" direction) | C8 |
| `review/context-line.tsx` | keep; `<HanziText>` at :25 | C3 |
| `review/example-sentences.tsx` | keep; `<HanziText>` at :362 — named by product-decisions §4, and the existing per-token reading becomes per-character; `DictStore` | C3, C4a |
| `review/grade-bar.tsx` | keep; four new labels, vermillion primary, the 2×2 grid survives | C8 |
| `review/phrase-face.tsx` | keep; `<HanziText>` at :50 :69 | C3 |
| `review/production-card.tsx` | keep; `<HanziText>` at :169 :173 :216; relabelled "Write" | C3, C8 |
| `review/recall-input.tsx` | keep; **relabel only** — its suggest-don't-press behaviour and ring-plus-word cue are correct and are not rewritten | C8 |
| `review/review-card.tsx` | keep; `<HanziText>` at :108 :111 :165 :201; "Do you remember it?" / "Show the answer" ordering | C3, C8 |
| `review/review-session.tsx` | becomes `screens/practice.tsx`. **The queue merge (§2's unassigned gap) lands here or nowhere**; C7 re-homes the screen, it does not merge the queues. | C7 |
| `settings/optimizer-panel.tsx` | keep, 414 lines unchanged; moved into Library and made **absent** below 1,000 scorable reviews | C7, C8 |
| `shell/data-banner.tsx` | **deleted**, replaced one-for-one by the `DictStatus` screens | C4a |
| `shell/nav-link.tsx` | rewritten for the tab model (the router swap is `web.md` W1's) | C7 |
| `shell/nav.ts` | rewritten: seven routes → three tabs | C7 |
| `shell/page-header.tsx` | keep; retuned to the type scale, may be absorbed by the shells | C0, C7 |
| `shell/site-header.tsx` | rewritten for the tab model; the 七巧板 wordmark at :12 stays plain type, no ruby | C7 |
| `shell/test-hooks.tsx` | **keep unchanged.** It exposes the repository on `window.__tangram` and the e2e suite depends on it through the migration. | — |
| `stats/calibration-chart.tsx` | **open** — relabelled with the owner's one-sentence explanation, or deleted. C8 decides. | C8 |
| `stats/chart-tokens.tsx` | keep as a **separate** palette, re-derived from the new accents; do not merge into the UI tokens | C0 |
| `stats/maturity-panel.tsx` | keep; renamed "How many words are solid" | C8 |
| `stats/primitives.tsx` | keep; chart-internal primitives, token pass only — they are not `components/ui/**` and are not merged into it | C0 |
| `stats/retention-panel.tsx` | keep; renamed "How well it's sticking" | C8 |
| `stats/stats-view.tsx` | keep; moved into Library, renamed panels, edited if the calibration panel is cut | C7, C8 |
| `stats/workload-chart.tsx` | keep; renamed "What's coming up" | C8 |
| `tts/speak-button.tsx` | rewritten as the block speaker (v2); the pending/ready/unavailable triad and its visible reason survive verbatim | C2, C6 |
| `ui/badge.tsx` | keep; retuned to the new tokens and radii | C0, C1 |
| `ui/button.tsx` | keep; retuned, plus a `grade` shape | C0, C1 |
| `ui/card.tsx` | keep; border not shadow, new radii | C0, C1 |
| `ui/input.tsx` | keep; retuned, and `Field` wraps it | C0, C1 |

Outside `components/`, one screen file moves: `app/(today)/today-view.tsx` becomes
`components/screens/today.tsx` in C7 and is rewritten as a sentence in C8.
