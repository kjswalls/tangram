# Tangram — build plan: the Android app

**Status:** plan, written 2026-09-13. Sibling plans: [`core.md`](core.md), [`data.md`](data.md),
[`web.md`](web.md), [`ios.md`](ios.md), [`backend.md`](backend.md).

**Read first:** [`docs/STACK.md`](../STACK.md) is the decision record this plan executes — §2.1
(Capacitor, native TTS, mandatory font bundling), §2.5 (the bundled SQLite dictionary), §2.7 (the
audio tiers) and §4 (the known-unknowns register, whose numbers this plan cites as "register #n").
It is cited here, never re-argued. [`PLAN.md`](../../PLAN.md) remains authoritative for the data
contract (§3.1), the schema (§3.3), the grounding contract (§3.4) and the licence boundary (§5).

Two facts frame everything and are not repeated: **there are no users and no data** — nothing here
is a migration plan and none of it may become one — and the builder is **one person with AI
assistance**. A third, specific to this plan: **mainland China is not a priority market**, which is
what removed the strongest objection to shipping Android on Capacitor at all (STACK §2.1) and what
keeps Huawei/HarmonyOS out of §7.

---

## 1. Goal

When this plan is done, the same Vite build that serves the web app is installable from Google Play
as an Android app that works with the aeroplane mode on: the dictionary is a bundled SQLite file
queried through a native plugin, Chinese renders in a font the app ships rather than whatever the
manufacturer chose, speech comes from Android's own engine through a native plugin because the
WebView has no `speechSynthesis` at all, and the app draws correctly edge-to-edge under a keyboard
on API 36. None of that exists now — there is no `android/` directory, no Capacitor dependency, no
bundled font file anywhere in the repo, and no `env(safe-area-inset-*)` in any stylesheet.

## 2. Scope boundaries

**This plan owns:**

- The Capacitor Android project: `capacitor.config.*`, the committed `android/` directory, the
  Gradle wiring, SDK levels, and the copy steps that get `dist/` and the dictionary artifact into
  the package.
- The Android plugin set, its versions, and the JS-side adapters that sit on top of the plugins —
  except where a sibling plan owns the interface being implemented (see the table below).
- The **native TTS adapter**: `@capacitor-community/text-to-speech` behind `core.md`'s widened
  `TTSProvider`, Mandarin-voice availability at runtime, the install-voice-data path, and the
  honest state on a device with no Mandarin voice at all.
- Edge-to-edge, safe-area insets, the keyboard inset, the status/navigation bars and the hardware
  back button.
- **The Chinese font inside the app package** and the on-device verification that the language
  declaration produces Simplified glyph forms under a non-Chinese device locale.
- The **WebView version floor**: choosing it, detecting it, and what the app says below it.
- Signing, the release AAB, the 16 KB page-size check, and the Play Console path including the
  closed-testing gate.
- Every register check in STACK §4 whose hardware is an Android phone: #5, #7, #8, #11 (Android
  half), #15, #16, #18 (Android half), #19.

**This plan does not own, and must not start:**

| Not here | Owner | Where the seam is |
|---|---|---|
| The Vite build, the router, the service worker, PWA install, web font *delivery*, the API base and the gate's client half | `web.md` | This plan consumes `apps/app/dist/` as a directory of static files and never edits what produces it. `web.md` owes it a build with no absolute-origin assumption (W1/W9); this plan owes `web.md` nothing but the origin string the app runs from. |
| Design tokens, `components/ui/**`, the tab bar, per-character ruby, drag-select, the `TTSProvider` **interface**, the web TTS adapter, the font *families* and the coverage script | `core.md` | `core.md` C0 names the faces and runs `pnpm font:coverage`; this plan puts the chosen file in the package and checks it on real hardware. `core.md` C7 owns the tab bar and the CSS variable it reads; this plan owns the plugin that fills that variable. |
| The SQLite schema, the `DictStore`/`SqlRunner` interfaces, `lib/dict/runners/capacitor.ts`, the artifact's name and manifest | `data.md` | Exactly as `data.md` §2 states it: that plan owns the file and the runner that opens it, this plan owns getting the file into the app package and the native project that runs it. A5 below is the Android half of `data.md` D5 and shares its acceptance criteria. |
| The iOS project, Xcode, the App Store, and everything that needs a Mac | `ios.md` | **Android needs no Mac.** This is worth stating because STACK §4's precondition table reads as one mobile blocker; it is two, and only the iOS half needs Apple hardware. |
| The server, accounts, sync, BYOK custody, the `/api/ask` contract | `backend.md` | This plan owes `backend.md` one fact — the exact origin the WebView runs from, so CORS and the gate can allow it — and nothing else. |
| Audio tiers 2 and 3 (cloud voice, the recorded syllable set) | out of scope for v1 (§7), unless A4 forces the question | A4 runs the check that decides it and writes the answer down; it does not build a syllable set. |

## 3. What exists today

Read in the repo at `HEAD` of `claude/apps-ui-design-791zpq`. There is no Android work of any kind
in this repository, so this section is mostly an inventory of what A1 will have to adapt.

**No native project, no Capacitor.** `git ls-files` has no `android/`, no `ios/`, no
`capacitor.config.*`. `package.json` has no `@capacitor/*` dependency; its `scripts` are Next-shaped
(`dev`/`build`/`start`/`lint`/`test`/`e2e`/`data`/`data:ensure`/`sw`/`smoke`) and `engines.node` is
`>=20.9`, which `web.md` W0 raises to `>=22.22`.

**No bundled font.** `find . -name '*.woff*' -o -name '*.otf' -o -name '*.ttf'` (outside
`node_modules`) returns nothing. `app/globals.css:51` declares `--font-hanzi: "Noto Serif SC",
"Songti SC", "Source Han Serif SC", "PingFang SC", …` — a system-font gamble on every device, which
is precisely the thing STACK §2.1 calls mandatory to fix on Android.

**No safe-area handling.** `grep -rn 'safe-area\|env(' app/globals.css components/` returns nothing.
`app/layout.tsx` sets `viewport = { width: 'device-width', initialScale: 1, themeColor: '#0f766e' }`
with no `viewportFit`, and `<html lang="en">` — not `zh-Hans`. `core.md` C0 rule 2 changes the `lang`
attribute; nothing today sets an inset variable for a tab bar to read.

