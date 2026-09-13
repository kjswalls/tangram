# Tangram — build plan: the iOS app

**Status:** plan, written 2026-09-13. Sibling plans: [`data.md`](data.md), [`core.md`](core.md),
[`web.md`](web.md), [`android.md`](android.md), [`backend.md`](backend.md).

**Read first:** [`docs/STACK.md`](../STACK.md) is the decision record this plan is built on. It is not
re-argued here — where this plan says "because §2.1", go and read §2.1. STACK §4 is the
known-unknowns register; this plan settles eight of its entries and cites them by number throughout.
[`PLAN.md`](../../PLAN.md) remains authoritative for the data contract (§3.1), the schema (§3.3) and
the grounding contract (§3.4). The product decisions taken with the owner supersede PLAN.md's UI
wherever they conflict.

Two facts frame everything below and are not repeated: **there are no users and no data** (nothing
here is a migration plan), and the builder is **one person with AI assistance**.

**A third fact frames this plan specifically, and it is a hard gate.** STACK §4's precondition table
says it plainly: *"A register entry that cannot be run is not a soft entry; it is a blocked phase."*
Every phase in this document needs **a Mac with Xcode 26**, and every phase from I1 on needs **physical
devices running iOS 26** — plural, and in particular states: §4.2 fixes the matrix at I0 and the
criteria below reference its roles rather than saying "a device". The Linux container that builds the
rest of this repo cannot build,
sign, run or test an iOS app, and the Simulator answers only two of the questions below. If the
hardware does not exist, the honest response is to say the iOS app is out of scope for now and ship
the web and desktop product — not to soften a check.

---

## 1. Goal

When this plan is done there is a signed Tangram app on the App Store and on TestFlight that is the
same React codebase the web ships, wrapped by Capacitor 8.5.x, with the 124k-entry dictionary inside
the app package and answering queries from native SQLite, Mandarin speech from
`AVSpeechSynthesizer` including the character-by-character slow mode, and a layout that respects the
notch, the home indicator and the keyboard. None of that is true now: there is no `ios/` directory,
no Capacitor dependency, no native adapter of any kind, and the only things in the repo that have ever
touched iOS are a 180×180 home-screen icon and the `appleWebApp` metadata in `app/layout.tsx`, both for
an installed PWA.

## 2. Scope boundaries

**This plan owns:**

- The Capacitor iOS project: `capacitor.config.ts`, the generated `ios/` tree, what is committed and
  what is generated, the deployment target, and the dependency-manager question the generated project
  answers.
- The **shared** Capacitor surface — the config file, the platform-detection seam, and the JS-side
  adapter for plugins whose JS API is identical on both platforms. `android.md` §2 adopts the same
  three answers and consumes them; I0 lands them, or reviews them if `android.md` A1 ran first.
