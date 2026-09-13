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
on API 36. None of that exists now — there is no `android/` directory anywhere, no Capacitor
dependency, no bundled font file in the repo, and no `env(safe-area-inset-*)` in any stylesheet.

## 2. Scope boundaries

**This plan owns:**

- The Capacitor **Android** project: the committed `apps/app/android/` tree, the Gradle wiring, SDK
  levels, and the copy steps that get `dist/` and the two data artifacts into the package. It does
  **not** own the shared Capacitor surface — the config file, the Capacitor dependencies, the
  platform-detection seam and the cross-platform plugin adapters. See the `ios.md` row below, which is
  the most important row in this table.
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
- Every register check in STACK §4 that needs an Android phone in hand: **#5, #7, #8, #11** (Android
  half), **#18** (Android half), **#19**. STACK §4's precondition table binds exactly this set to "a
  physical Android phone with Google Mobile Services".
- Two register checks that are browser work and need no phone at all: **#15** (read Play's current
  closed-testing policy) and **#16** (read the download size Play reports after the first upload).
  They are listed separately on purpose, because §5's standing rule blocks a phase whose register
  check could not be run for want of hardware and neither of these may ever be blocked on that
  ground.

**This plan does not own, and must not start:**

| Not here | Owner | Where the seam is |
|---|---|---|
| The Vite build, `apps/app/index.html`, the router, the service worker, PWA install, web font *delivery*, the API base and the gate's client half | `web.md` | This plan consumes `apps/app/dist/` as a directory of static files and never edits what produces it. The obligation runs the other way in `web.md` §2's scope table — *"a build with no absolute-origin assumption … and a `navigate` boundary they can drive"* — and **W1** discharges it, including the subpath-build criterion. The two web-build changes this plan's phases depend on — `viewport-fit=cover` on the viewport meta and a native-platform branch in `components/pwa/register-sw.tsx` — are **both in W1's own Files list**, so they arrive with the build rather than being handed over; this plan asserts them on a device and never edits the files. This plan owes `web.md` nothing but the origin string the app actually runs from. |
| Design tokens, `components/ui/**`, the tab bar, per-character ruby, drag-select, the `TTSProvider` **interface**, the web TTS adapter, the font *families* and the coverage script | `core.md` | `core.md` C0 names the faces and runs `pnpm font:coverage`; this plan puts the chosen file in the package and checks it on real hardware. `core.md` C7 owns the tab bar and the CSS variable it reads; this plan owns the plugin that fills that variable. |
| The SQLite schema, the `DictStore`/`SqlRunner` interfaces, `lib/dict/runners/capacitor.ts`, the artifact's name and manifest | `data.md` | Exactly as `data.md` §2 states it: that plan owns the file and the runner that opens it, this plan owns getting the file into the app package and the native project that runs it. A5 below is the Android counterpart of `data.md` **D5a** — the Android-runnable half of the old D5 — and shares its acceptance criteria. |
| The iOS project, Xcode, the App Store, and everything that needs a Mac | `ios.md` | The iOS build itself needs Apple hardware and no phase in this plan does. `data.md`'s D5/D5a split and A1's independence from `core.md` C7 are what make that true rather than aspirational; both are settled in [`wave-zero.md`](wave-zero.md) §4. |
| **The shared Capacitor surface**: `apps/app/capacitor.config.ts` and its location, the `@capacitor/*` dependencies and the `cap` scripts in `package.json`, `lib/platform/native.ts`, and the JS-side adapter for any plugin whose JS API is identical on both platforms (today: `lib/tts/capacitor.ts`) | **whichever mobile plan runs first** — `ios.md` **I0** by default | `ios.md` §2 claims these in terms: *"`android.md` consumes these; it must not fork them"*, and offers the reciprocal — *"If `android.md` starts first, the same rule applies in reverse and this plan's I0 collapses to a review."* This plan takes I0's side of that bargain in full, including its location decision (below). Whichever plan lands the surface records the interface in `HANDOFF.md`; the other reviews and extends it. |
| The server, accounts, sync, BYOK custody, the `/api/ask` contract | `backend.md` | This plan owes `backend.md` one fact — the exact origin the WebView runs from, so CORS and the gate can allow it — and nothing else. |
| Audio tiers 2 and 3 (cloud voice, the recorded syllable set) | out of scope for v1 (§7), unless A4 forces the question | A4 runs the check that decides it and writes the answer down; it does not build a syllable set. |

**The shared surface, settled here so two build sessions cannot start in the same files at two
different paths.** STACK §7's rule is that shared surfaces are settled before parallel work starts,
and the Capacitor config, the platform seam and the TTS adapter are shared by construction: the
`@capacitor-community/text-to-speech` JS API is the same object on both platforms with different
native code underneath. `ios.md` I0 settles them and this plan **adopts its decisions verbatim rather
than re-deciding them**:

- **Location.** `apps/app/capacitor.config.ts` with `webDir: 'dist'`, and `apps/app/ios/` and
  `apps/app/android/` beside it. I0's reason is mechanical — `webDir` resolves relative to the config,
  so a config anywhere else needs `dist/` copied to it on every build. This plan has no better
  argument and does not offer one; every `android/**` path in §5 is under `apps/app/`.
- **The platform seam.** `lib/platform/native.ts` is the one module that answers "is this a Capacitor
  WebView, and which platform". Every native branch this plan adds — the TTS adapter choice, the
  service-worker gate, the safe-area source, the API base — imports from it. I0's acceptance criterion
  greps for stray `window.Capacitor` / `isNativePlatform` outside that module, and this plan must not
  be what makes that grep fail.
- **The TTS adapter.** `lib/tts/capacitor.ts`, created by `ios.md` I4. A4 below **extends and
  Android-reviews that file**; it does not fork it and it does not invent a second filename.

**If this plan runs first**, the reciprocal clause applies: A1 creates the config, the dependencies
and `lib/platform/native.ts` at exactly the paths above, A4 creates `lib/tts/capacitor.ts`, both are
recorded in `HANDOFF.md` as settled, and `ios.md` I0 and I4 collapse to reviews. **What must not
happen is either plan choosing differently.** The orchestrator decides which mobile plan starts and
writes that decision into `HANDOFF.md` before either does; §4's gate table carries `ios.md` I0 as a
gate on A1 on the assumption that iOS goes first, which is the default because I0 also carries the
Apple enrolment, the longest non-hardware lead time in either plan.

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

**The web app assumes a server origin, and it will still assume two of the three when A1 runs.**
`public/manifest.webmanifest` declares `"id": "/"`, `"start_url": "/"`, `"scope": "/"`, `theme_color`
`#0f766e` and five icons under `/icons/`; `app/layout.tsx` composes
`components/pwa/register-sw.tsx`, which registers a service worker in production; the dictionary is
fetched from `/api/dict/*`. One of those three is gone before this plan starts and two are not, and
pretending otherwise is how a phase gets an acceptance criterion it cannot meet:

- **The service worker is gated off on native by `web.md` W1.** W3 rewrites the worker; the native
  branch on `components/pwa/register-sw.tsx` — registration suppressed under `lib/platform/native.ts`
  — is in **W1's own Files list and acceptance criteria**, so it arrives with the build A1 packages.
  What is still this plan's is the **assertion on a real device** that no worker registers inside the
  app — see A1.
- **The dictionary is still fetched over HTTP.** `data.md` D6 deletes `app/api/dict/**`, and it runs
  **last** in that plan, after `core.md` has re-pointed every consumer at `DictStore`. A1's gate is
  `web.md` W1, whose own acceptance criteria still require `tests/e2e/d/smoke.spec.ts`'s `runSmoke`
  over all eight API route files to pass. So at A1 the app inside the WebView has **no working
  dictionary**: the fetch resolves against the Capacitor local origin and fails. A1's criteria say so
  explicitly rather than asserting a lookup that cannot work yet.
- **The manifest's `start_url` and `scope`** stop mattering inside the package, because Capacitor
  serves `dist/` from the root of a local scheme; `web.md` W1's subpath-build criterion is what proves
  the bundle survives that.

