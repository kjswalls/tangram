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
- The disposition of every existing file under `components/`.

**This plan does not own, and must not start:**

| Not here | Owner | Why the seam is where it is |
|---|---|---|
| The SQLite dictionary, the `DictStore` interface, moving `lib/dict/pinyin.ts` and the segmenter DP to the client, the `pnpm data` artifact path | `data.md` | Every hanzi component takes data as props or through `DictStore`; none of them opens a database. |
| The Vite + React Router migration, the build, the service worker, PWA install and `persist()`, the Astro marketing site, **web font delivery** (`unicode-range` subsets, first-load budget) | `web.md` | This plan names the font families and the coverage requirement; how bytes reach a browser is a build decision. |
| Capacitor projects, the **native** TTS adapters, safe-area insets, fonts inside the app package, every device-only register check | `ios.md`, `android.md` | This plan widens `TTSProvider`; the mobile plans implement it against `@capacitor-community/text-to-speech`. |
| The server, accounts, sync, BYOK key custody, the new `/api/ask` request contract | `backend.md` | The ask panel's three states are designed here against a provider interface; what is behind it is not. |
| List import (clipboard / Pleco / Anki) | its own task, per STACK §7 | Scoped separately by product-decisions §9. |

**One gap the orchestrator has to close before C8.** product-decisions §1 merges new-word
introduction into a single Practice session. That is queue *composition* — `lib/lists/today.ts`,
`lib/lists/introduce.ts`, `lib/srs/session.ts` — not shared UI, and **no sibling plan names it**.
This plan relabels and re-homes the existing review session; it does not merge the queues. Assign
that work somewhere explicitly, or C8 ships a Practice tab that still introduces new words on a
different screen from the one that reviews them.

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
`app/layout.tsx` composes them. **Every navigational component imports `next/*`.**

**Screens.** `app/(today)/today-view.tsx` (three number tiles — `today-due-count`,
`today-new-count`, a direction split line — which product-decisions §2 explicitly rejects),
`components/lookup/**` (5 files; `ask-panel.tsx` is 813 lines and already implements the grounded
answer, `entry-detail.tsx` the reading picker and Add, `lookup-panel.tsx` is a frozen file),
`components/review/**` (8 files; `grade-bar.tsx` renders `Again · Hard · Good · Easy` from
`GradeOption.label`, already a 2-col grid on phones, already carrying the **real** previewed
interval from `fsrs.repeat()`), `components/reader/**` (6 files), `components/lists/**` (7 files),
`components/stats/**` (7 files, four panels), `components/settings/optimizer-panel.tsx` (414 lines).

**The reader, precisely — this is what C3–C5 replace.** `components/reader/reader-text.tsx` renders
one `<button data-token-index>` per **token**, with a single delegated `onClick` on the container
(deliberate: a 2,000-character text is ~1,300 tokens). `lib/stores/reader.ts` models a span as
`selected` / `spanEnd` **token** indexes, with `extend()` growing it by whole adjacent word tokens
and `spanOf()` slicing the body. Selection is therefore token-granular in both the DOM and the
store, and product rules 1–2 make both character-granular: this is a rewrite of the data model, not
an addition to it (STACK §2.1).

**Hanzi rendering.** `grep -rn 'ruby\|<rt'` over the repo returns **nothing**. Pinyin is displayed
as a whole-word string from `Entry.pinyinMarked`, produced by `toMarked()` in `lib/dict/pinyin.ts`,
which runs syllables together with orthographic apostrophes (`Xi1 an1` → `Xī'ān`). **There is no
function that aligns syllables to characters**, which is exactly what per-character ruby needs.
`markSyllable()` (one numbered syllable → one marked syllable) and `isNumberedSyllable()` exist and
are the building blocks. `Entry.pinyinNum` is space-separated (`da3 suan4`) and also carries `·`,
`,` and Latin runs (`3C`, `OK`).

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
already; `tests/e2e/**` has per-phase directories `p1`–`p6` plus `full-loop`, `integration` and
`smoke` specs. Playwright drives the container's Chromium at `/opt/pw-browsers/chromium`.