- Getting `dict-<schema>-<cedict>.sqlite` and `decomp.json` into the app package and onto the device,
  and the four device checks that prove the file works there (registers #20, #6, #18, #11).
- The **native** `TTSProvider` adapter over `@capacitor-community/text-to-speech`, the voice
  selection that reaches Apple's enhanced Mandarin voices, and how the per-character highlight is
  driven on iOS.
- Safe areas, the keyboard, WKWebView's own gesture recognizers, the long-press callout, and
  overscroll.
- App identity: icons, the launch screen, display name, bundle identifier, version and build numbers.
- Signing, the first archive, TestFlight, and App Store submission.
- The iOS half of register #1 — the reported WKWebView crash on iOS 26 with `-webkit-user-select:
  none` — and the decision that follows from whichever way it goes.
- **What "tested" means on native**, which STACK §7 leaves undecided and which this plan settles in
  I1 rather than leaving to be discovered at submission time.

**This plan does not own, and must not start:**

| Not here | Owner | Why the seam is where it is |
|---|---|---|
| The SQLite artifact, the `DictStore` interface, `lib/dict/runners/capacitor.ts`, the query layer | `data.md` | STACK's seam, quoted exactly in `data.md` §2: *that* plan owns the file and the `SqlRunner` that opens it; *this* plan owns getting the file into the app package and the native project that runs it. |
| Design tokens, `components/ui/**`, screens, per-character ruby, drag-select, the `TTSProvider` **interface**, the block speaker, the slow-mode sequencer | `core.md` | This plan implements C2's interface against a plugin. It does not widen the interface and it does not write `lib/tts/sequence.ts`. |
| The Vite build, the router, the service worker, PWA install, web font delivery, the Astro site, the configured API base, the gate's client half, and the local export | `web.md` | This plan consumes `apps/app/dist/` and W5's export. Where it needs a change to the web build it names the file and hands the edit to `web.md`, which owns it: `viewport-fit=cover` in `apps/app/index.html` and the native gate on `components/pwa/register-sw.tsx` are both in **W1's Files list**, so this plan gates on W1 rather than editing either file. |
| The Capacitor **Android** project, `@capacitor-community/safe-area`, Play packaging, the 16 KB alignment check (#5), the no-GMS voice question (#7), the CJK bold regression (#8) | `android.md` | Same plugin set, different native halves. Register #19 (`typeof window.speechSynthesis` in the Android WebView) is Android's; iOS has Web Speech and does not need it. |
| The server, accounts, sync, BYOK key custody, the new `/api/ask` contract | `backend.md` | This plan points the app at a base URL and proves it reaches it over HTTPS. **`backend.md` does not own reviewer access:** `grep -rn -i 'demo\|App Review\|reviewer' backend.md` returns nothing but CORS and repository text. I8 therefore owns the reviewer-access answer itself, and its default is the degraded dictionary-only state rather than a demo account (see I8 and §4). |
| Merging the new-word queue into one Practice session | `core.md` **C7** | Assigned by `wave-zero.md` §9: C7's Files list carries `lib/lists/today.ts`, `lib/lists/introduce.ts` and `lib/srs/session.ts`, and its acceptance criteria require one session to serve new words, recognition and writing from one queue. Noted here so it is not assumed to be mobile work. |
| List import | deferred from v1 | `wave-zero.md` §8 records it as deliberately unscheduled rather than merely unwritten. |

**Three shared surfaces, and both mobile plans already give the same three answers.** Read this
before I0.

STACK §7 is the rule — *"shared surfaces must be settled before parallel work starts"* — and the three
surfaces are `capacitor.config.ts`, the `Capacitor.isNativePlatform()` gate, and the native TTS adapter.
None of them is contested. The config is **`apps/app/capacitor.config.ts` with `webDir: 'dist'`**, with
`apps/app/ios/` and `apps/app/android/` beside it — `android.md` §2's "Location" bullet says exactly
that, for the same mechanical reason (`webDir` resolves relative to the config, and a config one
directory away from the build output is one more path to keep in sync). The gate is
`apps/app/lib/platform/native.ts`; no sibling claims it and it is this plan's to create. The native TTS
adapter is **one file for both platforms**, `apps/app/lib/tts/capacitor.ts`, created by I4 and
**extended** — never forked — by `android.md` A4, which says so in terms: *"This is one file for two
platforms and this phase does not create a second one."*

Two consequences worth stating rather than leaving implicit. The Mandarin voice predicates
(`isChineseVoice`, `isCantoneseVoice`) live in exactly one module, which follows from one adapter and
which `android.md` A4 requires independently. And whichever mobile plan runs first lands the surface at
those paths and records the interface in `HANDOFF.md`; the other reviews and extends it. `android.md`
§2 takes that side of the bargain in full, so if A1 runs before I0, I0 collapses to a review.

## 3. What exists today

Everything below was read in the repo on `claude/apps-ui-design-791zpq`, not recalled.

**There is no native anything.** `grep -rniE "capacitor|safe-area|viewport-fit|env\(safe" app
components lib public scripts tests next.config.ts package.json` returns **nothing**. `package.json`
has no `@capacitor/*` dependency, no `ios` script, and `engines.node` is `>=20.9`. There is no `ios/`
directory and no `capacitor.config.ts`.

**The app is a Next 16 App Router app** with `middleware.ts`, eight route handlers under `app/api/**`,
and `next.config.ts` carrying `headers()` and `outputFileTracingIncludes`. All of it is being replaced
by `web.md`; this plan starts after that.

**What iOS-shaped work has already been done, and it is all PWA.** `app/layout.tsx` exports
`metadata.appleWebApp = { capable: true, title: 'Tangram', statusBarStyle: 'default' }` and
`viewport = { width: 'device-width', initialScale: 1, themeColor: '#0f766e' }` — **no
`viewport-fit: cover`**, which is what `env(safe-area-inset-*)` needs to be anything but zero.
`app/apple-icon.png` is a 180×180 rasterisation of `app/icon.svg`, added in Phase 6 because (HANDOFF.md
§"Install icons and orientation") *"Safari ignores manifest icons for the home-screen tile and refuses
SVG, so before this an iOS install got a screenshot of whatever page was open."*
`public/manifest.webmanifest` lists an SVG plus 192 and 512 PNGs. **The largest raster in the repo is
512×512**; the App Store's marketing icon is 1024, so a new render from `app/icon.svg` is required —
this is not a resize of an existing file.

**TTS is Web Speech and three members wide.** `lib/tts/provider.ts` is `readonly name`,
`available(): Promise<boolean>` and `speak(text, {lang?, rate?}): Promise<void>`, and its own header
says `speak` *"Resolves once the utterance has been queued (not once it has finished)"*. There is no
`stop()`, no utterance identity, no events, no voice selection.
`lib/tts/speech-synthesis.ts` is a careful Web Speech implementation worth reading before writing the
native one, because its judgements carry over: it waits for `voiceschanged` with a 500 ms timeout
(`VOICES_TIMEOUT_MS`), it **ranks** rather than filters (`zh-CN`/`zh-SG`/Hans → 0, `zh-TW`/Hant → 1,
bare `zh`/`cmn` → 2), and it **refuses Cantonese outright** (`isCantoneseVoice`: `yue*`, `zh-HK`,
`zh-MO`) because *"the card shows Mandarin pinyin, so a Cantonese reading of it is a wrong answer the
learner cannot detect"*. The native adapter must apply the same rule to `AVSpeechSynthesizer`'s voice
list. `components/tts/speak-button.tsx` renders pending / ready / unavailable with the reason as
**visible text**, and the header explains why: *"a touch screen never shows a `title`"*. That reasoning
is about to matter a great deal more than it did on the web.

**The reader is token-granular.** `components/reader/reader-text.tsx` renders one
`<button data-token-index>` per token with a single delegated `onClick` on the container (deliberate:
*"a 2,000 character text is ~1,300 tokens"*), and `lib/stores/reader.ts` models a span as
`selected`/`spanEnd` **token** indexes. `grep -rn 'ruby\|<rt'` returns nothing. `core.md` C3–C5b
replaces both; this plan tests the replacement on hardware.

**`app/globals.css`** is `@import "tailwindcss"` plus ten custom properties, a `.hanzi` utility and a
`:focus-visible` rule. There is **no** `user-select`, no `-webkit-touch-callout`, no
`overscroll-behavior` and no safe-area padding anywhere in the repo. Every one of those is new work.

**The service worker** is registered by `components/pwa/register-sw.tsx`, production-only, and its
header explains that a stale worker on a shared origin is the failure mode it guards against. Inside a
Capacitor WebView the origin is a local scheme and the same guard reasoning applies in a new form —
see I1.

**Tests.** `tests/unit/**` (vitest, jsdom) and `tests/e2e/**` (Playwright against the container's
Chromium at `/opt/pw-browsers/chromium` — never run `playwright install`). Nothing in either suite can
observe an iOS device.

## 4. Dependencies

### 4.1 Orchestrator and hardware

| Needs | From | State it must be in |
|---|---|---|
| **CLAUDE.md rewritten** (STACK §7: *"the first commit of the migration, before any build phase runs"*) | orchestrator | **Before I0.** Today's CLAUDE.md is auto-loaded project instruction and outranks this plan. It freezes `package.json` — *"no phase after 0 should be touching `package.json` at all"*, *"it is not negotiable"* — which I0 edits to add the Capacitor dependencies, and it freezes `app/globals.css` and `app/layout.tsx`, which I5 proposes changes to. `core.md` and `web.md` both carry this row; this one was missing and its absence would stop a fresh session on its first edit. |
| **The device matrix** (§4.2), a Mac with **Xcode 26**, and a signing identity | the owner | See §4.2. Capacitor 8 requires Xcode 26 and the iOS 26 SDK has been mandatory for App Store submissions since 28 April 2026 (STACK §2.1). |
| An **Apple Developer Program** membership ($99/yr, sourced) | the owner | **Enrolment submitted at I0; the paid membership is a hard gate on I7 only.** I1 needs a signing identity that can install a debug build on a *registered* device, which is a weaker requirement. Whether a free personal team supplies that is **not established by any audit**: read it off Apple's current documentation during I0's reading pass and record the answer. Enrolment can take days, which is why it starts at I0 and not at I7. |

### 4.2 The device matrix — fixed at I0, referenced everywhere else

One handset is not enough, and the criteria below already assume more than one. Rather than leaving
"the smallest supported device" and "a device that has never had a development build" as phrases that
appear once each, **I0 writes a device table into `HANDOFF.md`** — model, screen size in points, OS
version, free storage — and assigns these four roles. One physical phone may hold several roles; two of
them cannot be the same phone at the same time.

| Role | Used by | Constraint |
|---|---|---|
| **The primary** | I1–I6, every device pass | iOS 26, notch and home indicator, Safari Web Inspector attached. |
| **The clean target** | I7 criterion 2 | Must never have had a development build of this app installed. By I7 the primary has, so this is a second handset — or the primary after a full erase, which is a lead-time item, not a five-minute one. |
| **The smallest** | I5 criterion 3 | The smallest screen the app claims to support, stated as a point size in the table. This is a *decision* I0 records, not a device that exists by default. |
| **The oldest** | R5, I3's cold-start number | The oldest device available. If there is only one handset, say so and record cold start as measured on new hardware, which is the optimistic case. |

Two device *states* are also lead-time items and belong in the same table: **wiped** (I3 criterion 1 is a
clean install) and **near-full** (register #18's storage half). Filling a phone to near capacity takes
longer than the check does.

### 4.3 Sibling plans

| Needs | From | State it must be in |
|---|---|---|
| The workspace layout (`apps/app/`) | `web.md` W0 | **Before I0.** It decides where `capacitor.config.ts` and `ios/` live, and it relocates every path this plan writes (see the note at the head of §5). |
| `apps/app/dist/` — a Vite build that works from a non-`/` origin | `web.md` W1 | **Before I1.** `web.md` §2 already owes this: *"Those plans consume this plan's `dist/`. This plan owes them a build that works from a non-`/` origin and a `navigate` boundary they can drive."* |
| A configured API base URL and the gate's client half | `web.md` W4 | Before I1's network check. A device cannot reach a relative `/api/...` under a local scheme. |
| **The native gate on `components/pwa/register-sw.tsx`** | `web.md` W1 | **Before I1.** Inside a Capacitor WebView a worker adds nothing and can serve a previous build's shell after an app update. The gate is in **W1's Files list**, with a unit test on its native branch in W1's criteria; I1 asserts the behaviour on the device and does not edit the file. |
| **`viewport-fit=cover` in `apps/app/index.html`** | `web.md` W1 | **Before I5.** Without it every `env(safe-area-inset-*)` is zero, and I5's whole safe-area criterion rests on it. It is one attribute in `index.html`, it is in **W1's Files list** and in W1's acceptance criteria, and this plan does not make the edit: I5 asserts it and, if it is missing, the phase is blocked on W1 rather than patching a file `web.md` owns. |
| **The local export** (`lib/db/export.ts` / `import.ts`) | `web.md` W5 | **Before I7.** R9 makes this the v1 durability story on iOS and nothing enforced it. W5 ships and round-trips it, but tests it in Chromium only; whether a browser download path works inside a Capacitor WKWebView, or needs a Filesystem/Share plugin, is established by **no audit** — it is on I0's reading list and it is proved on the device at I7. |
| `TTSProvider` widened — `stop()`, utterance identity, `start`/`end`/`boundary` events, `supportsBoundary`, voice preference — and recorded verbatim in `HANDOFF.md` | `core.md` C2 | **Before I4.** `core.md`'s own sentence is stronger — *"C2 must land before any mobile plan starts"*, i.e. before I0 — and the two are **not the same constraint**. This plan's reading governs here: I0–I3 consume nothing from `TTSProvider` and can run without it. Do not treat the mismatch as an error to fix by blocking I0; if C2 has landed anyway, nothing changes. |
| `lib/tts/sequence.ts` (one utterance per character, highlight on `start`) | `core.md` C6 | Before I4's slow-mode check. I4 supplies the provider it runs on; it does not write the sequencer. |
| **`core.md` C5a** — the per-character ruby + `caretRangeFromPoint` + Custom Highlight API harness in `components/gallery/**`, working in desktop Chromium, **with no production reader file touched** | `core.md` (see the note below) | **Before I2**, and no C5b production file may land before I2 returns. STACK register #1: *"Run it in desktop Chromium first — free, in the container, no hardware — and then on a real iOS 26 device before anything else in the reader is built."* |
| **`core.md` C3, C4 and C5b shipped** — the production `<HanziText>`, `use-span-select.ts` and the character-granular span model — **and C7's three-tab shell** | `core.md` | **Before I5.** Criterion 6 tests a left-edge drag against WKWebView's back-forward gesture, which needs the real interaction and not I2's harness; the tab-bar and status-bar work is C7's shell, and criterion 1 checks "all three tabs". This is the phase where the shipped reader and real hardware meet, so it is also where I1's reader checklist rows first apply. |
| **`core.md` C4a's `dict-status` components** — the four dictionary states, and the native first-launch copy progress with its low-storage failure path | `core.md` C4a | **Before I3.** C4a part three builds these explicitly for `ios.md` register #18 and `android.md` A5 (*"They are the same two components as `preparing` and `failed{reason:'storage'}` with different copy"*). I3 criterion 1 asserts they appear on the device; without C4a there is nothing to appear. |
| `dict-<schema>-<cedict>.sqlite` produced by `pnpm data`, plus `lib/dict/runners/capacitor.ts` | `data.md` D1, D5a and D5b | Before I3. D5a writes the runner and answers the Android half; **D5b is the iOS half and it and I3 are the same device session** seen from two plans — run those two together with both documents open. |
| `decomp.json` delivery decided | `data.md` (STACK §2.2 leaves it open) | Before I3. It is 0.92 MB, it must stay a separate artifact for the licence reason, and on native the obvious answer is the app package — but nothing has decided it. |
| A deployed HTTPS server, or a decision that v1 ships without AI on device | `backend.md` | Before I8. See R13. |
| **A live privacy policy URL and a live support URL** | `web.md` W7 | **Before I8.** App Store Connect will not take a submission without both. W7 owns the two pages on the Astro site — `/privacy` and `/support` at the apex — and records their exact URLs in `HANDOFF.md`; I8 puts those URLs into the listing. If W7 has not landed, I8 is **blocked**, not improvising two pages of its own. |

### 4.4 The two splits this plan's ordering required, both now settled

Both were asked for here and both are settled in [`wave-zero.md`](wave-zero.md) §4, written into the
documents that own them. They are recorded here because I2 and I3 are the phases that consume them.

**One: `core.md` C5 is split into C5a and C5b.** C5 was one phase whose Files list was the production
rewrite (`use-span-select.ts`, `hanzi-text.tsx`, `reader-text.tsx`, `lib/stores/reader.ts`) with "build
the prototype first, in this phase" inside it — so the harness I2 needs would only have existed once C5
had started, and I2 gates C5's production code. The split was cheap because C5 already kept the harness
(`components/gallery/**` — *"the prototype stays, as the harness"*): **C5a is the gallery harness alone,
desktop Chromium, no production reader file touched; C5b is everything else in C5's Files list, and it
does not start until I2 has an answer.** C5b is therefore the one `core.md` phase that depends on this
plan; every other one does not, and `core.md` is right to say so.

**Two: `data.md` D5 is split into D5a and D5b.** D5 opened by requiring a Mac, an iOS device *and* an
Android phone in one session, which blocked Android's native store on Apple hardware. **D5a** is the
Android-runnable half — `lib/dict/runners/capacitor.ts`, the `open()`/copy logic and the manifest
contract, with the Android device checks — and **D5b** is the iOS half, which adopts that runner
unchanged and keeps the Mac-and-iPhone precondition. **I3 pairs with D5b**, and the two are the same
device session seen from two plans.

**An honesty note on register #1's wording.** It says the device run happens *"before anything else in the
reader is built"*, and under `core.md`'s ordering that is not literally achievable: C5a needs `<HanziText>`
to render per-character ruby, which is C3, which is production reader code. Accept it and record why — if
I2's check 1 crashes, the fault is in the selection CSS, not in the ruby renderer, so C3 survives the bad
outcome and only C5b is at risk. What must not land before I2 is C5b.

**Nothing in `web.md` depends on this plan, `data.md` depends on it only through D5b's hardware, and in
`core.md` only C5b does.** That is otherwise the sequencing advice in STACK §4: everything web and
desktop proceeds in the container; the Capacitor phases wait for hardware.

## 5. Phases

**Every path in this section is post-W0.** `web.md` W0 is a `git mv` of `app/`, `components/`, `lib/`,
`public/`, `scripts/`, `tests/`, `middleware.ts` and the config files into `apps/app/`, leaving only
`data/`, `docs/`, `PLAN.md`, `HANDOFF.md` and `CLAUDE.md` at the workspace root — and §4 makes W0 a hard
dependency of I0. So a Files list here reads `apps/app/lib/...`, and the pre-migration spellings in §3
(`app/globals.css`, `lib/tts/provider.ts`) are historical: that is where those files are **today**, and
§3 is a record of today. `data/ATTRIBUTION.md` and `HANDOFF.md` keep their root paths because W0 leaves
them there. Where `core.md` also renames a file this plan touches, the entry says so.

Every phase ends the way PLAN.md §4 says: `pnpm lint`, `pnpm test`, the web e2e suite green, an
adversarial review, a commit. On top of that, every phase from I1 on ends with a **device pass**: a
written checklist run on a real iPhone with the result, the OS version and the build number recorded
in `HANDOFF.md`. Where a criterion is a measurement nobody has taken, it says so and names the number
to record rather than pretending a threshold was validated.

---

### I0 — The shared Capacitor surface, and the facts nobody has read yet

**What it builds.** The configuration and the seam that both mobile plans inherit, plus the
five-minute reading that validates a whole cluster of facts. Most of this phase runs in the container;
the enrolment does not.

STACK register #12 exists because `capacitorjs.com`, `ionic.io` and `capawesome.io` were all
egress-blocked during the audits, so **Capacitor 8's iOS minimum, its plugin list and several version
facts rest on search snippets**. STACK §4 calls the fix *"a five-minute task and it validates a whole
cluster of facts at once"*. Do it here, before anything is installed.

**Read and record, from the official docs, on an unblocked network:**

| Fact | Currently sourced from | Why it matters here |
|---|---|---|
| Capacitor 8.5.x's minimum iOS deployment target (recorded as iOS 15) | search snippet | It decides whether `rt { user-select: none }` copy exclusion (Safari 16.4+) and the CSS Custom Highlight API (Safari 17.2+) are guaranteed or need a floor. |
| Capacitor 8.5.2's Xcode requirement (recorded as Xcode 26+) | search snippet | The whole toolchain. |
| The UIScene adoption in 8.5, and what the generated project contains for it | AUDIT 1 | See below. |
| The official `@capacitor/*` plugin list | **not enumerated by any audit** | I5 needs keyboard, status-bar, splash and lifecycle behaviour and no audit says which plugin provides what. Write the list down. |
| `@capacitor-community/text-to-speech` 8.0.2's actual API | AUDIT 1 named `onRangeStart` with `{start, end, spokenWord}` | I4 is built on it. |
| **Whether the Capacitor CLI requires `ios/` and `android/` to be siblings of `capacitor.config.ts`**, and how `webDir` is resolved | **not established by any audit** | §2's layout puts them there anyway, so this is a confirmation rather than a decision — but a CLI that resolves `webDir` from somewhere other than the config would make the settled `'dist'` string wrong, which is a silent empty app. |
| **Which Safari version ships with which iOS version** | **not established by any audit or by STACK** | The CSS floors below are stated in *Safari* versions and an Xcode deployment target is an *iOS* version. Without this mapping "the floor the ruby CSS requires" is not a number anyone can type into the project settings. |
| **Whether a free personal team can install a debug build on a registered device** | **not established by any audit** | It decides whether I1 can start before the paid enrolment clears (§4.1). |
| **Whether a blob / `<a download>` save works inside a Capacitor WKWebView**, and which plugin it needs if not | **not established by any audit** | `web.md` W5's export is the v1 durability story on iOS (R9) and W5 tests it in Chromium only. I7 proves it on the device; this reading tells I7 what to expect. |

**Decide the deployment target with the CSS floors in mind, not the other way round.** Three features
the reader depends on have version floors in STACK §6's table, and the highest is not the one an earlier
draft of this plan chose:

| Feature | Floor | What a lower target costs |
|---|---|---|
| `ruby-align`, `ruby-overhang`, unprefixed `ruby-position` | **Safari 18.2** (late 2024); further overhang fixes in Safari 26.x | The reader's rendering model is per-character ruby (`core.md` C3, product-decisions §4 rule 1). `core.md` C3 judges the practical risk **cosmetic** — `over` is the engine default for horizontal text, so an engine that ignores the declaration lays it out the same way — but this is the highest floor and it governs the recommendation. |
| CSS Custom Highlight API | Safari 17.2+ (Baseline 2025) | No painted span highlight. `core.md` C5b's feature-detected fallback (tap-then-tap-to-here, painted with a class) covers it, so this is a degrade rather than a break. |
| `user-select: none` excluded from copy | WebKit since Safari 16.4 (bug 80159) | Pinyin in copied text **wherever native selection is still allowed**. That is not the reader passage — see I2, which explains why — but it is everywhere else `<HanziText>` renders: lookup headwords, card faces, example sentences. `rt { user-select: none }` is `core.md` C3's rule and this floor is what makes it work. |

**Recommendation: set the deployment target at the iOS version corresponding to Safari 18.2, the highest
of the three, and record in the config file's header which three floors chose it.** There is no user base
to strand and raising a deployment target is free today and expensive later. The Safari→iOS mapping
this requires is an **open question** — no audit and no part of STACK establishes it — and it is
settled by the same documentation read this phase already performs.

**Also carry over one question `core.md` C3 hands to this phase by name:** *"Hand the 'do we also emit
`-webkit-ruby-position`' question to `ios.md` alongside its deployment-target decision in register #12;
do not add the prefix speculatively."* Answer it here with the deployment target, in one line, and record
it — the answer follows from the target, and a prefix added on reflex is how a stylesheet accumulates
cruft nobody dares delete.

**Write the config where §2 says it goes, with the exact `webDir` string.**
`apps/app/capacitor.config.ts`, with `apps/app/ios/` and `apps/app/android/` beside it, and
`webDir: 'dist'` — the location `android.md` §2 already adopts, for the mechanical reason both
documents give: `webDir` resolves relative to the config, so a config one directory away from the build
output is one more path to keep in sync. **`'dist'` and `'apps/app/dist'` are not interchangeable and
the wrong one is a silent empty app**, so write the string that matches the layout and confirm it
against the CLI's own `webDir` resolution on this phase's reading list.

**Build the platform seam.** One module — `apps/app/lib/platform/native.ts` — exporting whether the app
is
running inside a Capacitor WebView and which platform it is, so that no component anywhere does
`typeof (window as any).Capacitor`. Everything that branches on native (service-worker registration,
the API base, the TTS adapter choice, the `DictStore` implementation choice) imports from here. Keep
it importable under Node and under jsdom without a Capacitor runtime present — the unit suite runs in
both.

**Start the Apple Developer Program enrolment now, and separate it from what I1 needs.** The membership
is $99/year (sourced) and it is a **hard gate on I7**, not on I1. What I1 needs is a signing identity that
can install a debug build on a registered device, which may be weaker; whether a free personal team
supplies it is on this phase's reading list (§4.1). Enrolment is the item in this plan with the longest
lead time that is not hardware, which is why it starts here.

**Write the device matrix.** §4.2 defines four roles — primary, clean target, smallest, oldest — and
two device *states* (wiped, near-full). Fill the table in `HANDOFF.md` now, with the real models available,
and decide "the smallest supported device" as a point size rather than leaving it to I5 to invent. If a
role has no device, the phases that need it are **blocked, not softened**, and the table is where that is
visible.

**Name the plugins in `package.json`, all of them, here.** Three phases later assume plugins that no phase
adds. Install what this plan is built on rather than letting it arrive by implication:
`@capacitor/core` and `@capacitor/cli` at **8.5.2**, `@capacitor-community/sqlite` at **8.1.1** (I3),
`@capacitor-community/text-to-speech` at **8.0.2** (I4), and whatever the plugin-list reading above names
for keyboard, status bar, splash and lifecycle (I5). All versions are STACK §6's pins, re-checked by the
reading pass above.

**Files.** `apps/app/capacitor.config.ts`, `apps/app/lib/platform/native.ts`,
`apps/app/tests/unit/platform/*`, `apps/app/package.json` (the Capacitor dependencies and the `cap`
scripts), `.gitignore`, and `HANDOFF.md`. **No sibling document is
edited by this phase** — `android.md` already states the same three answers (§2).

**Acceptance criteria.**

1. `HANDOFF.md` carries a table of the register-#12 facts with the URL each was read from and the date.
   A fact still marked *(search)* after this phase is a failed phase.
2. `capacitor.config.ts` exists, is typed, and its header states **the deployment target and the three
   floors that chose it**, plus the Safari→iOS mapping it was derived from and where that was read.
3. `apps/app/lib/platform/native.ts` has unit tests that pass under jsdom with no Capacitor global
   present, and pass with a faked one. `grep -rn "window.Capacitor\|isNativePlatform" apps/app/src
   apps/app/lib apps/app/components` returns only this module.
4. `pnpm lint`, `pnpm test` and the web build are unchanged and green — this phase adds dependencies
   and one module; it must change no behaviour on the web.
5. The Apple Developer Program enrolment is submitted, and its state is recorded. Separately, the
   personal-team question is answered from Apple's documentation, so I1's start does not wait on the
   enrolment unless the answer says it must.
6. The device matrix is in `HANDOFF.md` with all four roles assigned or explicitly marked unavailable.
7. `apps/app/package.json` declares every plugin named above at a pinned version, and `pnpm test`'s
   dependency-table spec (`tests/unit/deps.test.ts`, which asserts the table equals `dependencies`)
   is updated in the same commit.

---

### I1 — The Xcode project, and the app running on a real device

**What it builds.** `npx cap add ios`, a first sync, and an app that launches on a physical iPhone and
reaches every screen the build under test has. This is the phase where the SPA meets a local scheme, and
three things break that never break on the web.

**A note on what "every screen" means at this point, because it is not three tabs yet.** The three-tab
shell is `core.md` C7, and §4 does not gate this phase on it — deliberately, because I1 unblocks I2 and
I2 is the phase the stack decision rests on. Whatever this plan's own §1 says about three tabs, the build
I1 puts on a device is whatever `web.md` W1 produced: today's `components/shell/nav.ts` declares **seven**
routes and W1 ports that app to Vite rather than restructuring it. So I1's criteria and its standing
checklist are written against `src/routes.tsx` as it exists at this commit, and **`core.md` C7 is the phase
that re-baselines the checklist** to three tabs. Say that in `HANDOFF.md` when the checklist is written, so
the next reader knows a seven-row checklist is correct rather than stale.

**The three things.**

1. **The service worker must not register inside the app.**
   `apps/app/components/pwa/register-sw.tsx` exists
   because a stale worker on a shared origin serves yesterday's page for reasons nobody can see. Inside
   Capacitor the web assets are already local and already versioned by the app build, so a worker adds
   nothing and can serve a previous build's shell after an app update. Whether a service worker even
   registers under Capacitor's local scheme is **not established by any audit** — do not find out by
   accident. The gate off `apps/app/lib/platform/native.ts` is **`web.md` W1's edit**, in W1's Files
   list and its criteria; this phase is where it is proved on a device, and if W1 did not land it, this
   phase is blocked on W1 rather than editing the file.
2. **The API base cannot be relative.** Capacitor serves the web assets from a local origin, not from
   the app's own domain, so a relative `/api/ask` resolves to that local origin and fails. Read the
   actual origin off the running app rather than assuming its spelling — no audit records it — and
   record it, because it is also what the server's CORS configuration has to allow. `web.md` W4 owns
   the configured base; this phase proves a device reaches it. Separately, iOS is generally understood
   to require HTTPS for outbound requests unless an exception is declared, and **no audit establishes
   the current rule**: assume HTTPS, and if a plaintext base is ever proposed, read Apple's current
   App Transport Security guidance rather than adding an exception on reflex.
3. **The router must survive a non-`/` origin and a WebView with no address bar.** React Router 8 in
   data mode with `createBrowserRouter` needs the history API to behave under that local origin; verify
   a deep route survives a reload and that nothing in the app builds an absolute URL from
   `window.location.origin` expecting a real host. If history mode misbehaves, hash routing is the
   obvious fallback — but it is **this plan's proposal and it is recorded nowhere else**: neither
   AUDIT 4, nor STACK §2.3, nor `web.md`, which owns the router, mentions it, and a grep of `docs/` for
   `HashRouter` or `createHashRouter` matches only this paragraph. Measure before reaching for it, and
   if it is needed, it changes the URL model `web.md` W8 builds the keyboard layer on and therefore
   needs W8's agreement, not a note in `HANDOFF.md`.

**Verify UIScene adoption in the generated project and write down what you saw.** AUDIT 1: Capacitor
8.5 (July 2026) adopted UIScene, *"which the iOS 27 SDK will make mandatory (apps without it fail to
launch)"*. This is a future-dated, launch-breaking requirement, so it is worth thirty seconds now:
open the generated `Info.plist` and the app delegate, confirm the scene manifest and scene delegate
are present, and record the exact keys and filenames in `HANDOFF.md`. That record is what lets a
future session confirm the adoption survived a Capacitor upgrade, an Xcode migration or a hand edit.
**Do not upgrade to Capacitor 9** (at alpha.6 as of 2026-09-13) to get anything in this plan.

**Record which dependency manager the generated project uses.** AUDIT 1 notes that
`@capacitor-community/sqlite` 8.1.0 *added SPM*; whether the Capacitor 8 iOS template is CocoaPods or
SPM is not established by any audit. Read it off the first `cap add ios`. It decides how I3's native
dependency and any future native code are wired, and it is the sort of thing that is obvious on the
day and unrecoverable six months later.

**Decide the commit boundary.** The generated `ios/` tree is a real Xcode project and belongs in git;
the directory `cap sync` copies `dist/` into is generated output and must be gitignored. **Read its
actual path off the first sync rather than assuming one**, and put that path — not a guess — in
`.gitignore`.

**Settle what "tested" means on native.** STACK §7 leaves this open: *"there is no native test story at
all ... decide whether native builds are tested in v1 at all. Say which, because 'tested' otherwise
silently means 'web only'."* **This plan's answer: automated tests stay web-only, and every native
phase ends with a written manual device checklist.** The reasoning is that the automated suite already
exercises the same JavaScript that the app runs, the WebView is not what breaks, and a solo developer
who adds an iOS UI-test rig will maintain it instead of shipping. What that answer costs is that
nothing catches a native regression between phases, which is why the checklists are written down and
re-run rather than remembered.

**The standing checklist, written into `HANDOFF.md` at this phase.** It is the plan's only native
regression net, so it has to cover the surfaces the plan spends its risk budget on and not only the ones
that work on day one. It has two parts:

*Now, against whatever shell W1 produced:* launch; every route in `src/routes.tsx` renders and navigates;
look up a word; add a card; grade a card; background and resume; rotate; airplane mode.

*From the commit `core.md` C3–C6 land, added by whichever native phase runs next and never removed:* paste
a text into the reader and confirm it renders; drag a span and confirm the lookup fires with that span;
tap a character and confirm the character sheet opens; tap a block speaker; hold a block speaker and
confirm the per-character highlight advances. **Until C3–C6 land these five rows are marked "not yet
applicable" rather than deleted**, so their absence is visible.

*Re-baselined at `core.md` C7*, when seven routes become three tabs.

**Files.** `apps/app/ios/**` (generated, committed), `.gitignore`, `HANDOFF.md`. The native gate on
`apps/app/components/pwa/register-sw.tsx` is **`web.md` W1's** and is not edited here.

**Acceptance criteria.**

1. `npx cap sync ios` completes and the app launches from Xcode on a **physical iOS 26 device** — not
   only the Simulator. The device's OS version, the Xcode version, `@capacitor/core`'s version and the
   deployment target are recorded together.
2. Every route in `src/routes.tsx` renders and navigates on the device — at this commit that is the
   seven `components/shell/nav.ts` routes, not three tabs (see the note above); a deep route survives a
   reload; no request in the WebView inspector targets the local scheme for `/api/*`.
3. `navigator.serviceWorker.getRegistrations()` returns empty inside the app, asserted from Safari Web
   Inspector attached to the device. The unit test on the native branch of
   `apps/app/components/pwa/register-sw.tsx` is `web.md` W1's criterion; this one is the device half of
   the same claim, and a failure here is reported to `web.md` rather than patched in this phase.
4. One authenticated call to the real API base succeeds over HTTPS from the device, and the response
   is rendered. If `backend.md` has not shipped, this criterion is explicitly deferred **in writing** to
   I8 rather than silently skipped.
5. The scene-manifest evidence for UIScene is pasted into `HANDOFF.md`.
6. The standing device checklist exists in both its parts, its reader rows are marked "not yet
   applicable" with the phase that activates them, and the applicable rows have been run once with their
   results.
7. The device the app launched on is identified by its role in §4.2's matrix, not just by model.

---

### I2 — The crash check, and the per-character reader on real hardware

**This is the phase the whole iOS decision rests on, and no `core.md` C5b production file may land
before it returns.** It settles register #1 and register #2. Everything else in this plan is ordinary app
work; this is the part that could invalidate the stack choice. §4.4 states the C5a/C5b split this
ordering required and where it is settled.

**What is being tested, precisely.** STACK register #1 states that *neither audit ran the combination
this record specifies*: one `<ruby>` element per character, `caretRangeFromPoint` on every
`pointermove`, painted with the CSS Custom Highlight API, over a DOM whose text nodes are interleaved
with `<rt>` annotations. Each audit recommended the pieces; nobody ran them together. So there are two
questions in one prototype, and both need a real device:

- **Does it crash?** AUDIT 1: *"an Apple forum thread reports a WKWebView crash on the iOS 26 beta with
  `-webkit-user-select: none` during touch; resolution unknown. Test on a real iOS 26 device early."*
  That CSS property sits on the critical interaction. The reader suppresses native selection precisely
  so that a drag can be hand-rolled — there is no version of this design that does not apply it, and it
  is applied to the element the finger is on.
- **Is it fast enough?** Pointer latency per `pointermove` hit-test, and layout time for a pasted
  passage of a few hundred characters where every character is its own ruby element. Both unmeasured
  on any device.

**Two `user-select` rules, and they are not the same rule.** An earlier draft of this plan conflated
them and the conflation made check 5 unrunnable. Keep them apart:

| Rule | Where | What it does | Whose floor |
|---|---|---|---|
| `-webkit-user-select: none` on the **passage** | the reader, `core.md` C5b | Suppresses native selection entirely, so a drag can be hand-rolled. AUDIT 1's own recommendation is *"do NOT use native WKWebView selection over ruby"*. This is the crash risk. | none — it is the interaction design |
| `rt { user-select: none }` | every `<HanziText>`, `core.md` C3 | Excludes pinyin from a copy **where native selection still happens** — lookup headwords, card faces, examples. Not the reader passage: there is no native selection there to exclude anything from. | Safari 16.4 (bug 80159), which is why I0's floor table keeps the row |

The consequence for this phase is that **there is no system selection to make and no system copy to
inspect on the reader passage.** Whatever reaches the clipboard from a span comes from `core.md` C5b's own
`copy` handler in `components/hanzi/span-clipboard.ts`, which calls `preventDefault()` and writes
`spanOf(from, to)` — the app choosing the string rather than the engine deriving it. Safari 16.4's
behaviour is irrelevant to that path. STACK register #1 still asks the phase to *"confirm copy excludes
the pinyin"*, and check 5 below is that confirmation, restated against the affordance that actually
exists.

**How to run it.** Load `core.md` **C5a**'s harness — the gallery page that already ran in desktop
Chromium, with no production reader file touched (§4.4) — inside the Capacitor WebView from I1, not in
mobile Safari. Mobile Safari is WKWebView too but not with Capacitor's configuration, and the
configuration is part of what is being tested. Attach Safari Web Inspector to the device for the console
and the timeline.

**The checklist, all on the device:**

| # | Check | What settles it |
|---|---|---|
| 1 | Apply `-webkit-user-select: none` to the passage and drag across it repeatedly, including fast flicks and multi-touch. | No crash, over a sustained session. A crash reproduces the forum report and triggers the decision below. |
| 2 | Hit-test on every `pointermove`. | Median and p95 `pointermove`→highlight-updated latency, recorded as numbers. Nobody has a threshold; record what it is and judge it by feel with the owner. |
| 3 | Render a realistic pasted passage (a few hundred characters, per-character ruby). | Layout/paint time, recorded. Then scroll it and record whether it stays smooth. |
| 4 | Feature-detect `caretPositionFromPoint` and log which path is taken (register #2). | Whether the hit test is standards-track on Safari 26 or forks to the WebKit-proprietary `caretRangeFromPoint`. Not fatal either way — the proprietary one is present in every WKWebView — but the code must prefer the standard and fall back, and the log says which ran. |
| 5 | Drag a span, then invoke whatever copy affordance the harness carries from `core.md` C5a — on touch that is the explicit **Copy** control, since there is no `Cmd+C`. | The string the app writes to the clipboard is exactly the span's base characters, with **no pinyin**. Read the clipboard back and compare it to `spanOf()`'s string; do not infer it from what the selection looks like. If the harness has no copy affordance yet, record that and hand the check to whichever phase ships one — do not substitute a system copy, because there is no system selection on this passage to copy from. |
| 6 | Confirm highlight ranges land on base characters and never on `<rt>` text. | Visual, plus assert the resolved range's container in the console. |
| 7 | Repeat 1–3 with VoiceOver on and with Dynamic Type at a large setting. | Neither audit touched accessibility on this interaction and the reader is the app's core screen. Record what happens; do not fix it here. |

**If the crash reproduces: the containment boundary, and what taking it costs.**

STACK §2.1 records the escape hatch and, in the same paragraph, refuses to let it be read as cheap. A
Capacitor plugin can present a native `UIViewController` from `bridge.viewController`, so **if WebKit
selection proves unusable the damage is confined to the reader screen** — lookup, practice, library,
the dictionary, the database and every other surface are untouched, and nothing about the Capacitor
decision has to be reversed. That is a genuinely valuable property and it is why this risk is
survivable at all.

It is not an escape from the work. Taking that exit means building exactly the thing the whole stack
decision exists to avoid: a Core Text ruby layout engine, plus hit-testing, plus
`UITextInteraction`/`UITextSelectionDisplayInteraction` — the Pleco path, which STACK's own
alternatives table calls *"a company's worth of work"*. It is also **iOS-only**: neither audit records
an Android equivalent of `bridge.viewController`, and if the interaction design fails it plausibly
fails on both engines, in which case Android's answer is a custom Compose `Layout` plus
`TextLayoutResult.getOffsetForPosition` — a second native text engine, in a language the owner does
not use.

**So the order of attempts, if check 1 crashes, is:**

1. **Find a CSS workaround first.** Try `user-select: none` unprefixed only; try applying it to a
   parent rather than the touched element; try applying it on `pointerdown` and removing it on
   `pointerup`; try suppressing the callout with `-webkit-touch-callout: none` alone and leaving
   selection enabled but discarded. Record every variant tried and its result — this list is the
   evidence for the next step and it is worth more than a conclusion.
2. **Re-check against the current OS.** The report is from the iOS 26 **beta** and its resolution is
   unknown. Update the device to the current release and re-run. If it is fixed, note the OS version at
   which it is fixed and set the app's floor accordingly rather than treating it as gone.
3. **Only then** consider whether the reader is the first candidate for the native boundary — and if
   so, stop and re-plan with the owner, because that is a scope change, not a phase.

**Files.** `HANDOFF.md`, and at most a development-only route under `apps/app/` that mounts `core.md`
C5a's existing gallery harness. **This phase writes no production reader code.** It is a measurement.

**Acceptance criteria.**

1. All seven checks have written results with the device's exact OS version, including the two latency
   numbers and the layout number as figures, not adjectives.
2. Register #1 and register #2 are marked settled in `HANDOFF.md`, with the command or the code that
   settled each.
3. If check 1 crashed: every workaround variant from the list above is recorded with its result, and
   the phase ends in a written recommendation to the owner. **A crash with no recorded workaround
   attempts is a failed phase, not a blocked one.**
4. If the checks pass: **`core.md` C5b** — the production half of the split, `use-span-select.ts`,
   `hanzi-text.tsx`, `reader-text.tsx` and `lib/stores/reader.ts` — is unblocked, and `HANDOFF.md` says
   so explicitly, because that phase is waiting on this answer (§4.4).

---

### I3 — The dictionary in the app package

**What it builds.** `dict-<schema>-<cedict>.sqlite` and `decomp.json` inside the iOS app bundle, the
first-launch copy into app storage, and the four device answers that make `data.md`'s "one file, all
three platforms" claim true on iOS. **Run this as the same device session as `data.md` D5b, with both
documents open** — D5a owns `lib/dict/runners/capacitor.ts` and D5b adopts it unchanged, this phase
owns the asset reaching the device and the iOS half of the measurements.

**The asset path is a build-system problem, not a copy.** `data/*.json` is generated and gitignored
today, and STACK §7 lists the `pnpm data` → artifact path as an **undecided shared surface** that must
reach the Capacitor `ios/` and `android/` asset directories, the web host and possibly the Astro
build, reproducibly. `data.md` owns deciding it. This phase's job is to consume that decision and prove
it: the file must land in the bundle from a build step, not from a developer dragging it into Xcode,
because a hand-placed asset is the kind of thing that works for a year and then silently ships a stale
dictionary.

**Budget the file twice, at the number `data.md` D5a actually gives.** The artifact sits compressed in
the package **and** expanded in app storage after the copy. D5a's figure — the single budget for both
platforms, which D5b adopts unchanged — is **~19.5 MB + 43.1 MB ≈ 63 MB**,
and it says so in terms that bind this document: *"Use ~19.5 MB + 43.1 MB ≈ 63 MB, not the 57 MB an
earlier draft gave … Every size estimate in `ios.md` and `android.md` must use 63 MB and must carry
that caveat."*
The caveat is that the packaged half is a `gzip -9` proxy — **register #16 is "Store compression ratio",
and its check is to read the real download size in the Play Console and App Store Connect after the first
upload.** Nothing in any audit says a Capacitor app with a bundled SQLite asset is app-thinned, so do not
describe the App Store Connect figure as a thinned download; it is *the download size App Store Connect
reports*, which is what #16 asks for. Apple's limits have enormous headroom (4 GB uncompressed, 80 MB
`__TEXT` per binary, sourced), but the *"Ask if over 200 MB"* cellular prompt is a user default since
iOS 13.

**Four register entries, one session:**

| # | Question | The check |
|---|---|---|
| 20 | **Is FTS5 compiled into the SQLCipher iOS pod?** Verified for the Android artifact only; named in the dictionary audit's own not-verified list. This is the claim that makes one file work on iOS with no per-platform build. | Open the copied asset through the plugin and run `SELECT sqlite_version()` and a gloss query against the FTS5 table. If FTS5 is absent, English gloss search is broken on iOS and `data.md`'s fallbacks are the recourse — say so loudly rather than shipping a silently degraded search. |
| 6 | Do `ATTACH` and the `immutable=1` URI flag pass through the plugin? | Call both; read the error. Not fatal either way — two connections work — but it decides whether the dictionary and the learner's database can share one. |
| 18 | **How long does `copyFromAssets()` of a ~43 MB file take, and what does it cost in storage?** Unmeasured by anyone; STACK §2.5 says the audit's *"no failure mode"* phrasing should not survive into a build plan. | Time it on the **primary** and on the **near-full** device state from §4.2's matrix. Record peak storage. Then confirm the one-time progress state and the low-storage failure path actually appear. Those two screens are `core.md` **C4a part three**, which builds them by name for this register entry (*"the same two components as `preparing` and `failed{reason:'storage'}` with different copy"*); `data.md` D5a owns the state model and D5b checks the same two states on iOS; this phase owns proving they render on the device. §4.3 gates I3 on C4a for exactly this reason. |
| 11 | Cold-start time with the dictionary open, on iOS. | Measure it. AUDIT 1 records practitioner reports of *"under ~2 s on iPhone 11-class hardware"* with **no rigorous benchmark**, so this is a number to establish, not a threshold to pass. Record it against the owner's own bar. |

**The bridge is the performance story, not SQLite.** STACK §2.5 hard part 4: every query is a JSON
round trip (~1–5 ms plus serialisation). `data.md` D2's round-trip test — the one that keeps a
keystroke to two plugin calls — must be run against this runner on the device, not only in Node.

**`decomp.json` rides along.** 0.92 MB, needed by the character sheet on every platform, and it must
**never** merge into `dict.sqlite`: `dict.json` is CC BY-SA and Make Me a Hanzi is
LGPL-3.0-or-later (PLAN.md §5, CLAUDE.md). Two files in the bundle, two licences, and both notices in
`data/ATTRIBUTION.md`.

**SQLCipher's BSD notice.** The plugin bundles SQLCipher on both platforms and STACK §2.5 is explicit:
*"You must reproduce SQLCipher's BSD notice in-app."* It goes into `data/ATTRIBUTION.md` next to
CC-CEDICT and Make Me a Hanzi, and the settings screen already renders that file.

**The native dependency lands here, and this phase owns it landing.** `@capacitor-community/sqlite`
8.1.1 is declared in `apps/app/package.json` at I0, but a declared npm package is not a wired native
dependency: `npx cap sync ios` has to run again and the pod or SPM resolution has to succeed. I1 recorded
**which** dependency manager the generated project uses; this is the phase that first depends on the
answer. Re-run the sync, paste the resolution output into `HANDOFF.md`, and note the resolved SQLCipher
version alongside it — register #20 is a question about that exact artifact.

**Files.** `apps/app/package.json` (if the plugin was not already pinned at I0), the build step that
places the assets (jointly with `data.md`), `apps/app/ios/**` (asset references, and the re-synced native
dependency), `data/ATTRIBUTION.md`, `HANDOFF.md`.

**Acceptance criteria.**

1. A clean install on the **wiped** device state from §4.2 performs the copy once, shows `core.md`
   C4a's progress state with its bar advancing, and answers dictionary queries offline with airplane mode
   on. If C4a has not landed, this phase is **blocked** rather than passing with an undrawn state.
2. Registers #20, #6, #18 and #11 have written answers with the command run and the output, in
   `HANDOFF.md`. **A phase that cannot run these because there is no hardware is blocked, not
   complete.**
3. The fixed query list `data.md` uses at D2/D3/D4 returns byte-identical results through the
   Capacitor runner on the device.
4. Deleting the app and reinstalling reproduces the copy; changing the dictionary version in the
   manifest triggers exactly one re-copy and no more.
5. The installed size on device is recorded (both halves) against D5a's ~63 MB budget, and the App Store
   Connect **download size** is recorded at I7 when there is an upload to read it from.
6. SQLCipher's BSD notice is in `data/ATTRIBUTION.md` and visible in the app's licences screen.
7. `npx cap sync ios` re-run after the plugin is present, with the pod or SPM resolution output and the
   resolved SQLCipher version pasted into `HANDOFF.md`.

---

### I4 — Native speech, and how the character-by-character highlight is driven

**What it builds.** `apps/app/lib/tts/capacitor.ts` — the `TTSProvider` implementation over
`@capacitor-community/text-to-speech` 8.0.2 (MIT, June 2026) — plus the voice selection that reaches
Apple's enhanced Mandarin voices, and the wiring that lets `core.md` C6's hold-to-slow mode work on a
device. **This is one file for both platforms** (§2): it is created here, `android.md` A4 extends it
with the Android half rather than forking it, and the Mandarin voice predicates live in one module.

**Why native and not Web Speech, restated because it decides the whole phase.** AUDIT 1: Web Speech
inside WKWebView *"only exposes compact/pre-installed voices (Apple forum 723503; regressions in iOS
18), so Tingting/Meijia Enhanced voices would be unreachable."* That half is sourced and it is the whole
argument. AUDIT 1 also calls WebKit boundary events unreliable, but **its own "Could not verify" list
contains "whether WebKit fires Web Speech `boundary` in WKWebView"** — so the audit contradicts itself
on that clause, and the design does not depend on it either way, since the highlight is driven off
per-utterance `start`. The plugin wraps `AVSpeechSynthesizer` and forwards
`willSpeakRangeOfSpeechString` as an `onRangeStart` event carrying `{start, end, spokenWord}`.

**How the character-by-character highlight is actually driven, and why it is not `onRangeStart`.**
Product rule 3 (product-decisions §4): hold the speaker → 0.6× playback, character by character, each
character lit as it plays. STACK §2.1 makes the mechanism a rule rather than a fallback: **enqueue one
utterance per character and advance the highlight on each utterance's `start`.** The reason is that
range events are engine-dependent on Android, and building the interaction twice — one path where
boundaries exist and one where they do not — means the path that only runs on one platform is the one
that is never tested. So iOS uses the same per-utterance path as Android, and `onRangeStart` is
plumbed through as a *capability* rather than as the mechanism: the adapter reports
`supportsBoundary` honestly, `core.md` C6's sequencer ignores it for slow mode, and it stays available
for anything later that wants word-level tracking inside a single long utterance.

The highlight itself is painted by `core.md` — the Custom Highlight API, under a different highlight
name from the drag selection so that "currently speaking" and "selected span" compose instead of
fighting (C6). This phase supplies events, not paint.

**What the adapter must carry over from the Web Speech implementation.** Read
`lib/tts/speech-synthesis.ts` before writing this file. Three of its judgements are about Mandarin, not
about Web Speech, and must survive: rank rather than filter; **refuse Cantonese outright** (`yue*`,
`zh-HK`, `zh-MO`) because a Cantonese reading of a Mandarin pinyin card is a wrong answer the learner
cannot detect; and prefer `zh-CN`/`zh-SG`/Hans over `zh-TW`/Hant over bare `zh`. On iOS there is a
fourth: **prefer the enhanced/premium voice when one is installed**, because it is the entire reason
for going native.

**What happens when only a compact voice is installed is an open question, not a requirement this phase
can state.** The obvious answer — tell the learner a better voice can be downloaded in iOS Settings —
would be a **fourth** speaker state, and `core.md` C2 fixes the set at three: *"The pending / ready /
unavailable triad and its visible reason survive verbatim."* No `core.md` phase adds a fourth, this plan
does not own components (§2), and no criterion below tests one. So the deliverable here is the *finding*,
not the affordance: record in `HANDOFF.md` whether the device distinguishes compact from enhanced in the
voice list and how, and put the question — "iOS can have a Mandarin voice available but only in compact
quality; is that worth a state?" — to the owner. If the answer is yes, it becomes a `core.md` addition
with its own criterion, not a line of prose in a mobile phase.

**Everything about the plugin's runtime behaviour is unverified and this phase is where it is
established.** No audit ran it. Record answers for all of these:

| Question | Why it matters |
|---|---|
| Does `speak()` resolve when the utterance **finishes** or when it is **queued**? | `TTSProvider`'s current header documents the queued semantics; C2's widened interface may assume otherwise. The sequencer's timing depends on it. |
| What happens when `speak()` is called while speaking — queue, replace, or error? | Tapping a second speaker mid-utterance is the most common real interaction. |
| Does `stop()` cancel a queued sequence, or only the current utterance? | C6 requires that releasing the hold stops the remainder. |
| How does the plugin's `rate` map to `AVSpeechUtterance`? Is 0.6× intelligible or slurred? | Product rule 3 names 0.6×. Judge it by ear with the owner and record the value actually shipped. |
| What is the **gap between consecutive utterances** in a per-character sequence? | This is the risk that decides whether slow mode feels like reading or like a fax machine. Measure the inter-character interval for a 5-character block. |
| Does speech play with the **silent switch** on? Does it duck or stop background audio? Does it survive a phone call, an interruption, and backgrounding? | AUDIT 1 notes `@capgo/capacitor-speech-synthesis` (MPL-2.0) has explicit audio-session control and the community plugin's is unstated. If the community plugin's audio session is wrong and unconfigurable, capgo is the recorded alternative. |
| Does `onRangeStart` actually fire, and are its offsets character offsets into the string? | Decides `supportsBoundary`. |

**Files.** `apps/app/lib/tts/capacitor.ts`, the shared Mandarin voice predicates,
`apps/app/tests/unit/tts/capacitor.test.ts` (against a faked plugin), and the provider-selection
point — **one module**, branching on `apps/app/lib/platform/native.ts`, which `android.md` A4 reads
rather than rewrites — plus `HANDOFF.md`.

**Acceptance criteria.**

1. Unit tests, with the plugin faked, drive the adapter through C2's contract: speak → stop → speak
   cancels the first and not the second; two overlapping sequences, cancelling the older leaves the
   newer running; `supportsBoundary` is reported from a real capability, not hard-coded.
2. On the device: tapping a block speaker reads the block in Mandarin, in an enhanced voice when one is
   installed, and the voice actually used is logged.
3. On the device: holding the speaker on a 5-character block produces five utterances at the configured
   rate with the highlight advancing once per character, and releasing mid-sequence stops it
   immediately with no further audio.
4. Tapping a single character speaks exactly that character.
5. A device with **no Mandarin voice at all** renders the existing unavailable state with its visible
   reason — the state `components/tts/speak-button.tsx` already ships and whose header explains why the
   reason is visible text rather than a `title`. Simulate it by forcing the adapter's voice list empty.
6. Every question in the table above has a written answer in `HANDOFF.md`, including the inter-character
   gap as a number. `android.md` reads this section rather than re-deriving it.
7. The compact-versus-enhanced finding is recorded, with the voice list the device returned, and the
   question is put to the owner in writing. No fourth speaker state is built in this phase.

---

### I5 — Safe areas, the keyboard, and the WebView's own gestures

**What it builds.** The chrome work: a layout that respects the notch and the home indicator, an input
that stays visible above the keyboard, and a WebView whose built-in gestures do not fight a hand-rolled
drag.

**Nothing in the audits covers iOS safe areas or the iOS keyboard.** AUDIT 2 *reported* — from
Capacitor #8432 and an issue tracker, not from a device it ran — that Chromium below WebView 140 returned
0 px safe-area insets and that the keyboard bottom inset was fixed in 144; its own "Could not verify"
section records that direct reads of `issues.chromium.org` (with capacitorjs.com, ionic.io, tauri.app and
capawesome.io) were egress-blocked. STACK §6 records `@capacitor-community/safe-area` as an **Android**
plugin. So on iOS there is no finding at all, measured or reported: whether WKWebView reports
`env(safe-area-inset-*)` correctly under Capacitor is **unestablished**, and this phase's first job is to
find out rather than to assume iOS is the easy platform.

**The work:**

- **`viewport-fit=cover`, which `web.md` W1 carries and this phase asserts.** `env(safe-area-inset-*)`
  is zero without it, so every criterion below rests on it. Today's `app/layout.tsx` viewport export
  does not set it; the attribute is in **W1's Files list** for `apps/app/index.html` and in W1's
  acceptance criteria, so this phase neither makes the edit nor hands it anywhere. Confirm it is there
  before measuring anything — if it is missing, this phase is blocked on W1, and a zero inset with the
  attribute absent is a `web.md` bug rather than an iOS finding.
- **The tab bar and the home indicator.** product-decisions §10 puts the phone on *"the three-tab shell"*
  and §1 defines the three tabs, but **neither says the bar is at the bottom** — that is on the design
  canvas, which a fresh session cannot read. The safe-area reasoning here depends entirely on the bar
  being at the bottom, so **I5 records the placement as a decision** with one line of justification and
  `core.md` C7 is told. If it is at the bottom, that is exactly where the home indicator lives: the bar
  takes `env(safe-area-inset-bottom)` as padding, not margin, so its background extends under the
  indicator.
- **The status bar and the notch, in both colour schemes.** The header takes `env(safe-area-inset-top)`.
  The status-bar style has to be decided against the ground it sits on, and there are **two** grounds, not
  one: product-decisions §11 fixes the warm paper light palette (`#f8f4ec`), and today's `app/globals.css`
  also carries a full `@media (prefers-color-scheme: dark)` block with `html { color-scheme: light dark }`,
  which `core.md` C0 keeps and extends (its criteria require both a `prefers-color-scheme` block and a
  `[data-theme="dark"]` block defining the same tokens). So decide the style for light and for dark, and
  say how it follows the scheme at runtime. The manifest's current `theme_color` is the old jade `#0f766e`
  and will be wrong after C0 in either scheme.
- **The keyboard.** The lookup box leads the Look up screen (product-decisions §2) and the write-card
  input is the whole interaction on a Write card. Establish, on the device: does the WebView resize or
  does the keyboard overlay it; does `visualViewport` report the change; does the focused input scroll
  into view on its own; does the tab bar ride up with the keyboard or stay under it. Then pick a
  behaviour and make it deliberate. Which Capacitor plugin supplies keyboard control is the list I0
  recorded.
- **Overscroll, bounce and the callout.** A rubber-band scroll under a fixed tab bar reads as broken,
  and the long-press callout ("Copy / Look Up / Translate") is Apple's UI appearing on top of the app's
  own dictionary UI. Both are suppressed with CSS (`overscroll-behavior`, `-webkit-touch-callout:
  none`) and possibly with WebView configuration. **Note the interaction with I2:** callout suppression
  and selection suppression are neighbours in the same critical interaction, so any change here re-runs
  I2's check 1 rather than assuming it still holds.
- **The back-forward navigation gesture.** WKWebView can treat a left-edge horizontal swipe as "go
  back". A left-edge horizontal drag is also exactly how a learner selects a span at the start of a
  line. Whether Capacitor enables the gesture by default is **not established by any audit** — read the
  generated configuration, then test a drag starting within a few points of the left edge.

**Files.** `core.md` C0's token stylesheet — `app/globals.css` today, relocated by `web.md` W0 and
rewritten by C0, so **C0 fixes its final path and this phase uses whatever that is**; this is `core.md`'s
file, so the safe-area utilities are proposed here and landed there or by explicit agreement. Plus
`core.md` C7's shell components (same rule), `apps/app/ios/**` configuration, and `HANDOFF.md`.
`apps/app/index.html` is **`web.md` W1's** and is not edited here.

**Acceptance criteria.**

1. On a device with a notch and a home indicator: no content is under either, in portrait and
   landscape, on all three tabs and on a practice card. Screenshots in `HANDOFF.md`.
2. `env(safe-area-inset-top)` and `-bottom` are logged from the device and are non-zero. If they are
   zero, that is the iOS equivalent of the Chromium bug AUDIT 2 found and it needs the same kind of
   plugin answer — record it as a finding, not as a styling problem.
3. Focusing the lookup input and the write-card input keeps the input and its submit affordance
   visible, with the keyboard up, on **the smallest device in §4.2's matrix** — the role, at the point
   size I0 recorded. Recorded as screenshots.
4. Dismissing the keyboard restores the layout with no gap and no double scroll.
5. Rubber-band overscroll does not detach the tab bar or the header; a long press on hanzi produces
   the app's own sheet and **not** the system callout.
6. A drag starting at the left edge of the reader selects a span and does not navigate back. This is
   the **production** interaction — `core.md` C5b's `use-span-select.ts` over `<HanziText>`, which §4.3
   gates before this phase — not a second run of I2's harness, and it is the first time the shipped reader
   meets real hardware. Run the reader rows of I1's standing checklist in the same session and record them.
7. I2's check 1 is re-run after this phase's CSS lands, and the result recorded again.

---

### I6 — Identity: icons, launch screen, name, version

**What it builds.** The app as an object on a home screen and in App Store Connect.

**The icons cannot be resized from what exists.** The largest raster in the repo is
`public/icons/tangram-512.png`; the App Store marketing icon is 1024. `app/icon.svg` is the source and
everything is rendered from it. HANDOFF.md records that the existing PNGs came from *"a stdlib-only
rasteriser — no new dependency"*; whether that script survives the Vite move is `web.md`'s business,
but this phase needs a full iOS icon set out of the same SVG, and whatever tool produces it must be
recorded and repeatable. A hand-exported icon set is a stale icon set.

**The launch screen is not a loading screen.** Replace the generated project's default with something
that matches the warm paper ground so the app does not flash white — and note what it must *not* do:
the app's real first-run cost is I3's dictionary copy, which happens after the WebView is up and has
its own designed progress state. A launch screen with a spinner would be pretending to be that state.
Read the generated project to see what mechanism it uses and record it.

**Also here, because they are cheap and annoying to get wrong later:** the display name under the icon,
the bundle identifier (fixed at I0 and never changeable after the first upload), the marketing version
and the build number, and the version-bump step that makes a second TestFlight upload possible. Decide
whether the build number is derived from CI or bumped by hand and write it down; "upload rejected,
build number already used" is the most common wasted twenty minutes in iOS releases.

**Files.** `apps/app/ios/**` (asset catalog, launch screen, Info.plist), the icon-generation script,
`HANDOFF.md`.

**Acceptance criteria.**

1. The icon renders correctly on the home screen, in Settings, in Spotlight and in the app switcher on
   a real device — light and dark home screens.
2. A 1024 marketing icon exists, is generated from `app/icon.svg` by a recorded command, and is not a
   scaled-up 512.
3. Cold launch shows the launch screen on the app's own ground colour with no white flash and no
   spinner.
4. The display name, bundle identifier, version and build number are recorded in `HANDOFF.md`, along
   with how the build number is incremented.

---

### I7 — Signing, the first archive, and TestFlight

**What it builds.** A signed archive uploaded to App Store Connect and installable through TestFlight
on the owner's own device.

**Three submission-time obligations that no audit established.** Say this plainly at the top of the
phase so nobody treats them as known: **the audits scoped the client, and none of them covers App
Store Connect's compliance questionnaire.** Each of these is an open question with a check, not a
requirement this plan can state:

| Open question | Why it is live for *this* app | The check |
|---|---|---|
| **Export compliance / encryption.** | `@capacitor-community/sqlite` bundles **SQLCipher** (STACK §2.5) — an encryption library — even though this app opens the dictionary read-only and encrypts nothing. App Store Connect asks about encryption at every upload and the answer has legal weight. | Read Apple's current export-compliance guidance and SQLCipher's own statements before the first upload, and record the answer given and the reasoning. Do not guess it once and copy it forever. |
| **The privacy manifest and any required-reason API declarations.** | Not mentioned in any audit. Capacitor and its plugins are third-party SDKs. | Read Apple's current requirements and check whether the Capacitor pods ship their own manifests. Record what was found. |
| **App privacy ("nutrition label") answers.** | The app collects nothing today — every card lives in the device's IndexedDB (`docs/deploy.md`: *"a deployment holds no user data at all"*) — but `backend.md` adds accounts, sync and custody of the learner's API key, which changes the answer. | Answer for what the submitted build actually does, and re-answer when `backend.md` ships. |

**Signing.** This is the phase the **paid** Apple Developer Program membership hard-gates (§4.1);
enrolment started at I0 and if it has not cleared, this phase is blocked and I1–I6 were not. Certificates
and provisioning profiles, and a decision between automatic and manual signing. Recommendation:
automatic, for a solo developer with one Mac. Record the team id and the profile names.

**Prove the export on the device, because nowhere else does.** R9 makes `web.md` W5's local export the
v1 durability story on iOS — *"a local export must exist before the first TestFlight build reaches
anyone"* — and until now nothing enforced it. W5 ships and round-trips the export but tests it in
Chromium; whether a
blob or `<a download>` save works inside a Capacitor WKWebView, or needs a Filesystem/Share plugin, is
established by no audit and is on I0's reading list. This is the phase that finds out, on the build a
tester would actually install. If it does not work, say so in the TestFlight notes rather than shipping a
durability claim the app cannot honour.

**TestFlight.** Internal testing on the owner's own devices is the goal for this phase. External
testing requires a review pass whose current rules no audit establishes — if external testers are
wanted, read the requirements before promising anyone a build.

**Files.** `apps/app/ios/**` (signing configuration), `HANDOFF.md` (the compliance answers and the
signing record).

**Acceptance criteria.**

1. `Product > Archive` succeeds and validates, and the build appears in App Store Connect.
2. The build installs from TestFlight on **the clean target** from §4.2's matrix — a device that has
   never had a development build of this app, which by now is not the primary — and passes the standing
   device checklist from I1 **including its reader rows**, since `core.md` C3–C6 have landed by this
   point. This is the first time the app runs without Xcode attached, and it is where signing and
   asset-bundling mistakes surface.
3. The dictionary copy runs on that clean install and the app works fully offline afterwards.
4. The download size App Store Connect reports after the upload, and the installed size, are recorded
   against `data.md` D5a's ~63 MB budget — settling register #16 ("Store compression ratio") for iOS.
5. All three compliance questions above have written answers with their sources.
6. **The local export produces a retrievable file on the device**, not in Chromium: run it from the
   TestFlight build, retrieve the file off the phone, and re-import it into a fresh install. If it needs a
   plugin, that plugin is named and added here.

---

### I8 — App Store submission

**What it builds.** A listing and a submitted build.

**Guideline 4.2 is low risk and should still be pre-empted in the review notes.** AUDIT 1: rejection
risk is *"LOW — Guideline 4.2 rejections hit 'repackaged website' apps; an offline 124k-entry
dictionary + SRS + native TTS clears it comfortably."* Low is not zero, and the cheapest insurance is
one paragraph in the review notes saying exactly that: the dictionary is bundled and works in airplane
mode, speech is `AVSpeechSynthesizer`, and the scheduling is computed on device.

**Reviewer access: this plan owns the answer, and the answer is the degraded state.** An earlier draft
assigned "the demo account App Review will want" to `backend.md`. It does not own it —
`grep -rn -i 'demo\|App Review\|reviewer' backend.md` returns nothing but CORS and repository text — and
rather than push an unowned artifact at a sibling, this plan takes the cheaper path it had already
designed. **Default: the AI surfaces degrade to the dictionary-only state product-decisions §5 already
requires** (*"with no AI reachable, a quiet 'Dictionary only — offline' chip and everything else still
works"*). It is a designed state, not a hack, it needs no credentials to exist, and it is demonstrable.
A demo account is the fallback if the owner decides a reviewer must see the AI answer, and taking it means
getting a row into `backend.md` first.

**One question that genuinely does need `backend.md`, and one that needs nobody:**

- **A reachable API base**, if the submitted build is meant to show the AI answer at all (§4.3).
- **Does BYOK interact with the payment guidelines?** The learner brings their own third-party API key
  and is billed by that provider. Nothing in the audits or the product decisions establishes how Apple
  treats that. **Read the current App Review Guidelines on this specific point before submitting**, and
  record the reading. This is the single most plausible cause of a rejection in this plan.

**The listing.** Screenshots at the required sizes (take them from a
real device, on the settled visual language, not from the Simulator's default wallpaper), description,
keywords, age rating, and the licence attribution — CC-CEDICT is CC BY-SA 4.0 and Make Me a Hanzi is
LGPL-3.0-or-later, both already rendered in-app from `data/ATTRIBUTION.md`, and the description should
say the dictionary's provenance rather than leaving a reviewer to wonder where 124k entries came from.

App Store Connect also requires a **support URL** and a **privacy policy URL**, and **`web.md` W7 owns
both pages** — `/privacy` and `/support` on the Astro site at the apex, with their exact URLs recorded in
`HANDOFF.md`. This phase reads those two URLs and puts them in the listing; it does not write the pages.
If W7 has not landed, this phase is blocked on it, and a blocked submission is a week — so check the two
URLs resolve before the listing is started, not on submission day.

**Files.** `HANDOFF.md` (the submission record), screenshot assets, `data/ATTRIBUTION.md` if the
listing surfaces anything not already there.

**Acceptance criteria.**

1. The listing is complete — including `web.md` W7's live support URL and live privacy policy URL,
   both checked to resolve from outside the network they were built on — and the build is submitted.
2. The review notes paragraph pre-empting Guideline 4.2 exists, quoted in `HANDOFF.md`.
3. The reviewer-access decision is written down and, since the default is "degrade to dictionary-only",
   that path is demonstrated on a device with the API base unreachable and the demonstration recorded.
   Choosing a demo account instead requires a `backend.md` row first, and the criterion then becomes the
   credentials working from a clean device.
4. The BYOK/payments reading is recorded with the date and the guideline section read.
5. Whatever the outcome — approved, rejected, or metadata-rejected — the resolution is appended to
   `HANDOFF.md`. A rejection reason is the most valuable paragraph this plan can produce for whoever
   ships the next version.

---

## 6. Risks

Each risk names the trigger that would tell you it is happening. The first six are things an audit
explicitly could not verify and that this plan depends on; each carries the check that settles it.

**R1 — The iOS 26 WKWebView crash on `-webkit-user-select: none` during touch (register #1).** One
Apple forum thread, on a beta, resolution unknown. It sits on the app's single most important
interaction and there is no version of the reader design that does not apply that property to the
element under the finger.
*Trigger:* the WebView dies during a drag in I2, or in ordinary use of the reader afterwards — and the
second half is watched by the reader rows added to I1's standing checklist, re-run at I5 against the
shipped interaction and at I7 on the TestFlight build.
*Check:* I2 check 1, on a real iOS 26 device, before `core.md` C5b lands. **Cannot be run
in the container and cannot be run on the Simulator with any confidence** — a WKWebView crash on a
specific OS build is a device fact.
*Mitigation, in order:* the CSS workaround list in I2; then re-test on the current release rather than
the beta the report came from; then the native `UIViewController` boundary, whose real cost is stated
in I2 and is a scope change rather than a fallback.

**R2 — The per-character reader combination is unmeasured on any device (register #1, second half).**
One `<ruby>` per character, a `caretRangeFromPoint` hit-test per `pointermove`, Custom Highlight API
paint, over a DOM interleaved with `<rt>` nodes. Each audit recommended a piece; nobody ran them
together, on any hardware.
*Trigger:* I2's latency numbers are bad, or a pasted passage of a few hundred characters janks on
scroll.
*Check:* I2 checks 2 and 3, recorded as numbers. Desktop Chromium first (free, in the container, and
`core.md` C3/C5a runs it anyway), then the device.
*Mitigation:* the usual ones exist and are cheap — throttle the hit-test to animation frames, hit-test
only when the pointer crosses into a new character, cap the rendered passage length — and all of them
are `core.md`'s to implement. What this plan owes is the measurement that says which is needed.

**R3 — FTS5 may not be compiled into the SQLCipher iOS pod (register #20).** Verified for the Android
artifact only. This is the claim that makes "one file, no per-platform build" true on iOS, and it is
load-bearing for `data.md`'s entire storage decision.
*Trigger:* the gloss query in I3 errors with "no such module: fts5" or returns nothing.
*Check:* I3, in the same device session as registers #6 and #18.
*Mitigation:* `data.md` owns it. The recorded options are a different plugin (Capawesome's is technically
the best fit and is **sponsorware**, per STACK §6) or English gloss search degrading to a non-FTS path
on iOS — which would be a real product regression and must be visible, not silent.

**R4 — The first-launch dictionary copy is unmeasured and can fail (register #18).** A ~43 MB copy on
first launch, on a device that may be nearly full, with the installed footprint carrying the file
twice.
*Trigger:* a first launch that appears to hang, or a copy that fails on a full device.
*Check:* I3, timed on an empty and a nearly-full device, with peak storage recorded.
*Mitigation:* the one-time progress state and the low-storage failure path, which **do not exist in any
screen today** and are built by `core.md` **C4a part three**, which names this register entry as its
reason. `data.md` D5a owns the state model, C4a owns the screens, I3 proves them on the device, and §4.3
gates I3 on C4a so the criterion is not left depending on unowned UI.

**R5 — Cold-start time on iOS is unknown (register #11).** AUDIT 1 has practitioner reports of under
~2 s on iPhone 11-class hardware and says plainly that no rigorous benchmark exists.
*Trigger:* the app feels slow to open once the dictionary path is in.
*Check:* I3, measured on **the oldest** device in §4.2's matrix. Record the number and the device's role;
there is no validated threshold to pass. If the matrix has only one handset, the number is optimistic and
must be labelled so.
*Mitigation:* the pathological reports AUDIT 2 collected all trace to large bundles or loading data at
boot, and this architecture does neither — the dictionary is queried, not parsed. If it is still slow,
the bundle is the thing to look at.

**R6 — `caretPositionFromPoint` may not be default-on in Safari 26 (register #2).** It landed in WebKit
in late 2024 behind a flag.
*Trigger:* nothing fatal — `caretRangeFromPoint` is WebKit-proprietary and present in every WKWebView.
*Check:* I2 check 4, feature-detect and log which path ran.
*Mitigation:* write the code to prefer the standard and fall back, which is what `core.md` C5b does
anyway. The only cost of the wrong answer is a fork the code already contains.

**R7 — Everything about the TTS plugin's runtime behaviour is unverified.** No audit ran
`@capacitor-community/text-to-speech` on a device. Whether `speak()` resolves at end or at queue,
whether `stop()` clears a queue, whether the audio session ducks or respects the silent switch, and how
`rate` maps to `AVSpeechUtterance` are all open.
*Trigger:* I4's table cannot be filled in, or slow mode sounds wrong.
*Check:* I4, on a device, question by question.
*Mitigation:* AUDIT 1 records `@capgo/capacitor-speech-synthesis` v8 (MPL-2.0) as the alternative, with
`boundary` events plus pause/resume and **explicit audio-session control** — which is exactly the axis
most likely to fail. Swapping is one adapter file, which is the point of the `TTSProvider` seam.

**R8 — Per-character utterances may be choppy across the bridge.** Slow mode is N plugin calls for an
N-character block, each a JSON round trip.
*Trigger:* I4's measured inter-character gap makes a five-character phrase sound mechanical.
*Check:* measure the gap in I4 and listen to it with the owner.
*Mitigation:* pre-queue the whole sequence in one call if the plugin supports it; otherwise use
`onRangeStart` on a single utterance on iOS specifically, accepting that Android keeps the
per-utterance path — which is the divergence STACK deliberately avoided, so take it only with the
measurement in hand.

**R9 — Learner data in the WebView's IndexedDB may be evictable (register #3).** Whether ITP's seven-day
rule applies to WKWebView inside a native app is unanswered on Apple's own forums, and the flashcards
are the one thing that cannot be rebuilt. STACK §2.8: *"losing the dictionary is a re-download; losing
the flashcards is the actual loss."*
*Trigger:* cards disappear after a period of not opening the app. By the time this triggers it has
already cost something.
*Check:* the honest one is expensive — write a marker row, leave a device untouched for eight days of
Safari use, re-open. The cheap answer is to not need it.
*Mitigation:* STACK §2.8 names two live options and this plan does not choose between them, because the
`Repository` interface is `core.md`'s and the sync story is `backend.md`'s. What this plan insists on is
the thing STACK §2.8 already makes a named deliverable: **a local export must exist before the first
TestFlight build reaches anyone**, because on day one neither sync nor a native store exists and an
export is the only thing that makes a lost WebView database recoverable. If that export does not exist
by I7, say so in the TestFlight notes. **This is now enforced rather than asserted:** §4.3 carries a
dependency row for `web.md` W5's export before I7, and I7 criterion 6 requires the export to produce a
retrievable file *on the device* and to re-import into a fresh install — because W5 tests it in Chromium
and no audit establishes that a browser download path works inside a Capacitor WKWebView.

**R10 — UIScene, and the iOS 27 SDK making it mandatory.** Capacitor 8.5 adopted it; apps without it
will fail to launch under a future SDK. This is a risk of *drift*, not of today.
*Trigger:* a Capacitor downgrade below 8.5, a hand-edit to the app delegate, or an Xcode migration
assistant that rewrites the project.
*Check:* I1 records the scene-manifest evidence; re-read it after any Capacitor or Xcode upgrade.
*Mitigation:* stay on 8.5.x (Capacitor 9 is at alpha.6) and keep the recorded evidence current.

**R11 — Capacitor 8's iOS minimum and several toolchain facts came from search snippets (register
#12).** `capacitorjs.com` and `ionic.io` were egress-blocked during the audits.
*Trigger:* the deployment target chosen at I0 turns out to be impossible, or a plugin needs a higher one.
*Check:* I0's reading pass, before anything is installed. Five minutes.
*Mitigation:* the deployment target is a project setting with no users to strand; raising it is free.

**R12 — Safe areas and the keyboard in WKWebView are unaudited.** AUDIT 2 *reported* Chromium's
failures from Capacitor #8432 rather than from a device it ran — `issues.chromium.org` was among the hosts
egress-blocked during that audit — and nobody looked at iOS at all. Its reported finding, Chromium
returning 0 px insets below WebView 140, is precisely the shape of bug that could exist here and be
discovered late.
*Trigger:* I5 logs zero insets, or the keyboard overlays the input on the app's most-used screen.
*Check:* I5 criteria 2 and 3, on a notched device.
*Mitigation:* Android's answer is a plugin (`@capacitor-community/safe-area`); if iOS needs an
equivalent, find it at I5 rather than at submission.

**R13 — App Review, on three separate axes.** Guideline 4.2 is low risk per AUDIT 1 and pre-empted in
the notes. The other two are not assessed by anyone: whether a reviewer can use the app at all without
credentials, and how BYOK interacts with the payment guidelines.
*Trigger:* a rejection.
*Check:* I8 — the reviewer-access decision and the guidelines reading, both before submitting.
*Mitigation:* the dictionary-only degraded state that product-decisions §5 already requires is the
cheapest reviewer story available and it is a designed state, not a hack. Use it.

**R14 — Export compliance and the privacy manifest are unestablished, and SQLCipher makes the first one
non-trivial.** The plugin bundles an encryption library into an app that encrypts nothing.
*Trigger:* the upload questionnaire at I7 asks a question nobody has an answer for.
*Check:* I7's table, read from Apple's current guidance before the first upload.
*Mitigation:* none needed if it is read in time; it is a paperwork risk, and paperwork risks are cheap
early and expensive at 11pm before a release.

**R15 — `@capacitor-community/sqlite` is community-maintained after its original author retired at
6.x** (AUDIT 2), and both mobile platforms depend on it for the product's core data.
*Trigger:* an unfixed bug, or a release cadence that stops.
*Check:* nothing to run; watch the repository.
*Mitigation:* the `SqlRunner` seam in `data.md` means the plugin is one implementation behind an
interface. The recorded alternative, Capawesome's, is technically the best fit and is paid.

**R16 — Bundling ties every dictionary refresh to a store release** and its review latency (STACK §2.5).
*Trigger:* a CC-CEDICT correction the owner wants out today.
*Check:* none; it is a property of the choice.
*Mitigation:* recorded and cheap to reverse — download-on-first-launch is the same file, the same
manifest, the same versioning, and only `open()`'s first branch changes (`data.md` D5a).

**R17 — The hardware gate itself.** Every phase here needs a Mac with Xcode 26, and most need a physical
iOS 26 device — in practice **more than one**, and in more than one state: §4.2's matrix names a
primary, a clean TestFlight target that has never had a development build, a smallest, and an oldest,
plus a wiped and a near-full device state. Wiping and filling a phone are lead-time items, like the
enrolment.
*Trigger:* a phase starts without them and produces a plausible-looking diff nobody can run.
*Check:* the phase's device pass. A phase that cannot run its device checks is **blocked, not
complete**, and must be recorded that way.
*Mitigation:* STACK §4's own advice — if the hardware is not going to exist, say plainly that the mobile
apps are out of scope for now and plan the web and desktop product on its own.

## 7. Out of scope for v1

- **A native reader.** The `bridge.viewController` boundary is a documented containment property, not a
  v1 plan. Taking it means a Core Text ruby engine plus hit-testing plus `UITextInteraction` — the
  Pleco path — and it is iOS-only, so it would leave Android needing a second text engine. It exists so
  that R1 is survivable, and it is entered only through I2's written recommendation.
- **iPad-specific layout, Mac Catalyst and visionOS.** The wide-screen shell is `core.md` C7 and
  `web.md` W8, and an iPad running the phone shell scaled up is an acceptable v1. HANDOFF.md already
  records the related lesson from the PWA: `"orientation": "portrait-primary"` was removed because it
  *"forced a tablet out of the wide reader layout the app renders perfectly well"*.
- **Every iOS-native surface: widgets, App Intents, Live Activities, a Share extension, Siri, Liquid
  Glass.** STACK §2.1 lists these as one of the conditions that would make the Capacitor decision wrong
  — if the differentiator becomes native surfaces, the whole decision reopens. Building one of them
  early would be arguing that case by accident.
- **Push notifications and study reminders.** They need a server, a capability, a permission prompt and
  an opinion about nagging. None of it exists.
- **In-app purchase and subscriptions.** STACK §5.4: BYOK now, a subscription is a market question, and
  the server already proxies every model call so metering is an add rather than a re-architecture.
  Adding StoreKit before anyone has pasted an API key would be designing for a decision nobody has made.
- **Universal links and deep links.** Nothing links into the app yet. When the Astro marketing site
  exists (`web.md` W7) and wants a "open in the app" button, this is the phase to add.
- **iCloud, Sign in with Apple, and any sync at all.** `backend.md` owns accounts and sync, and STACK
  §5.5 says the protocol is undesigned. The v1 durability story on iOS is the local export named in R9,
  which §4.3 gates before I7 and I7 criterion 6 proves on the device.
- **Automated native UI tests.** Decided at I1 and stated rather than left implicit: automated tests are
  web-only and each native phase ends with a written manual checklist. The cost is that nothing catches
  a native regression between phases, which is why the checklists live in `HANDOFF.md` and are re-run.
- **Audio tiers 2 and 3.** STACK §5.3 recommends tier 1 only in the first mobile release. Tier 3's
  necessity is decided by register #7, which is an **Android** question (a device with no Google Mobile
  Services may report no Mandarin voice at all); iOS ships Mandarin voices, so tier 1 is genuinely
  enough here.
- **Mainland China distribution.** Not a priority market (product-decisions §12), which among other
  things means the App Store's China requirements are not v1 work.
- **External TestFlight testing.** Internal testing on the owner's devices is the I7 goal. External
  testing has its own review pass whose current rules no audit establishes, and there is nobody waiting.
