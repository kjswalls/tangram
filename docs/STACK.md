# Tangram — stack decision record

**Status:** decided 2026-09-13, from four independent technology audits (iOS, Android, on-device
dictionary, web + desktop) plus the product decisions taken with the owner in the same week.
**Supersedes** [PLAN.md](../PLAN.md) §3 wherever the two conflict; PLAN.md remains authoritative for
the data contract (§3.1), the schema rules (§3.3), the grounding contract (§3.4) and the licence
boundary (§5).

This is a record, not a tutorial and not a build plan. It says what was decided, why, what was
rejected, and what is still open. Every number and version in it was measured or sourced on
**2026-09-13** and is tagged as one or the other. Re-check anything load-bearing before you act on
it.

The build plans that execute this record are in [`docs/plans/`](plans/README.md), and the decisions
that span them — the workspace layout, which shared surfaces are frozen by which commit, the phase
splits, and sixteen cross-document corrections including several to this file — are settled in
[`docs/plans/wave-zero.md`](plans/wave-zero.md). Where a plan and this record disagree about a seam
between plans, wave zero is the ruling; where a plan has **measured** something this record
estimated, the plan's figure supersedes and this record says so at the figure.

Two facts frame every decision below and are not repeated in each one:

- **There are no users and no data.** The owner has not used the app. Schema changes are free.
  Nothing in this document is a migration plan and nothing in it should become one.
- **Solo developer with AI assistance, mainland China is not a priority market.** The second fact
  removes the single strongest objection to the Android recommendation (no Google Mobile Services
  means no Mandarin TTS engine, plus lagging Huawei WebView, plus HarmonyOS NEXT dropping Android
  compatibility).

---

## 1. The shape, in one page

One React codebase. It is built by **Vite 8** as a plain SPA, routed by **React Router 8 in data
mode**. It ships to three places from that one build:

- **iOS and Android** — wrapped by **Capacitor 8.5.x**, with native plugins for SQLite and
  text-to-speech. (Safe-area handling on Android needs no plugin: Capacitor 8.5's built-in
  `SystemBars` does it — see §2.1's correction.) The web view is WebKit on iOS and Chromium on
  Android, and that is the point: both engines already do ruby layout that wraps and
  character-precise hit-testing in flowing text, which is the app's hardest UI requirement and which
  every non-web option requires you to build from scratch.
- **Desktop and wide web** — the same build, served as an **installed PWA**. An installed PWA gets a
  standalone window, a dock icon, offline operation and — critically for storage safety — exemption
  from Safari's seven-day ITP eviction and effectively-guaranteed persistence in Chromium. A **Tauri
  2** shell is a later, optional addition whose only new capability is a **global hotkey**.
- **Marketing** — a separate **Astro** site at the apex domain, with the app at `app.<domain>`, so a
  marketing redeploy can never touch the origin that holds the learner's flashcards, and so the
  access gate applies only to the app. There is no Content-Security-Policy in this repo today; when
  one is written it would apply only to the app for the same reason.

The dictionary stops being a 35 MB JSON blob parsed into the heap. It becomes **one prebuilt,
read-only SQLite file** (`dict-<schema>-<cedict>.sqlite`, **43.1 MB raw / 13.9 MB brotli**, measured
against the schema `data.md` D1 actually ships), produced by the existing `pnpm data` step,
**identical on all three platforms**, and queried rather than loaded. It uses only built-in SQLite
features — no tokenizer extension — which is exactly what makes one file work everywhere. Native platforms bundle it as an app asset and open it read-only through
`@capacitor-community/sqlite`; the web fetches it once and imports it into OPFS through
`@sqlite.org/sqlite-wasm` with the `opfs-sahpool` VFS. A small `DictStore` interface sits over the
two implementations, the same shape as the existing `lib/db/repository.ts` seam.

Chinese and pinyin "tokenization" happens at **build time in TypeScript**, not at query time in
SQLite. `lib/dict/pinyin.ts` moves to the client unchanged, and the derived pinyin keys it already
computes become indexed columns. `lib/dict/segment.ts` does **not** move unchanged — only its DP
does. The module reaches into the in-memory index for corpus statistics and script detection and has
to be inverted first; that is a schema decision, and it is spelled out in §2.5. FTS5 is used for
**English glosses only**.

Behind all three shells sits a **server**: accounts, sync, and an AI proxy. The learner's model key
is **BYOK, stored encrypted server-side against the account**, and every platform calls the model
through the server — the key never reaches a browser or a device. That server is two components, not
one: a stateless AI proxy, and a stateful part holding accounts, key custody and sync state. None of
it was audited and none of it is designed (§5.5, §7).

Local writes (cards, reviews, lists, settings) keep going to Dexie/IndexedDB behind
`lib/db/repository.ts`. Be precise about what that seam is, because the shorthand "the sync seam"
claims more than the code delivers: PLAN.md §3.3 built it as a **data-layer swap** seam, and its
schema rules (client-generated UUID keys, `createdAt`/`updatedAt`, soft delete) are the
*precondition* for sync rather than sync itself. The interface is a domain API — `grade()`,
`listDue()`, `addListMembers()` — with no change feed, no per-row version or origin, and no conflict
policy. It is where sync plugs in; the protocol is undesigned (§5.5). Separately, whether learner
data should live in the WebView's IndexedDB **at all** on native is an open question the iOS audit
answered "no" to — see §2.8.

One component set, and the shell around it is settled only on phones: a **three-tab shell** (Look up
/ Practice / Library) on phones and on the web below ~720px. **The desktop shell is open.** The owner
likes both the three-tab page shell at desktop width and a Raycast-style command palette, and
product-decisions §10 marks the choice explicitly undecided. §5.1 recommends building the page shell
first and treating the palette as a mode over the same components, because the palette's whole point
is being summonable and summoning needs a global hotkey, which needs Tauri (§2.4). The practice card,
the lookup result and the library rows are the same components in every shell; only the way the
learner arrives differs.

If you read nothing else, that is the answer: **Capacitor, because WebKit and Chromium already
solved ruby text and caret hit-testing, and nothing else has.**

One thing to establish before sequencing anything: the mobile half of this plan needs a Mac with
Xcode 26, a physical iOS 26 device, and at least two Android phones. The web and desktop half needs
none of them and runs in the existing Linux container. §4 opens with what that implies.

---

## 2. The decisions

### 2.1 Mobile wrapper: Capacitor 8.5.x

**Decision.** Ship iOS and Android as Capacitor 8.5.x apps wrapping the Vite build, with **two**
native plugins: SQLite (`@capacitor-community/sqlite`) and text-to-speech
(`@capacitor-community/text-to-speech`).

> **Correction, 2026-09-16, from `android.md` A2 — this said three, and the third must not be
> installed.** The third was `@capacitor-community/safe-area`, and A2 read both packages' shipped
> source rather than their READMEs. The community plugin publishes no insets at all: its entire JS
> API at 8.0.1 is `setSystemBarsStyle` / `showSystemBars` / `hideSystemBars`. It is a polyfill for
> Chromium below 140. **Capacitor 8.5 ships the same thing in core** —
> `@capacitor/android@8.5.2`'s `SystemBars` is a built-in plugin, registered unconditionally by
> `Bridge.registerAllPlugins()`, with the same version threshold, the same `injectSafeAreaCSS()`,
> and the keyboard workaround for Capacitor #8432 that this section expected to have to live with.
> Installing both is two owners of one window; the community plugin's own README tells you to set
> `SystemBars.insetsHandling: 'disable'` first. A2 configures the built-in one
> (`plugins.SystemBars`: `insetsHandling: 'css'`) and a unit test refuses the community plugin and
> three other safe-area plugins by name. See `HANDOFF.md` under A2.

**The single strongest reason.** The two hardest requirements in the product — *per-character ruby
pinyin that wraps correctly* and *character-precise tap and drag selection inside flowing text* —
are solved, standard, decade-old features of both web engines, and are **unsolved, hand-rolled
problems in every native option**. The iOS and Android audits reached this independently and in the
same words: every non-web stack requires you to write a text layout engine.

The evidence, per platform:

- **iOS.** SwiftUI `Text`/`AttributedString` has no ruby at all (an Apple forum thread on it has
  been unanswered since 2024). `UILabel`/`UITextView` ruby via `kCTRubyAnnotationAttributeName`
  broke in iOS 11 and never came back; Apple's own engineer's advice on that thread is to write a
  custom Core Text view — and then also write hit-testing and adopt `UITextInteraction`. That is
  what Pleco does, in a purpose-built native engine. WebKit gives it away: `<ruby>/<rt>`, with
  `ruby-align`, `ruby-overhang` and unprefixed `ruby-position` shipped in Safari 18.2 and further
  ruby-overhang fixes in Safari 26.x.
- **Android.** Per-character (mono-ruby) `<ruby>字<rt>zì</rt></ruby>` with `ruby-position: over`
  makes each pair one glyph wide, so it wraps naturally in *any* Chromium version — the Chrome 128
  line-breakable-ruby work only matters for multi-character pairs. Jetpack Compose has no ruby
  primitive; you build a custom `Layout` that reserves a band above each line.

**How selection actually works** (the same on both platforms, and the same as on desktop web): do
**not** use the engine's native long-press selection. It includes `<rt>` pinyin in the selection and
the clipboard in all engines, its precision degrades from characters to lines as the selection
grows, and its handles and callout menu fight the dictionary UI. Instead: `user-select: none` on the
passage, `touch-action: none` on the reader container, Pointer Events, hit-test each `pointermove`
with `document.caretRangeFromPoint` (WebKit-proprietary and Blink-ancient, present everywhere) with
`caretPositionFromPoint` as the standards-track upgrade, and paint the span with the **CSS Custom
Highlight API** (Safari 17.2+, Chrome 105+) so there is no DOM mutation per pointer move.
Drag-select is new work on *every* stack, web included.

**Be honest about how much of the existing reader survives.** What exists is *token*-granular:
`components/reader/reader-text.tsx` renders one button per token carrying `data-token-index`, with a
single delegated `onClick`, and `lib/stores/reader.ts` models a span as `selected` / `spanEnd` token
indexes that `extend()` grows by whole tokens. Product rules 1 and 2 require per-character ruby and
character-granular drag, so **both the DOM and the span model change granularity**: the indexes
become character indexes and the token becomes a grouping over characters rather than the unit. That
is a rewrite of the reader's data model, not an addition to it. Nor did either audit build the
combination this record specifies — one `<ruby>` element per character, hit-tested with
`caretRangeFromPoint` on every `pointermove`, painted with the Custom Highlight API over a DOM whose
text nodes are interleaved with `<rt>` annotations. Each audit recommended the pieces; neither ran
them together, so the pointer latency and the layout cost of a pasted passage of a few hundred
characters are unmeasured. Register entry #1 is now that prototype, and it is the same build that
answers the iOS 26 crash question.

**TTS must be native on both platforms, and that is not a close call.** `window.speechSynthesis` is
**undefined in the Android WebView** — long-standing Chromium issue 40468168, though note that
`issues.chromium.org` was egress-blocked during the Android audit, so the issue id and its status
came from a search snippet (register entry #19 is the five-second confirmation). In WKWebView, Web
Speech only exposes compact/pre-installed voices, so Apple's Tingting/Meijia *Enhanced* voices are
unreachable, and boundary events are unreliable. The native plugin wraps `AVSpeechSynthesizer`'s
`willSpeakRangeOfSpeechString` and Android's `UtteranceProgressListener.onRangeStart` (API 26+) and
forwards both as an `onRangeStart` event. For the 0.6x character-by-character mode, do **not** depend
on range events (engine-dependent on Android): enqueue one utterance per character and highlight on
each utterance's `start`.

**`TTSProvider` has to be widened first, and it is a shared surface.** The audits called the native
work "one adapter". That is true of the *shape* and false of the *interface*: `lib/tts/provider.ts`
today is exactly three members — `readonly name`, `available()`, and `speak(text, opts?)` with
`SpeakOptions = {lang?, rate?}` — and its own header says `speak` resolves once the utterance is
*queued*, not once it has finished. There is no stop, no queue or utterance identity, no voice
selection, and no event surface of any kind. Product rule 3 (hold the speaker → 0.6x character by
character, each character lit as it plays; tap a character → hear that syllable alone) needs all of
them. Widen the interface **before** any parallel work starts: at minimum `stop()`, a callback or
event for range/utterance boundaries, and an utterance identity so a per-character sequence can be
cancelled mid-flight. Two adapters implement it — the native plugin and Web Speech — and the web
adapter needs a stated answer for engines that give no boundary events (WebKit's are unreliable, and
the Android WebView has no Web Speech at all): drive the highlight off per-character utterance
`start` events, which is the same fallback the native path already uses for 0.6x mode. This is on the
§7 settle-first list.

**Alternatives, honestly.**

| Option | What it wins | What it costs |
|---|---|---|
| **Native Swift/SwiftUI** | Best SQLite (GRDB), best TTS (all enhanced voices, direct delegate), fastest launch, every iOS-native surface | Write a Core Text ruby engine *and* hit-testing; re-implement segmentation, pinyin marking, search and FSRS in Swift; two codebases forever. This is the Pleco path and it is a company's worth of work. |
| **Jetpack Compose** | Fastest Android cold start, best low-end performance, excellent SQLite (Room + `androidx.sqlite:sqlite-bundled` with FTS5) | Custom ruby `Layout`, custom selection via `TextLayoutResult.getOffsetForPosition`/`getBoundingBox`, known offset bugs with inline content — plus a full rewrite in a language the owner does not use. |
| **React Native / Expo** | Strong SQLite (`op-sqlite`, `expo-sqlite`), good TTS (`expo-speech` `onBoundary`) | Worst of both. RN `Text` has no ruby (the usual hack is a flex-wrap grid of per-character Views, which breaks CJK line-breaking and kills selection) and no `onSelectionChange` (issue #23147 still open). The realistic path is drawing text yourself on `@shopify/react-native-skia` — a text engine — *and* rewriting the UI. Expo DOM components (`'use dom'`) put the reader back in a WebView with an async bridge: Capacitor with extra layers. |
| **Tauri 2 on mobile** | Same WebKit/Chromium, so requirements 1–2 are *identical* to Capacitor; wins if you want a shared Rust core | Plugins are Rust + Swift/Kotlin; TTS only via third-party crates with no verified boundary events; the Xcode pipeline is reported opaque and Tauri maintainers said in 2024 that iOS expertise was thin; open mobile-keyboard issues (#10631, #7868). Nothing in Tangram needs Rust. |
| **Trusted Web Activity** (Android) | Runs in Chrome, so `speechSynthesis` works; near-zero cost | No native SQLite, no font bundling control, needs a hosted origin with Digital Asset Links, falls back to the WebView on devices without Chrome. A free extra distribution channel for the PWA, not the product. |
| **PWA only on iOS** | Zero cost | No App Store, and a non-installed Safari origin is subject to seven-day ITP eviction. Not viable as the iOS product. |

**The containment boundary — which is not the same as a cheap reversal.** A Capacitor plugin can
present a native `UIViewController` from `bridge.viewController`, so if WebKit selection ever proves
inadequate the damage is confined to the **reader screen** and nothing else in the app has to be
reversed. Confined is not cheap. Taking that exit means writing exactly the thing this whole decision
exists to avoid — a Core Text ruby layout engine plus hit-testing plus `UITextInteraction`, the Pleco
path, described in the alternatives table above as a company's worth of work — and the reader is the
one screen where both of those problems live. It is also **iOS-only**: neither audit records an
Android equivalent of `bridge.viewController`. If the drag-select design fails it plausibly fails on
both engines, and the Android answer would be the custom Compose `Layout` plus
`TextLayoutResult.getOffsetForPosition` path from the same table — a second native text engine, in a
language the owner does not use. Read this paragraph as "the blast radius is one screen", never as
"this decision is cheap to unwind".

**What would make this decision wrong.**

1. The reader must have iOS-native selection handles, magnifier and edit menu over ruby text rather
   than a custom drag highlight. Not fixable from JS; native wins.
2. Cold launch must be well under a second with the dictionary hot **and** you refuse native SQLite.
3. The differentiator becomes iOS-native surfaces: widgets, App Intents, Live Activities, Share
   extension, Liquid Glass.
4. You commit to one Rust core across mobile and desktop — then Tauri wins despite its mobile rough
   edges.
5. The iOS 26 `-webkit-user-select: none` WKWebView crash (see §4) turns out to be real, unfixed and
   un-workaroundable.
6. A Swift-fluent collaborator appears, removing the cost asymmetry that decides this.
7. Drag-select or card animations stay below acceptable on the low-end Android target after
   optimisation.

**Housekeeping the audits flagged.** Xcode 26 / the iOS 26 SDK have been mandatory for App Store
submissions since 28 April 2026, and Capacitor 8 requires Xcode 26. Capacitor 8.5 (July 2026)
adopted UIScene, which the iOS 27 SDK will make mandatory — apps without it will fail to launch — so
**stay on 8.5.x**; Capacitor 9 is at alpha. On Android, Capacitor 8 sets minSdk 24 and
compile/target 36, and target API 36 has been required by Play since 31 August 2026 (the Android
audit recorded an extension available to 1 November; re-read the Play Console policy page when you
run register check #15, which schedules the same visit). App Store
Guideline 4.2 ("repackaged website") rejection risk is **low**: a 124k-entry offline dictionary plus
an SRS plus native TTS clears it comfortably. OutSystems' 2025 wind-down of the commercial Ionic
products explicitly kept Capacitor and Ionic Framework open source and maintained, and 8.x is
shipping.

**What shipping to the stores costs, stated where the cost is incurred.** The App Store requires the
**Apple Developer Program at $99/year** *(sourced)*. That is incurred **here**, by the decision to
ship on iOS — not later by the desktop decision in §2.4, which has often been quoted as "$220/year"
by adding Apple's fee to Windows signing. By the time Tauri is considered, Apple's $99 is already
spent. Google Play charges a one-time developer registration fee that **none of the audits priced**;
read it off the Play Console during the same visit as register check #15. Xcode 26 means a Mac, which
is a precondition rather than a fee (§4). The server in §2.8 has running costs nobody has priced
either, because §5.5 has not chosen what it is.

**Font bundling is mandatory, not optional.** All three Android stacks draw with the device font
unless you bundle one, and OEMs differ (Xiaomi MiSans, Huawei HarmonyOS Sans, Samsung's own). Han
unification means a device in a Japanese locale renders Japanese glyph forms unless the page
declares `lang`. Set `lang="zh-Hans"` on the root and bundle a real Chinese face with a **true bold
weight** (a WebView regression in builds 139–140 stopped synthesising bold for CJK without a `lang`
attribute). Full Noto Sans SC OTFs are ~4.5–9 MB each; slim subsets of 0.7–1.4 MB will **not** cover
124k CC-CEDICT headwords — see §4.

On native those are app-package bytes and nobody notices. **On the web they are first-load bytes on
top of the dictionary**, and the settled visual language (product-decisions §11) asks for Noto Serif
SC for hanzi plus Newsreader and DM Sans for Latin. State the web first-load budget as one number
before committing to it: app bundle + 13.9 MB brotli dictionary (§2.5) + whatever the coverage check
in register entry #9 returns, multiplied by the weights actually used. That matters more than it
looks, because §2.4 makes the installed PWA the entire desktop product and §2.6 makes the web the
funnel. The mitigation that exists on web and is irrelevant in an app package:
`unicode-range`-split webfont subsets, so a visitor downloads only the blocks their page renders.

### 2.2 Web framework: leave Next.js for Vite

**Decision.** Move the app off Next.js 16 onto **Vite 8** as a plain SPA. Move the three
model-backed routes to a small server. Keep TypeScript 5.9, Vitest 4 and Playwright.

**The single strongest reason.** Capacitor and Tauri both need a directory of static files. Next's
`output: 'export'` produces one, but it removes precisely the four Next features this repo uses — so
"Next as a static export" is not a smaller Next, it is Next with the parts you use deleted *plus* a
separate server you must run anyway.

**The four features, verified in this repo, not assumed:**

| Feature | Where | What it does today |
|---|---|---|
| Middleware | `middleware.ts` | The `?key=` → cookie access gate: trades a query secret for a cookie on any route and refuses unauthorised requests to the three paid routes before a handler or a 35 MB dictionary load. |
| `next.config.ts` | `headers()` and `outputFileTracingIncludes` | `Content-Type` + `Cache-Control: no-store` + `Service-Worker-Allowed` for `/sw.js`, `application/manifest+json` for the manifest; and the per-function tracing map that ships `data/**` — four glob keys (`/api/dict/**`, `/api/ask/**`, `/api/examples/**`, `/api/recall/**`) covering **all eight** API routes, every one of which reaches the dictionary loader. Do not read "four keys" as "four routes": `tests/unit/server/routes.test.ts` states the set in prose as "every route in this app reads it except none", and mistaking the two is exactly how `/api/examples` and `/api/recall` shipped untraced. |
| POST route handlers | `app/api/ask`, `app/api/examples`, `app/api/recall` — plus `app/api/dict/segment` today | Static export supports static GET only. The first three spend money and move to the new server. `/api/dict/segment` does **not** move: it disappears with the rest of `/api/dict/*` once the `words` table and the DAG are on the client (§2.5). Do not provision a server endpoint for it. |
| `.next/BUILD_ID` | `scripts/build-sw.ts` | Stamps the build id into `public/sw.js` from `scripts/sw.template.js`, so the worker's cache name changes exactly when the output does. There is no `BUILD_ID` in a Vite build. |

There is a fifth, smaller casualty worth naming so it does not surprise anyone:
`lib/server/route-inventory.ts` walks `app/api/**/route.ts` and its import graph, and both
`tests/unit/server/routes.test.ts` and `pnpm smoke` are built on it. That machinery exists because
`/api/examples` and `/api/recall` once shipped without their tracing entries and only a human
opening the page noticed. Its *purpose* survives the move — "every route is exercised over HTTP on a
built server" — but its *implementation* is Next-shaped and has to be rewritten against whatever the
new server is.

Also genuinely given up: the Metadata API, `next/font`, `next/image`, `eslint-config-next`, and the
`app/` convention the phase plan is written around. None are load-bearing for a local-first app that
renders its own text in bundled fonts.

**What it buys.** `/api/dict/*` **disappears entirely** once the dictionary is on-device — that is
**five of the eight** API routes gone (`decomp`, `entries`, `hsk`, `search`, `segment`), `segment`
included, because the `words` table and the DAG go to the client with everything else. What remains
needing a server is `/api/ask`, `/api/examples` and `/api/recall`, which now need a server anyway for
accounts and sync (§2.8). Once those move, Next is a client-side router with a large compiler
attached.

**Do not bank the rest of the saving yet.** `outputFileTracingIncludes`, the 35 MB server-side load
and the cold-start work Phase 8 spent itself on disappear **only if §5.5 resolves one particular
way**. All three surviving routes read the dictionary today — `lib/ai/ground.ts` is reached from
every one of them and all three carry tracing entries — so the load leaves the server only if the
**client sends the retrieved entries** with the request, which is §5.5's recommendation but not yet
its decision. If instead the server keeps its own copy of the SQLite file, the cold-start and memory
problem *moves* rather than vanishing: smaller, because SQLite is not a 35 MB parse, but still there,
and the tracing plumbing returns in a new form as "get the file onto the host". Read §5.5 before
planning a server with no dictionary in it.

One thing the disappearance of `/api/dict/decomp` leaves open: **how `data/decomp.json` (0.92 MB)
reaches the client.** Product rule 2 puts decomposition on every character sheet, so it is needed on
all three platforms. It is too small to justify its own SQLite file and it must stay a separate
artifact for the licence reason in §2.5 — LGPL data must never merge into the CC-BY-SA data. The
obvious answers are bundling it in the app package on native and fetching it once, service-worker
cached, on web. Nothing has decided it; it rides along with the artifact-plumbing surface in §7.

**Migration cost, and what the number does not cover.** The audit itemised the job as: rewriting
`app/**` pages into route components, replacing `next/link` and `useRouter`, moving three POST routes
plus the gate, and rewriting `build-sw.ts` against Vite's hashed asset manifest (or replacing it with
`vite-plugin-pwa`). It called that **two to four focused days with AI assistance**. Scope that number
to **the client-side move only, with the server already existing** — the audit's own itemisation
includes "moving three POST routes plus the gate to a small server", and §5.5 has not chosen what
that server is while §7 records that it was never audited at all. Add to the same job, un-itemised by
the audit, the rewrite of `lib/server/route-inventory.ts` and the `pnpm smoke` machinery built on it.

Tests carry over nearly unchanged: `vitest.config.ts` already uses `@vitejs/plugin-react` and the `@`
alias, Vitest 4.1.11 accepts Vite `^6 || ^7 || ^8`, and Playwright needs only `webServer.command`
changed from `next start` to `vite preview`.

**Everything else in this record is unestimated, and that must not be read as cheapness.** The
Android audit's figure for the Capacitor work is "**days to low weeks** (plugins, safe-area, fonts,
Play packaging); zero UI rewrite" — restored here because it was dropped, and because it is the only
other effort number any audit produced. No audit estimated the SQLite dictionary work (build step,
`DictStore` interface, two implementations, the OPFS worker, the segmenter inversion), the shell
rewrite, the per-character reader, the `TTSProvider` widening, or accounts and sync. Anyone who reads
"two to four days" as the cost of this plan has read the smallest piece of it.

**The sequencing question is open too.** The Vite move and the SQLite move both touch `lib/dict/**`
and `app/api/dict/**`, and nothing here decides which lands first. The argument for
dictionary-first is that it deletes five routes the migration would otherwise have to carry across;
the argument for Vite-first is that everything after it is built on the new build system. Decide it
in the build plan, explicitly, because doing both at once in one worktree is the failure mode the
frozen-file rule existed to prevent (§7).

**Alternatives.** *Stay on Next with `output: 'export'`* — loses the four features above and still
needs the separate server; the only thing it saves is the page-rewrite day. *Stay on Next with a
Node server and wrap that* — you are then shipping a Node server inside a phone app, which is not a
thing. *TanStack Start* — still RC. *Astro for the app too* — wrong tool; this is a stateful client
app, not a content site.

**What would make this wrong.** You decide you want **indexable per-entry dictionary URLs** for SEO
(`/word/打算` pages that Google crawls). Then you need prerendering for app pages, and the answer is
React Router framework mode with `prerender` — or staying on Next. **Do not file this as remote.**
For a Chinese dictionary, per-word pages are how every incumbent is found, and if the condition
fires it reverses this decision, §2.6 and part of §2.5 at once. It has been promoted to an open
decision, with a middle path that may let the SPA survive it intact: **§5.7**.

### 2.3 Router: React Router 8, data mode

**Decision.** `react-router` 8.x with `createBrowserRouter` (data mode). Not framework mode, not
TanStack Router.

**The single strongest reason.** The app is three tabs and a palette. React Router 8 in data mode is
boring, it is enough, and it is on a planned yearly major cadence with a non-breaking v7→v8 upgrade
for anyone who adopted the future flags — which is the profile you want for the dependency you think
about least.

**Alternatives.** `@tanstack/react-router` is genuinely nicer for one thing Tangram happens to care
about: **typed search params**, and the command palette's query does live in the URL. It costs a
codegen Vite plugin and a dependency that ships several releases a week. Neither choice is wrong;
pick TanStack only if typed URL state turns out to be worth that. React Router **framework mode**
(`ssr: false` + `prerender: [...]`) is the credible one-repo alternative to the separate marketing
site (§2.6) and is what you would reach for if the SEO condition in §2.2 fires.

**Cost to check before starting.** React Router 8 requires **React >= 19.2.7** (this repo is on
19.2.8 — fine), **Vite 7+** (target is 8 — fine), **Node >= 22.22** (this repo's `engines.node` is
`>=20.9` — this must be bumped), is ESM-only, and has removed `react-router-dom`. Those came from
the changelog and are among the better-verified facts in the audits.

**What would make this wrong.** Typed search params become central to the palette's design; or React
Router's yearly major turns out to break the app anyway, at which point the two options are the same
risk.

### 2.4 Desktop shell: installed PWA now, Tauri 2 later, never Electron

> **The operational form of this decision is [`docs/desktop.md`](desktop.md)** (`web.md` W9): the
> trigger written as three conditions you can actually check, the pinned versions with what could and
> could not be re-checked, the two storage hazards, the hedge on every storage claim below, and the
> installed-PWA verification the owner still owes. This section stays the *why*; that page is what a
> reader decides from.

**Decision.** Ship desktop as the **installed PWA** from the same Vite build — zero additional
build, zero additional code, the manifest already exists. Add a **Tauri 2.11.x** shell when the
global hotkey is worth roughly **$120/year marginal** (Windows code signing at ~$9.99/month; Apple's
$99/yr Developer Program is already spent by the App Store decision in §2.1, so it is not a cost of
*this* decision) plus a three-target CI pipeline and an update channel you can never break.

**The coupling has to be stated up front, because it decides what "desktop" means.** The installed
PWA is the delivery vehicle for the **page shell** — the phone's three-tab structure at desktop
width. It is not the desktop product as the owner has described it. product-decisions §10 describes
that product as the Raycast-style command palette, and §5.1 of this record spells out why a palette
cannot exist inside a browser tab: its whole point is being summoned, summoning needs a global
hotkey, and no browser can register one. So this section is a *sequencing* decision, and the
sequencing is made explicitly here rather than left implied: **the palette is not a v1 goal.** Ship
the page shell as an installed PWA, use it for real study, and let §5.1's week-long test say whether
Cmd+K is a reflex worth $120/year, a Rust toolchain and a three-engine test matrix. Until Tauri
ships, do not describe the PWA as the differentiated desktop product; it is the same app, wider, and
that is a perfectly good v1.

**The single strongest reason.** **The global hotkey is the only capability a desktop wrapper adds
that an installed PWA lacks.** Offline operation, keyboard-first navigation, a standalone window, a
dock icon and per-app shortcuts are all available to the PWA. Chromium has an open issue (40749250)
for global shortcuts and a browser tab cannot register one in 2026, period. For a Raycast-style
palette the hotkey *is* the desktop pitch — which is why this is a sequencing decision, not a
capability judgement.

| | Installed PWA | Tauri 2 | Electron |
|---|---|---|---|
| Extra build | none | Rust toolchain, `src-tauri/`, per-OS CI | Node main process, per-OS CI |
| Download | 0 | ~3–10 MB + WebView2 bootstrapper on Windows *(vendor)* | ~85–120 MB *(vendor)* |
| Idle memory | one browser tab | tens of MB + shared system WebView *(third-party)* | 150–250 MB *(third-party)* |
| Global hotkey | **no** | yes on macOS/Windows/X11; **not Wayland** (tauri #3578 — protocol gap) | yes, same Wayland gap |
| Rendering engines to test | the user's browser | three (WebView2, WKWebView, WebKitGTK; the last has known NVIDIA/DMA-BUF glitches) | one Chromium |
| Auto-update | free | `tauri-plugin-updater`: minisign keypair, static JSON on GitHub Releases, signature cannot be disabled | `electron-updater` / Forge |
| Signing | none | macOS Developer ID + notarization $99/yr (automated in `tauri build` via `APPLE_*` env vars); Windows Azure Artifact Signing ~$9.99/mo, individuals accepted in US/Canada since the three-year-history rule was dropped in April 2026; without it SmartScreen warns until reputation builds. Linux: none. | identical burden |

**Why Tauri over Electron if it happens.** Electron's real advantage is one Chromium everywhere and
mature packaging. Tangram's UI is text, fonts and keyboard handling, which all three system engines
handle well; the offline dictionary makes the smaller download and memory footprint matter more than
usual; and Tauri 2 also targets mobile, so consolidating later is at least an option. **Tauri mobile
is less mature than Capacitor 8.5 — do not pick it for phones first.** **Tauri 3.0.0-alpha.0
appeared on crates.io on 2026-09-13**, driven by a GTK4 migration: stay on 2.x and **pin it**.

**Storage inside a Tauri shell.** WKWebView keeps its own ITP interaction counter that resets each
launch, so the Safari seven-day cap does not bite a desktop app *(secondary source)*; WebView2
follows Chromium quota rules. The one real hazard on record: **the IndexedDB directory path changed
between Tauri 1 and 2 (tauri #11252) and users lost data.** Pin the version. If a Tauri shell ships,
consider a second `Repository` implementation on `tauri-plugin-sql` (native SQLite) rather than
relying on the WebView's IndexedDB — `lib/db/repository.ts` exists for exactly that.

**What would make this wrong.** The palette must be summonable from day one — that is the sequencing
call above reversed, and it means skipping the PWA phase for Tauri, with its cost and its three
rendering engines, before the app itself is finished; Linux/Wayland is your primary desktop (the
hotkey does not exist in *any* shell there, so Tauri buys nothing over the PWA); you would rather
write zero Rust and accept a 100+ MB download (Electron is defensible); or Tauri 3 stabilises fast
and cheap, in which case pinning 2.11.x could strand you on an old GTK path on Linux.

### 2.5 Dictionary storage: one prebuilt read-only SQLite file; FTS5 for English only

**Decision.** `pnpm data` emits **one** `dict-<schema>-<cedict>.sqlite` (**43.1 MB raw, 13.9 MB
brotli** — `data.md` D1's measurement against the schema it ships, superseding this record's
original 47.2 / 15.4 estimate; §3) built with **only built-in SQLite features**. All Chinese and
pinyin normalisation happens at **build time in TypeScript**. `decomp.json` (0.92 MB) stays JSON —
it is never indexed, and keeping it separate is what guarantees the LGPL data never merges into the
CC-BY-SA data, which is a licence rule, not a preference.

**The single strongest reason.** The current approach cannot ship to a phone. Parsing `dict.json`
and building the index costs **58 MB of heap / 184 MB RSS and 0.7 s** in Node, with **another 1.6 s
on the first pinyin query**; in this repo's own server it settles at **~310 MB RSS** and Phase 8
spent a whole builder cutting the cold path from 3.9–4.6 s to under 1–2.4 s by making the indexes
lazy. On a server that starts once, that is an annoyance. In a mobile WebView, which is killed in
the background routinely, it is paid on **every cold launch** and it is how you get OOM-killed.
SQLite pays a few MB of page cache and answers in fractions of a millisecond.

**Why FTS5 is right for English glosses and wrong for Chinese.** This is the load-bearing insight of
the whole storage decision, and it is what makes "one file for all three platforms" true.

FTS5's built-in tokenizers are exactly four: `unicode61`, `ascii`, `porter`, `trigram` (confirmed
from `ext/fts5/fts5_tokenize.c`). The ICU tokenizer exists only for FTS3/4, is absent from every
wasm and mobile build, and would drag ICU data along.

- `unicode61` treats CJK ideographs as letters, so a run of hanzi is **one token**: `MATCH '打'`
  never finds 打算. Useless.
- `trigram` indexes every overlapping three-character window and lets `LIKE '%…%'` use the index —
  but the documentation is explicit that substrings of fewer than three characters match nothing,
  and **75k of the 120k simplified headwords are one or two characters**. Useless for the majority
  of the lexicon, and it costs +3.4 MB.
- Therefore the Chinese side does not need full-text search at all. **The lexicon *is* the
  dictionary**: every Chinese query is exact-or-prefix against a known headword, which is a B-tree
  range scan, and word breaking inside a sentence is done by the existing DAG segmenter, not by a
  tokenizer.
- English glosses are the opposite case: real natural-language text, stemming genuinely wanted,
  ranking genuinely wanted. `porter unicode61`, contentless, `detail=none`, ranked with `bm25()`.
  That is what FTS5 is for.

Using only built-in tokenizers means **no loadable extension**, which matters more than it sounds:
`@sqlite.org/sqlite-wasm` is built with `SQLITE_OMIT_LOAD_EXTENSION`, so a custom tokenizer in the
browser requires a custom wasm build, and on mobile it requires per-platform native builds of the
same tokenizer. Ruling tokenizers out is what collapses three artifacts into one.

**Query mapping and measured native latency** (all measured by the dictionary audit against the real
124,188-entry data, Python sqlite3 / SQLite 3.45, `page_size=4096`, VACUUMed):

| Query | Mechanism | Measured |
|---|---|---|
| Hanzi exact/prefix, simplified + traditional | B-tree range scan on `simp`, `trad` | 0.2 ms for 200 rows |
| Pinyin, with or without tones, spacing-tolerant | Two derived key columns (`dasuan`, `da3suan4`) — exactly the keys `lib/dict/pinyin.ts` `readingKeys()` already computes — B-tree prefix scan | 0.1 ms |
| English gloss, ranked | FTS5 `porter unicode61`, contentless, `detail=none`, `bm25()` | 0.2 ms ("plan"), 1.4 ms ("to plan") |
| Segmentation | `words(script, word, freq)` table; all ≤16-char substrings of a hanzi run are fetched in **one** `IN (...)` query, then the existing DP — `route()`, the function, not the module — runs unchanged in TS. See hard part 5 below: `lib/dict/segment.ts` as a whole does *not* port unchanged. | 0.7 ms for 653 candidates (205-char paragraph) |
| Many ids | `WHERE id IN (...)` on the unique id index | 0.15 ms for 50 |

**Bundle it, do not download it.** Google Play caps a base module's *compressed* download at 200 MB
(with a mobile-data warning, not a block, above that); Apple's cap is 4 GB uncompressed with an 80
MB `__TEXT` limit per binary. A ~20 MB compressed dictionary is nowhere near either. Bundling means
offline from the first second and no download UI.

It does **not** mean no failure mode, and the audit's "no failure mode" phrasing should not survive
into a build plan. Bundling still requires a `copyFromAssets()` of a 43.1 MB file into app storage on
first launch and again whenever `dict.version` changes. Nobody measured how long that takes, it can
fail on a device low on storage, and it means the installed footprint carries the dictionary
**twice** — compressed inside the package and expanded in app storage — so budget **≈63 MB** on
device (19.5 MB packaged + 43.1 MB expanded, `data.md` D5a's figure), not 14. Design it as a one-time
progress state, not as "offline from the first second". Register entry #18 is the measurement. And
state the consequence plainly: **bundling ties every dictionary refresh to a store release** and its
review latency. That is the trade the
`dict-<schema>-<cedict>.sqlite` naming implies but does not by itself deliver; if dictionary updates
ever need to be independent of releases, delivery switches to download-on-first-launch, which is the
same file and the same versioning (see "what would make this wrong" below).

On the **web** there is no bundling, so the first load pays a 13.9 MB brotli download behind a banner
— exactly the shape of the existing missing-data banner. Add the fonts to that budget, per §2.1.

**Delivery per platform.**

- **iOS / Android:** ship the `.sqlite` as an app asset; on first launch, and whenever
  `dict.version` changes, `copyFromAssets()` it into app storage and open it read-only.
  `@capacitor-community/sqlite` bundles SQLCipher's SQLite, so FTS5 should be available regardless
  of the OS SQLite version. That is **verified for the Android artifact** — `sqlcipher-android`'s
  `Android.mk` plus SQLCipher's shared `main.mk` — and **unverified for the iOS `SQLCipher` pod**:
  the dictionary audit's own not-verified list names "SQLite version behind the SQLCipher iOS pod".
  This is the claim that makes one file work on iOS with no per-platform build, so check it rather
  than assume it: register entry #20. **You must reproduce SQLCipher's BSD notice in-app** — add it
  to `data/ATTRIBUTION.md` alongside CC-CEDICT and Make Me a Hanzi.
- **Web:** fetch once, import into OPFS via `installOpfsSAHPoolVfs()` and
  `OpfsSAHPoolUtil.importDb(name, chunkCallback)` — the chunked form streams a `fetch` body without
  holding 43 MB in memory — then open with the `opfs-sahpool` VFS **in a dedicated worker**.
  `opfs-sahpool` needs **no COOP/COEP headers and no SharedArrayBuffer**, which is decisive: static
  hosts and embedded WebViews cannot set those reliably, and Capacitor closed its custom-headers
  issue (#7813) as "not planned".
- **Do not** use the Capacitor plugin's own web path (`jeep-sqlite`, sql.js-in-IndexedDB, last
  published 2024-08). Put a small `DictStore` interface over the two implementations.

**Five hard parts, recorded so nobody rediscovers them.**

1. **Pinyin is a normalisation problem, not a search problem.** Everything that makes `dasuan`,
   `da3suan4`, `dǎsuàn`, `da suan` and `da'suan` equal must happen *before* the query reaches the
   index. `lib/dict/pinyin.ts` already does this and moves to the client unchanged. The traps are
   known: keys are stored **without separators** because unsegmented input is ambiguous (`xian` is
   西安 or 先, and the concatenated toneless key resolves both); ü/v/`u:` folding; the neutral tone
   contributing no digit; `r5` erhua; CC-CEDICT's capitalised proper nouns; and short prefixes
   (`da`) matching thousands of rows, so **`ORDER BY freq DESC LIMIT` must be in the SQL**, not
   applied after. Initial-letter search (`ds` → 打算), which the app does not do today, would need a
   third key column at roughly +3 MB.
2. **`detail=none` trades phrase queries for 3.4 MB.** It supports token AND-queries and `bm25()`
   but not phrase or NEAR matching — "to plan" becomes the tokens `to` and `plan`. The existing
   `glossTier` ranking in `lib/dict/search.ts` either ports on top of `bm25()` or is recomputed in
   TS over the ≤50 candidate rows. `detail=full` costs +8.1 MB instead of +4.7 MB.
3. **Browser persistence has edges.** OPFS sync access handles require a worker; `opfs-sahpool`
   holds an **exclusive** lock, so it is one connection per origin and a second tab must fall back
   to an in-memory database (`sqlite3_deserialize`, ~43 MB of wasm heap) or route through a
   SharedWorker. Safari 16.4+ is the stated floor. Storage can be evicted, so **the import must be
   idempotent and keyed by dictionary version**.
4. **The Capacitor bridge is async.** Every keystroke becomes a JSON round trip through the plugin
   (~1–5 ms plus result serialisation). Batch the hanzi, pinyin and gloss queries into **one**
   plugin call, and keep the segmenter's candidate fetch to a single `IN` query per hanzi run.
5. **The segmenter does not port for free, and this is a schema decision.** `lib/dict/pinyin.ts`
   genuinely does move unchanged — `readingKeys()` returns `{toneless, toned}` and touches nothing
   else. `lib/dict/segment.ts` does not, and the audit never claimed it did: it said the *DP* runs
   unchanged. Read the module before planning around it. `segment()` calls `getDictIndex()` itself —
   a Node-fs-backed singleton — and then reads `index.bySimp`, `index.byTrad` and `index.entries`
   directly, for three things the proposed `words(script, word, freq)` table cannot answer. (a)
   `detectScript(index, text)` walks every character of the input and counts only those where the two
   scripts *disagree*, which needs a per-character simplified-only / traditional-only fact. (b)
   `statsFor()` computes `ScriptStats.logTotal` — the total corpus frequency, which is the DP's
   unknown-word floor — by summing the head frequency of every headword in the index. (c)
   `ScriptStats.maxLen` is derived the same way and bounds the DP's inner scan. Only `route()` runs
   unchanged.

   The work: invert `segment()` to take an injected candidate map and a `ScriptStats` value instead
   of calling `getDictIndex()`; add a small `meta` table to the SQLite file carrying `logTotal` and
   `maxLen` per script, since over a fixed dictionary both are build-time constants; and decide how
   `detectScript` is answered — either an `is_simp_only` / `is_trad_only` flag on the `chars` table
   (which §5.6 already proposes shipping, and which would make this nearly free) or one extra batched
   query per hanzi run. `MAX_WORD_CHARS = 16` and jieba's `(score, end)` tie-break are unaffected and
   must be preserved exactly; the existing segmentation unit tests are the regression net for the
   inversion. Because it changes the file's schema, it belongs on the §7 settle-first list next to
   the `DictStore` interface, not inside a build phase.

**Alternatives.** *Keep the JSON index* — works today, and is the fallback if native dependencies
are refused, at ~2 s and ~60 MB heap per cold launch. *Pure-JS search libraries* (MiniSearch,
FlexSearch, Orama) all hold the index in memory: the same cost profile as today with more code, and
nothing beats a B-tree for exact/prefix lookups on 124k short keys. *A Chinese-aware FTS5 tokenizer*
(`wangfenjin/simple` is the serious one — MIT/GPL dual, pinyin search, iOS xcframework and Android
builds) has **no WASM story** and a reported ~4 s jieba load. *Ship a bare 20.0 MB table and build
indexes on device* — re-measured by `data.md` D1 (§3) after the audit's compressed figures failed a
sanity check: 6.2 MB brotli, indexes rebuilt in 0.46 s, so the saving is real and larger than this
record supposed. It still buys a second code path for 7.7 MB of transfer. Start with the full file.

**What would make this wrong.** You need full-text search **inside** Chinese text — example
sentences, Chinese-language gloss text, user notes. Then you need a bigram/trigram tokenizer, a
custom sqlite-wasm build, and per-platform native builds, and `simple` becomes the candidate with no
browser answer. Or: the app must be under 10 MB, or the dictionary must update independently of app
releases — then mobile switches to download-on-first-launch, which changes only delivery, not the
storage layer.

### 2.6 Marketing site: separate deployment, separate origin

**Decision.** App at `app.<domain>`, marketing at the apex, built with **Astro**.

**The single strongest reason.** **The service worker scope and the storage origin stay clean.** A
marketing redeploy must never be able to touch the origin that holds the learner's flashcards — and
with one origin, a bad `sw.js` or a storage-clearing mistake on the marketing side is exactly that.
Secondary but real: the access gate then applies only to the app — as would a
Content-Security-Policy, though there is none in this repo today — and you get indexable HTML
without dragging `@react-router/dev`'s file-route conventions into an app that has no other use for
them.

**Alternative.** React Router framework mode with `ssr: false` + `prerender: [...]` emits static
HTML plus a `__spa-fallback.html`, and is the credible one-repo answer. It is the right answer if
the SEO condition in §2.2 fires and you need prerendered *app* pages too, because at that point you
are running framework mode anyway.

**What would make this wrong.** Maintaining two deployments is friction the owner does not want, and
no app page ever needs indexing — then one React Router framework-mode repo is simpler.

### 2.7 Audio: three tiers, device voice first

**Decision.** Three tiers, shipped in order:

1. **Device voice** — already built behind `lib/tts/provider.ts`. Free, offline, no licensing. The
   default. On mobile this becomes the native plugin adapter (§2.1), not Web Speech.
2. **Cloud voice, cached per entry** — generated once, stored on device, paid for once. Fixes
   desktop web quality, where the browser's Mandarin voice is whatever the OS happens to have.
3. **A recorded syllable set** — roughly 1,300 toned Mandarin syllables read once by one speaker,
   covering every word in the dictionary offline forever, stitched with tone sandhi (two third tones,
   and the shifts on 一 and 不). *Both the 1,300 and the "a few megabytes" are estimates, not
   measurements:* product-decisions §8 states them, and the Android audit says only that "~1,300
   pinyin syllables × tones is the standard Mandarin-app approach". Nothing has measured the audio.

**The single strongest reason for the ordering.** Tier 1 exists, costs nothing, and works on the two
platforms that matter most. **But tier 3 moved from "nice to have" to "likely necessary"** when the
Android audit found that a device without Google Mobile Services may report **no Mandarin voice at
all** — there is no tier-1 fallback on those phones, and the standard Mandarin-app answer is a
per-syllable set. This mirrors Pleco: paid whole-word native-speaker recordings *plus* TTS for
anything unrecorded, falling back to syllable-by-syllable stitching when there is no whole-word
recording.

**Constraints on tier 3.** Recordings from another app cannot be reused. Any open recording set
needs its licence read before ingestion, and the result goes in `data/ATTRIBUTION.md` like
everything else.

**Runtime handling on Android regardless of tier:** query `isLanguageAvailable` at startup, offer
the "install voice data" intent when an engine exists but the pack is missing, and degrade to the
syllable set when neither is there.

### 2.8 Accounts, sync, and BYOK

**Decision.** A server holds accounts and sync, and **proxies every model call** — two components
rather than one, a stateless AI proxy plus a stateful accounts / key-custody / sync part (§5.5). The
learner's own model key is **stored encrypted server-side against the account** and never touches a
browser or a device. Money model is **BYOK for now**, possibly a subscription later. "Free with a
cap" is out — the owner cannot fund inference for strangers.

**The single strongest reason for sync.** Today every device is an island: a phone and a laptop are
two decks, and deleting the app deletes everything. Sync is a **data-safety** feature before it is a
convenience one, because browser storage eviction is real. The framing that matters: **losing the
dictionary is a re-download; losing the flashcards is the actual loss.** The defences are
`navigator.storage.persist()` plus install, early account sync, and a local export.

**On native, record the alternative the iOS audit actually recommended, because this record adopted
only half of its sentence.** AUDIT 1: "Do NOT rely on IndexedDB/OPFS in WKWebView for anything you
cannot rebuild ... Dictionary as bundled asset + user data in **native SQLite** (or Dexie with a real
export) is the safe shape." The dictionary half is taken (§2.5); the user-data half was dropped, and
the flashcards are precisely the thing that cannot be rebuilt. So there are two live options for
learner data on iOS and Android, and the choice is open:

1. **Dexie in the WebView's IndexedDB**, as today, with account sync as the durability story.
2. **A second `Repository` implementation on `@capacitor-community/sqlite`** for user data, through
   the seam that already exists — the same move §2.4 proposes with `tauri-plugin-sql` on desktop. The
   argument is *stronger* on mobile: the eviction question (register entry #3) is genuinely
   unanswered there, and the plugin is already a dependency for the dictionary.

What decides between them is register entry #3, or simply declining the risk. Option 2 is the
conservative choice and it is not expensive, because a second implementation behind the interface is
what the interface is for. Whichever is chosen, **the local export becomes a named deliverable of the
first mobile phase**, not a mitigation mentioned in prose: on day one neither sync nor a native store
exists, and an export is the only thing that makes a lost WebView database recoverable in the
meantime. Nothing specifies its format yet; JSON of the repository's own row shapes is the obvious
answer, since the schema rules already guarantee stable UUID keys and timestamps.

**The single strongest reason the key lives server-side.** The Anthropic TypeScript SDK only permits
browser calls behind an explicitly-named "dangerous" flag, and it is named that because the key is
exposed to anything running on the page. Since a server is required for sync anyway, routing AI
through it keeps the key out of every client and gives rate limiting for free. **The web version does
get AI** — an earlier suggestion that it might not was withdrawn.

"Costs nothing extra" is how this was first recorded and it is too generous, so correct it here.
Holding **other people's** provider keys at rest is a design of its own: where the master key lives,
how it rotates, what the breach response is, and the fact that a solo developer becomes the custodian
of strangers' billing and a credential target worth attacking. It also carries a question nobody has
answered — **whether the provider's terms permit a third party to store and use end-user API keys on
their behalf.** Neither the audits nor the product decisions establish that. Both go to §5.5 as open,
and until they close, "BYOK, stored encrypted server-side" is a direction rather than a design. Note
the shape that needs no custody at all and is the actual situation until §5.4's distribution
experiment happens: one account, the owner's own key, nobody else's credentials on the server.

**What the server actually replaces.** `/api/ask`, `/api/examples` and `/api/recall` move to it more
or less as they are, minus the dictionary load: the grounding step in `lib/ai/ground.ts` needs
dictionary entries by id, and the natural shape after §2.5 is for the **client** to send the
retrieved entries it already has locally, rather than the server keeping its own copy of a 35 MB
file. That is a real design question, not a settled one — it changes the request contract in PLAN.md
§3.4 — and it is listed in §5.

**The access gate has to be re-sited, not merely kept.** `TANGRAM_ACCESS_SECRET` is superseded by
real accounts, and until those exist it is the only thing standing between a deployed URL and an
invoice — but half of it is Next middleware, which §2.2's own table lists among the features the move
removes, and a static SPA has nowhere to run middleware. Split it the way the code already splits:
`lib/server/access.ts` imports nothing from `next/*` and moves to the new server, where
`requireAccess` gates the three paid routes exactly as it does today. That is not a downgrade — the
module header says the routes check for themselves precisely because middleware is one `matcher` edit
away from silently not running, and the paid routes are the only thing that costs money. What is lost
is the page-level `?key=` → cookie trade, which existed so the owner could authorise a phone that
cannot set a request header. Dropping it is acceptable; if the phone workflow is still wanted, the
cheapest replacement is the same exchange served by the new server on a single endpoint. Decide it
when the server is chosen, and do not let the gate quietly cease to exist during the migration.

**Storage-eviction facts that justify the "install and persist" advice** *(all sourced via search;
vendor pages were blocked)*: Chromium grants up to 60% of disk per origin,
`navigator.storage.persist()` never prompts and is granted silently to an installed, bookmarked,
notification-permitted or high-engagement origin, and eviction is LRU under disk pressure only and
**skips persisted origins**. WebKit 17+ made the quota disk-based, and **web apps added to the Home
Screen or Dock are exempt from the seven-day ITP cap** and get the browser-level quota. Firefox
prompts on `persist()` and has no desktop PWA install. The dangerous case is a **non-installed
Safari tab** — which is another reason installation is the desktop story.

**What would make this wrong.** BYOK proves to be too much friction for anyone but the owner (nobody
wants to paste an API key), in which case the subscription question in §5 becomes urgent rather than
hypothetical; or a managed sync backend (Supabase, which PLAN.md §3.3's schema rules were written
for) turns out to be enough that "a small server" is only the AI proxy.

---

## 3. The numbers

Everything below is from the audits of 2026-09-13 unless a row says otherwise. **Measured** means an
agent ran it in this container against the real generated data. **Sourced** means it came from
documentation, a changelog, a vendor page or a search summary.

### Dictionary artifacts

**The shipping figure is the last row, not the audit's.** Everything above it is the dictionary
audit's measurement against the schema the audit sketched; `data.md` D1 then specified and measured
the schema that is actually being built, and **its 43.1 MB raw / 13.9 MB brotli supersedes this
record's 47.2 / 15.4 everywhere**. The audit rows stay because the per-feature deltas are still the
best available guide to what each index costs.

| Artifact | Raw | gzip -9 | brotli q11 | Basis |
|---|---|---|---|---|
| `data/dict.json` (today, 124,188 entries) | **35.1 MB** | 7.4 MB | 5.2 MB | measured |
| `data/decomp.json` | 0.92 MB | 0.19 MB | — | measured |
| SQLite: entries table + unique id index | 23.5 MB | | | measured, audit schema |
| + hanzi indexes (`simp`, `trad`) | 27.6 MB | | | measured, audit schema |
| + pinyin key table (toneless + toned, indexed) | 36.0 MB | | | measured, audit schema |
| + gloss FTS5 (`detail=none`) | 40.7 MB | | | measured, audit schema |
| + `words` table for segmentation (242k rows) | 43.3 MB | | | measured, audit schema |
| + optional `chars` table for infix "contains 算" (427k rows) | 47.2 MB | 21.5 MB | 15.4 MB | measured, audit schema — **superseded** |
| **The finished file, `data.md` D1's schema** | **43.1 MB** | **19.5 MB** | **13.9 MB** | **measured against the schema that ships** |
| Bare entries table only (indexes built on device) | 20.0 MB | 8.5 MB | **6.2 MB** | re-measured by `data.md` D1 — the audit's 22.8 / 9.8 / 11.9 was wrong |
| Gloss FTS5 at `detail=full` instead of `none` | +8.1 MB (vs +4.7 MB) | | | measured, audit schema |
| Trigram FTS over simp/trad (rejected) | +3.4 MB | | | measured, audit schema |

D1 comes in smaller while shipping *more* — it also carries an `entries_hsk` index the audit never
priced. Three of its choices are why, and each is measured in D1's own cumulative table rather than
derivable from the rows above: **pinyin keys are columns on `entries`, not a side table** (3 MB
cheaper and one fewer join); **the gloss FTS5 content is pre-stemmed at build time**, contentless
and `detail=none`; and **the infix capability is a packed delta-varint posting list** per
(character, script) at **+1.4 MB**, where the obvious one-row-per-(character, script, entry) shape
is 636k rows and **+22.4 MB**. A build session that writes the obvious version makes the file 50%
bigger for nothing.

**The bare-table row did not pass a sanity check, and has been re-measured.** Brotli q11 larger than
gzip -9 on the same input is implausible, and every other row in the table has brotli comfortably
below gzip (35.1 → 7.4 → 5.2; 43.1 → 19.5 → 13.9). The audit's figures were transcribed faithfully
— they were not an invention — but its own prose then called this variant a "ship 12 MB, index on
first launch" option, which matched neither of its compressed numbers cleanly. `data.md` D1 re-ran it
against the shipping schema: **20.0 MB raw, 8.5 MB gzip -9, 6.2 MB brotli q11, indexes rebuilt in
0.46 s**. The number is load-bearing twice — §2.5 offers this variant as the fallback if transfer
size matters, and register entry #4 offers it as the fallback if the OPFS cap bites — and the real
saving (13.9 → 6.2 MB brotli) is *larger* than this record supposed, at the cost of a second code
path. D1 still declines it for v1; the case is in `data.md` §7.

**Any on-device footprint estimate has to double the file.** A bundled dictionary sits compressed in
the app package *and* expanded in app storage after `copyFromAssets()`, so the installed cost on a
phone is roughly the download plus the 43.1 MB expansion, not the download alone: **≈63 MB**
(19.5 MB packaged + 43.1 MB expanded), which is the figure `data.md` D5a, `ios.md` and `android.md`
all budget against, with the packaged half resting on register entry #16 (§2.5, register entry #18).

### Query latency

| Query | Latency | Basis |
|---|---|---|
| Hanzi exact/prefix, 200 rows | 0.2 ms | measured, native SQLite 3.45 |
| Pinyin prefix on derived key | 0.1 ms | measured, native |
| Gloss FTS5 `bm25()` — "plan" / "to plan" | 0.2 ms / 1.4 ms | measured, native |
| Segmentation candidate fetch, 653 candidates from a 205-char paragraph | 0.7 ms | measured, native |
| `WHERE id IN (...)`, 50 ids | 0.15 ms | measured, native |
| The same under WASM | **2–5× the above** | **extrapolated, not measured** |
| Building all indexes on-device from the bare table | 0.8 s | measured, native, SQL only |

### The current JSON approach

| Figure | Value | Basis |
|---|---|---|
| Parse `dict.json` + build `DictIndex` | **+58 MB heap, 184 MB RSS in Node, 0.7 s** | measured (`--expose-gc`, tsx) |
| First pinyin query (lazy sub-index) | +1.6 s | measured |
| First hanzi query (lazy sub-index) | +0.34 s | measured |
| Subsequent queries | 0.1–8 ms | measured |
| One `getDictIndex()` load, memoised per process (Phase 1 figure) | ≈2 s, ≈310 MB RSS | measured, HANDOFF.md |
| Per route, cold instance, all seven indexes built eagerly (Phase 8, before laziness) | 3.9–4.6 s, 280–292 MB | measured, HANDOFF.md |
| After Phase 8's lazy indexes, per route | 972 ms – 2429 ms, RSS 171–267 MB | measured, HANDOFF.md |
| Irreducible floor of the JSON approach | the 650 ms `JSON.parse` | measured, HANDOFF.md |

### Store and platform limits

| Limit | Value | Basis |
|---|---|---|
| Google Play base-module compressed download | 200 MB cap; mobile-data warning above it, not a block | sourced |
| Apple app size | 4 GB uncompressed; 80 MB `__TEXT` per binary; "Ask if over 200 MB" cellular prompt is a user default since iOS 13 | sourced |
| Play cold-start flag | over 5 s | sourced |
| Capacitor cold start on iPhone 11-class hardware | under ~2 s, practitioner reports; **no rigorous benchmark exists** | sourced, weak |
| Chromium per-origin quota | up to 60% of disk | sourced |
| WebKit 17+ quota | disk-based; installed web apps exempt from the 7-day ITP cap | sourced |
| Reported OPFS per-file cap in WKWebView | 10 MB | **single third-party README — see §4** |
| `sqlite3.wasm` binary / ES module | 869 KB / ~640 KB | sourced |
| Full Noto Sans SC OTF / slim subset | ~4.5–9 MB per weight / 0.7–1.4 MB | sourced |
| Tauri download / idle memory | ~3–10 MB + WebView2 bootstrapper / tens of MB | vendor and SEO-comparison blogs — **order of magnitude only** |
| Electron download / idle memory | ~85–120 MB / 150–250 MB | vendor and third-party benchmarks — **order of magnitude only** |
| Apple Developer Program | $99/yr — incurred by the App Store decision in §2.1, **not** by the desktop shell | sourced |
| Windows code signing (Azure Artifact Signing) | ~$9.99/mo ≈ $120/yr — the *marginal* cost of a Tauri desktop shell (§2.4) | sourced |
| Google Play developer registration | one-time fee, **not priced by any audit** — read it off the Play Console | unpriced |
| Server hosting (§2.8) | unpriced — depends on which shape §5.5 chooses | unpriced |

---

## 4. Known-unknowns register

These are the things the audits explicitly **could not verify** and on which the plan actually
depends. Each has the check that would settle it. Do not soften these and do not let a phase claim
completion on one of them without running the check.

### Preconditions: the hardware and toolchain the register assumes

Read this before sequencing anything, because a third of the checks below cannot be run in the
environment this repo is built in. That environment is a Linux container: Playwright drives the
container's Chromium at `/opt/pw-browsers/chromium`, `pnpm e2e` serves on `$PORT`, and worktrees use
3001–3003. Nothing in it can build an iOS app, sign an Android bundle, or touch a phone. A register
entry that cannot be run is not a soft entry; it is a blocked phase.

| Needed | Which checks, and for what | Without it |
|---|---|---|
| **A Mac with Xcode 26** | Any iOS build at all — Capacitor 8 requires Xcode 26, and the iOS 26 SDK has been mandatory for App Store submissions since 28 April 2026 | No iOS phase can start. Not partially: there is no build. |
| **A physical iOS 26 device** | #1 (the `-webkit-user-select: none` crash and the reader prototype), #2, #4 (OPFS import on iPhone), #11 (cold start), #20 (FTS5 behind the iOS pod) | The Simulator answers #2 and can host the reader prototype for *shape*; a WKWebView crash on a beta OS and real cold-start timings are device facts. |
| **A physical Android phone with Google Mobile Services** | #5 (`zipalign -c -P 16` on a real AAB), #7, #8, #11, #19 | The emulator answers #8 and #19 and can produce a build for #5. It cannot stand in for real hardware on #7 or #11. |
| **A physical Android phone without GMS** | The other half of #7 — whether a no-GMS device reports any Mandarin voice | Unanswerable. This is the check that decides whether audio tier 3 is v1 scope (§5.3), so leaving it open leaves tier 3 a live v1 risk with an unpriced production project behind it. |
| **A named low-end Android target** | #11, and reason 7 of "what would make Capacitor wrong" | This record says "the low-end Android target" and never names a device. Name one before the first Android phase, or the performance bar is unfalsifiable. |
| **Desktop Safari** | #4 (importing the real 43.1 MB file into `opfs-sahpool`) and #13 (`persist()` behaviour) | Needs the same Mac. Note this one blocks the **web** dictionary path, not only mobile. |

The sequencing consequence should be planned rather than discovered. **Everything web and desktop
proceeds in the container**: the Vite move, the SQLite build step, the `DictStore` web
implementation, the shell rewrite, the per-character reader prototype against desktop Chromium, the
server. **The Capacitor phases cannot start until the Mac and the phones exist.** The one check that
needs no hardware at all is #9 (font coverage), which is a script over `data/dict.json` — run it
first. If the hardware is not going to exist, that is not a reason to soften the register; it is a
reason to say plainly that the mobile apps are out of scope for now and to plan the web and desktop
product on its own.

| # | Unknown | What it blocks | The check that settles it |
|---|---|---|---|
| 1 | **The per-character reader itself, plus a reported WKWebView crash on the iOS 26 beta when `-webkit-user-select: none` is applied during touch** (one Apple forum thread; resolution unknown). Neither audit ran the combination this record specifies: one `<ruby>` element per character, `caretRangeFromPoint` on every `pointermove`, painted with the Custom Highlight API over a DOM interleaved with `<rt>` nodes. Each recommended the pieces separately. | The entire reader and drag-select design. On iOS the CSS is load-bearing for suppressing native selection; everywhere, the per-character combination's pointer latency and layout cost are unmeasured, and product rules 1–2 make the reader's data model character-granular (§2.1). | **One prototype answers both, so build it once.** Per-character ruby over a realistic pasted passage (a few hundred characters), drag-select via `caretRangeFromPoint`, highlight via the Custom Highlight API. Measure `pointermove` latency and layout time; confirm highlight ranges land on base characters and never on `<rt>` text; confirm copy excludes the pinyin. Run it in desktop Chromium first — free, in the container, no hardware — and then on a **real iOS 26 device** before anything else in the reader is built. If the crash reproduces and no CSS workaround exists, the reader screen is the first candidate for the native-`UIViewController` boundary in §2.1, with the cost that paragraph now states. |
| 2 | **Is `caretPositionFromPoint` default-on in Safari 26?** It landed in WebKit in late 2024 behind a flag. | Nothing fatal — `document.caretRangeFromPoint` is WebKit-proprietary and present in every WKWebView — but it decides whether the hit-test path is standards-track or forks per engine. | Feature-detect at runtime and log which path is taken on a real iOS 26 device. Write the code to prefer the standard and fall back. |
| 3 | **Does ITP's seven-day eviction apply to WKWebView inside a native app?** Unanswered on Apple's own forums. | Whether any learner data may live only in the Capacitor WebView's IndexedDB. | Cheapest answer is to not need it: put the dictionary in bundled native SQLite and get account sync working early. To actually measure: write a marker row, leave a device untouched for eight days of Safari use, re-open. |
| 4 | **The reported 10 MB per-file OPFS cap in WKWebView.** Single third-party source (`wendylabsinc/opfs-checker`); WebKit's published policy is a per-origin quota of 15–20% of disk for non-browser apps. | The **web** delivery of the 43.1 MB dictionary on Safari and on iOS in general. Does not block native, which uses the plugin. | Import the real 43.1 MB file into `opfs-sahpool` on desktop Safari and on an iPhone, and see whether it succeeds. Do this before committing to the web dictionary path. Fallback if it fails: `sqlite3_deserialize` in-memory (~43 MB wasm heap) or the bare-table variant. |
| 5 | **Does `@capacitor-community/sqlite` ship 16 KB-page-aligned native libraries?** Required by Play for `.so` files since November 2025; the plugin bundles SQLCipher. | **Play Store submission.** A misaligned `.so` is a rejection, not a warning. | `zipalign -c -P 16 -v <aab-or-apk>` on a real build, in the first Android phase. If it fails, the options are a newer plugin release, a rebuild of the native lib, or Capawesome's paid plugin. |
| 6 | **Do `ATTACH` and the `immutable=1` URI flag pass through `@capacitor-community/sqlite`?** | How the read-only dictionary connection is opened, and whether the dictionary and the user database can be attached in one connection. | Call both against a copied asset on a device and read the error. Not fatal either way — two connections work — but it changes the query layer's shape. |
| 7 | **Availability of a Mandarin TTS voice on the target Android devices**, including whether Google Speech Services' offline zh-CN pack is downloadable (never confirmed from Google's own docs) and what non-GMS devices report. | Which **audio tier** must ship first (§5), and whether tier 3 is v1 scope. | `isLanguageAvailable('zh-CN')` on each physical test device, GMS and non-GMS, before and after installing voice data. |
| 8 | **Whether the CJK synthetic-bold regression in Android WebView 139–140 is actually fixed in 143** (Chromium 446078849, reported fixed, unconfirmed). | How much the bundled-font work matters and whether a `lang` attribute alone is sufficient. | Render bold hanzi with and without `lang="zh-Hans"` on a device with WebView in the 139–143 range. Mitigated regardless by bundling a real bold weight. |
| 9 | **Whether a slim Noto subset covers the CC-CEDICT headword character set.** Subsets are 0.7–1.4 MB; the full face is 4.5–9 MB per weight. | App size vs. tofu boxes in the dictionary — **and the web first-load budget**, since on native a face is package bytes but on web it is transfer on top of the 13.9 MB dictionary (§2.1). | Extract the distinct character set from `data/dict.json` headwords and run a coverage check against the candidate subset's cmap, for every face and weight the visual language actually uses. This is a script, not a device test, and it needs no hardware — do it first. Then decide web delivery separately from native: `unicode-range`-split subsets exist on the web and are irrelevant inside an app package. |
| 10 | **WASM query latency.** The 2–5× multiplier over native is an extrapolation; nothing was measured in a browser. | The web build's interactive-search feel. Native is measured and comfortable. | Port the measured query set into a browser harness against the real file under `opfs-sahpool` and re-measure. |
| 11 | **Capacitor cold-start time on real hardware.** No rigorous benchmark exists in either direction; the pathological reports (Capacitor #6115, a 13 s migration report) all trace to large bundles or loading data at boot. | Requirement 2 of "what would make Capacitor wrong". | Measure cold start on the low-end Android target and on an older iPhone once the SQLite path is in, and compare against Play's 5 s flag and your own 2 s bar. |
| 12 | **Capacitor 8's stated iOS 15 minimum** and several other Capacitor/Tauri version facts came from **search snippets, because capacitorjs.com, ionic.io, tauri.app, capawesome.io and issues.chromium.org were all egress-blocked** during the Android audit. | Deployment-target choices and the `rt { user-select: none }` copy-exclusion behaviour, which needs Safari 16.4+. | Read the official docs from an unblocked network before the first mobile phase starts. This is a five-minute task and it validates a whole cluster of facts at once. |
| 13 | **`navigator.storage.persist()` behaviour in Safari for a non-installed site**, and current Firefox group limits. | How hard the app must push installation on web, and how loudly it must warn a non-installed Safari user. | Call `persist()` then `persisted()` in a real Safari tab and in an installed web app; read what each returns. |
| 14 | **Whether the Mac App Store sandbox permits `RegisterEventHotKey`-based global shortcuts through Tauri's plugin.** | Whether the desktop shell can be distributed through the Mac App Store at all, or must be direct-download only. | Only matters if and when Tauri ships. Check Apple's sandbox entitlement docs and Tauri's plugin implementation together. |
| 15 | **Play's 12-tester / 14-day closed-test requirement for personal developer accounts created after 13 November 2023.** Sourced, not confirmed from Google. | Android release timeline — it is a two-week gate before production, and it applies to every stack. | Read the current Play Console policy page before planning any launch date. |
| 16 | **Store compression ratio.** The audit used `gzip -9` as a proxy for what the stores actually do. | Only the app-size estimate, which has enormous headroom. | Read the actual download size in the Play Console and App Store Connect after the first upload. |
| 17 | **RN and Expo version disagreement between the two mobile audits** (SDK 57/RN 0.86 vs SDK 56/RN 0.85; `op-sqlite` 18.2.1 vs 17.1.3). A second inter-audit disagreement is recorded in §6 on the `tauri` core row (2.10.1 via search vs 2.11.5 on crates.io). | Nothing, unless RN is reconsidered. Recorded so the discrepancy is not mistaken for a fact. | Read the npm registry if RN ever comes back on the table. |
| 18 | **How long the first-launch `copyFromAssets()` of the 43.1 MB dictionary takes, and what it costs in storage.** Unmeasured by anyone; the audit's "no failure mode" phrasing skipped past it. | The first-run experience on both mobile platforms, and every on-device footprint estimate — the file lands twice, compressed in the package and expanded in app storage. | Time the copy on the lowest-spec Android target and on an iPhone, with the device near-full as well as empty, and record peak storage. Then design the one-time progress state and the low-storage failure path; neither exists in any screen today. |
| 19 | **Whether `window.speechSynthesis` really is undefined in the Capacitor Android WebView.** Chromium issue 40468168 — the id and its status came from a search snippet, because `issues.chromium.org` was egress-blocked during the Android audit. | Whether `@capacitor-community/text-to-speech` is mandatory or merely convenient, i.e. a plugin dependency. | Log `typeof window.speechSynthesis` in the Capacitor WebView on the Android test device or the emulator during the first mobile phase. Five seconds. Native TTS is wanted anyway for the enhanced iOS voices and the range events, so a surprise here changes the justification rather than the plan. |
| 20 | **The SQLite version behind the SQLCipher iOS pod, and therefore whether FTS5 is compiled into it.** Verified for the Android artifact only; named in the dictionary audit's own not-verified list. | The "one file, no per-platform build" claim on iOS — the load-bearing simplification of §2.5. | Open the copied asset on an iOS device through the plugin and run `SELECT sqlite_version()` plus a trivial `CREATE VIRTUAL TABLE t USING fts5(x)`. Fold it into the same device session as #6, which already touches the plugin against a copied asset. |

---

## 5. Open decisions

Genuinely unsettled. Each has a recommendation and what it would take to close it. Two entries at
the end are not open in that sense and are kept here so a reader looking for them finds them: §5.6
and §5.8 are **settled**, recorded with the decision rather than deleted, and §5.9 is an open item
with no owner rather than a decision awaiting a measurement.

### 5.1 Desktop shell: command palette or page shell — and its default theme

**Status:** the owner likes both; both are drawn on the design canvas. The palette is a floating
search panel that *is* the home screen (Practice is the first row and Enter starts it, typing looks
a word up in place, Cmd+Enter adds it, Tab asks the whole question), shrinking to a slim Cmd+K bar
during a practice session. The page shell is the phone's three-tab structure at desktop width. The
practice card, lookup result and library rows are identical in both.

**Recommendation:** build the **page shell first** and the palette second, as a *mode* over the same
components. The page shell is the phone shell at a wider breakpoint, so it costs close to nothing;
the palette is the differentiated thing and deserves to be built when it can be built well. Note the
coupling: the palette's whole point on desktop is being summonable, and **summoning requires the
global hotkey, which requires Tauri** (§2.4). A palette inside a browser tab is a search box with
ambitions.

**To decide:** use the page shell for a week of real study and see whether reaching for Cmd+K is a
reflex.

**Default theme** is unresolved. The settled visual language is a warm paper ground (`#f8f4ec` /
`#fffdf9` / ink `#1c1a17`), which is a light-first system; a Raycast-style palette conventionally
reads dark. **Recommendation:** ship light as the default because the reading surfaces are light and
a palette that inverts the app's own colours is jarring, and build the token layer so a dark palette
variant is a theme swap rather than a second design. To decide: draw the palette in both against the
settled tokens and pick.

### 5.2 Does the calibration chart survive?

**Status:** `/stats` ships four panels — true retention, calibration by decile, workload forecast,
and maturity/stability (`lib/stats/calibration.ts` and friends). Everything on `/stats` moves behind
Library and gets rewritten in plain English ("How well it's sticking", "What's coming up", "How many
words are solid"). The calibration chart is the one that is genuinely hard to explain without SRS
jargon.

**Recommendation: cut it from v1.** Its audience is someone tuning FSRS, and the product's stated
rule is no spaced-repetition jargon anywhere in the UI.

Be accurate about what cutting it touches, because "delete the chart component" is not the whole
edit. `lib/stats/calibration.ts` is re-exported by `lib/stats/index.ts` and consumed by
`lib/stats/summary.ts`, which computes `summary.calibration` for all four panels; the chart itself is
`components/stats/calibration-chart.tsx`, rendered from `components/stats/stats-view.tsx`. Cutting
the panel means editing `summary.ts` and `stats-view.tsx` as well, or deliberately leaving
`summary.calibration` computed and unread. Leaving the maths in place is defensible on its own terms
— it is cheap, and the panel may come back — but **not** on the grounds that the optimizer needs it:
the optimizer is `lib/fsrs-optimize/**`, and across `dataset.ts`, `loss.ts`, `optimize.ts` and
`previous.ts` its only internal imports are `@/lib/srs/params` and `@/lib/db/schema`. The real
relationship is narrower and is recorded in a comment in `lib/fsrs-optimize/dataset.ts`: scorability
and calibration measure elapsed time from the same timestamp.

**To decide:** try to write the panel's one-sentence explanation for a beginner. If it cannot be
written, it does not ship. (Note the related, already-settled decision: **hide the optimizer
entirely until it can actually run** — it needs ≥1,000 scorable reviews — rather than showing a
disabled button for months.)

### 5.3 Which audio tier ships first

**Status:** tier 1 (device voice) exists. Tier 3 (a ~1,300-syllable recorded set) moved from "nice
to have" to "likely necessary" because of the no-GMS finding.

**Recommendation:** ship **tier 1 only** in the first mobile release, with a clear in-app state when
no Mandarin voice is available, and let known-unknown #7 decide whether tier 3 is v1 or v1.1. Tier 2
(cloud voice, cached per entry) is the desktop-web quality fix and should follow the server, not
precede it.

**To decide:** run `isLanguageAvailable` on the actual test devices (register entry #7 — and note
that the no-GMS half of it needs a no-GMS phone, per §4's preconditions).

**If tier 3 is not optional, price it honestly, because two paths exist and only one has been given a
hearing.** A human-recorded set is a **production project, not a build task**: someone records ~1,300
toned syllables to a consistent quality bar, someone QAs every one of them, and the licence of any
existing open set must be read before ingestion (recordings from another app cannot be reused).
Nobody has costed that, and the owner's stated money constraint is that he cannot fund inference for
strangers. The cheaper path the audits never raised: **generate the syllable set once from the tier-2
cloud voice and bundle the result.** Tier 2 already establishes that pipeline, so this turns a
recording project into a build script, and the stitching and tone-sandhi work is identical either
way. What decides it is a licence question, not a technical one — **do the chosen TTS vendor's terms
permit redistributing generated audio inside a shipped app?** Many do not. Read the terms *before*
choosing the tier-2 vendor, so this option stays open. If neither path is available, tier 3 is a real
unbudgeted cost and it belongs in the schedule rather than in a footnote.

### 5.4 Does a subscription follow BYOK?

**Status:** BYOK now; "free with a cap" is out; a subscription is "possibly later".

**Recommendation:** do not design for it yet, but **do not build anything that makes it hard**: the
server already holds accounts and proxies every model call, so metering per account is an add, not a
re-architecture. The decision is a market question, not a technical one.

**To decide:** whether anyone other than the owner is willing to paste an API key. That is a
distribution experiment, and it needs the app in a stranger's hands first.

### 5.5 Where the server lives, and who holds the dictionary during grounding

**Status:** not addressed by the audits at all — they scoped the client. PLAN.md §3.3 anticipated
Supabase; §2.8 above says "a server". The concrete open question is whether it is a small Hono/Node
service, Supabase (Edge Functions + Postgres + Auth), or something else.

**First, resolve a contradiction this record shipped with.** §2.8 gives the server accounts,
authentication, sync state and custody of other people's encrypted API keys, and the recommendation
below calls for "a single stateless function". Both cannot be true. The resolution is that it is
**two components**: a *stateless* AI proxy — which is what the recommendation below is actually about
— and a *stateful* part holding accounts, key custody and sync, which is the half nobody has designed
and the half that decides the hosting bill. Everything below applies to the proxy; the stateful part
is open in every respect, including whether Supabase supplies it wholesale.

There is a second, sharper question hiding inside it. `lib/ai/ground.ts` validates the model's
response against dictionary entries by id, and today the server has the dictionary in memory. After
§2.5 the *client* has the dictionary and the server does not. Either the server keeps its own copy
of the SQLite file (simple, but re-introduces the cold-start and memory problem on the server side),
or the client sends the retrieved entries with the request and receives ids back to render locally —
which changes the `POST /api/ask` contract in PLAN.md §3.4 and moves grounding validation to the
client.

**Recommendation:** send the retrieved entries from the client. The client already has them, it is
the only party that can render them anyway (the grounding rule says hanzi and tone marks are rendered
from cited entries, never from model output), and it is what keeps the **AI proxy** stateless and
dictionary-free — which is the condition §2.2 depends on to claim the 35 MB server load goes away.
**To decide:** write the new request/response contract and check it against every grounding unit test
in `tests/unit/ai/` — those tests encode the rules and will say whether the contract still holds.

**Three further questions live in this section and none of them has an answer yet.**

*Key custody.* If the server holds learners' provider keys encrypted at rest, the design needs a
named scheme: envelope encryption against what master key, held where, rotated how, and what the
breach response is when the answer is "someone else's model bill". Unestablished anywhere in the
audits or the product decisions: **whether the provider's terms of service permit a third party to
store and use end-user API keys on their behalf.** Read them before building custody. The fallback
that needs no custody is one account holding the owner's own key, which is the real situation until
§5.4's distribution experiment happens.

*The sync protocol.* PLAN.md §3.3's schema rules — client-generated UUIDs, `createdAt`/`updatedAt`,
soft delete — are the precondition for sync, not sync. What is replicated, how conflicts resolve, and
whether `Repository` grows a change feed (`changesSince` / `applyRemote`) are all undesigned, and it
is a §7 shared surface. The recommendation, stated so that a build session does not invent something
elaborate: **the review log is append-only and merges trivially; derived card state does not, so
recompute it from the merged log rather than replicating it; and last-write-wins on `updatedAt` is
almost certainly sufficient for everything else** — there are no users, no data, and realistically
one person with two devices. Write that down as the protocol and revisit only when it visibly fails.

*Running cost.* Deliberately unpriced, because it depends on which of the two components lands where.
Do not put a number on the server in any plan until this section closes.

### 5.6 Does the `chars` infix table ship in v1? — **CLOSED by `data.md` D1**

The optional infix table is what makes "which words contain 算" answerable. The app does not do this
today. This record's recommendation was to include it, on the grounds that "show me every word with
this character" is a natural companion to the per-character sheet the product decisions require
(Rule 2: tap a character → its readings, meanings, decomposition, *and the words the learner already
has containing it*), and it left open whether that panel searches the whole dictionary or only the
learner's own words.

**`data.md` D1 closed it: the table ships.** It also removed the reason to hesitate. The naive shape
this section priced — one row per (character, script, entry), 636k rows — costs **+22.4 MB**, not the
+3.9 MB estimated here; the same information as one delta-varint posting list per (character, script)
costs **+1.4 MB**. Both measured. At 3% of the file, and with the schema frozen at the end of D1 —
so the alternative is not "add it later" but "bump `SCHEMA_VERSION` and re-ship 43 MB" — the larger
capability is the cheap side of the trade. The learner's-own-words panel `core.md` C4 builds is an
`allCards()` filter either way; the table is what lets the dictionary-wide variant exist at all.

### 5.7 Indexable per-word pages, and whether the SPA decision survives them

**Status:** §2.2 files this as a remote "what would make this wrong". It is not remote. For a Chinese
dictionary, per-word pages are the primary organic acquisition surface — it is how every incumbent
web dictionary is found — and §2.6 already assumes a marketing site whose job is to be found. If the
condition fires as §2.2 states it, three decisions reverse at once: the SPA with no prerendering
(§2.2), the separate Astro site (§2.6), and part of §2.5, because prerendering word pages puts the
dictionary back on a server.

**There is a middle path this record never evaluated, and it may make the reversal unnecessary.** The
Astro marketing site is already a build-time consumer of the same `pnpm data` output. It can
statically emit `/word/<headword>` pages at the apex domain from the generated dictionary, each
linking into the app, **without the app changing at all**: the SPA stays an SPA, `app.<domain>` stays
uncrawled and gated, and the indexable surface lives where indexable HTML already lives. The licence
rules permit it, with care — `dict.json` is CC BY-SA 4.0 and a public page must carry the attribution
and the modification notice visibly (PLAN.md §5), and `decomp.json` stays off any page that would
merge the two datasets.

**Recommendation:** plan for Astro static word pages and keep the SPA. **The measurement that decides
it** is Astro's build time and output size at that page count: try the full 124,188 headwords, and if
that build is impractical fall back to a curated subset — HSK 1–6 headwords are the natural cut, and
`pnpm data` already bands 11,028 of them. **There is no `data/hsk.json` and nothing generates one**;
the band lives on `Entry.hskBand` inside `dict.json`, and after `data.md` D1 in `entries.hsk_band`
with the `entries_hsk` index over it, so the cut is a query, not a file. Measure before committing;
a static site generator emitting 124k pages is a real build-time question, not a formality. Nothing
in the audits touched it.

**What would make even this wrong:** you want the *app* pages themselves indexed — a word page that
is the live app, not a marketing page that links to it. Then React Router framework mode with
`prerender` is the answer and §2.2 and §2.6 both reopen.

### 5.8 Where the web app is hosted — **SETTLED: Vercel**

`apps/app` is a static SPA build and it ships to **Vercel**, on the **same account as the existing
deployment** described in [`docs/deploy.md`](deploy.md). This was left unowned long enough that
`web.md` W2 had written a fallback around it — commit a placeholder `vercel.json` and record the
gap — and `docs/plans/wave-zero.md` ruling 14 closed it: the fallback is now the decision, taken
deliberately rather than defaulted into.

What it settles and what it does not. It settles where `web.md` W2's host config lands — the SPA
fallback, the manifest content type, the three `/sw.js` headers, and (per wave zero §6) the
dictionary's two rules: the content-addressed `.sqlite` path served `Cache-Control: public,
max-age=31536000, immutable`, and the pre-compressed `.br` under content negotiation. It does **not**
decide where `apps/server` lives — that is `backend.md` B0, inside §5.5, and it is still open. Nor
does it change §2.6: the Astro site is a separate deployment on a separate origin, and being on the
same provider is not being on the same origin. Note that `docs/deploy.md` documents a *Next* app on
Vercel today; most of it (the access gate, the function memory and timeout notes, `pnpm smoke`)
describes routes that §2.2 and `data.md` D6 remove, so it needs rewriting alongside W2 rather than
being followed as-is.

### 5.9 There is no CI, and v1 does not create one — **OPEN ITEM, NO OWNER**

Recorded because two of the build plans were quietly assuming otherwise. There is **no `.github/`
directory** in this repo and **no plan in the set creates one**; every check that says "in CI" today
means "when someone runs it". The rule that a new Postgres table without a row-level-security policy
is a failed migration, the assertion that the Android SDK level is what it claims, the grep that no
signing secret is committed, and the dictionary manifest's sha256 as an integrity check are all
things a pipeline would enforce. In v1 they are unit tests under `tests/unit/` instead — which is a
real guarantee for the ones that can be expressed as a test in this container, and no guarantee at
all for the ones that cannot.

This is an item rather than a decision because it has no recommendation attached and no phase to
attach it to. The two things a build session needs to know are that **writing "asserted in CI" into
an acceptance criterion writes an assertion nobody runs**, and that adding CI later is cheap and
uncontroversial — it is a workspace-level task, not a redesign. The related question of what
replaces `pnpm smoke` and `route-inventory.ts` as the "every route is exercised on a built server"
guarantee is in §7 and is `web.md` W2's; the native half of the same question ("what proves a
Capacitor build works") is answered by both mobile plans as a written manual device checklist, and
that answer is deliberate.

---

## 6. Version pins

Every version below was checked on **2026-09-13**, mostly against the npm registry and crates.io.
Several official sites were egress-blocked during the audits (see known-unknown #12), so anything
marked *(search)* rests on a search summary rather than a primary source. **Re-check every row
before work starts** — these are a starting point for a `pnpm add`, not a lockfile.

### Decided stack

| Package / tool | Version | Date | Notes |
|---|---|---|---|
| `@capacitor/core` | 8.5.2 | 2026-09-11 | **iOS 15+ and the UIScene adoption are now verified** against the shipped artifacts, not a search snippet — podspec, both Xcode templates, the SPM `Package.swift` and the CLI's own `minVersion`, plus `UIApplicationSceneManifest` + `SceneDelegate.swift` in the generated project (`ios.md` I0, HANDOFF.md). **Xcode 26+ is still *(search)*** and `capacitorjs.com` is still egress-blocked. minSdk 24, compile/target 36. Stay on 8.5.x; 9 is at alpha.6. |
| `@capacitor-community/sqlite` | 8.1.1 | Aug 2026 | `copyFromAssets`, read-only connections; bundles SQLCipher (`sqlcipher-android` 4.17.0, `SQLCipher` pod) — reproduce its BSD notice. Original author retired at 6.x; community-maintained. |
| `@capacitor-community/text-to-speech` | 8.0.2 | June 2026 | MIT. `onRangeStart` over `AVSpeechSynthesizer` / `UtteranceProgressListener`. |
| ~~`@capacitor-community/safe-area`~~ | **not installed** | — | **Superseded by Capacitor core, 2026-09-16.** `@capacitor/android@8.5.2`'s built-in `SystemBars` plugin carries the same 140 threshold, the same CSS-variable injection and the Capacitor #8432 keyboard workaround. The community plugin publishes no insets — it is a polyfill, and installing both is two owners of one window. `android.md` A2 configures the built-in one; a unit test refuses this package by name. See §2.1. |
| `@sqlite.org/sqlite-wasm` | 3.53.4-build1 | 2026-09-08 | Apache-2.0; wraps SQLite 3.53.4 (2026-07-24). FTS5 on, `SQLITE_OMIT_LOAD_EXTENSION`. Use the `oo1` API in your own worker — Worker1/Promiser deprecated 2026-04-15. |
| SQLite (upstream) | 3.53.4 stable; 3.54.0 draft targeted 2026-10-15 | 2026-07-24 | The audit's own measurements used Python's SQLite 3.45. |
| `vite` | 8.3.0 | 2026-09-10 | Rolldown became the bundler in 8.0 (2026-03-12). |
| `@vitejs/plugin-react` | 6.1.1 | — | Declares `vite: ^8.0.0` as a peer — this is what pins Vite 8. Already in this repo's devDependencies. |
| `react-router` | 8.3.1 | 2026-08-28 | v8.0.0 shipped 2026-06-17. Requires React >= 19.2.7, Vite 7+, **Node >= 22.22**, ESM-only, `react-router-dom` removed. |
| `astro` | 7.3.2 | 2026-09-08 | Marketing site only. |
| `vite-plugin-pwa` | 1.3.0 | — | Supports Vite 8. Candidate replacement for `scripts/build-sw.ts`. |
| `vitest` | 4.1.11 (keep) | — | Accepts Vite `^6 \|\| ^7 \|\| ^8`. 5.0.0 shipped 2026-09-03 and needs Node >= 22.12; not urgent. |
| `@playwright/test` | 1.63.0 | — | Only `webServer.command` changes. Container Chromium at `/opt/pw-browsers/chromium`; never run `playwright install`. |
| `typescript` | 5.9 (keep) | — | `docs/data-sources.md` records 7.0.2 as the native port. **Stay on 5.9.** |

### Deferred but decided-in-principle (desktop)

| Package | Version | Date | Notes |
|---|---|---|---|
| `tauri` (core) | 2.11.5 | — | **Pin.** The audits disagree: the Android audit saw "Tauri 2 (stable 2.10.1, Mar 2026)" via a search snippet, tauri.app having been egress-blocked for it; the web/desktop audit read core 2.11.5 / CLI 2.11.4 from crates.io. Take the crates.io figure and re-check before any Tauri work. 3.0.0-alpha.0 hit crates.io 2026-09-13 (GTK4 migration). |
| `tauri-cli` | 2.11.4 | — | |
| `tauri-plugin-updater` | 2.11.0 | — | minisign keypair + static JSON on GitHub Releases; signature cannot be disabled. |
| `tauri-plugin-sql` | 2.4.1 | — | Candidate second `Repository` implementation for the desktop shell. |

### Rejected, recorded so the comparison can be re-run

| Package / tool | Version | Date | Why it is here |
|---|---|---|---|
| `electron` | 44.3.0 | 2026-09-08 | Rejected desktop shell (`electron-updater` 6.8.9, Forge 7.11.2). |
| Expo SDK / React Native | SDK 57 / RN 0.86 *(iOS audit)*; SDK 56 / RN 0.85 *(Android audit)* | June 2026 | The two audits disagree — see known-unknown #17. New Arch only since SDK 55. |
| `expo-sqlite` | 57.0.3 | 2026-09-11 | `assetSource: { assetId }` imports a bundled `.db`. |
| `@op-engineering/op-sqlite` | 18.2.1 *(dict audit)* / 17.1.3 *(Android audit)* | 2026-09-07 | JSI synchronous calls, `fts5: true`, `tokenizers`, runtime extension loading. Would be *better* than the Capacitor plugin if RN were the wrapper. |
| Compose Multiplatform | 1.11.0 | — | With `androidx.sqlite:sqlite-bundled` 2.7.0 (FTS5). |
| `jeep-sqlite` | 2.8.0 | 2024-08 | The Capacitor plugin's web path. **Do not use** — sql.js in IndexedDB, unmaintained. |
| `@capawesome-team/capacitor-sqlite` | 0.3.x | — | Technically the best fit (sqlite-wasm + OPFS on web, FTS5, read-only, statically linked custom extensions on iOS) but **sponsorware** — paid Insiders registry. Same for Capawesome's TTS plugin. |
| `wa-sqlite` | GitHub v1.1.2 (Aug 2026); npm stuck at 1.0.0 (2024) | — | Releases are consumed from GitHub, not npm. More VFS variety, 1.3–3.7 MB binaries. The official build suffices for read-only use. |
| `@journeyapps/wa-sqlite` | 2.0.4 | 2026-09-03 | PowerSync's fork. |
| `birchill/nice-sqlite-wasm` | unverified | — | The 10ten Japanese Reader author's trimmed official build, `opfs-sahpool` only. A relevant precedent (a browser dictionary); its README warns it may be obsoleted as upstream moves to WASI. |
| `wangfenjin/simple` | 0.7.1 | 2026-02-23 | MIT/GPL dual. The serious Chinese FTS5 tokenizer: cppjieba optional, pinyin search, iOS xcframework + Android builds. **No WASM.** ~4 s jieba load. |
| `streetwriters/sqlite-better-trigram` | — | — | Public domain, native only. |
| `cwt/fts5-icu-tokenizer` | 7.1.1 | — | MIT, needs system ICU, Linux/macOS only. |
| MiniSearch / FlexSearch / Orama | 7.2.0 / 0.8.212 / 3.1.18 | — | Pure-JS search. All hold the index in memory — today's cost profile with more code. |

### Browser feature floors (sourced)

| Feature | Floor |
|---|---|
| `ruby-align`, `ruby-overhang`, unprefixed `ruby-position` | Safari 18.2 (late 2024); further overhang fixes in Safari 26.x |
| CSS Custom Highlight API | Safari 17.2+ (Baseline 2025), Chrome 105+ |
| `caretPositionFromPoint` (standard) | Chrome 128; WebKit late 2024 behind a flag — see known-unknown #2 |
| `caretRangeFromPoint` (proprietary) | Every WKWebView; ancient in Blink |
| `user-select: none` excluded from copy | WebKit since Safari 16.4 (bug 80159) |
| Line-breakable ruby pairs, `ruby-align` | Chrome 128 (Aug 2024) — only matters for multi-character pairs |
| OPFS sync access handles / `opfs-sahpool` | Safari 16.4+ stated floor; Android WebView minimum unverified |
| `UtteranceProgressListener.onRangeStart` | Android API 26+ |

---

## 7. What this record does not cover

The audits scoped the client. Three areas were not audited and any plan that depends on them is on
its own: **the server** (framework, host, auth, sync protocol, conflict resolution — §5.5), **the
model integration itself** (PLAN.md §3.4 remains the contract; the Anthropic SDK version and model
id are in `docs/data-sources.md` and `.env.example`), and **list import** (clipboard, Pleco
tab-separated export, Anki text export; `addListMembers(listId, entryIds[])` already exists on the
repository, `.apkg` is out of scope).

**List import was deliberately not scheduled for v1, and then it was.** The paragraph that stood
here argued the deferral was a choice rather than an oversight, and that argument still holds on its
own terms: product-decisions §9 specifies the feature fully, the repository already exposed the
bulk-add call it ends in, and none of it touches a schema. What it did not know is that the feature
had **already been written** — `main`'s `abe6793`, 1,654 lines, landed after the migration branch
forked and never ported. `wave-zero.md` §8a records the discovery and the owner's reversal on being
shown it: *"we should keep the list importer."*

It is built. The one thing it needed that this record did not anticipate is a **new member on a
frozen surface** — `DictStore.resolve`, settled in `wave-zero.md` §8b — because `search` ranks
across headwords and pages at fifty, which is right for a person typing and wrong for a paste where
each line needs its own candidates and 打 must not become 打算. So the sentence to carry forward is
narrower than the one it replaces: list import touched no *schema*, but it did open a frozen
interface, and §8b is the record of why that was allowed.

### CLAUDE.md is superseded, and rewriting it is the first task

A fresh session does not read PLAN.md first. It reads **`CLAUDE.md` at the repo root**, which is
auto-loaded as project instructions and therefore outranks this document unless it is changed. Two
parts of it contradict this record directly and must be rewritten **as the first commit of the
migration**, before any build phase runs. What the rewrite has to say is specified in
[`docs/plans/wave-zero.md`](plans/wave-zero.md) §2, which owns it as a wave-0 deliverable; this
section says why:

- **The Commands section is entirely Next-shaped** — `pnpm dev` is `next dev`, `pnpm build` is
  `pnpm data:ensure && next build && pnpm sw`, `pnpm sw` stamps `public/sw.js` from `.next/BUILD_ID`,
  `pnpm lint` is `eslint .` with `eslint-config-next` behind it. §2.2 abolishes all of it, and §2.5
  changes what `pnpm data` emits.
- **The frozen-file list**, which CLAUDE.md states in stronger terms than PLAN.md does — "This is
  what keeps two worktrees from fighting over the same file, so it is not negotiable" — freezes
  `next.config.ts`, `app/layout.tsx`, `app/globals.css`, `components/ui/**`, `lib/db/schema.ts`,
  `lib/db/repository.ts`, `lib/types.ts`, `lib/srs/params.ts`, `components/lookup/lookup-panel.tsx`
  and the config files. Several of those paths stop existing under Vite and most of the rest are
  exactly what this plan changes. **`lib/db/schema.ts` in particular is now editable**: it was frozen
  to protect data that does not exist, and there are no users and no data.

Relaxing the rule is not abolishing the reason for it. It existed to stop parallel builders fighting
over shared surfaces in an overnight build, and that failure mode is unchanged: **shared surfaces
must be settled before parallel work starts.** Rewrite CLAUDE.md with the new command set and a new
settle-first list; do not simply delete the section. Two other CLAUDE.md rules are untouched by any
of this and should survive verbatim: FSRS parameters are built in exactly one place
(`lib/srs/params.ts`), and `HANDOFF.md` is append-only.

### The surfaces that must be settled before parallel work

This table is the origin of `docs/plans/wave-zero.md` §2's settle-first list, and that list is now
the operative one: a shared surface is frozen by a **types-only first commit** in the plan that owns
it, and every other plan gates on that commit rather than on the whole phase. The State column below
names the commit where one now exists.

| Surface | Why it is shared | State |
|---|---|---|
| The `DictStore` interface | Every read path on three platforms goes through it | **Frozen by `data.md` D1's first commit** — the `DictStore` / `SqlRunner` / `DictStatus` declarations, types only. Two implementations: the Capacitor plugin and `sqlite-wasm` in a worker. |
| The SQLite schema — including the segmenter's `meta` table (`logTotal`, `maxLen` per script) and the script-detection flags | §2.5 hard part 5: inverting `segment()` is a schema decision, not a code detail | **Designed and frozen in `data.md` D1**, in the same pass as `DictStore`. `SCHEMA_VERSION` is in the artifact filename, so a later change re-ships the file. |
| The router and the route table | Every screen | React Router 8 data mode (§2.3). |
| The design tokens | Every component, both candidate shells, and the light/dark question in §5.1 | product-decisions §11 fixes the palette; the token layer is what makes a dark palette a swap rather than a second design. |
| **The `TTSProvider` interface** | Two adapters, and every surface with a speaker button (product rule 3) | Must gain `stop()`, boundary events and utterance identity before anything uses it (§2.1). |
| The new `/api/ask` request contract | Client, server, and every grounding test in `tests/unit/ai/` | **Frozen by `backend.md` B2's first commit.** §5.5's recommendation — the client sends the retrieved entries — is the shape it takes. |
| **Repository and workspace layout** | The plan produces three deployables — the Vite app, the Astro site, the server. One repo with workspaces, or three? This is literally the first commit. | **Settled: a single pnpm workspace** (wave zero §1), `apps/app` + `apps/server` + `apps/site` + `packages/ai`, with `data/` and `scripts/` staying at the root because three deployables consume `pnpm data`'s output. Executed by `web.md` W0. |
| **The `pnpm data` → artifact path** | `data/*.json` is generated and gitignored; the plan replaces it with a 43.1 MB SQLite file that has to reach the Capacitor `android/` and `ios/` asset directories, the web host, and (if §5.7 lands) the Astro build — reproducibly, from a step that today writes only to `data/`. `decomp.json`'s delivery (§2.2) rides along with it. | **Settled: `pnpm data` writes only to `data/` and each deployable's build copies out of it** (`data.md` D1). `pnpm data` is never taught about deployables. The web copy and its two host rules — including `decomp.json` — are `web.md` W2's (wave zero §6); the two Capacitor copies are `ios.md` I3 and `android.md` A5's. |
| **The sync protocol** | Client and server both; `Repository` may have to grow a change feed | Undesigned (§5.5); the recommendation there — append-only review log, recomputed card state, last-write-wins on `updatedAt` — is the thing to settle rather than invent per-phase. The **interface** is settled ahead of it: wave zero §5 lands one types-only `Repository` diff carrying both callers' additions at once — `exportAll`/`importAll` for `web.md` W5's local backup, `changedSince`/`applyRemote`/`syncState`/`setSyncState`/`resetAccount` for `backend.md` B5 — and freezes it. |

Two smaller things a build session hits on day one and should not have to decide alone. **Tailwind
4** currently runs through `@tailwindcss/postcss` and `postcss.config.mjs`; the Vite plugin story is
different and nothing here has checked it. And **there is no native test story at all** — Playwright
covers a built web server, `pnpm smoke` is Next-shaped and being rewritten (§2.2), and nothing in
this record says what proves a Capacitor build works. Both halves of that now have an answer.
`pnpm smoke`, `lib/server/route-inventory.ts` and `tests/unit/server/routes.test.ts` are **`web.md`
W2's** to give a final form — smoke as a dependency-free CLI, route-inventory reduced to what the
dev/preview adapter and the coverage check still need, `routes.test.ts` rewritten around the route
table and the host config; `data.md` D6 removes the `/api/dict/*` entries from them and deletes
none of the three (wave zero §3). On native, **both mobile plans say out loud that automated tests
stay web-only** and every native phase ends in a written manual device checklist — so "tested" means
"web only" by decision rather than by silence. What still has no owner is CI itself; see §5.9.