## 4. Dependencies

| Needs | From | State it must be in |
|---|---|---|
| CLAUDE.md rewritten | orchestrator, per STACK §7 | **Before C0.** Today's CLAUDE.md freezes `app/globals.css`, `components/ui/**` and `lib/types.ts`, and this plan edits all three. It is the first commit of the migration, not a phase. |
| Vite + React Router 8 skeleton building and serving | `web.md`, its first phase | **Before C1.** C0 is CSS and a script and can land under either build. Everything from C1 on writes components that must not import `next/*`, and the gallery route in C1 needs a router. |
| Repo/workspace layout decided | orchestrator, STACK §7 | Before C0 — it decides whether these paths gain an `src/` or a package prefix. This plan writes today's paths and expects `web.md` to relocate them once, mechanically. |
| `DictStore` interface **shape** agreed (not implemented) | `data.md` | Before C4. The character sheet reads entries and decomposition; it needs the signature, not the SQLite file. Until then it may read through today's `lib/dict/client.ts`. |
| `decomp.json` delivery decided | `data.md` (STACK §2.2 leaves it open) | Before C4 ships. The character sheet is the only consumer. |
| Nothing from `ios.md` / `android.md` / `backend.md` | — | This whole plan runs in the Linux container against desktop Chromium. That is deliberate: STACK §4 says everything web and desktop proceeds without hardware, and **the mobile plans depend on this one**, not the other way round. |

The one hard ordering constraint inside this plan: **C2 (`TTSProvider`) must land before any mobile
plan starts**, because two adapters implement it and STACK §7 lists it as settle-first.

## 5. Phases

Every phase ends the way PLAN.md §4 says: `pnpm lint`, `pnpm test`, the phase's e2e specs green, an
adversarial review, a commit. Each phase below adds acceptance criteria that are executable or
observable. Where a criterion is a *measurement nobody has taken*, it says so and names the number
to record rather than pretending a threshold was validated.

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
| `--practice` / `--practice-soft` | `#b93a26` / TBD | vermillion; Practice and the **single** primary action |
| `--lookup` / `--lookup-soft` | `#0f766e` / `#d9ece6` | jade; Look up and "learning" states |
| `--new` / `--new-soft` | `#8a6414` / `#f3ead3` | gold; "new" |
| `--radius-sm/md/lg` | 12 / 16 / 24 px | product-decisions §11 gives the 12–24 range |

Type: `--font-display` Newsreader, `--font-ui` DM Sans, `--font-hanzi` Noto Serif SC — each with a
real fallback stack, because until `web.md` and the mobile plans ship font files these are all
system-font gambles and the app must still look deliberate.

**Three structural rules, not styling opinions.**

1. Theme has **three** states, not two. Define the complete light palette on bare `:root`; redefine
   only the changed tokens under `@media (prefers-color-scheme: dark)` guarded as
   `:root:not([data-theme="light"])`; redefine them again under `:root[data-theme="dark"]`. Today's
   stylesheet has no explicit-choice path at all, and §5.1 leaves the palette shell's default theme
   open — this is what keeps that decision cheap. Ship **light as the default** (STACK §5.1).
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

**Files.** `app/globals.css` (split into a tokens block and a base block; `web.md` relocates the
file once). `components/stats/chart-tokens.tsx`. New: `scripts/font-coverage.ts`, and a
`pnpm font:coverage` script. `components/ui/**` only where a hardcoded colour has to become a token.

**Acceptance criteria.**

- `pnpm font:coverage` prints, for every candidate face and weight, the count and a sample of
  uncovered characters, and exits non-zero when coverage is below 100%. Its output for the chosen
  face is pasted into `HANDOFF.md`. **This is the phase's headline deliverable** — the number is
  currently unknown and three plans need it.