The dictionary only works inside the app at **A5**, which is where `data.md` D1's artifact and D5a's
runner arrive. §4's gate table is written against that reality.

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
| A Google Play developer account | A0, A8 | The registration fee is **unpriced by every audit** — read it off the Play Console. No audit establishes the identity-verification lead time on a new personal account either, and A8's 14-day gate hangs off the day the account becomes usable, so A0 records the verification state and any stated processing time on the day the fee is paid. Treat it the way `ios.md` I0 treats the Apple enrolment: the longest non-hardware lead time in the plan. |

**Sibling-plan gates.**

| Phase | Needs |
|---|---|
| A0 | **Two halves with different preconditions.** The Play Console visit and the register-#12 docs read need only network access and a payment method, and run first. The device matrix needs **every phone in the hardware table above, in hand** — a WebView version and a UA string are read off a handset, not out of a spec. See A0. |
| A1 | `web.md` **W1** — a Vite build that emits `dist/` and boots from a non-`/` origin. `web.md` **W0**'s workspace layout, so `dist/` has a stable path. `ios.md` **I0** — the shared Capacitor surface (§2): the config file at `apps/app/capacitor.config.ts`, the `@capacitor/*` dependencies and `lib/platform/native.ts`. Most of I0 runs in the container and needs no Mac, so it is not blocked by Apple hardware even though it lives in the iOS plan. If A1 runs first, A1 creates that surface at I0's paths and I0 becomes a review. **Nothing from `core.md`** — A1 boots whatever shell W1 produced and re-baselines its checklist at C7, exactly as `ios.md` I1 does; see A1. |
| A2 | `core.md` **C1** (the `TabBar` primitive) and **C7** (the phone shell), because an inset with nothing to inset is untestable. `web.md` **W1**, whose Files list carries the `viewport-fit=cover` attribute on `apps/app/index.html`'s viewport meta — without it every `env(safe-area-inset-*)` is zero. |
| A3 | `core.md` **C0** — the token layer, the `lang="zh-Hans"` root rule, and `pnpm font:coverage`'s output for the faces the visual language actually uses. `web.md` **W6** — the self-hosted subsets and its cmap coverage assertion. A3 measures what W6's files cost in a package; it does not choose a different set of files. |
| A4 | `core.md` **C2** — `TTSProvider` widened with `stop()`, utterance identity, an event surface and `supportsBoundary`. **C2 gates A4 and nothing earlier.** An earlier draft of this row quoted `core.md`'s "before any mobile plan starts"; that reading is retired. A1–A3 consume nothing from `TTSProvider`, exactly as `ios.md` says of I0–I3, and `core.md` §4 now says the same. `core.md` **C6** — the hold-to-slow control and `lib/tts/sequence.ts` as a working interaction; C2 creates the sequencer file but C6 is what gives it a hold gesture and a highlight to advance, and A4's slow-mode criterion exercises C6, not C2. `ios.md` **I4** if iOS ran first, because A4 extends `lib/tts/capacitor.ts` rather than creating it. |
| A5 | `data.md` **D1** (the artifact, its manifest and the `data/*.sqlite` gitignore rule) and **D5a only** — `lib/dict/runners/capacitor.ts`, the `open()`/copy logic and the manifest contract. D5a's hardware precondition is an Android phone; **D5b** is the iOS half and A5 does not wait for it. See the note below. |
| A6 | `core.md` **C3–C6**, because the floor is decided by which engine features the reader actually ships against *and* by which of them C5 already degrades from. |
| A6a | A1 (a project to put an icon in) and `core.md` **C0** (the ground colour the launch theme uses). Otherwise independent — the icon set is generated in the container. |
| A7, A8 | Everything above, plus A0's account in a usable, verified state. A8 additionally needs `web.md` **W7** — the Astro site's `/privacy` and `/support` pages, live at the apex with their exact URLs in `HANDOFF.md`. Play's listing will not accept a submission without the privacy policy URL, and this plan does not write the page. |
| — | **Nothing from `backend.md`.** The app is usable offline with the AI answer disabled; `web.md` W4's header-based gate and the API base are what make it reachable when the server exists. A1 and A7 record the origin and prove or defer one real call — see A1 and A7. |

**A5's gate is `data.md` D5a, and D5a needs no Apple hardware.** The old D5 opened *"This phase cannot
start without a Mac with Xcode 26, a physical iOS 26 device and at least one Android phone"* and folded
registers **#20** (FTS5 behind the SQLCipher **iOS** pod) and **#6** into one session; taken literally
that blocked A5 — and therefore A7 and A8 — on an iPhone. It has been split. **D5a** is the
Android-runnable half and states its own precondition: a Capacitor Android project that builds and
installs, and an Android phone. No Mac, no iOS device. **D5b** is the iOS half, and it consumes D5a's
`lib/dict/runners/capacitor.ts` unchanged.

So what A5 consumes is D5a in full: `lib/dict/runners/capacitor.ts`, the first-launch copy logic, the
read-only open, the manifest contract and the fixed query list, with the Android halves of registers
**#6**, **#11** and **#18** answered in D5a's own device session — the same session A5's measurements
run in. What A5 does **not** wait for is D5b: register #20, the iPhone halves of #6 and #18, and the
iOS side of "identical results on both devices". If D5b happens to land first, D5a reduces to its
Android checks against the same file; the runner is platform-neutral either way.

---

## 5. Phases

Ten phases. Every phase ends the way PLAN.md §4 says — `pnpm lint`, `pnpm test`, the phase's specs
green, an adversarial review, a commit — with two Android-specific additions: **every device
measurement is pasted into `HANDOFF.md` with the command that produced it and the device it ran on**,
and **a phase whose register check could not be run because the hardware was absent is blocked, not
complete**. A0, A6 and A6a are short. A1, A4, A5 and A8 are the substantial ones.

**Every path in this document is post-W0.** `web.md` W0 is a `git mv` of `app/`, `components/`,
`lib/`, `public/`, `scripts/` and `tests/` into `apps/app/`, and every phase here runs after it. So a
bare `lib/tts/capacitor.ts` below means `apps/app/lib/tts/capacitor.ts` on disk, and likewise for
`components/**` and `tests/**`. The exceptions are `data/` and `HANDOFF.md`, which W0 keeps at the
workspace root, and the native trees, which are written out in full as `apps/app/android/**`.

A note on ordering that is easy to get wrong: **A8's closed test is a 14-day calendar gate, not a
work item.** Start the Play tracks as early as an installable signed build exists (A7), and let
A8's testing period elapse while later work continues. Do not discover the two weeks at the end.

---

### A0 — The blocked docs, the Play account, and the device matrix

**Builds.** No code. It produces the facts every later phase asserts against, and it is the cheapest
phase in this document by a wide margin.

Three jobs, and **the first two need no hardware while the third needs every phone**. That split is
the whole reason this phase is ordered the way it is: jobs one and two are a browser and a payment
method and can run on day one, in parallel with `web.md` and `core.md`; job three cannot start until
the handsets are in hand, and under §5's standing rule an A0 that has not produced the device matrix
is blocked, not complete. Run one and two, record them, and leave the phase open for three rather
than declaring it done.

