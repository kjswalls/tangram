# Desktop

**Decision: Tangram's desktop product is the installed PWA, from the same `dist/` the web and the
phones ship. There is no desktop build, no second codebase and no Rust toolchain, and there will not
be one until the trigger in §3 fires.**

This page is written so it can be read alone. If you have arrived here to decide whether to build a
Tauri shell, §3 is the decision and §4 is what it costs; everything else is the evidence.

The decision record behind it is [`STACK.md`
§2.4](STACK.md#24-desktop-shell-installed-pwa-now-tauri-2-later-never-electron); the owner's ruling
that split the two shells is [`plans/wave-zero.md` §10c](plans/wave-zero.md); the phase that wrote
this page is `plans/web.md` W9. Where this page and those disagree, they were written first and
govern.

---

## 1. What "the installed PWA" means, concretely

`pnpm build` emits `apps/app/dist/` — static files, no framework runtime. A browser on macOS,
Windows or Linux installs that (Chrome and Edge: the install icon in the address bar, or ⋮ →
*Install Tangram*; Safari 17+: *File → Add to Dock*). What the learner gets:

| | Installed PWA |
|---|---|
| Standalone window, no browser chrome | yes |
| Dock / taskbar / Start-menu icon | yes |
| Offline operation | yes — the service worker (`scripts/sw.template.js`) plus the dictionary in OPFS |
| Keyboard-first navigation | yes — the grading keys; **no command palette**, see below |
| A better storage regime than a tab | **claimed, not verified — see §6** |
| **A global hotkey — summoning the app when it is not focused** | **no. Not in any browser, on any platform, in 2026.** |

That last row is the whole of the desktop question. Chromium has had an open issue for global
shortcuts since forever (40749250) and a browser tab cannot register one. Everything else a desktop
wrapper is usually bought for, the installed PWA already has.

**So this is a sequencing decision, not a capability judgement**, and it gets misread as the latter.
The product the owner has described — a Raycast-style command palette that *is* the home screen — is
not a browser-tab product: a palette's entire point is being summoned, summoning is the global
hotkey, and the hotkey is the one thing only a native shell can register. `wave-zero.md` §10c
settles the split: **wide-screen web gets the page shell; the desktop application gets the palette,
and the desktop application is deferred.** Until a native shell ships, do not describe the installed
PWA as a differentiated desktop product. It is the same app, wider, and that is a perfectly good v1.

---

## 2. What is not being bought, ever

**Electron.** 85–120 MB of download and 150–250 MB of idle memory to ship one Chromium, for an
application whose entire UI is text, fonts and keyboard handling — which all three system engines
render well. The offline dictionary makes download size and memory matter *more* here than in a
typical app, not less. Recorded so the comparison can be re-run rather than re-argued: `STACK.md` §6
keeps the `electron` row (44.3.0) with the rest of the rejected stack.

---

## 3. The trigger

**Build a Tauri 2 shell when all three of these are true.** They are conditions you can check, not a
mood. In practice condition 1 is the one that fires — per `wave-zero.md` §10c, the trigger is
*someone asks for the global hotkey* — but two and three are what make the ask affordable, and a
shell built while either is false is a shell that gets abandoned.

### Condition 1 — the hotkey has been *missed*, by someone, for a week

**The check.** The page shell has been the owner's actual study surface for **seven consecutive days
with a review session in each** — which is a fact, not an impression: Library's progress panels are
drawn from the review rows, and `repository.allReviewsChronological()` is what holds them. Over that
week, reaching for a summon key while Tangram was **not** the focused window happened **at least
once a day** and was noticed as an absence.

**Why it is written that way.** `STACK.md` §5.1 sets the test as "use the page shell for a week of
real study and see whether reaching for Cmd+K is a reflex". A reflex is observable: you press
something and nothing happens. One frustrated week beats any amount of reasoning about whether a
palette would be nice — and note what is *not* being measured: a palette that is only summonable
from inside the app is a search box with ambitions, and it is `core.md` C9's to build either way.
What decides this page is reaching for the key when the app is **not** in front of you.

**Keep a tally as it happens.** A week of "did I reach for it?" is not reconstructable afterwards;
one line in a note each time is the whole instrument.

**What does not count:** wanting the app to feel more native; a desire for a dock icon (you have
one); disliking the browser's install flow. None of those is the hotkey, and none of them is worth
§4's bill.

### Condition 2 — the bill is accepted, by name, before the first line of Rust

**The check.** Someone can answer all four of these with a name or a number:

1. **~$120/year marginal**, and it is budgeted. That is Windows Azure Artifact Signing at
   ~$9.99/month (individuals accepted in the US and Canada since the three-year-history rule was
   dropped in April 2026; without it SmartScreen warns every downloader until reputation builds).
   Apple's $99/year Developer Program is **already spent** by the App Store decision in `STACK.md`
   §2.1 and is *not* a cost of this decision. Linux signing costs nothing.
2. **Who owns a three-target release pipeline.** macOS, Windows and Linux, each built and signed on
   its own runner. Note what this repository does not have: **there is no CI here at all, and no
   plan in the set creates one** (`STACK.md` §5.9 is an open item with no owner). A Tauri shell is
   the first thing in this project that cannot be released by one person running one command on one
   machine.
3. **Who tests three rendering engines.** WebView2 on Windows, WKWebView on macOS, WebKitGTK on
   Linux — the last with known NVIDIA/DMA-BUF glitches. Today the web build is tested against one
   engine in the container and whatever the learner has.
4. **Who owns an update channel that can never be broken.** `tauri-plugin-updater` wants a minisign
   keypair and a static JSON manifest on GitHub Releases, and **the signature cannot be disabled**.
   Lose the private key and every installed copy is stranded on the version it has.

Write the four answers into `HANDOFF.md` under a dated heading before scaffolding `src-tauri/`. For
a solo owner "who owns it" answers itself, which is exactly why it has to be written down rather
than assumed: the point of the condition is that the answer was *given*, not that it was obvious.

### Condition 3 — the primary desktop is not Linux/Wayland

**The check.** On the machine this shell is being built *for*, `echo $XDG_SESSION_TYPE`. If it
prints `wayland`, stop: **Tauri buys nothing over the installed PWA there.** The global hotkey does
not exist in any shell on Wayland — it is a protocol gap, not a Tauri bug (tauri #3578) — so
condition 1's entire justification evaporates and you would be paying §4's bill for a dock icon you
already have.

macOS and Windows are fine. X11 is fine.

---

## 4. If the trigger fires: what the work actually is

**A packaging job, not a porting job — and that is a property this repository maintains on
purpose.** `dist/` is shell-agnostic: no absolute-origin assumption anywhere in the app or its
assets, no browser-only API on the critical path, and the API base configured at build time
(`VITE_API_BASE`). A Tauri shell serves that same directory from the root of `tauri://localhost/`,
exactly as Capacitor serves it from `capacitor://localhost/` on iOS and `http://localhost` on
Android, and exactly as the web serves it from an apex. The default build's `base` is `'/'` for that
reason and must stay `'/'` (see `apps/app/vite.config.ts`, and `web.md` W1 for why a relative base
and history routing are mutually exclusive).

**That property is a standing check, not a promise.** `apps/app/tests/e2e/d/origin-agnostic.spec.ts`
runs in `pnpm e2e` at every phase gate: it serves the default build from a second port and boots it,
then builds once more with `--base=/sub/`, serves that output behind a `/sub/` prefix and boots
that. The subpath build is the sharper half — it catches any path the app assumes is at the document
root.

**Four things are rooted at `/` by construction, and that is a documented boundary rather than
something to pretend about.** A real subdirectory deployment would have to parameterise all four:

- `components/pwa/register-sw.tsx` — `SW_URL` is `/sw.js`, registered with `scope: '/'`.
- `scripts/sw.template.js` **and** `scripts/build-sw.ts` — the worker's five path rules, its
  `/offline.html`, its `cache.match('/')` document fallback, and `precacheList()`'s
  `['/', '/offline.html', '/<hashed asset>']`.
- `public/manifest.webmanifest` — `id`, `start_url`, `scope` and all five `icons[].src`. It is
  copied verbatim, so a `--base` never reaches it; `tests/unit/pwa/manifest.test.ts` pins those
  fields.
- `apps/app/vercel.json` — every `source` is `/`-anchored, the `no-cache` on `dict-manifest.json`
  and the `immutable` on the artifact included. **This is the one with a user-visible
  consequence:** under a prefix those rules match nothing, so the pointer at a 43 MB
  content-addressed file becomes cacheable — which is precisely the failure the rule exists to
  prevent — and the artifact loses its immutable caching and is re-downloaded.

None of it reaches a native shell (the worker is deliberately **not** registered inside one, no
native shell reads a web manifest, and `vercel.json` is the web host's), and none of it affects a
root deploy, which is the only web deploy this project has. The standing check therefore allows
`/sw.js` by name and asserts that nothing *else* escapes the prefix, so a genuinely new
root-absolute path fails the suite rather than hiding behind these four.

**And the job itself, so it can be sized rather than only priced.** Almost none of it is application
code, which is the point of everything above — in rough order: scaffold `src-tauri/` and point it at
the existing `dist/`; generate a minisign keypair, escrow it somewhere that outlives a laptop, and
stand up the updater's static JSON manifest; get three targets producing signed artifacts (macOS
Developer ID plus notarisation, Windows through the signing account condition 2 budgets for, Linux
unsigned); settle store versus direct download on macOS once register #14 is answered (§6); and —
the one real piece of code — a second `Repository` on `tauri-plugin-sql` if Hazard 1 is taken
seriously, which §5 says it should be. The palette is **not** on this list: it is `core.md` C9, it
is deferred along with the shell, and it is the *reason* the shell would be built rather than part
of building it.

**Pinned versions.** Checked 2026-09-13 by the audit behind `STACK.md` §6, and **re-checked against
the npm registry on 2026-09-18** for the three that publish there:

| | Version | Re-checked 2026-09-18 |
|---|---|---|
| `tauri` (core) | **2.11.5** | **not re-checkable here — crates.io answers 403 through this container's proxy.** The audit read it from crates.io; a second audit saw 2.10.1 via a search snippet. Re-check before you start. |
| `tauri-cli` | **2.11.4** | corroborated — its npm distribution `@tauri-apps/cli` is at 2.11.4 (published 2026-06-28) |
| `tauri-plugin-updater` | **2.11.0** | corroborated — the JS side, `@tauri-apps/plugin-updater`, is at 2.11.0 (2026-08-31) |
| `tauri-plugin-sql` | **2.4.1** | corroborated — the JS side, `@tauri-apps/plugin-sql`, is at 2.4.1 (2026-08-31) |

The right-hand column is **corroboration, not the crate**: the npm packages are the CLI's
distribution and the plugins' JavaScript halves, and their versions track the crates rather than
being them. It is the strongest check this container can run, and it is worth having precisely
because §6's whole point is that a fact from a search summary is not a fact.

**Pin 2.x, and mean it.** Tauri **3.0.0-alpha.0 hit crates.io on 2026-09-13**, driven by a GTK4
migration; on 2026-09-18 the npm `next` tag had already moved to **3.0.0-alpha.1** for the CLI. An
alpha that is moving weekly is not a thing to track, and a GTK4 migration is exactly the kind of
change that strands a Linux build. The risk of pinning is the mirror image and is worth stating:
**if Tauri 3 stabilises quickly, 2.11.x leaves you on an old GTK path on Linux** — which is the one
scenario that would make this whole decision wrong in the other direction.

---

## 5. The two storage hazards

A desktop shell does not automatically make the learner's data safer. Two things are on record and
both must be handled at the time the shell is built, not discovered afterwards.

### Hazard 1 — a Tauri upgrade can orphan the database (tauri #11252)

**The IndexedDB directory path changed between Tauri 1 and Tauri 2 and users lost data.** That is
the one concrete, reported storage failure in the whole desktop record. Two consequences:

- **Pin the Tauri version** (§4) and treat a major upgrade as a data migration with a tested path,
  not a dependency bump.
- **The conservative answer is not to depend on the WebView's IndexedDB at all.** Write a second
  `Repository` implementation on `tauri-plugin-sql` (native SQLite). `lib/db/repository.ts` is an
  interface with exactly one implementation today (`lib/db/dexie.ts`) and it exists for this: every
  row keys on a client-generated UUID, every row carries `createdAt` / `updatedAt` / nullable
  `deletedAt`, and everything above the db layer talks to the interface. A second implementation is
  the swap that seam was designed for, and it is the reason a desktop shell is not a rewrite.

### Hazard 2 — nobody has verified what the desktop WebViews actually promise

What is on record is thin and none of it is primary:

- WKWebView is said to keep its own ITP interaction counter that **resets each launch**, so Safari's
  seven-day cap would not bite a desktop app — ***a secondary source***.
- WebView2 is said to follow Chromium's ordinary quota rules — same standing.
- Whether `navigator.storage.persist()` is honoured inside either shell has been run by **nobody**.

So: **do not design a desktop shell on the assumption that native storage is durable.** What *is*
durable, and does not depend on any of the above, is the export/import backup that `web.md` W5
already shipped (`Repository.exportAll()` / `importAll()`, surfaced on Library). It stays the answer
for a desktop shell too — and if the shell holds its rows in `tauri-plugin-sql` per Hazard 1, the
question mostly stops mattering.

---

## 6. The hedge, which is the part not to drop

**The storage advantages claimed for an installed web app in §1 are not verified, and this page is
the one a reader quotes when deciding desktop scope.** State them the way they are:

- *"A web app added to the Dock or Home Screen is exempt from Safari's seven-day ITP cap and gets
  the browser-level quota."* — **sourced from a search summary. webkit.org was egress-blocked when
  the audit ran (`web.md` R1), and it has not been read since.**
- *"In Chromium, an installed origin that calls `persist()` is effectively safe from LRU eviction."*
  — **same provenance: a search summary, MDN egress-blocked.** It is also **conditional on the
  `persist()` call**, which `src/pwa/persist.ts` makes on the first real interaction: an installed
  app that never calls it is not covered by the claim even if the claim is true.
- **`STACK.md` register #13 — whether `persist()` is honoured in Safari for a non-installed site —
  is still unrun**, because it needs a Mac with real Safari and this container has none. The app's
  own copy already assumes the worst for that case: `storageRisk()` in `src/pwa/persist.ts` returns
  `at-risk` for a **non-installed WebKit tab that holds cards** at every state except `persisted`,
  where the browser has actually promised and there is nothing left to warn about, and
  `tests/unit/pwa/persist.test.ts` pins both branches. A pessimistic default is the right default
  and it is not evidence.

`web.md` W5 carries this hedge for the same reason and in the same words. **Do not soften either
half into a fact, and do not let "installed is safer" become a reason to skip the backup.** What is
actually known is that an installed app is *no worse* than a tab, and that the local export works.

**Register #14 is the other unrun one and it decides distribution, not scope:** whether the Mac App
Store sandbox permits `RegisterEventHotKey`-based global shortcuts through Tauri's plugin. If it
does not, a Tauri shell on macOS is **direct-download only** — which is a signing, notarisation and
update-channel story rather than a store listing, and it changes condition 2's fourth bullet from
"nice to have" to "the only way anyone gets an update". Check Apple's sandbox entitlement
documentation and Tauri's plugin implementation *together*, and check it **before** building, not
after.

---

## 7. Outstanding: verify the installed PWA on a real desktop *(owner)*

**This has not been done and cannot be done here.** This is a headless Linux container: it has
Chromium for Playwright and no desktop browser session, no installed-app surface and no Safari. A
Playwright run can prove the app boots, that the service worker registers and serves a navigation
offline, and that the code path calling `persist()` ran — `tests/e2e/p6/pwa.spec.ts` and
`tests/e2e/c/sw-offline.spec.ts` between them do all of that — and **none of it is an installed
application in its own window.** Do not let a green e2e run stand in for this.

**What the owner must do**, once, on a real desktop machine:

1. Serve a production build over `https:` (or `http://localhost` — a secure context either way) and
   open it in Chrome or Edge.
2. Install it: the address-bar install icon, or ⋮ → *Install Tangram*. On macOS Safari, *File → Add
   to Dock*.
3. Quit the browser entirely. Launch Tangram from the Dock / taskbar / Start menu.
4. Use it: look a word up, get the dictionary, start a practice session, grade a card.
5. Turn the network off — Wi-Fi off, or DevTools → Network → Offline. Quit the app and relaunch it,
   then, still offline, look a word up and run a practice session to completion.
6. In DevTools (⋮ → *More tools* → *Developer tools* inside the installed window), run `await
   navigator.storage.persisted()` and `await navigator.storage.estimate()`.

**A pass is all five of these:**

- The app installs and appears as its own application in the Dock / taskbar / Start menu.
- It opens in a **standalone window with no browser chrome** — no address bar, no tab strip.
- Offline, after that warm load, **a relaunch still renders the app** and a practice session runs to
  completion: cards appear, a grade is accepted, the next card comes up. Not the offline page.
- The dictionary still answers a lookup offline (it is in OPFS, not the network).
- `persisted()` returns a value **and you write down which** — `true` or `false` — together with
  `estimate()`'s quota, the OS, the browser and its version.

**Record the result in `HANDOFF.md`** under a dated heading, including a `false` from `persisted()`:
that is a real data point about a real installed app on a real platform, and this project has
exactly zero of those today. If the app does **not** get a standalone window, or an offline relaunch
shows the offline page rather than the app, that is a web-shell defect and belongs in a phase, not
in this file.