- A unit test (`tests/unit/ui/tokens.test.ts`) parses the stylesheet and asserts: every semantic
  token is defined on bare `:root`; every token redefined in the dark blocks also exists in the
  light block; both a `prefers-color-scheme` block and a `[data-theme="dark"]` block exist and
  define the same token set.
- `grep -rnE '#[0-9a-fA-F]{3,8}' components/ | grep -v chart-tokens` returns nothing.
- Toggling `document.documentElement.dataset.theme` between `light` and `dark` in a Playwright spec
  changes the computed `background-color` of `body` in both directions, under both
  `prefers-color-scheme` emulations (four combinations, all correct).
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
whole app, and it is where the adversarial review looks first. Exclude it from production builds
(`web.md` owns how) but keep it reachable in the e2e build.

**Files.** `components/ui/{button,card,badge,input,sheet,tab-bar,chip,field,empty-state,skeleton}.tsx`,
`components/gallery/**`, one route module.

**Acceptance criteria.**

- Playwright spec `tests/e2e/core/gallery.spec.ts` loads `/gallery` at 390×844 and 1280×800, in both
  themes, and screenshots each section. **No horizontal scroll at 390px** (assert
  `document.documentElement.scrollWidth <= clientWidth`) and a side gutter of at least 16px.
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
- Any entry where the syllable count simply does not equal the character count.

So: `lib/hanzi/align.ts` exports `alignReading(headword, pinyinNum) → { chars: {char, syllable?}[],
mode: 'aligned' | 'fallback' }`. It aligns greedily character-by-syllable, skipping punctuation
tokens, and **when counts disagree it returns `mode: 'fallback'`** and the caller renders one ruby
annotation over the whole run (`<ruby>打算<rt>dǎsuàn</rt></ruby>`) rather than guessing. A wrong
per-character reading is worse than a correct word-level one.

`<HanziText>` then renders **one `<ruby>` element per character** — mono-ruby, `ruby-position:
over`, which is what makes each pair one glyph wide so it wraps naturally in any Chromium and in
WebKit (STACK §2.1). `rt { user-select: none }` so a copy excludes the pinyin (WebKit since Safari
16.4, bug 80159). Each character carries `data-char-index`; the container keeps **one delegated
handler**, as `reader-text.tsx` does today, because a pasted passage is hundreds of characters and a
handler per character is hundreds of closures per recolour.

Pinyin visibility becomes a setting: `SettingsRow.pinyinDisplay: 'always' | 'tap' | 'never'`,
default `'always'` (product-decisions §4 rule 1; the learner is a beginner). Optional field, merged
by `getSettings()`, **no Dexie version bump** — `STORES_V1.settings` indexes `id` only. The one
exception the product states: it never hides pinyin on a practice card's **answer** side, so the
component takes an explicit `force` prop the card back sets.

Word-vs-character grouping: characters are grouped into word spans (`data-token-index` survives as a
grouping attribute) so that a tap resolves to a word by default, per rule 2. The DOM's unit is the
character; the token becomes a grouping over characters.

**Files.** New `lib/hanzi/align.ts`, `components/hanzi/hanzi-text.tsx`, `components/hanzi/ruby.css`
(or the token stylesheet). `lib/db/schema.ts` (`pinyinDisplay` + default). Consumers switched in
this phase: `components/review/review-card.tsx`, `production-card.tsx`, `phrase-face.tsx`,
`components/lookup/entry-detail.tsx`, `search-results.tsx`, `components/lookup/ask-panel.tsx`.
`components/reader/reader-text.tsx` is **not** switched here — C5 replaces it.

**Acceptance criteria.**