**One: re-read the five egress-blocked sources (register #12).** AUDIT 2 could not reach
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
- **Google's current 16 KB page-size documentation, and specifically which artifact and which tool it
  names.** This one is added because A5, A7 and §6's R1 all rest on it and no audit read it. AUDIT 2
  records only the command shape — *"the SQLite plugin's SQLCipher library must be 16 KB-aligned
  (unverified for 8.1.1; check `zipalign -c -P 16`)"* — with **no artifact named**, and STACK register
  #5 writes it as `zipalign -c -P 16 -v <aab-or-apk>` without citing a source for either. Nothing
  establishes that `zipalign` accepts an `.aab` at all; alignment is a property of zip entries in an
  installable APK, and Play generates those from the bundle. So record three things: whether the check
  is zip-entry alignment of a delivered APK or ELF load-segment alignment of the `.so` (or both), the
  tool Google names for each, and the tool Google names for generating an APK set from an AAB. A7's
  release gate is written against whatever this returns.

**Two: open the Play Console (register #15 and #16).** Pay the one-time registration fee and record
what it was, **and record the account's verification state and any stated processing time on the same
day** — A8's fourteen-day calendar is drawn from the date the account becomes usable, not the date the
fee cleared. Read the current policy on the closed-testing requirement — AUDIT 2 records "12 testers,
14 days, for personal developer accounts created after 13 November 2023", sourced but not confirmed
from Google — and record the exact current wording, the account type it applies to, whether this
account is subject to it, and **what the page says about tester continuity**, because A8 plans a
fortnight around it. Read the target-API deadline in the same visit: AUDIT 2 says target API 36 has
been required since 31 August 2026 with an extension available to 1 November 2026. While the console
is open, capture the store-listing checklist it actually presents — A8 needs it and no audit covers
it.

**Three: name the devices** (needs the handsets). A table in `HANDOFF.md` with, for each phone
available: model, Android version, **Android System WebView version** (read it from the WebView's own
settings entry and from the UA string, and record both — they are the same number by different routes
and the second is what A6's gate parses), whether Google Mobile Services is present, RAM, and free
storage. One of them is designated **the low-end target** and every performance number in A5 and A6 is
quoted against it by name. Note explicitly whether any device in the matrix is **below WebView 144**,
because A2's keyboard criterion and A3's bold check both need one and neither can conjure it.

**Files.** `HANDOFF.md` (new sections), `docs/plans/android.md` (correct any fact this phase
disproves — a plan that contradicts a source it cites is worse than no plan).

**Acceptance criteria.**

1. Every one of the four issue/PR ids above is either confirmed with a URL and a one-line status, or
   marked "could not confirm" with what was tried. No id is left resting on a search snippet.
2. The 16 KB page-size check is written down as a **named tool against a named artifact**, with the
   URL and date, or marked "could not confirm" with what was tried. A7's acceptance criterion 2 is
   rewritten to match whatever this says before A7 runs.
3. The Play registration fee, the account's verification state, the closed-testing requirement and its
   tester-continuity wording, the target-API deadline and the store-listing checklist are recorded
   verbatim with the date read and a link.
4. The Capacitor local origin string, as documented, is in `HANDOFF.md` and `backend.md`'s author has
   been told. A1 checks it against the origin the running app reports.
5. `HANDOFF.md` contains the device table with a device explicitly labelled "the low-end target", and
   an explicit yes/no on whether any device in it is below WebView 144. Until this exists the phase is
   blocked, not complete — but jobs one and two are recorded and are not held hostage to it.

---

### A1 — The Capacitor Android project, and the first boot

**Builds.** An installable debug APK of the current app, running on a real phone.

**A note on what "the shell" means at this point, because it is not three tabs yet.** The three-tab
shell is `core.md` C7, and §4 deliberately does **not** gate this phase on it. C7 sits after C5 in
`core.md`'s sequence and `ios.md` I2 forbids any C5b production file landing before a physical iOS 26
device has answered register #1 — so gating A1 on C7 would put Android's first phase behind an iPhone,
which is the opposite of this plan's premise and of STACK §4's claim that the two mobile tracks are
independent. A1 therefore puts on a device **whatever shell `web.md` W1 produced**: today's
`components/shell/nav.ts` declares **seven** routes (Today, Lookup, Review, Read, Lists, Stats,
Settings) and W1 ports that app to Vite rather than restructuring it. So this phase's criteria and its
standing device checklist are written against the routes that exist at this commit, and **`core.md` C7
is the phase that re-baselines the checklist** to three tabs. Say that in `HANDOFF.md` when the
checklist is written, so the next reader knows a seven-row checklist is correct rather than stale.
This is exactly what `ios.md` I1 does, and for the same reason.

**The setup, and what it inherits rather than creates.** `ios.md` I0 owns the shared Capacitor
surface (§2): the `@capacitor/core` and `@capacitor/cli` dependencies at the versions STACK §6 pins
(8.5.2, 2026-09-11), `apps/app/capacitor.config.ts` with `webDir: 'dist'`, and `lib/platform/native.ts`.
**If I0 has landed, this phase adds the Android platform package to that config and nothing else** —
it does not create a second config, does not choose a different location, and does not re-pin the
Capacitor version. If this plan is running first, A1 creates all three at exactly I0's paths, records
them in `HANDOFF.md` as settled, and I0 collapses to a review.

What is unambiguously this phase's: `npx cap add android`, and **committing `apps/app/android/`**.
Capacitor's native directory is a source artifact you will edit (Gradle config, manifest entries, the
asset copy) rather than build output; treating it as generated means every edit is lost on the next
regeneration. Gitignore the contents that are genuinely generated — the Gradle build directories, and
the directory `cap sync` copies `dist/` into, whose path is read off the first sync rather than
assumed.

**Two gitignore rules that do not exist yet and are worth one sentence each**, because the failure is
a 43 MB binary in git history. The repository's only data rule today is `data/*.json`; it does **not**
match `data/dict-<schema>-<cedict>.sqlite`, and `data.md` D1 owns adding `data/*.sqlite`. It equally
does not match the copy of that file under the Android asset root, and **that rule is this plan's** —
add it here rather than at A5, so the ignore exists before the file that needs it. `git status` clean
after a full build is an acceptance criterion below.

The build order is: build the web app, copy the data artifacts (A5), then sync. Add that as a root
script so it is one command and nobody does it half-way.

**SDK levels.** minSdk 24, compileSdk 36, targetSdk 36 — Capacitor 8's own defaults per AUDIT 2, and
36 is what Play requires. Assert them rather than accept them: a Gradle property nobody looked at is
how a target-API rejection happens.

**The service worker must not register inside the app, and this phase is where that is proved on
Android.** `components/pwa/register-sw.tsx` registers `public/sw.js` in production. Inside Capacitor
the web assets are already local and already versioned by the app build, so a worker adds nothing and
can serve a previous build's shell after an app update. `ios.md` I1 states the deeper problem plainly:
*whether a service worker even registers under Capacitor's local scheme is not established by any
audit* — and Android WebView supports service workers, so this is at least as live here. The gate
itself is **`web.md` W1's**: the native branch off `lib/platform/native.ts` is in W1's Files list and
its acceptance criteria. What is this phase's is the **device assertion** that no worker registers
inside the running app.

**Three register checks cost seconds each while a device is in hand.**

- **#19:** log `typeof window.speechSynthesis` from the Capacitor Android WebView. AUDIT 2 says it is
  `undefined` and that this is why the native TTS plugin is mandatory rather than convenient. If it
  is defined, the plugin decision does not change — the enhanced voices and the range events still
  argue for it — but the justification in A4 does, and `core.md` C2's `supportsBoundary` fallback
  gains a third case to think about.
- Record `navigator.userAgent` and the Chrome version inside it on every test device. This is A6's
  input and it is free here.
- **Read `window.location.origin` off the running app** and reconcile it with the literal A0 recorded
  from the documentation. `ios.md` I1 warns that no audit records the spelling; A0's value is what the
  docs say and this is what the app says, and `backend.md`'s CORS allow-list and `web.md` W4's gate
  both key on the second one. If they differ, the observed value wins and A0's `HANDOFF.md` entry is
  corrected.

**Also here, because it is the first thing a tester will press:** the **hardware back button**.
`web.md` §2 assigns it to this plan and nothing else in any plan defines its behaviour — `core.md` C7
will define three tabs and tab state that survives navigation away and back, but it contains no
back-button model and no tab history. So this phase writes one. It is stated below against the
three-tab shell, because that is what it ultimately has to serve; at A1 it is **wired and exercised
against whatever routes W1 produced**, and the checklist is re-baselined at C7 along with the rest.
It is small enough to state in full rather than gesture at:

1. A back press with a sheet, dialog or overlay open closes that and stops.
2. Otherwise, if the current tab's own history stack is deeper than its root, pop it.
3. Otherwise, if the tab is not the **first** tab (Look up), switch to the previously visited tab,
   maintaining a most-recently-visited stack of tabs and popping it — not a fixed left-to-right order,
   because a learner who went Look up → Library → Practice expects back to return to Library.
4. At the root of the first tab, or with the tab stack exhausted, **background the app** rather than
   finishing the activity, so resuming returns to where they were mid-session.

Each of those four is a row in the acceptance checklist with that expected result — rows 2 to 4 read
against W1's routes at A1 and against the three tabs after C7. Wire it through whatever plugin A0's
docs read named for the hardware back button, against the router history `web.md` W1 provides, and put
the handler in one module so there are not two competing navigation owners; record its placement in
`HANDOFF.md` so `core.md` C7 adopts it rather than writing a second one.

**Files.** `apps/app/android/**`, `.gitignore`, a root `pnpm android:sync`-style script, the
back-button handler (one module in the shell layer, its placement recorded for `core.md` C7 to adopt),
a unit test asserting the SDK levels. `package.json`, `apps/app/capacitor.config.ts` and
`lib/platform/native.ts` only if this plan is running before `ios.md` I0 — otherwise they are I0's and
this phase reads them. `components/pwa/register-sw.tsx` is **`web.md` W1's** and is not edited here.

**Acceptance criteria.**

1. A debug APK builds and installs on a real device, and every route the W1 build ships renders and
   navigates — the seven of `components/shell/nav.ts` unless C7 has already landed, in which case the
   three tabs. **What does not work yet, and must be written down rather than discovered:** the
   dictionary. `data.md` D6 has not run, so `/api/dict/*` resolves against the local origin and fails;
   the expected state is `core.md` C4a's dictionary-unavailable screen, not a crash and not a blank
   screen. Assert that state explicitly. Lookup starts working at A5.
2. The build is reproducible from a clean checkout with one documented command sequence, written
   into `HANDOFF.md`. "It works on my machine after some fiddling" fails this phase.
3. `minSdkVersion`, `compileSdkVersion` and `targetSdkVersion` are asserted to be 24/36/36 by a check
   that fails the ordinary gate. **There is no CI in this repository** — no `.github/` directory
   exists and no sibling plan creates one — so the mechanism is a unit test under `tests/unit/` that
   reads the Gradle config and asserts the three values, in the pattern `tests/unit/deps.test.ts`
   already uses for repo-shape assertions, and it runs under `pnpm test`. That is what stops a
   plugin's own defaults from quietly overriding them.
4. Register #19 is answered in `HANDOFF.md` with the logged value and the device, and the observed
   `window.location.origin` is recorded beside A0's documented literal with a note on whether they
   match.
5. `navigator.serviceWorker.getRegistrations()` returns empty inside the app, read from the WebView
   inspector on the device. The unit test over `register-sw.tsx`'s native branch is `web.md` W1's and
   is not duplicated here; this criterion is the device half W1 cannot run.
6. The hardware back button is exercised by hand down the four-row checklist above — overlay open,
   route history non-empty, tab root with a previous tab, first-tab root — with each expected result
   stated and matched, and the checklist marked in `HANDOFF.md` as re-baselined at `core.md` C7.
7. `HANDOFF.md` records whether the container can install an Android SDK through the proxy, and if
   it can, a compile-only `assembleDebug` gate exists that runs without a phone.
8. `git status` is clean after a full build, including the `cap sync` output directory. This is the
   criterion that catches a missing gitignore rule before a large binary is committed.

---

### A2 — The shell fits the device: edge-to-edge, insets, and the keyboard

**Builds.** The app drawing correctly under the status bar, the gesture bar and the keyboard, on
API 36.

**Why this is not cosmetic.** AUDIT 2: API 36 **forces** edge-to-edge, and Chromium builds below 140
were reported to return **0 px** for the `env(safe-area-inset-*)` values, with the keyboard's bottom
inset fixed only in Chromium 144 (Capacitor #8432). That is why STACK §2.1 lists a safe-area plugin as
the third mandatory Android dependency — not a demographic argument about which phones beginners hold,
because AUDIT 2 found **no 2026 WebView version-distribution statistics** at all and also records that
WebView is Play-updated on every GMS device since Android 5, which cuts the other way.
`@capacitor-community/safe-area` is the plugin STACK §6 names; its version is A0's to establish, since
STACK §6 records the row as "version not recorded by the audit".

**The shape, and the discriminator that an earlier draft of this plan did not have.** The plugin
publishes inset values; the shell reads them from CSS variables; `core.md` C7's tab bar and every
bottom sheet consume those variables. `core.md` owns the variable's name and its consumers.

The tempting rule — "use `env()` when it is trustworthy and the plugin when it is not" — has no
discriminator, and it is worth saying why so nobody reinvents it under a deadline: the broken
behaviour AUDIT 2 records is that Chromium below 140 reports **0 px**, and 0 px is also the correct
answer on a device with no bottom inset. Reading `env()` cannot distinguish broken from genuinely
zero, and no audit establishes a runtime test for it. So the rule is by **platform**, not by
trustworthiness:

> One variable per edge, defined once. Its value is `env(safe-area-inset-*)` by default. On Android
> under Capacitor — branched off `lib/platform/native.ts`, not off a version sniff — the plugin's
> published value overrides it.

This is a superset of what `ios.md` I5 does: I5 takes `env()` directly on iOS, records that whether
WKWebView reports it correctly under Capacitor is unestablished, and its Files note says the token
file is `core.md`'s. The rule above leaves I5's iOS behaviour exactly as it is and adds the Android
override, so one definition serves both platforms and neither mobile plan reworks the other's. **The
variable is defined in `core.md`'s token file by agreement; this phase writes the Android runtime that
fills it.**

**The keyboard is the half that will actually break, and getting a pre-144 WebView to test it on is
not free.** The lookup box is the first thing on the Look up tab and a practice write-card is an
input; both are bottom-ish on a phone. Test each with the keyboard open on a device at or above
WebView 144 and, if one exists, below it. **Nothing in this plan produces a below-144 device**: WebView
is Play-updated on every GMS handset, so a current phone will be above the floor, and downgrading one
is not a work item anywhere. A0's matrix records whether any device the owner owns is below 144. If
none is, the two things to try, in order, are an **emulator system image old enough to carry an old
WebView** — plausible but unverified by any audit, so record whether it actually worked — and, failing
that, recording the pre-144 behaviour as **untested** and carrying it into A6 as an open risk against
the comfort floor. What is not acceptable is asserting the pre-144 result from the audit's description.

If the pre-144 behaviour does turn out to be unusable, the mitigation is the one A6 formalises: a
comfort floor with a banner asking the user to update Android System WebView, which on a GMS device is
advice that actually works.

**`viewport-fit=cover` arrives with W1.** `env(safe-area-inset-*)` is zero without it, and nothing in
the repo sets it today (`app/layout.tsx` exports `viewport` with no `viewportFit`). The file is
`apps/app/index.html`, which `web.md` W1 creates and owns, and the attribute is in **W1's Files list
and its acceptance criteria** — the same one-line edit both mobile plans need, made once, where the
file lives. This phase gates on W1 and then builds on top of it; it does not make the edit and does not
carry a conditional in case W1 did not.

**Files.** `apps/app/capacitor.config.ts` (plugin configuration only — the file is I0's),
`apps/app/android/app/src/main/**` (theme and manifest entries the plugin requires), the Android
runtime that fills the inset variables (a module under `apps/app/` branching off
`lib/platform/native.ts`). The variable *definitions* land in `core.md` C0's token file by agreement;
`apps/app/index.html` is `web.md` W1's and is not edited here.

**Acceptance criteria.**

1. Screenshots on at least two devices with different notch/gesture-bar geometry: the tab bar sits
   above the gesture bar, the header clears the status bar, and no content is under either.
2. With the keyboard open on a post-144 WebView, the focused input is visible and the tab bar is not
   floating in the middle of the screen. Repeated on any pre-144 device in A0's matrix, or on an
   emulator image old enough to supply one; if neither exists, `HANDOFF.md` records that the pre-144
   behaviour is **untested**, what was tried to obtain a device, and carries it to A6. Every result is
   recorded by WebView version.
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

**What is actually decided here, and what is inherited — and the answer is "less than an earlier
draft claimed".** `core.md` C0 names the families (product-decisions §11: Noto Serif SC for hanzi,
with Noto Sans SC as the alternative where a sans hanzi reads better — note the divergence from AUDIT
2, which assumed Noto Sans SC) and runs `pnpm font:coverage` against the CC-CEDICT headword character
set. `web.md` W6 self-hosts the files, splits them by `unicode-range`, and — this is the part that
settles the Android question — puts them under **`apps/app/src/fonts/`** referenced from
`src/styles/fonts.css`, deliberately *not* under `public/fonts/`, so Vite emits them into the hashed
asset directory the service worker's cache rule already covers. They are therefore in `dist/`, and
**Capacitor inherits the web's fonts with no Android font pipeline.**

**The full-face option, resolved rather than left hanging.** An earlier draft said in one breath that
no Android font pipeline should exist and in the next that the package might ship the **full** face
instead of the subsets. Those are incompatible: a full face that is not in `dist/` is exactly that
separate pipeline — a second set of files, a second `@font-face` block conditioned on the native
platform, and a build step to place them — and a full face that *is* in `dist/` lands in the web
build and blows W6's first-load budget (two weights of a full SC face is 9–18 MB by AUDIT 2's own
4.5–9 MB-per-weight figure).

The option is **closed, in favour of the subsets**, for a reason that is about correctness rather than
taste. The tofu argument for a full face is already answered by W6: its acceptance criterion asserts
the **union of the shipped subsets' `cmap` tables covers `core.md` C0's headword character set**, per
face and per weight, failing with the list of uncovered codepoints. If that criterion passes there is
nothing a full face adds in coverage. What is left is the many-small-requests concern over the local
scheme, which is a **measurement, not an argument** — so A3 measures it (below) and records the
number. If and only if that number turns out to matter does the full face come back, and then it comes
back as a **`web.md` W6 change** — a native-only `@font-face` set built by W6 and shipped in `dist/`,
written into `HANDOFF.md` as a need per §2's scope table — not as an Android pipeline built here.

**Budget the package honestly, with the right number.** `data.md` D5a is explicit and this plan had it
wrong: use **~19.5 MB packaged + 43.1 MB expanded ≈ 63 MB**, not 57 MB. The packaged half is the
`gzip -9` figure from D1's size table, because *"neither an AAB/APK nor an IPA compresses bundled
assets with brotli; the 13.9 MB brotli figure belongs to D4's web transfer budget and nowhere else"*.
And 19.5 MB is itself a proxy: **STACK register #16** records that the audit used `gzip -9` as a stand-in
for what the stores actually do, and its check is to read the real download size in the Play Console
after the first upload. So the 63 MB is an **estimate with a named unverified half**, it is what A3
quotes, and the figure that finally settles it is A7's Play-reported download size. Do not write 63 MB
into `HANDOFF.md` as a measurement.

**Files.** `apps/app/src/fonts/**` and `src/styles/fonts.css` are `web.md` W6's and are read here, not
edited. `apps/app/android/app/src/main/assets/**` is in this list only if the closed full-face option
is ever reopened, which would make it a W6 change first.

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
4. No tofu on the device. **Do not assert non-zero advance width** — `web.md` W6 spells out why that
   check is worthless: a missing glyph renders as `.notdef`, the tofu box, which has a non-zero
   advance, so the assertion passes on precisely the failure it is written to catch. The coverage
   guarantee is W6's `cmap`-union assertion and this phase does not duplicate it. What this phase adds
   is the device-side spot check W6 cannot run: screenshot-diff a fixed sample of the headwords
   `core.md` C0's coverage script produced, on every test device, against the same sample rendered on
   one reference device. Say which sample was used.
5. **The font numbers, and only the font numbers.** A debug APK built with the subsets, and its size
   delta against the same build with the hanzi faces removed — that is the measured cost of type in
   the package. Plus the number that decides the closed full-face option: the count and total transfer
   time of font requests over the local scheme on first paint, read from the WebView inspector. The
   dictionary's two costs arrive at A5 and the AAB and Play's reported download size at A7; A3 records
   `data.md` D5a's ~63 MB as the current **estimate** with its register-#16 caveat and does not present
   it as measured.

---

### A4 — Native speech: the TTS adapter, and the phone with no Mandarin voice

**Builds.** The Android half of `lib/tts/capacitor.ts` — the `TTSProvider` implementation over
`@capacitor-community/text-to-speech` 8.0.2 — and the answer to register #7, which is the question
that decides whether audio tier 3 is a v1 cost.

**This is one file for two platforms and this phase does not create a second one.** `ios.md` I4
creates `lib/tts/capacitor.ts` and marks it *"shared with `android.md`: same JS API, different native
halves"*; `ios.md` §2 adds that writing it twice *"is exactly the failure the frozen-file rule existed
to prevent"*. So **A4 extends and Android-reviews that file**. If this plan runs first, A4 creates it
under that name and I4 collapses to a review. Read I4's `HANDOFF.md` table of plugin-runtime answers
before writing anything — the resolve semantics of `speak()`, the behaviour of `speak()` during
speech, whether `stop()` cancels a queue, the rate mapping and the inter-utterance gap are all
questions I4 answers for the same JS API, and re-deriving them is waste.

**Why native, restated in one line so nobody re-litigates it during review:** `window.speechSynthesis`
is undefined in the Android WebView (Chromium 40468168; A1 confirmed or refuted it on a device), so
there is no web fallback on this platform at all. The plugin wraps Android's `TextToSpeech` and
forwards `UtteranceProgressListener.onRangeStart` (API 26+) as an `onRangeStart` event.

**The adapter.** It implements `core.md` C2's interface — `stop()`, utterance identity, the
`start`/`end`/`boundary` event surface, `voices()`, and the `supportsBoundary` capability flag — and
nothing more. **The native-versus-web branch is not negotiated here and not with `core.md` C2**: C2's
Files list is `lib/tts/provider.ts`, `speech-synthesis.ts`, `sequence.ts`, `speak-button.tsx` and
`tests/unit/tts/**`, and contains no selection module. The seam already exists — `lib/platform/native.ts`
from `ios.md` I0, which I0 names as the import point for *"the TTS adapter choice"* among others, with
an acceptance criterion that greps for stray `window.Capacitor` usage outside it. Branch there.

Two rules carry over from C2 and from AUDIT 2 and must not be re-decided here:

- **The 0.6x character-by-character mode does not depend on range events.** Range support is
  engine-dependent on Android. Enqueue one utterance per character and drive the highlight off each
  utterance's `start`. `lib/tts/sequence.ts` already contains that logic and is unit-tested with a
  fake clock; this adapter feeds it, it does not reimplement it. Note which phase produces which
  half, because A4's criteria depend on it: **C2** creates `sequence.ts`, but **C6** is what builds
  the hold gesture, the speaker control and the per-character highlight the sequencer drives. There is
  no hold-to-slow interaction to test on a device until C6 has landed, which is why C6 is in A4's gate
  row alongside C2.
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

**Files.** `lib/tts/capacitor.ts` (extended, or created here if Android runs first — never a second
file under a second name), `lib/platform/native.ts` (read, not rewritten: the provider selection
branches off it), `tests/unit/tts/capacitor.test.ts`.

**Acceptance criteria.**

1. Tapping the speaker on a headword speaks it in Mandarin on the GMS device. Recorded as a video or
   as a written observation with the device named — this is the one criterion no automated test can
   make.
2. Hold-to-slow plays character by character at 0.6x with the highlight advancing one character per
   utterance, and **releasing mid-word stops it within one character**. That is `stop()` plus
   utterance identity working; if the sequence runs to completion after release, the phase fails.
   This criterion exercises `core.md` **C6**, not C2 — there is no hold gesture and no highlight
   before C6 — so if A4 somehow runs ahead of C6, the criterion splits: the unit-level half (the
   sequencer, driven by this adapter against fake timers, cancels the remainder on `stop()`) runs now,
   and the device observation is deferred **in writing** until C6 exists rather than silently skipped.
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

### A5 — The two data artifacts in the package

**Builds.** The package side of `data.md` **D5a**: the ~43 MB SQLite dictionary **and `decomp.json`**
inside the app, copied to app storage on first launch, opened read-only, and answering queries
through the plugin.

**What this phase needs from `data.md` D5a, and what it does not wait for.** D5a owns
`lib/dict/runners/capacitor.ts` and the `open()`/copy logic; this phase owns the assets getting into
the package, the Gradle-side plumbing, and the Android measurements. Per §4, A5 consumes **D5a in
full** — the runner, the copy logic, the read-only open, the manifest contract and the fixed query
list — and D5a's own hardware precondition is an Android phone and a Capacitor Android project, both
of which A1 supplies. A5 does **not** wait for **D5b**: register #20 (FTS5 behind the SQLCipher
**iOS** pod), the iPhone halves of registers #6 and #18, and the iOS side of "identical results on
both devices" are all D5b's and all need Apple hardware.

**Two artifacts, two licences, and the second one is the one that gets forgotten.** `data.md` D1 emits
`data/dict-<SCHEMA_VERSION>-<cedictVersion>.sqlite` beside `data/dict-manifest.json` at the workspace
root, and **`decomp.json` (0.92 MB) stays a separate file forever**: `dict.sqlite` is CC BY-SA and Make
Me a Hanzi is LGPL-3.0-or-later, and PLAN.md §5 and CLAUDE.md forbid merging them. STACK §7 lists the
`pnpm data` → artifact path as a shared surface that must reach *"the Capacitor `android/` and `ios/`
asset directories"* with *"`decomp.json`'s delivery riding along with it"*, and `ios.md` I3 bundles
both for the same reason. It is not optional garnish: decomposition is part of the character sheet on
every surface (product-decisions §4), `data.md` D6 deletes the `/api/dict/decomp` route that serves it
today, and an Android package without it has a character sheet that dies the moment the aeroplane mode
goes on — which is this plan's §1 goal, failed.

**The asset path.** `data.md` D1 states that each deployable's build copies out of `data/` — "do not
teach `pnpm data` about deployables". So the Android build gains a copy step into the Android asset
root (`apps/app/android/app/src/main/assets`) for **both** files, and the **exact subdirectory
`@capacitor-community/sqlite`'s `copyFromAssets()` expects must be read from the plugin's own README
and recorded in `HANDOFF.md`** rather than guessed — it is a convention, not an inference, and getting
it wrong produces a silent "database not found" on first launch. `decomp.json` is a plain asset read
through the WebView rather than through the SQLite plugin, so it does not share that convention; say
in `HANDOFF.md` how it is read. The copied files are covered by the asset-root gitignore rule A1
added; the copy runs before `cap sync` in the one documented build command from A1.

**The 16 KB page-size check (register #5) is the one that can reject a release, and the artifact it
runs against is not settled.** Play has required 16 KB-page-aligned native `.so` libraries since
November 2025, and the plugin bundles SQLCipher's native library. AUDIT 2 could not verify that
`@capacitor-community/sqlite` 8.1.1 ships aligned libraries, and it named the command shape with **no
artifact**: *"check `zipalign -c -P 16`"*. STACK register #5's `<aab-or-apk>` is not sourced from
anywhere. An AAB is not the zip layout `zipalign` inspects — alignment is a property of the installable
APK, which Play generates from the bundle — so **the check that is known to be runnable is the one
against an APK**, and this phase is where it runs, on the debug APK, the moment the plugin is in the
dependency graph. Do that here rather than at A7, because discovering a misalignment at A7 wastes
everything between. A second, independent reading — the `.so`'s ELF load-segment alignment, read
directly out of the APK if a toolchain that can read program headers is available — is worth taking at
the same time, because it answers the underlying question without depending on what `zipalign` means
by `-P`. A0's docs read says which of these Google actually documents; A7's release gate is written
against that answer.

**Budget the package with `data.md` D5a's figure, not this plan's earlier one:** ~19.5 MB packaged +
43.1 MB expanded ≈ **63 MB**, where the packaged half is a `gzip -9` proxy that register #16 has not
retired. Add `decomp.json`'s 0.92 MB and A3's measured font delta. This phase records the **measured**
dictionary halves — the APK size delta from adding the assets, and the on-device storage after the
copy — which is the first time either number exists.

**Two measurements nobody has taken** (register #18 and #11), both against the low-end target named
in A0:

- How long `copyFromAssets()` of a 43 MB file takes, on an empty device and on a device near
  storage capacity, and what peak storage it costs. `data.md` D5a requires this and requires the copy
  to be a visible one-time progress state with a designed low-storage failure path. `core.md` draws
  those two screens; this phase produces the numbers that say how long the progress state has to be
  tolerable for.
- Cold-launch time with the dictionary open, compared against Play's 5 s flag and the 2 s bar STACK
  §2.1 sets for itself. AUDIT 2's guidance is the whole of the optimisation strategy: code-split, and
  **never parse the dictionary at startup** — query it. If the number is bad, that is where to look
  first.

**Files.** `apps/app/android/app/build.gradle` (or a root script — prefer the script, so the same
copy serves iOS), `.gitignore` (if A1's asset-root rule did not already cover both files),
`data/ATTRIBUTION.md` (SQLCipher's BSD notice — `data.md` D5a owns the text, this phase confirms it
renders in the built app alongside the CC BY-SA and LGPL notices that already exist), `HANDOFF.md`.

**Acceptance criteria.**

1. A fresh install on the low-end target reaches a working lookup with **no network at all**: a
   hanzi query, a pinyin query, an English gloss query and a segmented pasted passage all return
   correct results, **and a character sheet renders its decomposition**. Aeroplane mode on, verified
   by hand. The decomposition half is the one that proves `decomp.json` actually shipped.
2. `zipalign -c -P 16 -v` output for the **debug APK** is pasted into `HANDOFF.md`, pass or fail,
   alongside whatever direct `.so` alignment reading was available. A fail is not a phase failure — it
   is a decision point, and the options AUDIT 2 names are a newer plugin release, a rebuilt native
   library, or Capawesome's paid plugin.
3. Register #18's timings are recorded: copy duration empty and near-full, peak storage, and what
   happened when the device did not have room. "It did not fit" must produce the designed failure
   state, not a crash.
4. Cold launch on the named low-end target is measured and recorded against the 5 s flag and the 2 s
   bar. If it exceeds 2 s, the phase records what dominates before proposing a fix.
5. Killing and relaunching the app does **not** re-copy the file; changing the manifest's filename
   does. Both asserted on a device.
6. The licences screen on the **device** renders all three: CC-CEDICT's CC BY-SA 4.0 attribution with
   its modification notice, Make Me a Hanzi's LGPL-3.0-or-later notice with `COPYING-makemeahanzi`,
   and SQLCipher's BSD notice. Not just in the repo — on the device, in the built app.
7. The measured package numbers are in `HANDOFF.md`: the APK size delta from adding the two assets,
   the on-device storage after the copy, and the running total with A3's font delta — labelled
   measured, beside `data.md` D5a's ~63 MB estimate and its register-#16 caveat.

---

### A6 — The WebView floor, and what the app says below it

**Builds.** A version gate. Short phase, deliberately late, because the floor is determined by which
engine features the reader actually shipped with in `core.md` C3–C5.

**There is one floor, not two, and the reason is that `core.md` C5 already committed to a degrade.**
An earlier draft of this phase set up a "hard floor" against a "comfort floor" and told the builder to
find out by reading C5 whether the reader had a fallback. C5 is written and readable now, and it
answers the question: the fallback is **tap-the-first-character, then tap "…to here" on the last** —
*"the current `extend()` model generalised to characters, needs no `caretRangeFromPoint`, no Custom
Highlight API and no `pointermove` at all"* — and C5 says to *"ship it as the automatic degrade when
either API is missing, feature-detected at runtime, so the fallback is exercised in normal operation
rather than being dead code discovered in a crisis"*. It is committed, not conditional, and it is not
"span painting"; that term was this plan's invention and does not appear in C5.

So the engine features STACK §6 lists do **not** set a floor. The CSS Custom Highlight API is Chrome
**105**+ and C5 degrades without it; `caretRangeFromPoint` is ancient in Blink and needs no floor;
`caretPositionFromPoint` is Chrome **128**+ but is only the standards-track upgrade over a proprietary
API present everywhere; per-character (mono-ruby) `<ruby>` wraps naturally in any Chromium version,
and the Chrome 128 line-breakable-ruby work matters only for multi-character pairs, which this app
does not use.

**What is left is one advisory floor plus a verification job**, and both are this phase's deliverable:

- **The comfort floor** is where the app is *good*: safe-area insets were reported broken below **140**
  (A2), the keyboard bottom inset was fixed in **144** (Capacitor #8432), and the CJK synthetic-bold
  regression sat in **139–140** (mitigated by A3's bundled bold weight regardless). It **warns and
  never blocks**. A learner on a five-year-old phone should get a working dictionary with a banner
  asking them to update Android System WebView, not a wall. AUDIT 2's mitigation is exactly this:
  feature-detect, read the Chromium version from the UA, and show the banner below the chosen floor;
  Capacitor has no built-in gate (issue #4884), so this is app code.
- **The verification job:** walk `core.md` C3–C6 and confirm that every engine feature they depend on
  either works in any Chromium the app can meet or has a feature-detected degrade the way C5's does.
  C5 is settled. If any *other* surface turns out to depend on a versioned feature with no degrade,
  **that** surface sets a hard floor — and this phase reports it back to `core.md` as a missing
  fallback rather than inventing a version wall to hide it. Record the walk, feature by feature, even
  when the answer is "no floor".

If A2 could not obtain a pre-144 device, its untested keyboard result lands here as an open risk
against the comfort floor: the floor is then chosen from the feature table and the audit's reported
versions, with the gap stated.

WebView has been Play-updated since Android 5, so on a GMS device the banner's advice actually works.
On a non-GMS device it may not, which is another reason the gate warns rather than blocks.

**Prefer feature detection to version parsing wherever a feature can be detected.** The version is
for the *message* ("your WebView is 132; 144 or newer is recommended") and for telemetry-free
debugging; the behaviour branches on `CSS.highlights` existing, not on a number. AUDIT 2 found **no
2026 WebView version-distribution statistics**, so there is no data on which to pick a floor
demographically — pick it from the feature table and say so.

**Files.** A small version/capability module under `apps/app/`, the banner, and unit tests over the
UA parser with real UA strings collected in A0 and A1. **Do not reuse `components/shell/data-banner.tsx`**
— `core.md` C4a deletes it, replaced one-for-one by C4a's `DictStatus` screens — so take whatever
notice primitive `core.md` C1 leaves in `components/ui/**` and say which in `HANDOFF.md`.

**Acceptance criteria.**

1. The UA parser is unit-tested against the real UA strings recorded from every test device, plus a
   deliberately malformed one that must not throw.
2. On a device below the comfort floor, the banner appears once, is dismissible, and the app remains
   fully usable. On a device above it, no banner. Both observed on hardware or on an emulator image
   with an old WebView.
3. C5's committed degrade works inside the app, not only in desktop Chromium: feature-flag
   `CSS.highlights` off in a debug build and check that tap-then-tap-to-here still selects a span on
   the device. This is a device re-run of C5's own fallback spec, and it is what makes "no hard floor"
   a tested claim rather than an inference from another document.
4. The C3–C6 feature walk is in `HANDOFF.md`, feature by feature, with "degrades / no floor / floor at
   N" against each. Any feature with no degrade is reported to `core.md` by name.
5. The chosen comfort floor and the reasoning are one paragraph in `HANDOFF.md`, including the fact
   that AUDIT 2 found no 2026 WebView version-distribution statistics, so no demographic data exists
   to validate the choice, and including A2's pre-144 result or the record that it was untestable.

---

### A6a — Identity: the application id, the icon set, the launch theme, the version pair

**Builds.** The app as an object on a home screen and in the Play Console. Short phase, mostly
generated, and it exists because nothing else in this plan produced any of it — `ios.md` **I6** does
exactly this work for iOS and there was no Android counterpart, so A8's upload would have arrived at
a listing form with no icon and a default generated launcher.

**The `applicationId` is decided here and is never changeable afterwards.** `ios.md` I6 records the
same property of the iOS bundle identifier — *"fixed at I0 and never changeable after the first
upload"* — and Play's `applicationId` behaves the same way: it is the app's permanent identity in the
store. Pick it, write it in `HANDOFF.md` with the word "unchangeable" next to it, and keep it
consistent with whatever iOS chose so the two stores name the same product.

**The icon set is generated, not exported.** `app/icon.svg` is the source and the largest raster in
the repo is `public/icons/tangram-512.png`; HANDOFF.md records that the existing PNGs came from *"a
stdlib-only rasteriser — no new dependency"*. Android wants an adaptive icon — a foreground and a
background layer, plus the legacy raster densities — and none of those exist. Produce them from
`app/icon.svg` **by a recorded, repeatable command**, the same rule I6 sets for iOS, because a
hand-exported icon set is a stale icon set. Whether the existing rasteriser survives `web.md`'s Vite
move is `web.md`'s business; this phase needs a command that works and records which one it used.

**The launch theme is not a loading screen.** Replace the generated project's default with the warm
paper ground (`#f8f4ec`, product-decisions §11, via `core.md` C0's token) so the app does not flash
white — and note what it must *not* do: the app's real first-run cost is A5's dictionary copy, which
happens after the WebView is up and has its own designed progress state (`core.md` draws it). A launch
theme with a spinner would be pretending to be that state. A0's docs read named whatever splash plugin
Capacitor documents; this is the phase that uses it or records that the plain theme is enough.

**The version pair.** Play orders releases by an integer `versionCode` that must increase on every
upload, and shows users a `versionName` string. A7 owns the derivation of the code; this phase sets
the `versionName` and the display name under the icon alongside it, so the three are decided together
rather than one at a time under upload pressure.

**Files.** `apps/app/android/app/src/main/res/**` (the adaptive icon and the launch theme),
`apps/app/android/app/build.gradle` (`applicationId`, `versionName`), the manifest under
`apps/app/android/app/src/main/` (the display name and theme references), the icon-generation script,
`HANDOFF.md`.

**Acceptance criteria.**

1. The icon renders correctly on the home screen, in the launcher and in the app switcher on a real
   device, on both a light and a dark home screen, and it is not a scaled-up 512.
2. The whole icon set is regenerated from `app/icon.svg` by one recorded command, and re-running that
   command produces the same bytes.
3. Cold launch shows the launch theme on the app's own ground colour with no white flash and no
   spinner.
4. The `applicationId`, the display name, the `versionName` and how the `versionCode` is derived are
   recorded together in `HANDOFF.md`, with `applicationId` marked unchangeable after the first upload.

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

**Version numbering.** Play orders releases by an integer `versionCode` that must increase on every
upload. Pick a derivation now — a monotonic counter in a file, or something derived from the build —
and write it down beside A6a's `versionName`, because the failure mode is a release that cannot be
uploaded at 11pm.

**The release build is where the debug build's sins surface.** Run, and record:

- **The 16 KB alignment check, against an artifact the tool actually accepts.** A5 already ran
  `zipalign -c -P 16 -v` on the debug APK, which is the form no source disputes. The release-side
  question is what to run against a bundle, and **no audit answers it**: AUDIT 2 named the command
  with no artifact and STACK register #5's `<aab-or-apk>` is unsourced. An AAB is not the zip layout
  `zipalign` inspects; Play generates the installable APKs from the bundle. So: **generate the APK set
  from the AAB with whatever tool A0's docs read recorded for that purpose, and run the recorded check
  on the APK Play would actually install.** Paste both the command and the output. If A0 could not
  settle the tooling, the release gate falls back to A5's debug-APK result plus the release APK
  produced by the same local build, and `HANDOFF.md` says so — a gate that halts a release on a
  command that may fail for reasons unrelated to alignment is worse than no gate.
- The app boots, the dictionary opens, TTS speaks and the reader selects, all in the release build
  with whatever shrinking is enabled. Code shrinking removing a plugin's reflection target is a
  classic Capacitor release-only failure; if minification is on, exercise every plugin in the release
  build before believing it.
- The AAB's size, and after upload, the **download size Play reports** (register #16 — the audits
  used `gzip -9` as a proxy for store compression and it was never validated). AUDIT 3's ceiling is
  200 MB compressed for a base module, so there is enormous headroom; the number matters for honesty
  in the listing, not for compliance.

**Files.** `apps/app/android/app/build.gradle`, `apps/app/android/keystore.properties.example` (the
real one gitignored), `.gitignore`, a release build script, a unit test under `tests/unit/` asserting
no secret is tracked, `HANDOFF.md`.

**Acceptance criteria.**

1. A signed AAB is produced by one documented command from a clean checkout.
2. The 16 KB alignment check passes on **an installable APK generated from the release bundle**, by
   the tool and against the artifact A0 recorded, with the command and the output pasted into
   `HANDOFF.md`. If it fails, the phase stops here and the escalation is A5's list of three options.
   If A0 could not establish the tooling, the criterion is met by A5's debug-APK result plus the same
   check on the locally built release APK, with the gap written down.
3. The release build is exercised on the low-end target against a written checklist covering every
   plugin: SQLite (dictionary query), TTS (speak), safe area (inset non-zero), back button. Each
   passes in the **release** variant specifically.
4. The keystore's location, its backup, and the consequence of losing it are documented. No secret is
   in the repository — asserted by a **unit test under `tests/unit/`** that greps the tracked tree for
   the keystore filename and the properties filename and fails if either appears. **There is no CI
   here** — the repository has no `.github/` directory and no sibling plan creates one — so `pnpm test`
   is the gate, in the same repo-shape pattern `tests/unit/deps.test.ts` uses. If CI is ever wanted,
   naming the phase and the plan that creates it is a prerequisite, not an assumption.
5. The version-code derivation is documented and produces a strictly larger number than the previous
   upload, checked by a script rather than by the builder's memory.
6. One real call to the configured API base succeeds from the device over HTTPS and its response is
   rendered — the criterion `ios.md` I1 makes for iOS, made once here because nothing else in this
   plan ever proves the device reaches the server. If `backend.md` has not shipped, this criterion is
   deferred **in writing** to A8 rather than silently skipped, and the app ships with the AI answer
   disabled and `core.md` C7's "Dictionary only — offline" chip showing, which is a supported state.

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
build is ready, not after. Whether a tester list that falls short mid-run **restarts the clock** is
an **open question, not a fact** — no audit covers the mechanics of the counter, and A0 was sent to
the closed-testing policy page partly to record its wording on tester continuity. Plan as if it
restarts, because that is the cheap direction to be wrong in, but do not write it down as established.

**The listing work nobody budgets for**, and this list is **from memory rather than from a source** —
no audit covers Play Console listing requirements, and A7 sets the standard this phase has to meet
(*"read the console, write down what it said, and cite the date"*). Replace it with the checklist A0
captured from the console, or with what the console asks for on the day. As remembered, it is a store
listing (title, short and full description, screenshots at required sizes, a feature graphic, an
icon — A6a produced the icon), a **Data safety** form, a **content rating** questionnaire, a privacy
policy URL, and target-audience declarations. Two of those are unusually easy here and should be
stated plainly rather than fudged: the app collects
nothing and transmits nothing until `backend.md` exists (every card, review and setting lives in
on-device storage — the same fact `docs/deploy.md` already records about the web deployment), and the
only network calls are to the owner's own AI proxy. Fill the Data safety form to match what the code
actually does, and **re-answer it the moment `backend.md` lands accounts** — an inaccurate Data safety
declaration is an enforcement matter, not a formatting one, and accounts change the true answer from
"nothing leaves the device" to something else.

**The privacy policy URL is `web.md` W7's page, not this phase's writing job.** W7 ships `/privacy`
and `/support` on the Astro site at the apex and records both exact URLs in `HANDOFF.md`. This phase
pastes the privacy URL into the listing and checks that what the page says matches the Data safety
answers filled in above — one form and one page disagreeing is the failure worth catching. If W7 has
not landed, A8 is **blocked**: Play will not take the submission without the URL, and inventing a
page here would fork the one the App Store submission also uses.

**Attribution ships in the app, not only in the repo.** PLAN.md §5 and CLAUDE.md require CC-CEDICT's
CC BY-SA 4.0 attribution plus a modification notice, Make Me a Hanzi's LGPL notice with `COPYING`,
and now SQLCipher's BSD notice (`data.md` D1/D5a). The licences screen already exists at `/settings`;
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
   justification for each, and match the code as of that date, with a line saying they must be
   re-answered when `backend.md` lands accounts. The listing checklist recorded there is what the
   console actually asked for, with the date — not the remembered list above.
4. The listing's privacy policy URL is `web.md` W7's `/privacy` page, live and reachable, and its
   text does not contradict the Data safety answers. The URL is recorded in `docs/android-release.md`.
5. The licences screen renders CC-CEDICT, Make Me a Hanzi and SQLCipher on a device build.
6. Play's reported download size and any pre-launch report warnings are recorded (register #16).
7. Production release is a separate, later decision — not part of this phase's completion.

---

## 6. Risks

Each row names the trigger that would tell you it is happening and the mitigation. The first five
are things an audit explicitly could not verify and that this plan depends on; each carries the check
that settles it, and the register number is STACK §4's.

**R1 — `@capacitor-community/sqlite` may not ship 16 KB-page-aligned native libraries (#5).** Play
has required 16 KB alignment for `.so` files since November 2025 and the plugin bundles SQLCipher's
native library; AUDIT 2 could not verify 8.1.1.
*Trigger:* the alignment check fails, or Play rejects the upload with a page-size error.
*Check:* run `zipalign -c -P 16 -v` on a **debug APK** in A5, the moment the plugin is in the graph —
that is the artifact form no source disputes — and at A7 on an installable APK generated from the
release bundle. **No audit establishes what `zipalign -c -P 16` accepts**: AUDIT 2 named the command
with no artifact, and STACK register #5's `<aab-or-apk>` is unsourced, so A0's docs read settles which
tool and which artifact Google documents before A7 depends on it. Do not wait for the store to tell
you, and do not gate a release on a command that might be failing for reasons unrelated to alignment.
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
(`core.md` draws them, `data.md` D5a specifies them). The on-device footprint is `data.md` D5a's
**~19.5 MB packaged + 43.1 MB expanded ≈ 63 MB**, not the 13.9 MB brotli web-transfer figure and not
the 57 MB an earlier draft of this plan carried; every size statement must use the doubled figure and
must carry register #16's caveat on the packaged half.

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
*Trigger:* a phase's acceptance criterion turns out to be unrunnable and quietly becomes "the builder
looked at it". Note that **there is no CI in this repository at all** — no `.github/` directory, and no
sibling plan creates one — so "runnable" here means runnable under `pnpm lint`, `pnpm test` or
`pnpm e2e`, or by hand on a device against a written checklist. Any criterion in this plan phrased as
a CI check is a bug in the plan; A1's SDK-level assertion and A7's secret grep are both unit tests
under `tests/unit/` for exactly this reason.
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
- **Play asset delivery / dynamic feature modules for the dictionary.** At `data.md` D5a's ~19.5 MB
  packaged estimate — a `gzip -9` proxy that register #16 has not yet retired, not the 13.9 MB brotli
  figure, which is D4's web-transfer number and belongs nowhere near a package — the base module is
  nowhere near AUDIT 3's 200 MB cap for a base module. The conclusion survives either figure, so
  splitting buys complexity and nothing else. It becomes interesting only if a second dictionary
  source lands, or if A7's Play-reported download size comes back materially different.
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