**The web app assumes a server origin.** `public/manifest.webmanifest` declares `"id": "/"`,
`"start_url": "/"`, `"scope": "/"`, `theme_color` `#0f766e` and five icons under `/icons/`;
`app/layout.tsx` registers a service worker; the dictionary is fetched from `/api/dict/*`. All three
assumptions change under `web.md` (W1, W3) and `data.md` (D6) before this plan needs them, which is
why every phase here is gated on those.

**TTS is Web Speech only.** `lib/tts/provider.ts` is three members — `name`, `available()`,
`speak(text, {lang?, rate?})` — and its own header says `speak` resolves once the utterance is
*queued*. `lib/tts/speech-synthesis.ts` is a careful Web Speech implementation (voice ranking,
Cantonese refused because a Cantonese reading of Mandarin pinyin is a wrong answer the learner
cannot detect, `voiceschanged` with a 500 ms timeout, `cancel()` before every `speak`).
`components/tts/speak-button.tsx` renders pending / ready / unavailable with the reason as **visible
text** rather than a `title`, for the stated reason that a touch screen never shows a `title`. That
last decision is worth preserving verbatim: on Android the unavailable state is not a headless-CI
curiosity, it is a real device outcome (register #7).

**The container this repo is built in cannot finish an Android build, but it is closer than STACK
§4 assumes.** *Measured 2026-09-13 (this plan):* `java -version` is OpenJDK **21.0.10**, `gradle
-version` is **8.14.3** at `/opt/gradle/bin/gradle`, Node is **22.22.2**, pnpm **10.33.0**. There is
**no Android SDK** (`ANDROID_HOME` is empty, no `adb`, no `zipalign`, no `sdkmanager`, no
`/usr/lib/android-sdk`). Whether `sdkmanager` can be installed and licensed through the agent proxy
is **unknown and untried** — A1 tries it, because if it works every phase below gains a
compile-only gate that runs with no phone attached, and if it does not, that fact belongs in
`HANDOFF.md` so nobody tries again.

## 4. Dependencies

**Hardware and accounts — none of this is optional and none of it exists in the container.**

| Needed | For | Without it |
|---|---|---|
| A dev machine with the Android SDK and Android Studio (any OS; **not** a Mac) | Every phase from A1 | No build. |
| **A named low-end Android target** | A5, A6, register #11 | STACK §4 says this plan must name one and never does. Name it in A0 or the performance bar is unfalsifiable. |
| A physical **GMS** phone | A1, A3, A4, A5, A6, registers #5, #7, #8, #11, #18, #19 | An emulator answers #8 and #19 and can produce a build for #5; it cannot stand in for #7 or #11. |
| A physical **non-GMS** phone | The other half of #7 | Unanswerable, and #7 is what decides whether audio tier 3 is v1 scope (STACK §5.3). Borrowed for an afternoon is enough. |
| A Google Play developer account | A0, A8 | The registration fee is **unpriced by every audit** — read it off the Play Console. |

**Sibling-plan gates.**

| Phase | Needs |
|---|---|
| A0 | Nothing but network access and a payment method. Run it first; it is the only phase with no hardware dependency. |
| A1 | `web.md` **W1** — a Vite build that emits `dist/` and boots from a non-`/` origin. `web.md` W0's workspace layout, so `dist/` has a stable path. |
| A2 | `core.md` **C1** (the `TabBar` primitive) and ideally **C7** (the phone shell), because an inset with nothing to inset is untestable. |
| A3 | `core.md` **C0** — the token layer, the `lang="zh-Hans"` root rule, and `pnpm font:coverage`'s output for the faces the visual language actually uses. `web.md` **W6** self-hosts the font files; this plan decides which of them ride in the package. |
| A4 | `core.md` **C2** — `TTSProvider` widened with `stop()`, utterance identity, an event surface and `supportsBoundary`. STACK §7 and `core.md`'s own dependency table both say C2 lands **before any mobile plan starts**; A4 is the phase that consumes it. |
| A5 | `data.md` **D1** (the artifact and its manifest) and **D5** (the Capacitor `SqlRunner`). A5 is D5's Android half and they should be reviewed together. |
| A6 | `core.md` C3–C5, because the WebView floor is decided by which engine features the reader actually ships against. |
| A7, A8 | Everything above, plus A0's account. |
| — | **Nothing from `backend.md`.** The app is usable offline with the AI answer disabled; `web.md` W4's header-based gate and the API base are what make it reachable when the server exists. |

---

## 5. Phases

Nine phases. Every phase ends the way PLAN.md §4 says — `pnpm lint`, `pnpm test`, the phase's specs
green, an adversarial review, a commit — with two Android-specific additions: **every device
measurement is pasted into `HANDOFF.md` with the command that produced it and the device it ran on**,
and **a phase whose register check could not be run because the hardware was absent is blocked, not
complete**. A0 and A6 are short. A1, A4, A5 and A8 are the substantial ones.

A note on ordering that is easy to get wrong: **A8's closed test is a 14-day calendar gate, not a
work item.** Start the Play tracks as early as an installable signed build exists (A7), and let
A8's testing period elapse while later work continues. Do not discover the two weeks at the end.

---

### A0 — The device matrix, the blocked docs, and the Play account

**Builds.** No code. It produces the facts every later phase asserts against, and it is the cheapest
phase in this document by a wide margin.

Three jobs.

**One: name the devices.** A table in `HANDOFF.md` with, for each phone available: model, Android
version, **Android System WebView version** (read it from the WebView's own settings entry and from
the UA string, and record both — they are the same number by different routes and the second is what
A6's gate parses), whether Google Mobile Services is present, RAM, and free storage. One of them is
designated **the low-end target** and every performance number in A5 and A6 is quoted against it by
name.

**Two: re-read the five egress-blocked sources (register #12).** AUDIT 2 could not reach
capacitorjs.com, ionic.io, tauri.app, capawesome.io or issues.chromium.org, so a cluster of facts
this plan depends on rests on search snippets. STACK §4 calls this a five-minute task that validates
a whole cluster at once. Read and record, with the URL and the date:

- Capacitor 8's stated minSdk / compileSdk / targetSdk and its Android Gradle Plugin and JDK
  requirements. The audit says minSdk 24 and compile/target 36; confirm it.
- The **exact plugin names and current versions** for the core plugins this plan needs and that no
  audit named: whatever Capacitor documents for the hardware back button, the status bar, the
  keyboard and the splash screen. Do not guess these from memory — write down what the docs say.
- The **local scheme and origin** Capacitor's Android WebView serves from, and the config key that
  sets it. `backend.md` needs that exact string for CORS and `web.md` W4's gate needs it too, so it
  goes in `HANDOFF.md` as a literal.
- `@capacitor-community/safe-area`'s current version — STACK §6 records the row as "version not
  recorded by the audit".
- Chromium issue **40468168** (no `speechSynthesis` in the Android WebView), **446078849** (the CJK
  synthetic-bold regression in WebView 139–140, reported fixed in 143) and Capacitor issues
  **#8432** (keyboard bottom inset) and **#4884** (no built-in WebView version gate). All four ids
  came from search snippets. Confirm each id resolves to what the audit says it does, or correct it.

**Three: open the Play Console (register #15 and #16).** Pay the one-time registration fee and
record what it was. Read the current policy on the closed-testing requirement — AUDIT 2 records "12
testers, 14 days, for personal developer accounts created after 13 November 2023", sourced but not
confirmed from Google — and record the exact current wording, the account type it applies to, and
whether this account is subject to it. Read the target-API deadline in the same visit: AUDIT 2 says
target API 36 has been required since 31 August 2026 with an extension available to 1 November 2026.

**Files.** `HANDOFF.md` (new sections), `docs/plans/android.md` (correct any fact this phase
disproves — a plan that contradicts a source it cites is worse than no plan).

**Acceptance criteria.**

1. `HANDOFF.md` contains the device table with a device explicitly labelled "the low-end target".
2. Every one of the four issue/PR ids above is either confirmed with a URL and a one-line status, or
   marked "could not confirm" with what was tried. No id is left resting on a search snippet.
3. The Play registration fee, the closed-testing requirement and the target-API deadline are
   recorded verbatim with the date read and a link.
4. The Capacitor local origin string is in `HANDOFF.md` and `backend.md`'s author has been told.

---

### A1 — The Capacitor Android project, and the first boot

**Builds.** An installable debug APK of the current app, running on a real phone.

**The setup.** Add `@capacitor/core` and `@capacitor/cli` at the versions STACK §6 pins (8.5.2,
2026-09-11) plus the Android platform package, generate the native project, and **commit
`android/`**. Capacitor's native directory is a source artifact you will edit (Gradle config,
manifest entries, the asset copy) rather than build output; treating it as generated means every
edit is lost on the next regeneration. Gitignore the *contents* that are genuinely generated —
build directories, and the dictionary asset, which is 43 MB and follows `data/`'s existing
gitignore rule.

`webDir` points at `apps/app/dist` (the path `web.md` W0 establishes). The build order is: build the
web app, copy the dictionary asset (A5), then sync. Add that as a root script so it is one command
and nobody does it half-way.

**SDK levels.** minSdk 24, compileSdk 36, targetSdk 36 — Capacitor 8's own defaults per AUDIT 2, and
36 is what Play requires. Assert them rather than accept them: a Gradle property nobody looked at is
how a target-API rejection happens.

**Two register checks cost five seconds each while a device is in hand.**

- **#19:** log `typeof window.speechSynthesis` from the Capacitor Android WebView. AUDIT 2 says it is
  `undefined` and that this is why the native TTS plugin is mandatory rather than convenient. If it
  is defined, the plugin decision does not change — the enhanced voices and the range events still
  argue for it — but the justification in A4 does, and `core.md` C2's `supportsBoundary` fallback
  gains a third case to think about.
- Record `navigator.userAgent` and the Chrome version inside it on every test device. This is A6's
  input and it is free here.

**Also here, because it is the first thing a tester will press:** the **hardware back button**.
`web.md` §2 assigns it to this plan. Wire whatever plugin A0's docs read named to the router's
history, with the rule that back at the root of a tab returns to the previous tab and back at the
first tab backgrounds the app rather than closing it. A back button that exits the app from the
middle of a practice session is the single most reported Capacitor-app complaint and it is one
handler.

**Files.** `package.json` (root and `apps/app/`), `capacitor.config.ts`, `android/**`, `.gitignore`,
a root `pnpm android:sync`-style script, and the back-button handler under `apps/app/` (a small
module in the shell layer, co-ordinated with `core.md` C7 so it is not two competing navigation
owners).

**Acceptance criteria.**

1. A debug APK builds and installs on a real device, and the three tabs render and navigate.
2. The build is reproducible from a clean checkout with one documented command sequence, written
   into `HANDOFF.md`. "It works on my machine after some fiddling" fails this phase.
3. `minSdkVersion`, `compileSdkVersion` and `targetSdkVersion` are asserted to be 24/36/36 by a
   check that runs in the build — a grep over the Gradle config is enough, and it is what stops a
   plugin's own defaults from quietly overriding them.
4. Register #19 is answered in `HANDOFF.md` with the logged value and the device.
5. The hardware back button is exercised by hand down a written checklist: back inside a screen,
   back at a tab root, back at the first tab, back while a sheet is open. Each has a stated expected
   result and each matches.
6. `HANDOFF.md` records whether the container can install an Android SDK through the proxy, and if
   it can, a compile-only `assembleDebug` gate exists that runs without a phone.

---

### A2 — The shell fits the device: edge-to-edge, insets, and the keyboard

**Builds.** The app drawing correctly under the status bar, the gesture bar and the keyboard, on
API 36.

**Why this is not cosmetic.** AUDIT 2: API 36 **forces** edge-to-edge, and Chromium builds below 140
were reported to return **0 px** for the `env(safe-area-inset-*)` values, with the keyboard's bottom
inset fixed only in Chromium 144 (Capacitor #8432). So the WebView's own CSS answer to "how tall is
the system bar" is wrong on exactly the devices most likely to be in a beginner's hand, which is why
STACK §2.1 lists a safe-area plugin as the third mandatory Android dependency.
`@capacitor-community/safe-area` is that plugin; its version is A0's to establish.

**The shape.** The plugin publishes inset values; the shell reads them from CSS variables;
`core.md` C7's tab bar and every bottom sheet consume those variables. `core.md` owns the CSS
variable's name and its consumers, this plan owns filling it. Define the variable so that
`env(safe-area-inset-bottom)` is the value when it is trustworthy and the plugin's number when it is
not — one variable, one source of truth, decided at runtime rather than two competing paddings.

**The keyboard is the half that will actually break.** The lookup box is the first thing on the Look
up tab and a practice write-card is an input; both are bottom-ish on a phone. Test each with the
keyboard open on a device whose WebView is below 144 and on one at or above it, and record which
behaviour each showed. If the pre-144 behaviour is unusable, the mitigation is the same one A6
formalises: a WebView floor with a banner asking the user to update Android System WebView, which is
Play-updated on every GMS device.

**Files.** `capacitor.config.ts`, `android/app/src/main/**` (theme/manifest entries the plugin
requires), the inset variable definition in the shared stylesheet (co-ordinated with `core.md` C0's
token file), `apps/app/index.html` (`viewport-fit=cover` — nothing in the repo sets it today).

**Acceptance criteria.**

1. Screenshots on at least two devices with different notch/gesture-bar geometry: the tab bar sits
   above the gesture bar, the header clears the status bar, and no content is under either.
2. With the keyboard open on both a pre-144 and a post-144 WebView, the focused input is visible and
   the tab bar is not floating in the middle of the screen. Both results recorded by version.
3. The inset variable has a non-zero value on a device that has a notch, asserted by reading the
   computed value in the WebView, not by eye.
4. Rotating the device and returning does not leave a stale inset.
5. Dark mode and light mode both render the system bars legibly (icon contrast is a native theme
   setting, not CSS).

---

### A3 — Type: the bundled Chinese face, and the language declaration on a real device

**Builds.** The app renders Chinese in a font it ships, in Simplified glyph forms, with a real bold
weight, on every test device regardless of manufacturer or device locale.

**The three facts this phase exists for**, all from AUDIT 2 via STACK §2.1:

1. All three Android stacks draw with the **device** font unless you bundle one, and OEMs differ —
   Xiaomi ships MiSans, Huawei HarmonyOS Sans, Samsung its own. The app cannot look like itself
   without a bundled face.
2. **Han unification** means a device whose locale is Japanese renders Japanese glyph forms for
   shared code points unless the page declares the language. `core.md` C0 puts `lang="zh-Hans"` on
   the root and a `lang` on every hanzi run; this phase is where that is *verified*, because the
   failure is invisible on an English-locale device.
3. A WebView regression in builds **139–140** stopped synthesising bold for CJK without a `lang`
   attribute, reported fixed in 143 and **unconfirmed** (register #8). Bundling a real bold weight
   makes the regression irrelevant, which is why the mitigation is "ship two weights" rather than
   "wait for 143".

**What is actually decided here, and what is inherited.** `core.md` C0 names the families
(product-decisions §11: Noto Serif SC for hanzi, with Noto Sans SC as the alternative where a sans
hanzi reads better — note the divergence from AUDIT 2, which assumed Noto Sans SC) and runs
`pnpm font:coverage` against the CC-CEDICT headword character set. `web.md` W6 self-hosts the files
under `apps/app/public/fonts/` and splits them by `unicode-range` for the web. Those files are
already in `dist/`, so **Capacitor inherits the web's fonts for free** — no separate Android font
pipeline exists or should be built.

The one Android-specific decision: whether the package ships the **full** face instead of the
`unicode-range` subsets. On the web a subset set is a transfer optimisation; inside an app package
every byte is already downloaded, and a split set means many small requests over the local scheme
for no benefit. The audit's numbers say a full SC OTF is ~4.5–9 MB per weight and a slim subset
0.7–1.4 MB, and that a slim subset will **not** cover 124k CC-CEDICT headwords. Two weights of a
full face is therefore roughly 9–18 MB of package — real, but small beside the dictionary. Measure
the actual package delta both ways and choose with the number visible.

**Budget the package honestly.** `data.md` D5 requires every size estimate here to use the doubled
dictionary figure: ~14 MB compressed in the package plus ~43 MB expanded in app storage ≈ 57 MB,
before the fonts and the app shell. Write the total into `HANDOFF.md` as one number.

**Files.** `android/app/src/main/assets/**` only if the font delivery diverges from `dist/` (prefer
that it does not), `apps/app/public/fonts/**` (shared with `web.md` W6), the `@font-face` block.

**Acceptance criteria.**

1. A screenshot of the same passage on every test device is glyph-identical. Different manufacturers
   producing different-looking hanzi is the failure this phase prevents.
2. **The Japanese-locale check:** set a device's system language to Japanese, open a passage
   containing characters whose Simplified and Japanese forms differ (直, 化, 骨, 令 are the usual
   examples; pick from the coverage script's output and record which were used), and screenshot. The
   forms are Simplified. Then remove the `lang` attribute in a debug build and screenshot again — if
   the two screenshots are identical, the check proved nothing and the character sample is wrong.
3. **The bold check (register #8):** render bold hanzi with and without `lang="zh-Hans"` on a device
   whose WebView is in the 139–143 range if one is available, and record the result. On every
   device, bold hanzi uses the bundled bold face, verified by the absence of synthetic slanting or
   smearing at large size and by the font file appearing in the WebView's loaded resources.
4. No tofu: render the sample of headwords `core.md` C0's coverage script produced and assert every
   glyph has non-zero advance width, or screenshot-diff a fixed sample. Say which was used.
5. The package-size table is in `HANDOFF.md`: APK/AAB size, the dictionary's two costs, the fonts,
   and the on-device total.

---

### A4 — Native speech: the TTS adapter, and the phone with no Mandarin voice

**Builds.** `TTSProvider` implemented over `@capacitor-community/text-to-speech` 8.0.2, and the
answer to register #7 — which is the question that decides whether audio tier 3 is a v1 cost.

**Why native, restated in one line so nobody re-litigates it during review:** `window.speechSynthesis`
is undefined in the Android WebView (Chromium 40468168; A1 confirmed or refuted it on a device), so
there is no web fallback on this platform at all. The plugin wraps Android's `TextToSpeech` and
forwards `UtteranceProgressListener.onRangeStart` (API 26+) as an `onRangeStart` event.

**The adapter.** It implements `core.md` C2's interface — `stop()`, utterance identity, the
`start`/`end`/`boundary` event surface, `voices()`, and the `supportsBoundary` capability flag — and
nothing more. Two rules carry over from C2 and from AUDIT 2 and must not be re-decided here:

- **The 0.6x character-by-character mode does not depend on range events.** Range support is
  engine-dependent on Android. Enqueue one utterance per character and drive the highlight off each
  utterance's `start`. `core.md`'s `lib/tts/sequence.ts` already contains that logic and is
  unit-tested with a fake clock; this adapter feeds it, it does not reimplement it.
- **Cantonese is refused, not ranked last.** `lib/tts/speech-synthesis.ts` established this and the
  reasoning is unchanged on a native engine: the card shows Mandarin pinyin, so a Cantonese reading
  is a wrong answer the learner cannot detect. Port the `isChineseVoice` / `isCantoneseVoice`
  predicates rather than writing new ones, so both adapters agree.

**Runtime availability is a three-state answer, not a boolean** (STACK §2.7): query the engine's
language availability at startup; if an engine exists but the Mandarin data is missing, offer the
system's install-voice-data path; if no engine reports Mandarin at all, degrade to a stated
in-app state. The existing `SpeakButton`'s unavailable state — disabled, with the reason as visible
text next to the glyph — is that state and it already exists; do not build a second one.

**Register #7 is the deliverable.** Run the availability query on every device in A0's matrix, GMS
and non-GMS, before and after installing voice data, and record the raw result. AUDIT 2 could not
confirm from Google's own documentation that Google Speech Services' offline zh-CN pack is
downloadable, and could not test a no-GMS device at all.

**What the answer means, written now so the phase's review can act on it:**

| #7 result | Consequence |
|---|---|
| Mandarin available on every target device, offline pack installable | Tier 1 is enough for v1 (STACK §5.3's recommendation stands). Tier 3 stays in §7. |
| Available on GMS, absent on non-GMS | Ship v1 as-is with the honest no-voice state, and record that non-GMS devices are a degraded target. This is defensible because China is not a priority market and non-GMS phones outside it are rare. |
| Absent or unusable on a target device the owner cares about | Tier 3 becomes v1 scope, and STACK §5.3 says price it honestly: a human-recorded ~1,300-syllable set is a **production project**, not a build task, and the cheaper path is generating the set from the tier-2 cloud voice — which turns on a licence question (do the vendor's terms permit redistributing generated audio inside a shipped app?) that must be answered **before** the tier-2 vendor is chosen. Escalate; do not absorb it into this phase. |

**Files.** `lib/tts/capacitor-tts.ts` (new adapter), the provider selection point (one module that
picks the native adapter when running under Capacitor and the Web Speech adapter otherwise — agree
its location with `core.md` C2 so there is exactly one), `tests/unit/tts/**`.

**Acceptance criteria.**

1. Tapping the speaker on a headword speaks it in Mandarin on the GMS device. Recorded as a video or
   as a written observation with the device named — this is the one criterion no automated test can
   make.
2. Hold-to-slow plays character by character at 0.6x with the highlight advancing one character per
   utterance, and **releasing mid-word stops it within one character**. That is `stop()` plus
   utterance identity working; if the sequence runs to completion after release, the phase fails.
3. Starting a new utterance while one is playing cancels the old one and not the new one — the same
   assertion `core.md` C2's unit test makes, now against the real plugin.
4. Register #7's raw output is in `HANDOFF.md` for every device, in all three states (before voice
   data, after, and on the non-GMS phone), with the exact API call used.
5. On a device with no Mandarin voice, the speaker renders disabled with the visible reason and
   nothing throws — assert by disabling the voice on a test device (or by injecting an unavailable
   provider in a debug build) rather than by reasoning.
6. The adapter's unit tests run in the container against a faked plugin bridge, so the logic is
   covered without hardware and only the audio itself needs a phone.

---

### A5 — The dictionary in the package

**Builds.** The Android half of `data.md` D5: the 43 MB SQLite artifact inside the app, copied to
app storage on first launch, opened read-only, and answering queries through the plugin.

**This phase and `data.md` D5 are one piece of work reviewed together.** D5 owns
`lib/dict/runners/capacitor.ts` and the `open()`/copy logic; this phase owns the asset getting into
the package, the Gradle-side plumbing, and the Android measurements. Do not duplicate D5's
acceptance criteria here; add to them.

**The asset path.** `data.md` D1 emits `data/dict-<SCHEMA_VERSION>-<cedictVersion>.sqlite` beside
`data/dict-manifest.json` at the workspace root, and states that each deployable's build copies out
of `data/` — "do not teach `pnpm data` about deployables". So the Android build gains a copy step
into the Android asset root (`android/app/src/main/assets`), and the **exact subdirectory
`@capacitor-community/sqlite`'s `copyFromAssets()` expects must be read from the plugin's own README
and recorded in `HANDOFF.md`** rather than guessed — it is a convention, not an inference, and
getting it wrong produces a silent "database not found" on first launch. The copied file is
gitignored; the copy runs before `cap sync` in the one documented build command from A1.

**The 16 KB page-size check (register #5) is the one that can reject a release.** Play has required
16 KB-page-aligned native `.so` libraries since November 2025, and the plugin bundles SQLCipher's
native library. AUDIT 2 could not verify that `@capacitor-community/sqlite` 8.1.1 ships aligned
libraries. `zipalign -c -P 16 -v` on a real build is the check. It belongs in A7 formally, because
that is where a release artifact exists — but run it here on the debug build the moment the plugin
is in the dependency graph, because discovering it at A7 wastes everything between.

**Two measurements nobody has taken** (register #18 and #11), both against the low-end target named
in A0:

- How long `copyFromAssets()` of a 43 MB file takes, on an empty device and on a device near
  storage capacity, and what peak storage it costs. `data.md` D5 requires this and requires the copy
  to be a visible one-time progress state with a designed low-storage failure path. `core.md` draws
  those two screens; this phase produces the numbers that say how long the progress state has to be
  tolerable for.
- Cold-launch time with the dictionary open, compared against Play's 5 s flag and the 2 s bar STACK
  §2.1 sets for itself. AUDIT 2's guidance is the whole of the optimisation strategy: code-split, and
  **never parse the dictionary at startup** — query it. If the number is bad, that is where to look
  first.

**Files.** `android/app/build.gradle` (or a root script — prefer the script, so the same copy serves
iOS), `.gitignore`, `data/ATTRIBUTION.md` (SQLCipher's BSD notice — D5 owns the text, this phase
confirms it renders in the built app), `HANDOFF.md`.

**Acceptance criteria.**

1. A fresh install on the low-end target reaches a working lookup with **no network at all**: a
   hanzi query, a pinyin query, an English gloss query and a segmented pasted passage all return
   correct results. Aeroplane mode on, verified by hand.
2. `zipalign -c -P 16 -v` output for the build is pasted into `HANDOFF.md`, pass or fail. A fail is
   not a phase failure — it is a decision point, and the options AUDIT 2 names are a newer plugin
   release, a rebuilt native library, or Capawesome's paid plugin.
3. Register #18's timings are recorded: copy duration empty and near-full, peak storage, and what
   happened when the device did not have room. "It did not fit" must produce the designed failure
   state, not a crash.
4. Cold launch on the named low-end target is measured and recorded against the 5 s flag and the 2 s
   bar. If it exceeds 2 s, the phase records what dominates before proposing a fix.
5. Killing and relaunching the app does **not** re-copy the file; changing the manifest's filename
   does. Both asserted on a device.
6. SQLCipher's BSD notice appears in the app's licences screen on the device, not just in the repo.

---

### A6 — The WebView floor, and what the app says below it

**Builds.** A version gate. Short phase, deliberately late, because the floor is determined by which
engine features the reader actually shipped with in `core.md` C3–C5.

**There are two floors and conflating them is the mistake to avoid.**

The **hard floor** is the lowest Chromium in which the app is *correct*. From STACK §6's feature
table: the CSS Custom Highlight API is Chrome **105**+; `caretRangeFromPoint` is ancient in Blink and
needs no floor; `caretPositionFromPoint` is Chrome **128**+ but is only the standards-track upgrade
over a proprietary API that works everywhere; per-character (mono-ruby) `<ruby>` wraps naturally in
*any* Chromium version, and the Chrome 128 line-breakable-ruby work matters only for multi-character
pairs, which this app does not use. So the hard floor is set by the Highlight API — and only if
`core.md` C5 shipped without the span-painting fallback. Establish which it is by reading C5's code,
not by assuming.

The **comfort floor** is where the app is *good*: safe-area insets were reported broken below **140**
(A2), the keyboard bottom inset was fixed in **144** (Capacitor #8432), and the CJK synthetic-bold
regression sat in **139–140** (mitigated by A3's bundled bold weight regardless).

**The recommendation:** gate hard at the Highlight API floor and warn — not block — between there and
the comfort floor. A learner on a five-year-old phone should get a working dictionary with a banner
asking them to update Android System WebView, not a wall. AUDIT 2's mitigation is exactly this:
feature-detect, read the Chromium version from the UA, and show an "update Android System WebView"
banner below the chosen floor; Capacitor has no built-in gate (issue #4884), so this is app code.

WebView has been Play-updated since Android 5, so on a GMS device the banner's advice actually works.
On a non-GMS device it may not, which is another reason the gate warns rather than blocks.

**Prefer feature detection to version parsing wherever a feature can be detected.** The version is
for the *message* ("your WebView is 132; 144 or newer is recommended") and for telemetry-free
debugging; the behaviour branches on `CSS.highlights` existing, not on a number. AUDIT 2 found **no
2026 WebView version-distribution statistics**, so there is no data on which to pick a floor
demographically — pick it from the feature table and say so.

**Files.** A small version/capability module under `apps/app/`, the banner (reuse `core.md`'s banner
component — the app already has the shape in `components/shell/data-banner.tsx`), unit tests over
the UA parser with real UA strings collected in A0 and A1.

**Acceptance criteria.**

1. The UA parser is unit-tested against the real UA strings recorded from every test device, plus a
   deliberately malformed one that must not throw.
2. On a device below the comfort floor, the banner appears once, is dismissible, and the app remains
   fully usable. On a device above it, no banner. Both observed on hardware or on an emulator image
   with an old WebView.
3. Below the hard floor, the affected surface degrades to its fallback rather than breaking — assert
   by feature-flagging `CSS.highlights` off in a debug build and checking the reader still selects.
4. The chosen floors and the reasoning are one paragraph in `HANDOFF.md`, including the fact that no
   version-distribution data exists to validate the choice.

---

### A7 — Release: signing, the AAB, and the checks that gate a store

**Builds.** A signed release Android App Bundle that Play will accept.

**Signing, in two halves.** The local half is standard Gradle: a keystore, a `signingConfig`, and
credentials that live **outside the repository** (a properties file that is gitignored, or
environment variables) with the loss-of-keystore consequence written down next to them. The Play-side
half — which of the console's signing arrangements this account uses, and what it does with the
upload key — is read off the Play Console during A0's or this phase's visit and recorded. No audit
covered signing, so do not take any of it from memory: read the console, write down what it said, and
cite the date.

**Version numbering.** Play orders releases by an integer that must increase on every upload. Pick a
derivation now — a monotonic counter in a file, or something derived from the build — and write it
down, because the failure mode is a release that cannot be uploaded at 11pm.

**The release build is where the debug build's sins surface.** Run, and record:

- `zipalign -c -P 16 -v` on the **AAB** (register #5), not just the debug APK.
- The app boots, the dictionary opens, TTS speaks and the reader selects, all in the release build
  with whatever shrinking is enabled. Code shrinking removing a plugin's reflection target is a
  classic Capacitor release-only failure; if minification is on, exercise every plugin in the release
  build before believing it.
- The AAB's size, and after upload, the **download size Play reports** (register #16 — the audits
  used `gzip -9` as a proxy for store compression and it was never validated). AUDIT 3's ceiling is
  200 MB compressed for a base module, so there is enormous headroom; the number matters for honesty
  in the listing, not for compliance.

**Files.** `android/app/build.gradle`, `android/keystore.properties.example` (the real one
gitignored), `.gitignore`, a release build script, `HANDOFF.md`.

**Acceptance criteria.**

1. A signed AAB is produced by one documented command from a clean checkout.
2. `zipalign -c -P 16 -v` passes on the AAB, with the output pasted into `HANDOFF.md`. If it fails,
   the phase stops here and the escalation is A5's list of three options.
3. The release build is exercised on the low-end target against a written checklist covering every
   plugin: SQLite (dictionary query), TTS (speak), safe area (inset non-zero), back button. Each
   passes in the **release** variant specifically.
4. The keystore's location, its backup, and the consequence of losing it are documented. No secret
   is in the repository — asserted by a grep in CI for the keystore filename and for the properties
   file.
5. The version-code derivation is documented and produces a strictly larger number than the previous
   upload, checked by a script rather than by the builder's memory.

---

### A8 — Play: internal, then the closed test, then production

**Builds.** A Play listing and the two-week gate cleared.

**Start this the day A7 produces an AAB.** AUDIT 2 records — sourced, not confirmed from Google, and
A0 was tasked with confirming it — that personal developer accounts created after 13 November 2023
must run a **closed test with 12 testers for 14 continuous days** before applying for production
access, and that this applies to every stack, so there is no way to engineer around it. Internal
testing has no such gate and should be used from A7 onward for the owner's own devices.

**Twelve testers is the real constraint, not the fourteen days.** A solo developer needs twelve
people with Google accounts willing to install and keep the app installed. Recruit them before the
build is ready, not after; a tester list that is short on day 13 restarts the clock.

**The listing work nobody budgets for.** The Play Console requires a store listing (title, short and
full description, screenshots at required sizes, a feature graphic, an icon), a **Data safety** form,
a **content rating** questionnaire, a privacy policy URL, and target-audience declarations. Two of
those are unusually easy here and should be stated plainly rather than fudged: the app collects
nothing and transmits nothing until `backend.md` exists (every card, review and setting lives in
on-device storage — the same fact `docs/deploy.md` already records about the web deployment), and the
only network calls are to the owner's own AI proxy. Fill the Data safety form to match what the code
actually does, and revisit it the moment `backend.md` lands accounts — an inaccurate Data safety
declaration is an enforcement matter, not a formatting one.

**Attribution ships in the app, not only in the repo.** PLAN.md §5 and CLAUDE.md require CC-CEDICT's
CC BY-SA 4.0 attribution plus a modification notice, Make Me a Hanzi's LGPL notice with `COPYING`,
and now SQLCipher's BSD notice (`data.md` D1/D5). The licences screen already exists at `/settings`;
this phase confirms it renders on the device build and that the store listing does not claim
authorship of the dictionary data.

**Files.** No repository code. `HANDOFF.md` and a short `docs/android-release.md` recording the
listing content, the Data safety answers, and the release checklist, so the second release is a
checklist and not an archaeology exercise.

**Acceptance criteria.**

1. An internal-testing release is installable by the owner from Play, on a device that has never had
   a sideloaded build — this is what proves the signing and the Play-side pipeline, not the local AAB.
2. Twelve testers are enrolled and the closed test's 14-day clock has started, with the start date
   recorded. This criterion is met by *starting*, not by finishing; the phase's review happens at the
   start and a short follow-up records the end.
3. The Data safety form's answers are reproduced in `docs/android-release.md` beside a one-line
   justification for each, and match the code as of that date.
4. The licences screen renders CC-CEDICT, Make Me a Hanzi and SQLCipher on a device build.
5. Play's reported download size and any pre-launch report warnings are recorded (register #16).
6. Production release is a separate, later decision — not part of this phase's completion.

---

## 6. Risks

Each row names the trigger that would tell you it is happening and the mitigation. The first five
are things an audit explicitly could not verify and that this plan depends on; each carries the check
that settles it, and the register number is STACK §4's.

**R1 — `@capacitor-community/sqlite` may not ship 16 KB-page-aligned native libraries (#5).** Play
has required 16 KB alignment for `.so` files since November 2025 and the plugin bundles SQLCipher's
native library; AUDIT 2 could not verify 8.1.1.
*Trigger:* `zipalign -c -P 16 -v` fails, or Play rejects the upload with a page-size error.
*Check:* run `zipalign -c -P 16 -v` on a debug APK in A5, the moment the plugin is in the graph, and
again on the AAB in A7. Do not wait for the store to tell you.
*Mitigation:* a newer plugin release; rebuilding the native library; or Capawesome's paid plugin
(STACK §6 records it as technically the best fit and sponsorware). **This is a rejection, not a
warning, so it gates the release and nothing else in the plan is worth finishing until it is
answered.**

**R2 — A target device may have no Mandarin voice at all (#7).** AUDIT 2 could not confirm from
Google's own documentation that the offline zh-CN pack is downloadable, and could not test a non-GMS
device.
*Trigger:* the availability query returns false on a device in A0's matrix, before or after
installing voice data.
*Check:* A4 runs it on every device, GMS and non-GMS, in all three states.
*Mitigation:* in order — the install-voice-data path; the honest disabled state with its visible
reason, which already exists; and, only if the answer is bad on a device the owner cares about,
promoting audio tier 3 to v1. STACK §5.3 is explicit that tier 3 is an **unbudgeted production
project** unless it can be generated from the tier-2 cloud voice, which turns on a licence question
that must be answered before the tier-2 vendor is chosen. Escalate rather than absorb.

**R3 — The CJK synthetic-bold regression may not be fixed where the audit thinks (#8).** Chromium
446078849; WebView 139–140 stopped synthesising bold for CJK without a `lang` attribute, reported
fixed in 143, unconfirmed — and `issues.chromium.org` was egress-blocked during the audit.
*Trigger:* bold hanzi looks identical to regular on a device in that WebView range.
*Check:* A3's bold check, on a device with a WebView between 139 and 143.
*Mitigation:* already taken — bundle a real bold weight so nothing is synthesised, and declare
`lang="zh-Hans"` (`core.md` C0). The regression becomes an anecdote rather than a defect.

**R4 — Cold start on a low-end device may exceed the bar (#11).** No rigorous benchmark exists in
either direction; the pathological reports AUDIT 2 found (Capacitor #6115, a 13-second migration
report) all trace to large bundles or loading data at boot.
*Trigger:* the measurement in A5 exceeds 2 s, or Play's pre-launch report flags a start over 5 s.
*Check:* A5, on the low-end target named in A0.
*Mitigation:* code-split, and never parse the dictionary at startup — query it, which is the whole
point of `data.md`. If it is still bad, the levers are the entry bundle's size and deferring the
dictionary open until the first query rather than at boot.

**R5 — `copyFromAssets()` of 43 MB is unmeasured and can fail on a full device (#18).** Nobody has
measured it on any platform; the audit's "no failure mode" phrasing skipped past it, and STACK §2.5
corrects it explicitly.
*Trigger:* first launch hangs, or fails on a near-full device.
*Check:* A5 times it empty and near-full and records peak storage.
*Mitigation:* the copy is a visible one-time progress state with a designed low-storage failure path
(`core.md` draws them, `data.md` D5 specifies them). The on-device footprint is ~57 MB, not ~14 MB,
and every size statement must use the doubled figure.

**R6 — A whole cluster of Android facts rests on search snippets (#12).** capacitorjs.com, ionic.io,
capawesome.io and issues.chromium.org were all egress-blocked during AUDIT 2. Capacitor 8's SDK
minimums, the CJK-bold regression, the Play deadlines and the plugin licensing all came from
snippets.
*Trigger:* any of them turns out to be wrong at the moment it becomes load-bearing — the worst case
being a target-SDK or plugin-version fact discovered during A7.
*Check:* A0's docs read, before any code. It is a five-minute task that validates the cluster.
*Mitigation:* A0 is first for exactly this reason, and its acceptance criteria refuse "could not
confirm" without saying what was tried.

**R7 — The 12-tester / 14-day closed test is a calendar gate on a solo developer (#15).** Sourced,
not confirmed from Google.
*Trigger:* discovering it at release time, or reaching day 13 with eleven testers.
*Check:* A0 reads the current policy page and records the wording; A8 starts the clock as early as
possible.
*Mitigation:* recruit testers before the build is ready and start the closed track the day A7
produces a signable AAB. There is no engineering answer — AUDIT 2 notes it applies to every stack.

**R8 — OEM fragmentation in fonts and WebView.** Xiaomi, Huawei and Samsung ship their own CJK faces;
Huawei's own WebView was reported lagging below Chromium 107 by a practitioner; AUDIT 2 found **no
2026 WebView version-distribution statistics** at all.
*Trigger:* a screenshot from one manufacturer's device looks unlike the others, or a feature the app
relies on is missing on a device that is otherwise current.
*Mitigation:* A3 bundles the font, which removes the manufacturer from the typography entirely; A6's
gate handles the engine. Huawei specifically is out of scope (§7) because China is not a priority
market.

**R9 — Native learner data is still an open decision, and it is not this plan's to make.** STACK §2.8
records two live options for cards and reviews on mobile — Dexie in the WebView's IndexedDB, or a
second `Repository` implementation on `@capacitor-community/sqlite` — and register #3 (does ITP's
seven-day eviction reach WKWebView?) is what would decide it, on iOS.
*Trigger:* a build session in this plan starts writing a Dexie replacement because the SQLite plugin
happens to be a dependency already.
*Mitigation:* it is `core.md`'s and `backend.md`'s call. What this plan owes it is not to make it
harder: the plugin is a dependency from A5 onward, so option 2 stays one implementation away. Note
that `web.md` W5 ships the local export and `ios.md`/`android.md` reuse it — the export is the
recovery path until sync exists and this plan does not rebuild it.

**R10 — Capacitor's maintenance story.** OutSystems wound down the commercial Ionic products in 2025
but explicitly kept Capacitor and Ionic Framework open source and maintained (last EOL 31 Dec 2027),
and 8.x is shipping. `@capacitor-community/sqlite`'s original author retired at 6.x and releases
continue from the community.
*Trigger:* a needed fix sits unreleased, or a Play policy change lands with no plugin update.
*Mitigation:* nothing pre-emptive. Recorded so a review does not raise it as new. Capacitor 9 is at
alpha — **stay on 8.5.x** (STACK §2.1: 8.5 adopted UIScene, which the iOS 27 SDK will make
mandatory).

**R11 — The container cannot finish an Android build, and the plan's gates assume it can.** *Measured
2026-09-13:* JDK 21.0.10 and Gradle 8.14.3 are present; there is no Android SDK, `adb` or `zipalign`.
*Trigger:* a phase's acceptance criterion turns out to be unrunnable in CI and quietly becomes "the
builder looked at it".
*Mitigation:* A1 tries installing the SDK through the proxy and records the result. If it works,
every phase gains a compile-only gate. If it does not, say so in `HANDOFF.md` and accept that Android
verification is manual and device-bound — which is a real cost of this platform and should be
visible, not absorbed.

---

## 7. Out of scope for v1

- **A Trusted Web Activity, and Play distribution of the PWA.** AUDIT 2 calls it a near-zero-cost
  extra distribution channel and not the product: no native SQLite, no font-bundling control, a
  hosted origin with Digital Asset Links, and a fallback to the WebView on devices without Chrome.
  `web.md` §7 defers it on the same grounds. Revisit when the app is worth distributing twice.
- **Huawei AppGallery, HarmonyOS, and any China-market build.** China is not a priority market
  (product-decisions §12), which is the single fact that made Capacitor defensible on Android at all
  (STACK §2.1). HarmonyOS NEXT drops Android compatibility entirely, so it would be a separate app
  regardless of stack.
- **Audio tiers 2 and 3** — cloud voice caching and the ~1,300-syllable recorded set — **unless A4's
  register #7 forces tier 3**, which is the one thing in this list that can change during the build.
  Both the "1,300" and the "a few megabytes" are estimates that nobody has measured (STACK §2.7).
- **Play asset delivery / dynamic feature modules for the dictionary.** At ~14 MB compressed the
  base module is nowhere near Play's 200 MB cap, so splitting it buys complexity and nothing else.
  It becomes interesting only if a second dictionary source lands.
- **Widgets, quick-settings tiles, app shortcuts, share-target intents and daily-practice
  notifications.** A share target ("share selected text to Tangram") is genuinely attractive for a
  dictionary and is the first one to reconsider — it is also the first thing that makes the app
  Android-shaped rather than web-shaped, and STACK §2.1 lists "rich native platform features" among
  the things that would have made a different stack right. Deferred deliberately, not forgotten.
- **Tablets, foldables and landscape as designed targets.** The manifest's
  `"orientation": "portrait-primary"` was already removed once (HANDOFF.md, "Phase 6 review fixes"
  §6) precisely so
  a tablet gets the wide layout; that is the whole of the tablet story for v1.
- **Play billing and any subscription.** STACK §5.4: BYOK now, a subscription only if a distribution
  experiment says anyone but the owner will paste an API key.
- **Automated device testing** — Firebase Test Lab, an emulator matrix in CI, Appium. STACK §7 flags
  that there is no native test story at all and that "tested" otherwise silently means "web only".
  This plan's answer for v1 is explicit and modest: unit-tested adapters in the container, a
  compile-only gate if A1 can install the SDK, and written per-phase device checklists. Say that out
  loud rather than implying coverage that does not exist.
- **A second `Repository` implementation on native SQLite for learner data.** Open (STACK §2.8, R9
  above), owned elsewhere, and kept one implementation away by the fact that the plugin is already a
  dependency.