- `tests/unit/hanzi/align.test.ts` covers, by name: `打算` (clean 2/2), `一点儿` (erhua), `AA制`,
  `卡拉OK`, `3C`, an entry with `·`, an entry with `，`, and at least one deliberate count mismatch —
  asserting `mode: 'fallback'` rather than a wrong pairing. Add a property test over a sample of
  real `data/dict.json` entries asserting that `mode: 'aligned'` implies every character got a
  syllable and no syllable was dropped, and **record the fallback rate over the whole dictionary in
  `HANDOFF.md`**. If that rate is above a few percent the alignment rule needs another pass before
  C5 builds on it.
- Playwright: select a rendered passage with `document.execCommand`-free selection APIs and assert
  the copied string contains the hanzi and **no pinyin** (this is the `user-select: none` behaviour;
  it is Chromium-verified here and Safari-verified only later, register #12).
- At 390px, a 200-character passage wraps with no horizontal scroll and no ruby annotation clipped:
  assert every `<rt>`'s bounding box is inside its container's.
- `pinyinDisplay: 'never'` hides every `<rt>` **except** on a card answer face, asserted in a unit
  test.
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

### C5 — Drag to select a span

**This is the riskiest single piece of UI in the project and it gets its own phase, its own
prototype, and a fallback that ships if it fails.** Both mobile audits reached the same conclusion
independently: the platform's own text selection is unusable here because it sweeps the `<rt>`
pinyin into the selection and the clipboard, its precision degrades from characters to lines as the
selection grows, and its handles and callout menu fight the dictionary UI.

**The design** (STACK §2.1, identical on all three platforms): `user-select: none` on the passage,
`touch-action: none` on the container, Pointer Events, hit-test every `pointermove` with
`document.caretRangeFromPoint` — WebKit-proprietary, ancient in Blink, present everywhere — with
`caretPositionFromPoint` preferred where available (Chrome 128+; WebKit landed it behind a flag in
late 2024 and **whether it is default-on in Safari 26 is unverified**, register #2 — feature-detect
and log which path was taken). Paint the span with the **CSS Custom Highlight API** (Chrome 105+,
Safari 17.2+) so there is **no DOM mutation per pointer move**. Release → look up exactly that span.

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

**Files.** `components/hanzi/use-span-select.ts`, `components/hanzi/hanzi-text.tsx` (drag
integration), `components/reader/reader-text.tsx` (replaced by `<HanziText>`),
`lib/stores/reader.ts` (character-granular span model), `components/gallery/**` (the prototype
stays, as the harness).

**Acceptance criteria.**

- Playwright, desktop Chromium: press on character 3 of a rendered passage, move across characters
  4–7, release → the reported span is exactly characters 3–7 and the lookup fires with that string.
  Repeat backwards (press on 7, drag to 3) → the same span. Repeat with touch emulation.
- Drag across a line break → the span is contiguous in the source string, not in visual order.
- **The highlight never covers an `<rt>`**: assert that every range in the highlight registry
  resolves to a text node whose parent is not an `<rt>`.
- Copying while a drag-selection exists yields hanzi only.
- Scrolling is not broken: a vertical drag that starts on the passage still scrolls the page.
  (`touch-action: none` is how this gets broken; the criterion exists because it is the classic
  failure.)
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

Hold detection needs a real threshold and a way out: a pointer held past ~350 ms enters slow mode,
releasing stops the sequence, and the control must be keyboard- and screen-reader-reachable (a
long-press is not an accessible affordance on its own — pair it with a visible control or a modifier
key, and say which in the component's header).

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

**The enforcement is the deliverable, not the two shells.** Screens live in `components/screens/**`
and take everything they need as props or from stores; they import nothing from
`components/shell/**` and nothing from the router. Navigation is handed down (a `navigate` prop or a
tiny context the shell provides), so a screen rendered inside a palette row behaves exactly as it
does inside a tab. Without this rule, C9 is impossible and the two shells drift into two designs.

**Files.** `components/shell/nav.ts` (→ tabs), `components/shell/phone-shell.tsx`,
`components/shell/wide-shell.tsx`, `components/shell/site-header.tsx` (rewritten,
`next/link`-free), `nav-link.tsx`, `page-header.tsx`, `data-banner.tsx` (its probe changes when
`/api/dict/*` disappears — coordinate with `data.md`), `components/screens/**` (screens moved in),
`eslint.config.mjs` (the import rule).

**Acceptance criteria.**

- An eslint `no-restricted-imports` rule forbids `components/shell/**` and router imports inside
  `components/screens/**`, and `pnpm lint` fails when it is violated. A unit test walking the import
  graph is an acceptable substitute if the eslint rule proves awkward; one of the two must exist.
- e2e: the same practice card, the same lookup result and the same library row render at 390px and
  1280px with the same test ids and the same text; the spec asserts equality of the extracted text
  content between the two widths, not just that both render.
- Tab state survives navigation away and back; the bottom bar shows the active tab with
  `aria-current="page"`.
- No screen imports `next/*`. `grep -rn "from 'next/" components/ app/` returns nothing outside
  whatever `web.md` still owns.
- The old seven-route nav is gone and no spec references a removed route.

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
(`lib/db/schema.ts`, now editable per STACK §7 — it was frozen to protect data that does not exist).
The bottom of Library shows "Your level: Just starting — new words come from HSK 1, easiest first,"
with a Change button. The HSK band model is unchanged; only its presentation is.

**Stats, in plain English, behind Library.** "How well it's sticking" (retention), "What's coming
up" (workload), "How many words are solid" (maturity). **Cut the calibration chart** (STACK §5.2).
Be accurate about the edit: it is `components/stats/calibration-chart.tsx` *plus*
`components/stats/stats-view.tsx` *plus* `lib/stats/summary.ts`, which computes
`summary.calibration` for the panel. Leaving the maths computed-and-unread is defensible on its own
terms — **but not on the grounds that the optimizer needs it**: `lib/fsrs-optimize/**` imports only
`@/lib/srs/params` and `@/lib/db/schema`, and the real relationship is only that scorability and
calibration measure elapsed time from the same timestamp. Decide, and write which in the commit.

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
- e2e: Today renders one sentence containing the three counts and a duration, and **no number tile**
  (`today-due-count` and `today-new-count` as tiles are gone; if the test ids survive as spans inside
  the sentence, say so in the spec).
- e2e: a recognise card shows "Show the answer" before any grade button is reachable; the grade bar
  is not in the accessibility tree until the answer is shown.
- With a fresh database, `/library` shows "Your level: Just starting" and `spineStartBand` reads 1.
- The optimizer surface is absent below 1,000 scorable reviews and present above it — two e2e
  fixtures.
- `/stats`'s calibration panel is gone and no test references it.

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
*Trigger:* C1 ships without a `Chip` and an `EmptyState`, or the ask panel's review only exercises a
successful answer.
*Mitigation:* the three states are gallery entries in C1 and named e2e fixtures wherever the ask
panel is reviewed. `ask-panel.tsx` is 813 lines and already implements much of this — audit it
before rewriting it.

**R10 — The default theme decision (STACK §5.1) arrives after the components are written.**
*Trigger:* anyone hardcodes a light-only assumption (a shadow, a hex, an image with a white matte).
*Mitigation:* C0's three-state theme layer plus the no-raw-hex grep. Ship light as the default and
leave the palette's dark variant a token swap.

**R11 — `data.md` and this plan collide on the reader's data source.** `data-banner.tsx` probes
`/api/dict/hsk`, which disappears when the dictionary moves on-device, and the reader currently posts
to `/api/dict/segment`, which also disappears.
*Trigger:* C7 lands while `data.md` is mid-flight and the banner probes a dead route.
*Mitigation:* the banner's probe becomes a `DictStore` readiness question, not an HTTP one; agree the
signature with `data.md` before C7 and write it into `HANDOFF.md`.

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
- **The calibration chart** (STACK §5.2). Its audience is someone tuning FSRS and the product's rule
  is no SRS jargon. The test is whether its one-sentence beginner explanation can be written; it
  could not be.
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
