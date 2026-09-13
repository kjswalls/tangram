# Tangram — build plan: the web shell

**Status:** plan, written 2026-09-13. Sibling plans: [`data.md`](data.md), [`core.md`](core.md),
[`ios.md`](ios.md), [`android.md`](android.md), [`backend.md`](backend.md).

**Read first:** [`docs/STACK.md`](../STACK.md) is the decision record this plan implements and it is
not re-argued here — where this plan says "because §2.2", go and read §2.2. [`PLAN.md`](../../PLAN.md)
remains authoritative for the data contract (§3.1), the schema rules (§3.3), the grounding contract
(§3.4) and the licence boundary (§5). The product decisions taken with the owner supersede PLAN.md's
UI wherever they conflict.

Two facts frame everything below and are not repeated: **there are no users and no data** (nothing
here is a migration plan, and moving the app to a new origin costs nothing because nothing is stored
on the old one yet), and the builder is **one person with AI assistance**.

---

## 1. Goal

When this plan is done, `pnpm build` produces a directory of static files — no Node server, no
framework runtime — that a browser installs as a PWA, that Capacitor wraps on both phones, and that
Tauri could wrap on desktop without changing a line of application code. The four Next features this
repo actually uses each have a named home: the access gate moves onto the API server as a header
check, the custom headers become host configuration with a test that catches their disappearance, the
POST handlers move or are deleted, and the service worker's cache name is stamped from a hash of
Vite's own output instead of `.next/BUILD_ID`. Marketing lives on a different origin from the
learner's flashcards, permanently. None of that is true now: today the app is Next 16.3.4, its
service worker cannot be stamped with a real build id without `.next/BUILD_ID`, and its offline
story is a browser tab whose storage Safari's seven-day ITP cap can clear.

## 2. Scope boundaries

**This plan owns:**

- The build: Vite 8, `index.html`, the client entry, Tailwind 4 under Vite, `tsconfig`, `eslint`,
  `engines.node`, and the pnpm workspace layout that holds three deployables.
- The router: React Router 8 in data mode, the route table, and every replacement for `next/link`,
  `usePathname`, `useRouter` and the two server-shaped pages.
- The destinations of the four Next casualties and the fifth (`lib/server/route-inventory.ts` and
  `pnpm smoke`), listed route by route in §3.
- The service worker: its generation, its build stamp, its cache policy under hashed Vite assets,
  and `public/offline.html`.
- The PWA: the manifest, the install affordance, `navigator.storage.persist()`, and the local export
  that makes an evicted origin recoverable.
- Web font delivery — `unicode-range` subsets, self-hosting, and the first-load budget as one number
  (`core.md` names the families and runs the coverage check; this plan decides how bytes arrive).
- The Astro marketing site and the two-origin split.
- Test carry-over: `vitest.config.ts`, `playwright.config.ts`, and the replacement for the
  route-inventory/smoke machinery.
- The **routing and keyboard layer** of the wide-screen shell: the URL model, the shortcut registry,
  focus and scroll restoration on navigation, the in-app Cmd+K binding, and the honest statement of
  what a browser cannot do.
- The desktop question: the installed PWA as the v1 desktop product, and the written trigger for a
  Tauri shell.

**This plan does not own, and must not start:**

| Not here | Owner | Why the seam is where it is |
|---|---|---|
| The SQLite dictionary, `DictStore`, the OPFS worker, the `pnpm data` artifact path, `decomp.json` delivery | `data.md` | This plan makes a build that can ship a large binary asset and a worker; it does not decide what the asset is. The one hard coupling is that the service worker must **not** cache the dictionary (§5, W3). |
| Design tokens, `components/ui/**`, screens, per-character ruby, drag-select, `TTSProvider`, the palette's *components* | `core.md` | This plan routes to screens and hands them a `navigate` boundary; it never renders one. The palette is a mode over `core.md`'s screens; this plan supplies the URL and the keys. |
| Capacitor projects, native plugins, the Android hardware back button, fonts inside an app package | `ios.md`, `android.md` | Those plans consume this plan's `dist/`. This plan owes them a build with no absolute-origin assumption — it boots from the root of `capacitor://localhost` or `tauri://localhost` as readily as from an apex — and a `navigate` boundary they can drive. |
| The server itself — framework, host, auth, sync, key custody, the new `/api/ask` request contract | `backend.md` | This plan owns only the *transport*: the configured API base, credentials mode, and the gate's client half. What is behind the base URL is not its business. |
| List import (clipboard / Pleco / Anki) | its own task, per STACK §7 | Scoped separately by product-decisions §9. |
| The seven-route → three-tab collapse (product-decisions §1) | `core.md` C7 | C7 says it plainly: "`web.md` wires the route table; this plan defines the tabs", and "the migration is a C7 commit, not a C7 side effect". W1 creates `src/routes.tsx` with today's eight routes because W1 must keep today's suite green; **C7 edits that file** to three. See the note below. |
| The `Repository` interface (`lib/db/repository.ts`) | settle-first shared surface, orchestrator | No sibling plan claims it and CLAUDE.md freezes it. W5 and `backend.md` B5 both need it widened, so W5 states the exact addition it needs and takes it through the frozen-file route (§5, W5). |

**`src/routes.tsx` is this plan's file and `core.md` C7 changes it. Two consequences that must not be
discovered later.** W2's smoke cases and W3's `SHELL`/precache list are both *derived* from the route
table rather than copied from it — that is the discipline that made `PAGE_CASES` read `NAV_ITEMS`
today — so the collapse re-derives them for free. What it does **not** do for free is re-run them:
after C7 lands, W2's per-route DOM markers and W3's precache assertions are about three routes and
nobody has watched them pass. **C7's commit re-runs `pnpm smoke` and the W3 service-worker specs, and
records the result in `HANDOFF.md`.** W2 and W3 say so at the point the assertion is written.

**One thing this plan decides that STACK §2.2 explicitly left open: sequencing.** STACK §2.2 says the
Vite move and the SQLite move both touch `lib/dict/**` and `app/api/dict/**`, that nothing has
decided which lands first, and that the build plan must decide it explicitly. **Vite lands first.**
Three reasons. Everything after it is built on the new build system, and `core.md`'s own dependency
table says its C1 cannot start without a Vite + React Router skeleton. `@sqlite.org/sqlite-wasm` in a
dedicated worker with a `.wasm` asset is a bundler integration, and doing it twice — once against
Turbopack, once against Rolldown — is the only way to pay for it twice. And the argument for
dictionary-first (it deletes five routes the migration would otherwise carry) evaporates because of
W1's dev/preview API adapter: the ten existing handlers in those eight route files already take a
standard `Request` and return a standard `Response` (four of them a `Promise<Response>` — §3), so
carrying them across costs a plugin, not a rewrite.

## 3. What exists today

Read at `HEAD` of `claude/apps-ui-design-791zpq`. Everything below is a fact from the repo, not a
recollection.

**The build.** Next 16.3.4 with the App Router, React 19.2.8, Tailwind 4 through
`@tailwindcss/postcss` and `postcss.config.mjs`. `pnpm build` is
`pnpm data:ensure && next build && pnpm sw`. `engines.node` is `>=20.9`; `.nvmrc` says `22`; the
container is on **v22.22.2**. `@vitejs/plugin-react` **6.1.1** is already a devDependency (vitest uses
it) and declares `vite: ^8.0.0` as a peer. **Vite 8.2.2 is therefore already installed** — as a
resolved peer of `vitest@4.1.11`, `@vitest/mocker@4.1.11` and `@vitejs/plugin-react@6.1.1`
(`node_modules/.pnpm/vite@8.2.2_…`, and `pnpm-lock.yaml:71`) — it is simply not a *declared*
dependency. W1 declares it, and if it declares STACK §6's pinned 8.3.0 that is a **Vite bump for
vitest as well as a new build system for the app**, since one resolution serves both. `pnpm test` is
the first thing to run after that install, before any router work.

**The routes.** Eight page files under `app/`: `(today)/page.tsx`, `lookup`, `read`, `review`,
`lists`, `lists/[id]`, `stats`, `settings`. `app/layout.tsx` composes `SiteHeader`, `DataBanner`,
`TestHooks`, `RegisterServiceWorker` and a `<main>` wrapper, and declares `metadata` (title,
description, `manifest`, `appleWebApp`) and `viewport` (`themeColor: '#0f766e'`).

Two pages are genuinely server-shaped and both need a destination:

- `app/settings/page.tsx` is `export const dynamic = 'force-dynamic'` and `readFile`s
  `<dataDir()>/ATTRIBUTION.md` per request, because `TANGRAM_DATA_DIR` can relocate `data/` and the
  build cannot know where. It renders through `app/settings/attribution.tsx`, a hand-written
  Markdown renderer. CLAUDE.md requires the attribution to be rendered in `/settings`; this must not
  regress.
- `app/lists/[id]/page.tsx` awaits `params` for the list id and passes it to `ListDetail`.

Everything else under `app/` is a thin server component wrapping a `'use client'` component. There
are 41 files carrying `'use client'`.

**The `next/*` surface is small — nine files, eleven import sites.** `next/link` in
`components/shell/site-header.tsx`, `components/shell/nav-link.tsx`,
`components/review/review-session.tsx`, `components/lookup/entry-detail.tsx`,
`components/lists/list-detail.tsx`, `components/lists/list-card.tsx`, `app/settings/settings-form.tsx`
and `app/(today)/today-view.tsx`; `usePathname` in `nav-link.tsx`; `useRouter` in `list-detail.tsx`
(one call, for a post-delete navigation); the `Metadata`/`Viewport` types in `app/layout.tsx`.
`tests/unit/deps.test.ts` imports `next/server` as the `next` package's proof-of-load.
`components/pwa/register-sw.tsx` is the only client file reading `process.env` (`NODE_ENV`).

**The API.** Eight route *files* exporting **ten handlers**, all taking a Web `Request` and none
importing anything from `next/*` (`grep -rn "from 'next" app/api/` returns nothing). The shapes are
not uniform and the adapter's type depends on it: **four are `async` returning `Promise<Response>`**
(`ask` POST, `examples` POST, `recall` POST, `dict/segment` POST) and **six return `Response`
synchronously** (`ask` GET, `examples` GET, `dict/search` GET, `dict/entries` GET, `dict/decomp` GET,
`dict/hsk` GET). `ask` and `examples` each export both verbs, so a dispatcher must key on method.
Five files are dictionary routes (`dict/decomp`, `dict/entries`, `dict/hsk`, `dict/search`,
`dict/segment`); three reach a paid model (`ask`, `examples`, `recall`). Nine files carry
`export const dynamic = 'force-dynamic'`. `lib/dict/client.ts` is the typed fetcher: same-origin
relative paths, with an optional `baseUrl` for server and test callers, and a `DictRequestError`
whose `dataMissing` flag drives the banner.

**One handler is reached by a verb nobody exports.** `components/shell/data-banner.tsx:19` probes
`/api/dict/hsk?band=1` with `{ method: 'HEAD' }` and reads only the status; its comment says "Next
answers it from the same route handler". No route file exports `HEAD` — Next derives it from `GET`.
Anything replacing Next in front of these handlers has to derive it too, or the missing-data banner
silently stops working and the failure looks like a data problem.

**The gate.** `middleware.ts` does two things: it trades `?key=<secret>` for an `HttpOnly` cookie on
any route and redirects with the key stripped out, and it refuses unauthorised requests to
`GATED_PATHS` (`/api/ask`, `/api/examples`, `/api/recall`) before a handler runs. `lib/server/access.ts`
is the other half and **imports nothing from `next/*`** — its own header says so, deliberately, so
that middleware, handlers and unit tests run the same code. Its header also states the reason the
credential is a cookie: *"The owner tests on a phone, and a phone browser cannot set a request
header."* With `TANGRAM_ACCESS_SECRET` unset the gate does not exist, which is what keeps `pnpm dev`,
`pnpm test` and `pnpm e2e` unchanged.

**The config.** `next.config.ts` has exactly two blocks: `outputFileTracingIncludes` with four glob
keys (`/api/dict/**`, `/api/ask/**`, `/api/examples/**`, `/api/recall/**`) that ship `./data/**` into
the eight route bundles, and `headers()` with two entries —
`application/manifest+json; charset=utf-8` for `/manifest.webmanifest`, and
`text/javascript; charset=utf-8` + `no-cache, no-store, must-revalidate` +
`Service-Worker-Allowed: /` for `/sw.js`.

**The service worker.** `scripts/sw.template.js` is the committed source; `scripts/build-sw.ts`
writes `public/sw.js` from it, substituting `__TANGRAM_BUILD_ID__` with `.next/BUILD_ID` (or the
literal `dev` when there is no build), refusing any id that is not `[A-Za-z0-9_-]{1,64}`. `public/sw.js`
is gitignored. The worker's policy is three ordered rules: `/api/**` returns before `respondWith`
(never cached), `/_next/static/**` is cache-first with no revalidation, and navigations are
**network-first** with the per-route cached copy then `/offline.html` behind them. Its header
explains why network-first is load-bearing: a cached document references hashed chunks a new
deployment no longer serves. `SHELL` precaches the seven nav routes plus `/offline.html`.

**The PWA.** `public/manifest.webmanifest`: `id`/`start_url`/`scope` `/`, `display: standalone`,
`theme_color: #0f766e`, `background_color: #fbfaf7`, `lang: "en"`, a `categories` array, and **five
icon entries over three files** in `public/icons/` (`tangram.svg`, `tangram-192.png`,
`tangram-512.png`), **two of them `purpose: maskable`** (the SVG and the 512 PNG). The two colour
fields and `lang` matter because product-decisions §11 replaces the palette and `core.md` C0 rule 2
sets `lang="zh-Hans"` on the document — W5 edits the colours, and `tests/unit/pwa/manifest.test.ts`
asserts both are `#rrggbb`.
`components/pwa/register-sw.tsx` registers in production only and actively unregisters any worker it
finds in development. **There is no install prompt handling and no `navigator.storage.persist()` call
anywhere in the repo** — HANDOFF.md records install and offline as unverifiable in this container.

**The harness.** `lib/server/route-inventory.ts` walks `app/api/**/route.ts` and each route's import
graph to answer "does this route reach `lib/dict/load.ts`, and is it covered by a tracing key";
`tests/unit/server/routes.test.ts` imports `@/next.config` and turns the answer into a failing test;
`scripts/smoke.ts` derives its page cases from `NAV_ITEMS` and its coverage check from
`discoverApiRoutes`. `tests/e2e/d/smoke.spec.ts` runs the same `runSmoke` against the built server.
`tests/e2e/c/sw-version.spec.ts` reads `.next/BUILD_ID` off disk. `tests/e2e/d/access-gate.spec.ts`
spawns a second `node_modules/.bin/next start` on `PORT + 100` with the secret set.
`playwright.config.ts` runs `pnpm build && pnpm start -p $PORT` and pins Chromium at
`/opt/pw-browsers/chromium`. `vitest.config.ts` already uses `@vitejs/plugin-react` and the `@` alias.

**Two harness facts that decide phases below.** First, **`next build` is the only thing in this repo
that typechecks.** `pnpm lint` is `eslint .` over `eslint-config-next/typescript`, which is not
type-aware; there is no `typecheck` script in `package.json`; Vite and Rolldown do not typecheck.
Remove `next build` and type errors ship silently from that commit onward. Second, two specs are
written against Next file conventions and Next-supplied headers and will break in W1:
`tests/unit/pwa/manifest.test.ts` asserts `existsSync(<root>/app/apple-icon.png)` (line 46) and reads
`app/layout.tsx` for `manifest: '/manifest.webmanifest'` (line 66); `tests/e2e/p6/pwa.spec.ts`
asserts `content-type: application/manifest+json` on the manifest and `cache-control: no-cache` on
`/sw.js` — the two `next.config.ts` `headers()` entries.

**Marketing.** There is none. No landing page, no apex content, nothing to migrate. §2.6's "separate
deployment" is therefore not a split of anything — it is a decision about origins taken at the only
moment it is free.

## 4. Dependencies

| Needs | From | State it must be in |
|---|---|---|
| CLAUDE.md rewritten with the new command set and settle-first list | orchestrator, STACK §7 | **Before W0.** Today's CLAUDE.md documents `next dev`, `next build`, `.next/BUILD_ID` and a frozen-file list containing `next.config.ts` and `app/layout.tsx`. It is auto-loaded project instruction and outranks this plan until it changes. |
| Nothing at all from `data.md`, `core.md`, `ios.md`, `android.md` or `backend.md` | — | W0–W3 are pure build-system work in the Linux container. STACK §4 is explicit that everything web and desktop proceeds without a Mac or a phone. |
| The dictionary artifact's name and extension | `data.md` | **Before W3 ships.** The service worker must be told, by rule, never to cache it; a 15 MB brotli file in the HTTP cache *and* in OPFS is the same bytes twice. |
| `DictStore` readiness signal replacing the `/api/dict/hsk` HEAD probe | `data.md` (this is `core.md`'s R11) | **Not a blocker for any phase here.** Until it exists, W1's adapter must derive `HEAD` from `GET` or the banner breaks; W2 asserts that (criterion 5). When `data.md` replaces the probe, W2's banner criterion moves with it. |
| **The static host for `apps/app`** | orchestrator / `backend.md` | **Before W2 starts.** W2 writes and unit-tests that host's config file — its name, schema and SPA-fallback syntax all follow from the choice, and there is nothing to parse until it is made. If the choice is still open when W2 comes up, commit `vercel.json` (what `docs/deploy.md` describes today) as a placeholder, make the parse test host-specific, and write both facts into `HANDOFF.md` so W7's second deployment does not inherit a guess as a decision. |
| An addition to `lib/db/repository.ts` for whole-database export/import including tombstones | orchestrator (settle-first surface; CLAUDE.md freezes the file) | **Before W5's round trip.** The interface today has no tombstone-visible read and no dump/restore, so the criterion cannot be met through the seam without it. W5 names the exact addition; `backend.md` B5 widens the same file for the change feed, so one of the two goes first and the other rebases. |
| The API base contract: origin, credentials mode, and where `lib/server/access.ts` lives | `backend.md` | **W4 defines the client half against the dev/preview adapter and hands the server half over.** W4 can complete without `backend.md` having started; it cannot be *deleted* until `backend.md` implements the same module. |
| `core.md` C0's font-coverage numbers | `core.md` | Before W6. The budget cannot be stated without them. |
| `core.md` C7's shells and screens, and its three-tab collapse of `src/routes.tsx` | `core.md` | Before W8. W8 routes to screens that must already exist and must already be shell-agnostic, and its URL model is the three-tab one. C7's commit re-runs W2's smoke and W3's worker specs against the collapsed table. |
| The `core.md` §5.1 decision (page shell vs palette) | owner, after a week of real study | Before `core.md` **C9**, which owns the palette's components. Nothing in W8 is gated on it: W8b's palette-dependent acceptance criteria are the only part that waits, and W8a closes the phase without them. |
| A Mac with desktop Safari | hardware, STACK §4 | For register #13 (`persist()` in a non-installed Safari tab) and register #4 (importing the real dictionary into `opfs-sahpool`). **Neither can run in the container**, and register #4 gates the whole web dictionary path, not only mobile. W5 and W6 record them as unrun rather than claiming them. |

**The hard ordering constraint against the sibling plans:** W0 relocates every path in the repo, and
`core.md` states that it writes today's paths and expects `web.md` to relocate them once,
mechanically. **W0 must therefore be the first commit after the CLAUDE.md rewrite, before `core.md`'s
C0.** W1 must land before `core.md`'s C1. Nothing else in this plan blocks anything else in that one.

## 5. Phases

Every phase ends the way PLAN.md §4 says: `pnpm lint`, `pnpm test`, **`pnpm build`**, the phase's e2e
specs green, an adversarial review, a commit — plus one addition this plan is obliged to make.

**`pnpm build` in that list is currently the repo's only typechecker, and W1 removes it.** §3 records
why: `eslint-config-next/typescript` is not type-aware, there is no `typecheck` script, and neither
Vite nor Rolldown typechecks. So **W1 adds `"typecheck": "tsc --noEmit"` to the root scripts** (with
`tsconfig.json`'s `next` plugin and `.next/types` includes removed in the same commit, or `tsc` fails
on the missing plugin), and **`pnpm typecheck` joins the phase gate from W1 onward.** Without it the
largest phase in this plan — nine files' imports, the whole route layer, every page module — lands
with no type checking at all.

Each phase below adds acceptance criteria that are executable or observable. Where a criterion is a
measurement nobody has taken, it says so and names the number to record rather than pretending a
threshold was validated.

**The migration estimate, stated once.** AUDIT 4 put "rewriting `app/**` pages into route components,
replacing `next/link`/`useRouter`, moving three POST routes plus the gate to a small server, and
rewriting `build-sw.ts`" at **two to four focused days with AI assistance**, and STACK §2.2 scoped
that to the client-side move with the server already existing. That number is **supported for W1 and
W2 and for nothing else in this document.** W1's page and router work is genuinely small — nine files
import `next/*`, the route handlers are already Web-standard, and most of the suite carries over
untouched (four specs do not; W1 names them and what each becomes) — and the dev/preview adapter that
replaces "the server already existing" is a plugin, not a service. The
service worker rebuild, the gate's re-homing, install and persistence, the export, fonts, the
marketing site, the keyboard layer and the desktop decision are all outside it. Anyone reading "two
to four days" as the cost of the web shell has read two phases of ten.

---

### W0 — One workspace, three deployables, and a Node floor

**Builds.** The repository shape this plan produces output into, done as a pure move while the app is
still Next, so that W1's diff is the build swap and nothing else.

A single pnpm workspace (STACK §7: "A single pnpm workspace is the obvious default for a solo
developer and keeps the shared `pnpm data` step in one place"). Everything that exists today moves
wholesale into `apps/app/`; `apps/site/` arrives in W7 and `apps/server/` is `backend.md`'s. The
`pnpm data` step and the `data/` directory stay at the workspace root, because three deployables
consume its output and STACK §7 lists the artifact path as an undecided shared surface that
`data.md` owns — this phase must not pre-empt it, only stop making it harder.

**The part that actually breaks is path arithmetic, not the move**, and it breaks in two different
ways that need two different remedies. No type checker sees either.

*File-relative roots.* These count `..` from their own module and, moved one directory deeper, land
one directory short. Each needs one more `..`, or — better, because it survives the next move —
a shared `repoRoot()` helper that walks up to the directory holding `pnpm-workspace.yaml`.

| File | Today's expression |
|---|---|
| `scripts/build-sw.ts` | `resolve(dirname(...), '..')` |
| `scripts/smoke.ts` | `resolve(fileURLToPath(import.meta.url), '../..')` |
| `tests/unit/server/routes.test.ts` | `resolve(__dirname, '../../..')` |
| `tests/unit/pwa/manifest.test.ts` | `resolve(import.meta.dirname, '../../..')` |
| `tests/unit/deps.test.ts` | `join(dirname(...), '..', '..')` |
| `tests/e2e/d/access-gate.spec.ts` | `new URL('../../..', import.meta.url)` |

`lib/server/route-inventory.ts` takes `repoRoot` from its callers and so is correct by construction
once its callers are; it is listed here only so nobody "fixes" it.

*The two that decide where `data/` is, and they are the dangerous ones.* This phase declares that
`pnpm data` and `data/` stay at the workspace root, because three deployables consume the output and
`data.md` owns the artifact path. Two files decide that, and moving them naively relocates the
artifact **while every acceptance criterion below still passes**:

- **`scripts/build-data.ts`** — line 27 is
  `const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')` and line 30 makes
  `dataDir` `resolve(repoRoot, 'data')`; it writes `dict.json`, `decomp.json` and
  `COPYING-makemeahanzi` there (lines 375, 424–427). Under `apps/app/scripts/` it writes
  `apps/app/data/`.
- **`lib/dict/load.ts`** — `dataDir()` is `configured ? resolve(configured) : resolve(process.cwd(),
  'data')`. It is **cwd-relative, not file-relative**, so it does not "move with its file": run under
  `pnpm --filter app`, cwd is `apps/app/` and it reads `apps/app/data`.

The two then *agree with each other* in the wrong place — data generated and read under `apps/app/`,
build green, tests green, the workspace-root invariant quietly gone, and `apps/site/` and the native
asset paths inheriting the wrong root in W7 and in the mobile plans. **The remedy is explicit, not
arithmetic:** both files already honour `TANGRAM_DATA_DIR` (`build-data.ts:28`, `load.ts:30`), so the
root `data` / `data:ensure` / `build` scripts set it to the absolute workspace-root `data/`, and
`build-data.ts` additionally resolves its own default upward rather than to its parent. Say which of
the two mechanisms is authoritative in `HANDOFF.md`; do not ship both silently.

`pnpm build` is `pnpm data:ensure && next build && pnpm sw` today. In the new root `build` script the
`data:ensure` step stays at the workspace root and the per-app build runs after it — the app build
must never be the thing that generates data into its own directory.

Also here, because they are one-line config facts that W1 should not have to argue: `engines.node`
becomes `>=22.22`, which React Router 8 requires (STACK §2.3, read from the changelog) and which the
container already satisfies at **v22.22.2** — one patch above the floor, which is worth noticing
because any build image on 22.21 fails. `.nvmrc` becomes `22.22`.

**Files.** `pnpm-workspace.yaml` (new), `package.json` (root: workspace scripts, `engines`, `.nvmrc`),
`apps/app/package.json` (the current one, minus what belongs at the root), `.gitignore`, and a
`git mv` of `app/`, `components/`, `lib/`, `public/`, `scripts/`, `tests/`, `middleware.ts`,
`next.config.ts`, `tsconfig.json`, `eslint.config.mjs`, `postcss.config.mjs`, `vitest.config.ts`,
`playwright.config.ts`. `data/`, `docs/`, `PLAN.md`, `HANDOFF.md`, `CLAUDE.md` stay at the root.

**`.gitignore` is in that list for a reason and is easy to forget.** Its patterns are anchored to the
file's own directory, so `public/sw.js`, `data/*.json` and `next-env.d.ts` stop matching the moment
those trees are under `apps/app/`: the generated worker becomes committable noise. Re-anchor them
(`apps/app/public/sw.js`, or the leading-slash-free forms that match at any depth) as part of the
move, and check with `git status` after a build that nothing generated is untracked-and-offered.

**The workspace globs must provision `packages/`, not only `apps/`.** W4 moves `lib/server/access.ts`
into a shared package and `backend.md` names `packages/access/**` and `packages/ai/**` explicitly. A
workspace declared as `apps/*` alone means W4 either invents a layout or puts shared code in an app.
Declare `apps/*` and `packages/*` now; empty `packages/` costs nothing.

**Acceptance criteria.**

- `pnpm build`, `pnpm lint`, `pnpm test` and `PORT=3000 pnpm e2e` all pass from the workspace root,
  with the same test counts as before the move. **A changed test count is a failed phase**: this
  phase changes no behaviour.
- `git log --stat` for the phase shows renames and configuration edits only. `git diff -M --stat`
  reports no file with substantive content change outside the config files listed above.
- `pnpm smoke` against the built server still passes, which proves the `../..` arithmetic in
  `scripts/smoke.ts` and `route-inventory.ts` survived.
- **The data artifact is at the workspace root and the app reads that same directory.** Delete
  `data/*.json`, run `pnpm data` from the workspace root, and assert `test -f data/dict.json` **at
  the workspace root** and no `apps/app/data/` directory exists. Then run the app from `apps/app/`
  (`pnpm --filter app …`) and assert `/api/dict/hsk?band=1` does **not** 503 — the two halves of the
  invariant, checked separately, because they fail together and look fine.
- `node -v` is asserted against `engines.node` by the build (`pnpm` enforces `engines` when
  `engine-strict` is on; if it is not, add a one-line check to the root build script rather than
  trusting it).
- `HANDOFF.md` records the final layout, because five plans write files into it.

---

### W1 — Vite builds it, React Router routes it, and the eight handlers keep answering

**This is the largest phase in the plan and the only one that cannot be half-done.** A repo cannot
serve from Next and Vite at once, so this phase is atomic: it starts with a working Next app and ends
with a working Vite app with the whole test suite green.

**Builds, in four parts.**

*1. The build.* `vite` 8 and `react-router` 8 installed (STACK §6 pins 8.3.0 and 8.3.1 as of
2026-09-13 and says re-check every row before work starts — do that first, it is a `pnpm view` away).
`apps/app/index.html` as the entry document, carrying what `metadata` and `viewport` declared: the
title, the description, `<link rel="manifest">`, the Apple web-app meta tags, the theme colour, and
`lang="zh-Hans"` on `<html>` per `core.md` C0's rule 2. `src/main.tsx` mounts the router;
`app/layout.tsx`'s composition (`SiteHeader`, `DataBanner`, `TestHooks`, `RegisterServiceWorker`,
`<main>`) becomes the root route element.

**`base` is `'/'`, and that is not a placeholder.** Capacitor and Tauri serve `dist/` from the *root*
of a custom scheme (`capacitor://localhost/`, `tauri://localhost/`) or of `http://localhost`, which a
root-absolute base satisfies exactly; no audit asks for anything else, and STACK §2.2 says only that
both "need a directory of static files". A relative base (`'./'`) would actively break this build:
Vite emits `./assets/<hash>.js` into `index.html`, and under the SPA fallback this phase requires, a
hard refresh of `/lists/<id>` returns that same document, whose script URL now resolves to
`/lists/assets/<hash>.js`, which the fallback answers with `index.html` again — a deep route that
boots to a blank page. **Relative base and history routing are mutually exclusive; pick history
routing.** If a subpath deploy is ever wanted it is a *separate build invocation*
(`vite build --base=/sub/`), whose output is then served only under that prefix, and W9's standing
check tests that invocation rather than the default one.

Tailwind 4: try `@tailwindcss/vite`, and if it misbehaves keep the existing
`@tailwindcss/postcss` + `postcss.config.mjs`, which Vite picks up natively. STACK §7 names this
explicitly as a thing "nothing here has checked", so **whichever path is taken, write which and why
into `HANDOFF.md`** rather than leaving the next reader to infer it from a config file.

*2. The router.* `createBrowserRouter` (data mode, STACK §2.3). The route table is a module —
`src/routes.tsx` — not a scattering of file conventions, because `scripts/smoke.ts` derives its page
list from a module today and W2 needs it to keep doing so. The eight pages become route components;
`app/lists/[id]/page.tsx`'s awaited `params` becomes `useParams()`. `app/settings/page.tsx`'s
per-request `readFile` of `ATTRIBUTION.md` becomes a build-time raw import of the committed file
(Vite's `?raw` suffix). That trades away runtime `TANGRAM_DATA_DIR` relocation for the attribution
text, which is acceptable — the file is committed, not generated — but **say so in the code**, since
CLAUDE.md makes rendering it in `/settings` a licence obligation, not a nicety.

The eleven `next/*` import sites: `next/link` → React Router's `Link`; `usePathname` →
`useLocation()`; `useRouter().push` in `list-detail.tsx` → `useNavigate()`. `process.env.NODE_ENV` in
`register-sw.tsx` → `import.meta.env.PROD`. `tests/unit/deps.test.ts`'s loader table drops `next` and
gains `react-router` and whatever else `package.json` declares — the test asserts the table equals
`dependencies`, so it fails until it is right, which is the point.

*3. The dev/preview API adapter.* A small Vite plugin, `apps/app/vite-plugins/api.ts`, that mounts the
existing `app/api/**/route.ts` handlers in the dev server and the preview server (`configureServer`
and `configurePreviewServer` — confirm both names against the installed Vite 8's types; AUDIT 4 could
not reach vite.dev). It adapts a Node request to a `Request` and writes the returned `Response` back.
It reuses `discoverApiRoutes()` from `lib/server/route-inventory.ts` to find them, so the inventory
machinery that STACK §2.2 calls "the fifth, smaller casualty" survives its first crossing.

**Three details that decide whether it works, none of which can be left to the builder's assumption.**

- **The handler contract is `(request: Request) => Response | Promise<Response>`, and the adapter
  must `await` either.** §3 has the breakdown: ten handlers, six of them synchronous. It must also
  dispatch by method, because `ask` and `examples` each export both `GET` and `POST`.
- **It derives `HEAD` from `GET`** — call the `GET` handler and return its status and headers with
  the body dropped. `components/shell/data-banner.tsx` probes `/api/dict/hsk?band=1` with `HEAD` and
  Next synthesised it; nothing else will.
- **How the TypeScript handler modules are *loaded* differs between dev and preview, and preview is
  the one that matters.** In dev the plugin can go through the dev server's module runner. The
  preview server has no transform pipeline — it serves `dist/` statically — so a plain
  `await import('./app/api/ask/route.ts')` from Node is a resolution error, and every W1 acceptance
  criterion that proves the adapter runs against preview. Two mechanisms are available and one must
  be chosen and written into `HANDOFF.md`: (a) start preview from a small `scripts/preview.ts` run
  under **`tsx`**, which is already a direct devDependency and is already how `pnpm data`, `pnpm sw`
  and `pnpm smoke` execute TypeScript under Node — its loader hook then compiles the handler modules
  on import (confirm Vite 8's programmatic preview entry point against the installed types); or (b) a
  second esbuild/Rollup pass in `pnpm build` that emits the handlers as one Node-loadable ESM bundle
  which the preview plugin imports by path. **Prove the choice before building anything on it:** the
  first acceptance criterion below is one `GET` and one `POST` answering against `pnpm preview`.

Be clear about what this adapter is and is not. **It is a bridge, not a product.** It exists so that
`/api/dict/*` keeps answering until `data.md` deletes those five routes, and so that `/api/ask`,
`/api/examples` and `/api/recall` keep answering until `backend.md` has a server. It never ships: it
is dev- and preview-only, it is not in `dist/`, and the phase that removes the last handler removes
it too.

*4. The harness, minimally.* `playwright.config.ts`'s `webServer.command` becomes
`pnpm build && pnpm preview --port $PORT` (AUDIT 4 says this is the only change Playwright needs; the
adapter is what makes it true). `vitest.config.ts` needs no *config* change — it already uses
`@vitejs/plugin-react` and the `@` alias, and vitest 4.1.11 accepts Vite `^6 || ^7 || ^8` — but see
§3: declaring Vite re-resolves the version vitest itself runs on, from today's 8.2.2 to whatever this
phase pins, so `pnpm test` is run and read immediately after the install and before anything else.

**Four specs are casualties of this phase and each needs a stated destination.** "Updated to the
extent needed to keep them green" is not an instruction anyone can review.

| Spec | What breaks | What it becomes in W1 |
|---|---|---|
| `tests/unit/pwa/manifest.test.ts` | Asserts `app/apple-icon.png` exists (a Next file convention) and reads `app/layout.tsx` for `manifest: '/manifest.webmanifest'` (line 66); the layout stops being a metadata source | Assert against `index.html`: a `<link rel="manifest" href="/manifest.webmanifest">` and an `<link rel="apple-touch-icon">` pointing at a file that exists in `public/`. Same two guarantees, read from the document that now carries them. |
| `tests/e2e/p6/pwa.spec.ts` | Asserts `content-type: application/manifest+json` and `cache-control: no-cache` on `/sw.js` — headers `next.config.ts` supplied and W2 re-homes into host config, which `vite preview` does not apply | Set `preview.headers` in `vite.config.ts` so the two assertions keep passing in W1 and W2 inherits a green spec. If that proves impossible on the installed Vite, move those two assertions into W2 **in the same commit** that removes `next build`, and say so in the commit message — never leave them deleted. |
| `tests/e2e/c/sw-version.spec.ts` | Reads `.next/BUILD_ID` off disk | Minimal edit to read the `dev` stamp so it stays green; the real rewrite is W3. |
| `tests/e2e/d/access-gate.spec.ts` | Spawns `node_modules/.bin/next start` on `PORT + 100`, and the middleware it drives stops running | See the gate window below. |

**The gate is down between W1 and W4, and that is a deployment fact, not a test detail.**
`middleware.ts` stops running the moment Next goes, so the `?key=` → cookie exchange has no
replacement until W4 builds the header one. The three gated handlers still call `requireAccess`,
which reads a cookie that nothing can now set — so **on any deployment made in the W1–W3 window with
`TANGRAM_ACCESS_SECRET` set, `/api/ask`, `/api/examples` and `/api/recall` are unusable and cannot be
authorised from a phone.** With the secret unset (local dev, the whole test suite) nothing changes.
Accept the window or move W4 ahead of W2 and W3; the plan's order assumes no deployment happens in
it. `tests/e2e/d/access-gate.spec.ts` loses exactly the assertions that drive middleware — the
`?key=` redirect, the stripped parameter, the `Set-Cookie` attributes — and keeps the ones that do
not: with the secret unset everything is open, and the five ungated dictionary routes plus the
manifest, `sw.js` and `/offline.html` stay open. **List the removed assertions in the commit message
and map each to the W4 criterion that restores it**; W4's criteria are written to cover all three.

**Files.** New: `apps/app/index.html`, `vite.config.ts`, `src/main.tsx`, `src/routes.tsx`,
`vite-plugins/api.ts`, `apps/app/tracing.config.ts`, and `scripts/preview.ts` if the adapter's
loading mechanism is (a). Rewritten: the eight page modules (into `src/routes/**`), `app/layout.tsx`'s
composition, the nine files importing `next/*`, `package.json` scripts (including the new
`typecheck`), `eslint.config.mjs` (`eslint-config-next` out; a plain typescript-eslint flat config
in), `tests/unit/pwa/manifest.test.ts`, `tests/e2e/p6/pwa.spec.ts`,
`tests/e2e/c/sw-version.spec.ts`, `tests/e2e/d/access-gate.spec.ts`,
`tests/unit/server/routes.test.ts`, `tests/unit/deps.test.ts`. Deleted: `next.config.ts`.

`tsconfig.json` needs four edits, not one, and there is no `next-env.d.ts` to delete — it is
generated by `next dev`/`next build`, is gitignored (`.gitignore:6`) and is not in the tree. What
exists are the *references* to it: drop `"next-env.d.ts"`, `".next/types/**/*.ts"` and
`".next/dev/types/**/*.ts"` from `include`, and drop the `{ "name": "next" }` entry from
`compilerOptions.plugins` — that last one is what makes `pnpm typecheck` possible at all once `next`
is uninstalled. `eslint.config.mjs` likewise drops `.next/**` and `next-env.d.ts` from `ignores`.

`middleware.ts` stops running the moment Next goes and is dead code from here until W4 deletes it —
say so in a one-line header rather than leaving a live-looking gate that does nothing.

**The tracing guard survives; `next.config.ts` does not.** The config carries
`outputFileTracingIncludes`, and `tests/unit/server/routes.test.ts:22` does
`import nextConfig from '@/next.config'` to prove no dictionary-reading route ships without its data
— a guard that exists because `/api/examples` and `/api/recall` shipped untraced and a human found
it. Keeping the file is not an option, even as inert data: its first line is
`import type { NextConfig } from 'next'`, so once `next` leaves `package.json` that type import
cannot resolve and both `tsc` and vitest's module graph fail on it. **Move the four glob keys into
`apps/app/tracing.config.ts` as a bare object literal with no `next` import, point
`tests/unit/server/routes.test.ts` at it, and delete `next.config.ts` — all in one commit.** The rule
that matters is unchanged and is R9's mitigation: **delete the tracing map and its test in the same
commit as the thing they guarded**, that is, when `data.md` deletes the dictionary routes and
`backend.md` owns the rest. Silently dropping the test is the failure this paragraph exists to
prevent.

**Acceptance criteria.**

- **First, before anything else in this phase is built:** `pnpm test` passes against the newly
  declared Vite version, since that resolution is shared with vitest (§3).
- **Second, before the rest of the e2e work:** with `pnpm build && pnpm preview` running, one `GET`
  (`/api/dict/hsk?band=1`) and one `POST` (`/api/dict/segment`) return their expected bodies, and a
  `HEAD` to `/api/dict/hsk?band=1` returns 200. This is the proof that the adapter's module-loading
  mechanism works under preview, and everything below depends on it.
- `pnpm build` produces `apps/app/dist/` containing `index.html`, hashed assets, and no Next runtime.
  `grep -rn "next" apps/app/package.json` returns nothing.
- `grep -rn "from 'next" apps/app/{src,components,lib,app,tests,scripts}` returns nothing.
- **`pnpm typecheck` is clean**, and is in the phase gate from this commit onward.
- `pnpm test` passes. State the before/after test count explicitly in the commit message, itemised:
  the `deps.test.ts` loader-table change, `manifest.test.ts`'s two rewritten assertions,
  `routes.test.ts`'s config source, and the assertions removed from `access-gate.spec.ts` with their
  W4 restoration criterion each. An unexplained delta is a failed phase; "only `deps.test.ts`" is not
  a true statement of this phase's effect on the suite.
- `PORT=3000 pnpm e2e` passes the full suite, including `tests/e2e/smoke.spec.ts`'s seven routes and
  `tests/e2e/d/smoke.spec.ts`'s `runSmoke` over all eight API route files. The API cases passing is
  the proof that the adapter works end to end.
- A hard refresh of a deep route (`/lists/<id>`) served by `vite preview` renders the list, not a
  404 — i.e. SPA fallback is on, and the default `base: '/'` build's asset URLs resolve from a nested
  path. Assert it in a spec, because it is a host behaviour that W2 has to reproduce in production
  and the preview server's default hides it.
- **A separate subpath build** — `vite build --base=/sub/` into a second output directory — boots
  when served behind a `/sub/` prefix (e.g. `python3 -m http.server`). This is the Capacitor/Tauri
  and subpath-hosting criterion, and it tests *that* invocation; the default build is not expected to
  survive a prefix and must not be asserted to.
- **Record in `HANDOFF.md`:** production bundle size (total, and the entry chunk), and `pnpm build`
  wall time against Next's measured 28 s for `next build` + `pnpm sw` (`docs/deploy.md`). Nobody has
  a Vite number; this is the first one.

---

### W2 — The built server is provably correct: host config, and the smoke machinery rebuilt

**Builds.** The two things a static SPA can get wrong that no unit test sees — the host's routing
and the host's headers — plus the replacement for the machinery that used to catch exactly this class
of bug.

*Host configuration.* **There is no host config file in this repository today** — no `vercel.json`,
nothing equivalent. `docs/deploy.md:12` says "Vercel's Next.js preset is right out of the box.
Confirm rather than change", and the three rules below live in `next.config.ts`'s `headers()` block,
which W1 deleted. **W2 creates the first host config file, and until it exists the header rules exist
nowhere.** That is why the config and its parsing test must land in the same commit as the removal:
otherwise the rules are lost with no test to notice. The host choice itself is a §4 prerequisite; the
requirements are not:

1. **SPA fallback** — every navigation that is not a real file returns `index.html`.
2. `/manifest.webmanifest` served as `application/manifest+json; charset=utf-8`. Some installability
   checks refuse anything else; that is why the header exists today.
3. `/sw.js` served as `text/javascript; charset=utf-8` with `Cache-Control: no-cache, no-store,
   must-revalidate` and `Service-Worker-Allowed: /`. A worker at the root must be revalidated or a
   bad one is permanent.

*The smoke machinery.* `lib/server/route-inventory.ts` and `scripts/smoke.ts` exist because a route
can ship untraced and only a person opening the page notices. Their *purpose* — "every route is
exercised over HTTP on a built server" — survives; their implementation does not. It splits in two:

- **The SPA half, here — and it splits into two consumers that must not be merged.** With SPA
  fallback everything returns 200 `index.html`, including routes that no longer exist and builds
  whose entry chunk 404s, so **a status-only smoke on an SPA is a test that cannot fail** and the
  rendered-content assertion is the whole point. But `scripts/smoke.ts` is today a dependency-free
  `tsx` script whose reason for existing is that it runs against a *deployed URL*
  (`pnpm smoke --base-url https://… --key …`, `docs/deploy.md`'s after-deploy habit), and
  `tests/e2e/d/smoke.spec.ts` imports `runSmoke` from it so the two can never drift. Turning the
  script into a Playwright run inverts that and puts a browser dependency into the production
  checklist — in this container only the pinned `/opt/pw-browsers/chromium`, and CLAUDE.md forbids
  `playwright install`. So:
  - **`tests/e2e/p0/routes.spec.ts` (new, Playwright)** owns the rendered per-route DOM markers. It
    reads the route table from `src/routes.tsx` and fails when a route has no marker. This runs in
    `pnpm e2e` and is the assertion R7 is about.
  - **`scripts/smoke.ts` stays a dependency-free CLI** and keeps the HTTP-level checks that are still
    meaningful against a static host and a real deployment: every hashed asset in the build manifest
    is 200, `/manifest.webmanifest`, `/sw.js` and `/offline.html` are 200 with the three header rules
    above, and the configured API base answers. It keeps `--base-url` and `--key`.
  - **`tests/e2e/d/smoke.spec.ts` keeps importing `runSmoke`** so the CLI is exercised in CI, exactly
    as today. The shared route list lives in `src/routes.tsx` and both consumers derive from it —
    never a copy, which is the discipline that made `PAGE_CASES` read `NAV_ITEMS`.

  Both route-derived halves are re-run by `core.md` C7's commit when the table collapses to three
  tabs (§2); nothing here needs changing for that, but somebody has to watch it pass.
- **The API half, handed over.** The route-coverage check keeps working against the dev/preview
  adapter for as long as the adapter has handlers, and then becomes `backend.md`'s: three routes on a
  different deployable, exercised over HTTP against a built server, with the same coverage rule.
  Write that requirement into `HANDOFF.md` as a deliverable `backend.md` owes, or it will be lost —
  it is the guard that already failed once.

**A caveat to state loudly rather than bury.** `vite preview` does not apply the host's header
config, so a smoke run in the container proves the *content* rules and proves nothing about headers
2 and 3. Cover them two ways: a unit test that parses the host config file and asserts the three
rules are present (cheap, catches deletion), and a `pnpm smoke --base-url <deployed>` run in the
after-deploy checklist (`docs/deploy.md` already has that flag and that habit).

**Files.** `apps/app/vercel.json` or the chosen host's equivalent (**new — nothing like it exists
today**), `tests/e2e/p0/routes.spec.ts` (new), `scripts/smoke.ts` (rewritten),
`lib/server/route-inventory.ts` (reduced to what the adapter and the coverage check still need),
`tests/unit/server/routes.test.ts` (rewritten around the route table and the host config),
`tests/e2e/d/smoke.spec.ts`, `docs/deploy.md` (rewritten for a static deployment).

**Acceptance criteria.**

- The route spec fails when a route is added to `src/routes.tsx` with no marker — demonstrate it by
  adding one, watching it fail, and removing it. The coverage half is what survived the last person;
  it must survive this one.
- The route spec fails when the entry chunk is deleted from `dist/` — the deliberate proof that the
  content assertion is real and a 200 is not enough.
- A unit test parses the host config file and asserts SPA fallback plus the three header rules.
  Deleting any one of them fails the test. **This test and the host config file land in the same
  commit as W1's `next build` removal reaches deployment**, or the rules exist nowhere.
- **The missing-data banner still works on a built server**: with `data/` absent, `/api/dict/hsk?band=1`
  answers 503 to a `HEAD` and the banner renders; with it present, no banner. This is the criterion
  §4's `DictStore`-readiness row points at, and it is here because W1's adapter is what keeps the
  probe answering.
- `docs/deploy.md` describes a static deployment: what is uploaded, what the headers are, where the
  API base points, and an after-deploy checklist that ends in `pnpm smoke --base-url` — the CLI half,
  which needs no browser.

---

### W3 — The service worker, stamped from Vite's own output

**Builds.** The replacement for `.next/BUILD_ID`, and the cache policy rewritten for a single-document
SPA with hashed assets.

**The stamp.** There is no `BUILD_ID` in a Vite build (STACK §2.2). Turn on Vite's build manifest and
stamp the worker with a **content hash over that manifest plus the bytes of every unhashed file the
worker precaches or serves** — today `public/offline.html`, `public/manifest.webmanifest` and the
three files in `public/icons/`. The second half is not optional and it is the one a builder will
skip. Vite's manifest covers only what goes through the module graph; files in `publicDir` are copied
to the dist root verbatim, keeping their authored names and gaining no content hash, so they appear
in no manifest. Hash the manifest alone and editing `offline.html` leaves the stamp unchanged,
`activate` — which deletes every cache that is not the current one — purges nothing, and the stale
precached offline page is served forever. `.next/BUILD_ID` did not have that hole.

With that second half in place the scheme is better than what it replaces: `BUILD_ID` changed on
every build, so a rebuild with identical output purged a cache for nothing; this hash changes exactly
when the served bytes change, which is what `scripts/build-sw.ts`'s own header says it always wanted.
Keep the rest of that script verbatim — the placeholder, the `[A-Za-z0-9_-]{1,64}` refusal, the
"template is deliberately not under `public/`" rule, the `dev` fallback. Read the manifest's exact
filename off the installed Vite rather than assuming it.

**Why not `vite-plugin-pwa`.** STACK §2.2 offers it as the alternative and STACK §6 records it at
1.3.0 with Vite 8 support. Rejected, for the reason the current worker's own header gives: the
interesting part is the policy, and this app's policy is unusual in two ways a generator will fight —
`/api/**` must be network-only because the real cache is `ask_cache` in IndexedDB storing ids rather
than gloss text (CLAUDE.md), and the dictionary artifact must be excluded from the HTTP cache
entirely because it lives in OPFS. A generated precache manifest that hoovers up every emitted asset
does the wrong thing with a ~15 MB file by default. **If the hand-written worker becomes a
maintenance drag, `vite-plugin-pwa` with an explicit `globIgnores` is the fallback** — record that in
`HANDOFF.md` so the option is not rediscovered from scratch.

**The policy, rewritten.** Three ordered rules again, two of which change shape:

1. `/api/**` — unchanged, network-only, and now it must also skip the **configured API origin**,
   which after W4 is not same-origin. A rule keyed on `url.pathname.startsWith('/api/')` stops being
   true when the API moves to `api.<domain>`; the worker already returns early for cross-origin
   requests, so the correct statement is that it must keep doing so and a test must say why.
2. `/_next/static/**` becomes Vite's hashed asset directory — a **path prefix**, and note what that
   excludes: anything copied verbatim out of `publicDir` keeps its authored path and is not matched
   by it. Cache-first with no revalidation, same reasoning: content-hashed paths mean a hit is always
   correct. Anything the worker should cache-first and that is *not* content-hashed needs its own
   rule; W6's fonts are the case that comes up, and W6 resolves it by making the fonts hashed assets
   rather than by adding a rule.
3. Navigations stay **network-first**, and the reason survives the move intact. Under SPA fallback
   there is one document, so a stale cached `index.html` references `assets/<old-hash>.js` that the
   new deployment no longer serves — the exact failure the current header describes, with one
   document instead of seven. `SHELL` therefore collapses from the seven nav routes to `/`,
   `/offline.html`, and the entry chunk and stylesheet read out of the build manifest. That collapse
   also means `core.md` C7's three-tab change costs this phase nothing: there is no longer a
   per-route precache list to re-derive. What C7 can still move is the stamp, if it edits the
   manifest or the offline page — hence §2's rule that C7's commit re-runs these specs.

**The dictionary exclusion is the one new rule and it is not optional.** The worker must never store
the dictionary artifact. It is fetched once and imported into OPFS (`data.md`), and an HTTP-cache
copy is the same tens of megabytes a second time, on an origin whose whole storage story is fragile.
Express it as an explicit deny by path or extension, agreed with `data.md`, and test it.

**Files.** `scripts/build-sw.ts`, `scripts/sw.template.js`, `tests/unit/pwa/build-sw.test.ts`,
`tests/unit/pwa/manifest.test.ts`, `tests/e2e/c/sw-version.spec.ts`, `vite.config.ts` (manifest on).

**Acceptance criteria.**

- `tests/e2e/c/sw-version.spec.ts`, rewritten: the served `/sw.js` contains no placeholder, its
  `VERSION` equals the hash recomputed from `dist/`'s manifest, and after `navigator.serviceWorker.ready`
  the only `tangram-*` cache on the origin is the one named for that hash. This is the existing spec's
  shape with the id source swapped, and it must stay that strict.
- Two consecutive builds of an unchanged tree produce the **same** stamp; a build after touching one
  source file produces a different one. Two assertions, both cheap, and together they are the whole
  argument for the content hash.
- **Touching `public/offline.html` alone changes the stamp**, and after the next `activate` the cache
  named for the old stamp is gone. This is the criterion that catches a stamp computed over the build
  manifest only, which is the mistake this phase is most likely to make.
- A Playwright spec goes offline (`context.setOffline(true)`) after a warm load and asserts a
  navigation still renders the app shell, and that a navigation to a never-visited route renders
  something — not a browser error page. **This is new capability**: HANDOFF.md records that the
  existing e2e never goes offline, and it is available in the container for free.
- The dictionary artifact is requested once with the worker active and does **not** appear in
  `caches.keys()`'s contents. Assert on the cache's entries, not on a mock.
- No request to the configured API origin is answered from a cache — assert with the API base set to
  a second local port.

---

### W4 — The access gate, re-homed as a header

**Builds.** The destination of `middleware.ts`, and the client's side of talking to a server on
another origin.

**What the middleware did, split in two.** Its second job — refusing unauthorised requests to
`/api/ask`, `/api/examples` and `/api/recall` — moves to the server, and `lib/server/access.ts` moves
with it into a shared workspace package (`packages/access/**`, which `backend.md` names) that the
dev/preview adapter imports today and `backend.md`'s server imports tomorrow. That module was written
not to import `next/*`, on purpose, so that middleware, handlers and tests ran one implementation,
and that is what makes the *move* free. **The module is not unchanged, and the one function that
changes is the one every gated request runs through.** `isAuthorizedRequest` is today
`isAuthorizedValue(readCookie(request.headers.get('cookie'), ACCESS_COOKIE), env)`, and `requireAccess`
— the first line of all three gated handlers — calls it. Deleting `readCookie` rewrites both. State
the change as a diff, not as a move:

| Symbol | Fate |
|---|---|
| `constantTimeEqual`, `accessSecret`, `accessGateEnabled`, `isAuthorizedValue`, `unauthorizedResponse`, `GATED_PATHS`, `ACCESS_QUERY_PARAM`, `ACCESS_RESULT_PARAM` | Unchanged, moved |
| `isAuthorizedRequest` | **Rewritten** to read `request.headers.get(ACCESS_HEADER)` instead of a cookie. Same signature, same three rules, same `null`-secret short circuit |
| `requireAccess` | Signature and behaviour unchanged; it now calls the rewritten `isAuthorizedRequest` |
| `readCookie`, `accessCookie`, `clearAccessCookie`, `ACCESS_COOKIE`, `COOKIE_SAFE_SECRET`, `ACCESS_COOKIE_MAX_AGE_SECONDS`, `AccessCookieOptions` | Deleted |
| — | **New:** `export const ACCESS_HEADER = 'x-tangram-access'` |

**The header's name is the one thing the client half and the server half must agree on, so it is
named here and written into `HANDOFF.md` as the contract `backend.md` consumes: `X-Tangram-Access`,**
carrying the secret verbatim, exactly as the cookie did. `backend.md`'s CORS allowlist must include
it in `Access-Control-Allow-Headers`, because a custom request header makes every cross-origin `POST`
a preflighted request: after W7 the browser sends `OPTIONS` first, and a server that does not answer
it fails every gated call before the handler is reached. That is a `backend.md` deliverable and this
plan's job is to name it and to exercise it (criterion 6).

Its first job — trading `?key=<secret>` for a credential on a phone — needs a new mechanism.
`access.ts`'s header states the reason for the cookie exactly: *"a phone browser cannot set a request
header."* In an SPA, JavaScript sets the header. So: the client reads `?key=` at boot, keeps the
secret, strips the parameter out of the URL exactly as the middleware's redirect did (so it is not
left in history, in a bookmark or in a `Referer`), leaves `?access=granted|denied` behind as the only
feedback a phone with no devtools can read, and sends the secret as `X-Tangram-Access` on every call
to the API base.

**Where the secret is kept, and the posture change that comes with it.** `localStorage` under a
single key, read once at boot into module state — not IndexedDB, which is the learner's data store
and is what W5's export dumps, and not memory alone, since the point of the exchange is that the
phone is set up once. This is a **real change in posture and it must not be sold as free**: today the
credential is `HttpOnly`, and `accessCookie()`'s own comment says why — *"a stored credential that
`document.cookie` can reach is one XSS away from being public."* Under W4 the same verbatim secret is
script-readable, attached by page script, and there is **no CSP in this repo** (§7 defers one), which
is the mitigation that would normally offset it. It is acceptable for exactly one reason, and the
reason should be in the code comment: this gate protects **spend on three routes**, not user data —
`access.ts`'s own opening paragraph frames it as "anybody who finds the URL can spend the owner's
money" — and it is superseded by real accounts (STACK §2.8). It rotates the same way it always did:
change the environment variable and every issued secret dies at once.

**A divergence from STACK §2.8 taken on purpose, recorded so it can be reversed.** §2.8 says of the
`?key=` exchange: *"if the phone workflow is still wanted, the cheapest replacement is the same
exchange served by the new server on a single endpoint. Decide it when the server is chosen."* This
phase decides the **client** half before the server is chosen, because W1 removed the middleware and
something has to authorise a phone in the meantime. If `backend.md` prefers a server-side exchange
endpoint — the client posts the key once and gets back a token — the client half here is what it
replaces, and the header contract above is unaffected either way.

**Two consequences to state rather than discover.** First, on the web a cookie *would* in fact cross
from `app.<domain>` to `api.<domain>`: they share a registrable domain, so a `Domain=<apex>` cookie
is same-site and Safari's third-party blocking does not apply. The header is still the right answer,
for two reasons the cookie cannot meet: a Capacitor WebView on `capacitor://localhost` or
`http://localhost` **is** cross-site to `api.<domain>` and gets no cookie at all, and `ios.md`,
`android.md` and W9 all consume that build; and a header avoids credentialed CORS
(`credentials: 'include'` plus an exact-origin `Access-Control-Allow-Origin`) on every platform.
Second, **the gate never protected the page HTML and now visibly does not.** The current matcher
already excludes
`_next/static`, `sw.js`, `offline.html` and the manifest; a static host serves the shell to anyone who
asks. If the app's HTML itself must be private, that is host-level basic auth, not application code —
say which, in `docs/deploy.md`, rather than letting a reader assume the gate covers more than the
three paid routes it has always covered.

Also here: `lib/dict/client.ts` and the ask/examples/recall callers gain a configured base
(`import.meta.env.VITE_API_BASE`, empty in development so same-origin still works), and the
credentials/CORS mode is written down once. `backend.md` owns the server's CORS allowlist; this plan
owns the client's half and the fact that the two must agree.

**Files.** `middleware.ts` (deleted), `lib/server/access.ts` → `packages/access/**` (moved, with the
symbol-by-symbol diff above), new `src/access/client.ts`, `lib/dict/client.ts`, `lib/ai/*` call
sites, **`scripts/smoke.ts`** (line 32 imports `ACCESS_COOKIE` and line 270 sends
`headers.cookie` for `--key`; both become the header — the deploy checklist runs this script against
a gated deployment, so missing it means `pnpm smoke --key` 401s everything in production),
`tests/unit/server/access.test.ts`, `tests/e2e/d/access-gate.spec.ts` (rewritten to drive the preview
server with the secret set instead of spawning `next start`), `HANDOFF.md` (the header contract).

`tests/unit/server/access.test.ts` is **rewritten, not carried over**: it has a whole
`describe('readCookie')` block from line 107 and drives `isAuthorizedRequest` through
`${ACCESS_COOKIE}=…` header strings in at least six assertions (lines 52, 68–81). Rewrite it around
`X-Tangram-Access` **with the same case list** — absent, empty, near-miss, one trailing character,
wrong header name, and secret-unset-means-open — because that list is what has kept the gate honest,
and losing a case is how a gate quietly widens.

**Acceptance criteria.**

- With `TANGRAM_ACCESS_SECRET` unset, every existing test and e2e spec behaves exactly as before.
  This is rule 1 of `access.ts` and it is why the gate has survived; breaking it fails the phase.
- e2e against a preview server with the secret set: a call to each of the three gated paths without
  the header is `401 {"error":"unauthorized"}` with no echo of what was sent; visiting `/?key=<wrong>`
  leaves `?access=denied` and revokes any stored secret; visiting `/?key=<right>` leaves
  `?access=granted`, removes `key` from the URL, and the three routes then answer. That is the same
  phone flow the current spec drives, through the new mechanism.
- The five ungated dictionary routes, the manifest, `sw.js` and `/offline.html` stay open — asserted,
  because a gate that quietly widened would break the PWA.
- `tests/unit/server/access.test.ts`, rewritten around `X-Tangram-Access`, covers the same six cases
  the cookie version covered. Assert the case count in the review, not just that the file is green.
- **The cross-origin path is exercised before it is deployed**, which is R10's only real mitigation:
  serve the app from the preview server and the API from a **second local port** with an explicit
  CORS allowlist, set `VITE_API_BASE` to that port, and assert (a) the browser's `OPTIONS` preflight
  for a gated `POST` is answered with `X-Tangram-Access` in `Access-Control-Allow-Headers`, (b) the
  `POST` then succeeds, and (c) the same call without the header is 401. A same-origin run proves
  none of this.
- `pnpm smoke --key <secret>` against a gated preview server passes — the deploy checklist's own
  command, through the new credential.
- `grep -rn "next/server" apps/ packages/` returns nothing and `middleware.ts` no longer exists.

---

### W5 — Install, persist, and the export that makes eviction survivable

**Builds.** The three things that decide whether a learner's flashcards still exist next week, none of
which exist in the repo today.

**Why this is a data-safety phase and not a polish phase.** STACK §2.8's framing is the one to build
against: *losing the dictionary is a re-download; losing the flashcards is the actual loss.* AUDIT 4
established that an installed PWA is in a different storage regime from a tab — Chromium grants
`persist()` silently to an installed origin and skips persisted origins during LRU eviction, and
WebKit exempts a Home-Screen or Dock web app from the seven-day ITP cap and gives it the browser-level
quota. **A Safari tab that is not installed is the dangerous case**, and it is the default case for
anyone who tries the app from a link.

Three deliverables:

1. **The install affordance.** Capture `beforeinstallprompt`, keep it, and offer install where it is
   honest to offer it — Chromium fires the event, WebKit does not, so Safari needs instructions
   rather than a button. The affordance's copy belongs to `core.md`'s component set; the capture, the
   platform branch and the "already installed" detection (`display-mode: standalone`) belong here.
2. **`navigator.storage.persist()`**, called after a real interaction rather than on first paint —
   Chromium grants it silently to an installed, bookmarked or engaged origin, so asking at the wrong
   moment converts a silent grant into a refusal. Read back `persisted()` and surface the answer:
   a quiet line for a persisted origin, and a real warning for a non-installed Safari tab holding
   cards.
3. **A local export**, and this plan ships it rather than waiting. STACK §2.8 names the export as a
   deliverable of the first *mobile* phase, on the reasoning that on day one neither sync nor a
   native store exists. That reasoning applies with more force here: web ships first, and the moment
   anyone studies in a browser tab the only recovery from an evicted origin is a file they already
   downloaded. Format: JSON of the repository's own row shapes, which is safe because PLAN.md §3.3
   already guarantees client-generated UUID keys, `createdAt`/`updatedAt` and soft-delete tombstones.
   Round-trip it: the import path is what makes the export a backup rather than a souvenir.
   `ios.md` and `android.md` reuse it, and `backend.md` B5 builds its account-level export over the
   same row shapes; none of them rebuild it.

**The seam does not currently support this, and that is a prerequisite, not an implementation
detail.** `lib/db/repository.ts` is ~30 domain methods and exposes **no way to read a tombstoned row
and no dump/restore**: `lib/db/dexie.ts:131` defines `const alive = row => row.deletedAt === null`
and every list accessor filters through it, so `deleteList` (line 681) and `removeListMembers` (line
700) write `deletedAt` and the rows then vanish from `lists()` and `listMembers()`. The round-trip
criterion below therefore **cannot be met through the seam as it stands**, and bypassing the seam to
touch Dexie directly is exactly what the round trip must not do — the reason tombstones have to
survive is that dropping them resurrects deleted cards on the next sync, which is a `Repository`-level
guarantee.

So W5 states the addition and takes it through the frozen-file route (CLAUDE.md freezes this file;
§4 lists it as a settle-first surface with no sibling owner). The smallest addition that satisfies
the criterion:

```
exportAll(): Promise<Snapshot>          // every store, every row, tombstones included
importAll(snapshot: Snapshot): Promise<void>   // replaces the database wholesale
```

`Snapshot` is a versioned envelope — a format version, the `DB_VERSION` it was cut at, and one array
per store of the row shapes `lib/db/schema.ts` already defines. Two implementation notes that belong
in the interface's doc comment: `importAll` is destructive by contract (this is restore, not merge —
merge is `backend.md`'s sync), and both methods are the only members of the interface allowed to see
`deletedAt !== null` rows. `backend.md` B5 widens the same file for the change feed, so whichever
lands first, the other rebases; do not build two parallel export surfaces.

**Unverified, and it needs a Mac.** Register #13 — whether `persist()` is honoured in Safari for a
non-installed site, and current Firefox group limits — cannot be answered in this container. The check
is two lines: call `persist()` then `persisted()` in a real Safari tab and in an installed web app,
and read what each returns. Until someone runs it, the warning copy for Safari must be written from
the pessimistic assumption (not persisted, seven-day cap applies) and the phase must record in
`HANDOFF.md` that it is unrun.

**Files.** `src/pwa/install.ts`, `src/pwa/persist.ts`, `lib/db/export.ts` and `lib/db/import.ts` (the
names `backend.md` §2 already cites), `lib/db/repository.ts` and `lib/db/dexie.ts` (the two methods
above), `public/manifest.webmanifest` (`theme_color` / `background_color` from `core.md` C0's
tokens), `tests/unit/pwa/**`, **`tests/unit/db/backup.test.ts`** (new), `tests/e2e/p6/pwa.spec.ts`.

**`tests/unit/db/import.test.ts` already exists and is not this feature's test.** It is the
import-*surface* guard: it asserts PLAN.md §3.3's rule that importing anything under `lib/db` under
Node must not throw and must not open a database, checking `getDb`, `getRepository` and
`DB_VERSION === 3`. That rule is one CLAUDE.md states as non-negotiable. The obvious filename for
`lib/db/import.ts`'s test collides with it, so the round-trip test is
`tests/unit/db/backup.test.ts` and **`tests/unit/db/import.test.ts` is not touched by this phase.**

**Acceptance criteria.**

- Unit: export → wipe the database → import → every card, review, list and setting is byte-identical
  **through `exportAll()`**, tombstones included, with a soft-deleted list and a soft-deleted list
  member in the fixture. A round trip that drops soft-deleted rows is a round trip that resurrects
  deleted cards on the next sync — and it must be provable without reaching past the seam into Dexie.
- e2e in Chromium: `navigator.storage.persisted()` returns `true` after the app has been used, or the
  spec records what it returned and why. Chromium's heuristics mean this may legitimately be `false`
  in a headless run — **assert the code path ran, and record the returned value**, rather than
  asserting a browser policy this container cannot control.
- e2e: with `display-mode: standalone` emulated, the install affordance is absent; without it and
  with a captured `beforeinstallprompt`, it is present. Both are observable in Chromium.
- The manifest still passes `tests/unit/pwa/manifest.test.ts`'s field checks and its icons still 200.
- **Record in `HANDOFF.md`:** whether register #13 was run, on what, and what it returned. "Not run —
  no Mac" is an acceptable entry; silence is not.

---

### W6 — Fonts, and the first-load budget as one number

**Builds.** The delivery mechanism for the three families `core.md` C0 names, and the number that
tells the owner whether the web build is defensible.

STACK §2.1 is blunt about why this is a web phase and not a shared one: *"On native those are
app-package bytes and nobody notices. On the web they are first-load bytes on top of the
dictionary."* The settled visual language asks for Noto Serif SC for hanzi, Newsreader for Latin
display and DM Sans for UI; full Noto SC OTFs are 4.5–9 MB **per weight**, and the Android audit says
slim 0.7–1.4 MB subsets will not cover 124k CC-CEDICT headwords. `core.md` C0's `pnpm font:coverage`
produces the coverage facts; this phase produces the bytes and the budget.

**The mechanism** is `unicode-range`-split subsets, self-hosted, so a page downloads only the blocks
it renders. Self-hosted rather than a font CDN, for three reasons that all matter here: an
offline-first app cannot depend on a third origin, the service worker's cache rules are written for
same-origin responses (`response.type === 'basic'` is the existing storability test), and Capacitor
and Tauri ship the same files from a local scheme where a CDN is simply unreachable.

**The font files go through the module graph, not through `publicDir`, and this is load-bearing.**
W3's cache-first rule 2 is a *path prefix* over Vite's hashed asset directory. Files under
`public/fonts/` are copied to the dist root verbatim, keep their authored names, get no content hash,
and are matched by rule 2 (wrong prefix) and rule 3 (not a navigation) — that is, by nothing, so the
worker never stores them and the "zero font requests on second load" criterion below cannot pass.
**Reference every face from `src/styles/fonts.css` with a relative `url()`** so Vite emits it into
the hashed asset directory that rule 2 already covers, and put the sources under `src/fonts/`, not
`public/fonts/`. The alternative — keeping them in `public/` and adding a fourth worker rule
(`url.pathname.startsWith('/fonts/')` → cache-first, immutable) — works too, but it means unhashed
immutable caching, which is the thing the whole policy avoids. Take the hashed path; if for some
tooling reason you cannot, add the fourth rule to `scripts/sw.template.js` **and** its own test, and
say so in `HANDOFF.md`.

**The budget, stated as one number** and written into `HANDOFF.md`: entry bundle + CSS + the font
weights actually used at their subset sizes + the dictionary transfer (`data.md`'s number; STACK §2.5
estimates ~15 MB brotli, measured at 15.4 MB for the 47.2 MB file). Break it into *first paint*,
*first useful interaction* and *fully offline-capable*, because they are three different numbers and
only the last one includes the dictionary. Then decide, with the number visible, whether the hanzi
face ships at one weight or two.

**A dependency worth naming here rather than in the risk list.** Register #4 — the reported 10 MB
per-file OPFS cap in WKWebView, from a single third-party source — decides whether the web dictionary
path works on Safari at all. If it is real, the budget above is moot on one of the two engines that
matter and `data.md`'s fallback (`sqlite3_deserialize` in-memory, or the bare-table variant) changes
the number. The check is `data.md`'s and needs a Mac; this phase cites it and does not wait for it.

**Files.** `src/styles/fonts.css`, the subset font files under `apps/app/src/fonts/` (referenced from
that stylesheet, so Vite hashes them — see above), `scripts/font-subset.ts` (or the chosen tooling,
documented), `scripts/font-coverage-check.ts` (the cmap assertion below), `vite.config.ts`.
`scripts/sw.template.js` is **not** in this list on the hashed path: rule 2 already covers the
emitted files. It is in the list only if the `public/fonts/` fallback is taken.

**Acceptance criteria.**

- A Playwright spec loads the app with the network throttled and asserts no request to a third-party
  origin is made for a font. `grep -rn "fonts.googleapis\|fonts.gstatic" apps/` returns nothing.
- **Coverage is asserted against the fonts' `cmap` tables, not against rendered width.** A missing
  glyph renders as `.notdef` — the tofu box — which has a *non-zero* advance width, so a
  "width > 0" assertion passes on precisely the failure it is written to catch, and this is the
  phase's only real check on the risk STACK register #9 and AUDIT 2 both flag ("slim subsets
  (0.7–1.4 MB) will NOT cover 124k CC-CEDICT entries"). So: take the headword character set that
  `core.md` C0's `pnpm font:coverage` already extracts, read the `cmap` of **every shipped subset
  file, per face and per weight**, and assert the union covers the set — failing with the list of
  uncovered codepoints, not a boolean. A browser render of a sample passage stays as a spot check;
  if a rendered assertion is wanted alongside it, compare each character's advance against the same
  character rendered in a deliberately fallback-only stack, since an identical width means the
  subset supplied nothing.
- The budget table is in `HANDOFF.md` with real byte counts from `dist/`, not estimates.
- Second load of the same page issues zero font requests (the service worker's cache-first rule
  covers them).

---

### W7 — Two origins: the app moves, and the marketing site is born

**Builds.** `app.<domain>` for the app, the apex for an Astro site, and the permanent guarantee that a
marketing deploy cannot touch the learner's storage.

**There is nothing to split.** The repo has no marketing content. That is the point of doing this now
rather than later: the service worker's scope, IndexedDB, OPFS and the manifest's identity are all
**per origin**, so moving the app to a subdomain after anyone has studied would lose everything, and
there is nothing to lose today (STACK's framing fact, and product-decisions §12). The whole cost of
the decision is a DNS record and a deployment.

The Astro site (STACK §6 pins 7.3.2) is a content site: what the app is, how to install it, the
licence notices that are already committed in `data/ATTRIBUTION.md` and `data/COPYING-*`, and a link
to `app.<domain>`. It is a workspace member, `apps/site/`, so it can consume the same `pnpm data`
output later if §5.7's word pages ever happen.

**What the split buys, restated so nobody merges the origins back for convenience** (STACK §2.6): a
bad `sw.js` or a storage-clearing mistake on the marketing side can never reach the origin holding the
flashcards; the access gate applies only to the app; a Content-Security-Policy, when one is written,
applies only to the app; and indexable HTML exists without dragging file-route conventions into an
SPA that has no other use for them.

**Indexable per-word pages are not built here, and the plan says why.** STACK §5.7 promotes them from
a remote risk to an open decision: for a Chinese dictionary, per-word pages are how every incumbent is
found. The middle path is that the Astro site statically emits `/word/<headword>` at the apex from the
same `pnpm data` output, **with the app unchanged**. The measurement that decides it is Astro's build
time and output size at 124,188 headwords, with HSK 1–6 (11,028 banded headwords in `data/hsk.json`)
as the fallback cut. Do not build them in this phase; **do** leave `apps/site/` able to read the data
output, and record the measurement as an open item.

**The licence rule applies to any public page.** `dict.json` is CC BY-SA 4.0 and a public page
carrying its content must carry the attribution and the modification notice visibly (PLAN.md §5).
`decomp.json` is LGPL-3.0-or-later and must never appear on a page that merges the two datasets.
Whatever the marketing site shows of the dictionary, it shows under those rules.

**Files.** `apps/site/**` (new Astro project), `pnpm-workspace.yaml`, DNS and two deployment
configurations, `docs/deploy.md` (two deployments, two checklists), `apps/app/public/manifest.webmanifest`
(`id`, `start_url`, `scope` stay `/` — they are origin-relative and correct on the new origin).

**Acceptance criteria.**

- **The apex 404s app paths** — it is a static site and genuinely can. **The app origin cannot 404
  anything**, and asserting that it does would fail on a correct deployment: W2 requirement 1 makes
  SPA fallback mandatory, so every path there returns 200 `index.html` (this is R7 restated). What
  the app origin asserts instead is that a marketing path renders the SPA's **not-found route**,
  checked by the same per-route DOM marker W2 introduced — content, not status.
- `navigator.serviceWorker.getRegistration()` on the apex returns nothing — the worker is scoped to
  the app origin only, and this is the guarantee the whole decision exists for.
- Installing the PWA from `app.<domain>` produces a standalone window whose `start_url` resolves on
  that origin.
- The apex renders `data/ATTRIBUTION.md`'s content, or links to a page that does, and the CC BY-SA
  attribution plus modification notice is visible on any page carrying dictionary content.
- `pnpm build` at the workspace root builds both deployables; a failure in one does not silently
  produce a partial deploy of the other.

---

### W8 — The wide shell's routing and keyboard model

**Builds.** The URL model and the key handling that `core.md`'s wide shell and (if it happens) its
palette both sit on. `core.md` C7 owns the shells and C9 owns the palette's components; this phase
owns the parts that are the router's job.

**The URL is the shared state.** The three tabs are three routes; the lookup query lives in the URL
(`?q=`), so the palette and the tab shell are two views of one source of truth and a screen genuinely
cannot tell which shell it is in — which is exactly what `core.md` C7's enforcement rule bought.
STACK §2.3 records that TanStack Router's typed search params would be nicer for precisely this and
that it was not chosen; plain `useSearchParams` with a small typed wrapper is the compromise, and if
typed URL state turns out to be central, §2.3 names the reversal condition.

**The keyboard model, as declared data.** A shortcut registry module — bindings are entries in a
table, not handlers scattered through components — for three reasons: a help sheet can be generated
from it, a test can assert no two bindings collide, and the palette can reuse the same table instead
of growing a second key system.

Keep the two sources of the bindings apart, because a fresh session needs to know which are the
owner's and which are this plan's. **product-decisions §10 asks for four:** Cmd/Ctrl+K (the slim bar
during a practice session, and by extension summoning the palette), **Enter** — §10's words are
"Practice is the first row and Enter starts it", which generalises to running the highlighted row —
**Cmd+Enter** to add, and **Tab** to ask the whole question. **Escape-to-close-and-restore-focus and
arrow traversal are this plan's additions**, required by the two rules below and by the keyboard-only
acceptance criterion: a palette a keyboard user can enter and not leave is a trap, and a list with no
arrow traversal cannot be driven without a pointer.

**Two rules that the product decision does not state and that must be designed, not assumed.**

1. **A binding without a modifier never fires while focus is in a text input** — except inside the
   palette's own input, which owns arrows, Enter and Escape by design. Otherwise typing 中 into the
   lookup box triggers navigation.
2. **Tab is a browser navigation key, and rebinding it is an accessibility hazard.** Scope
   "Tab asks the whole question" to the palette input only, give it a visible button equivalent, and
   make sure Escape always leaves. If a keyboard-only user can get into the palette and not out of
   it, the binding is wrong however good it feels with a mouse.

**Focus and scroll on navigation.** A document navigation moves focus and resets scroll; a client-side
one does neither, and an SPA that skips this is a screen-reader trap. On every route change: move
focus to the new view's heading, announce the route politely, and restore scroll (React Router
provides a scroll-restoration component — confirm it is exported by the installed 8.x rather than
assuming the v6 spelling). This is not optional polish; it is the thing SPAs are notorious for
getting wrong.

**And the honest sentence about what a browser cannot do.** Cmd+K works only when the app already has
focus. There is no global hotkey in any browser — Chromium issue 40749250 is open and AUDIT 4 states
it flatly — so the palette in a browser tab or an installed PWA is a search box with ambitions
(STACK §2.4's words). Summoning arrives with Tauri or not at all. **If the palette ships before Tauri,
its release note says so.**

**Files.** `src/routes.tsx`, `src/keys/registry.ts`, `src/keys/use-shortcuts.ts`,
`src/shell/route-announcer.tsx`, `src/shell/scroll-restoration.tsx`, and the `navigate` boundary
`core.md` C7's screens consume.

**Acceptance criteria, in two sets.** The palette may never be built (STACK §5.1, product-decisions
§10 "NOT YET DECIDED", R11), so the phase needs a definition of done that does not assume it.
**W8a alone closes the phase when §5.1 has not been decided**; W8b is run when `core.md` C9 lands.

*W8a — runnable with no palette:*

- A unit test over the registry asserts no two bindings share a key combination in the same scope,
  and that every binding has a human-readable description (the help sheet is generated, so an
  undescribed binding is a bug).
- A route change moves focus to the new heading and the announcer's live region contains the new
  route's name. Assert both.
- Scroll position is restored on back-navigation to a scrolled list.
- Playwright, keyboard only, no pointer: reach every tab and every primary action of the current
  shell, and prove rule 1 — with focus in the lookup input, an unmodified binding key types a
  character and does not navigate.

*W8b — requires `core.md` C9's palette:*

- Playwright, keyboard only, no pointer: open the palette, type, arrow to a row, Enter, Escape, and
  land back where you started with focus on a visible element.
- Escape always leaves the palette, from every row and from the input — rule 2's hard requirement.
- The same lookup URL (`/lookup?q=打算`) renders the same result in the tab shell and the palette —
  the URL-is-the-state criterion, and the mechanical proof that the two shells did not fork.

---

### W9 — Desktop: the PWA is the product, and the Tauri trigger is written down

**Builds.** A short phase, mostly a decision record plus two mechanical guarantees, so that adding a
Tauri shell later is a packaging job and not a porting job.

**The decision, restated because it is a sequencing decision and gets misread as a capability one**
(STACK §2.4): desktop v1 **is** the installed PWA from the same `dist/`. Zero extra build, zero extra
code. It gets a standalone window, a dock icon, offline operation, keyboard-first navigation, and —
the part that matters — a better storage regime: per AUDIT 4, a web app added to the Dock or Home
Screen is **exempt from Safari's seven-day ITP cap** and gets the browser-level quota, and in
Chromium an installed origin **that calls `persist()`** is effectively safe from LRU eviction. Both
halves carry the same hedge W5 carries and it must not be dropped here, because this is the section a
reader quotes when deciding desktop scope: **AUDIT 4 sourced those policy statements from search
summaries with webkit.org and MDN egress-blocked (R1)**, and the Chromium half is conditional on the
`persist()` call that W5 builds — an installed app that never calls it is not covered. Until Tauri
ships, do not describe the PWA as a differentiated desktop product. It is the same app, wider.

**The trigger for Tauri, written as a condition rather than a wish.** Build a Tauri 2 shell when all
three are true:

1. The wide shell has been used for a week of real study and reaching for Cmd+K is a reflex (STACK
   §5.1's test, and the owner's own call).
2. The global hotkey — the **only** capability Tauri adds that the installed PWA lacks — is worth
   roughly **$120/year marginal** (Windows Azure Artifact Signing at ~$9.99/month; Apple's $99/year is
   already spent by the App Store decision in §2.1 and is *not* a cost of this decision), plus a
   three-target CI pipeline, three rendering engines to test, and an update channel that can never be
   broken.
3. The primary desktop is not Linux/Wayland, where the global hotkey does not exist in any shell
   (tauri #3578, a protocol gap) and Tauri therefore buys nothing over the PWA.

**What the phase actually does now**, so the trigger stays cheap to pull:

- Writes `docs/desktop.md` with the trigger above, the pinned versions (`tauri` core 2.11.5,
  `tauri-cli` 2.11.4, `tauri-plugin-updater` 2.11.0, `tauri-plugin-sql` 2.4.1 — **pin**, because Tauri
  3.0.0-alpha.0 hit crates.io on 2026-09-13 driven by a GTK4 migration), the two storage hazards (the
  IndexedDB directory path changed between Tauri 1 and 2 and users lost data, tauri #11252; a second
  `Repository` implementation on `tauri-plugin-sql` is the conservative answer and `lib/db/repository.ts`
  exists for exactly that), and register #14 (whether the Mac App Store sandbox permits
  `RegisterEventHotKey`-based global shortcuts through Tauri's plugin — unverified, and it decides
  whether the shell can be distributed through the store at all or must be direct download).
- Keeps `dist/` shell-agnostic, which is the same requirement Capacitor has: **no absolute-origin
  assumptions** (no hard-coded scheme, host or port anywhere in the app or its assets), no dependency
  on a browser-only API on the critical path, and the API base configurable at build time. The
  default build's `base` stays `'/'` — which is what `capacitor://localhost/` and `tauri://localhost/`
  serve from, and what history routing requires (W1). W1 already asserts the separate
  `--base=/sub/` subpath build; this phase makes it a standing check so it cannot regress.
- Records what is **not** being bought: Electron, ever (STACK §2.4 — 85–120 MB download, 150–250 MB
  idle, and Tangram's UI is text and keyboard handling, which all three system engines do well).

**Acceptance criteria.**

- `docs/desktop.md` exists and states the trigger as three testable conditions, the pinned versions,
  and the two storage hazards. A reader who has never seen this conversation can decide whether to
  pull the trigger from that page alone.
- A CI-able check asserts the build has no absolute-origin assumption: serve the default build from a
  second port and boot it, and build once more with `--base=/sub/`, serve that output behind a
  `/sub/` prefix, and boot it. Same two checks as W1's, now standing.
- The installed PWA is verified on at least one desktop platform available to the owner: it installs,
  opens in a standalone window, works offline after a warm load, and `navigator.storage.persisted()`
  is recorded. **Chromium in the container can prove most of this; a real installed window cannot be
  proved here** — say which parts were verified where.

---

## 6. Risks

Each risk names the trigger that would tell you it is happening. The first five are things an audit
explicitly could not verify and that this plan depends on; each of those carries the check that
settles it.

**R1 — Every version and policy fact in AUDIT 4 rests on a search summary.** vite.dev,
reactrouter.com, tauri.app, nextjs.org, webkit.org, MDN and releases.electronjs.org were all
egress-blocked during that audit. Version numbers came from npm and crates.io and the React Router
changelog on GitHub raw, but the *statements* — Safari's quota exemptions, Chromium's `persist()`
heuristics, Next's export limitations, Tauri's notarization env vars — did not.
*Trigger:* any of them turns out to be stale the first time it is relied on.
*Check:* re-read the official docs from an unblocked network **before W1 starts**. STACK §4's register
#12 schedules the same visit for the Capacitor facts; do both in one sitting, it is minutes.
*Mitigation:* nothing in W0–W3 depends on a policy statement — they depend on the installed packages'
own types and behaviour, which are checkable locally.

**R2 — React Router 8's floors bite an environment that is not this container.** It requires
React >= 19.2.7 (this repo is on 19.2.8), Vite 7+ (target 8), **Node >= 22.22**, is ESM-only, and has
removed `react-router-dom`. The container is on v22.22.2 — one patch above the floor.
*Trigger:* a build image, a CI runner or a contributor's machine on Node 22.21 or below.
*Check:* `node -v` in every environment that builds, and `engines.node` enforced rather than
documented (W0).
*Mitigation:* W0 bumps `engines` and `.nvmrc` before anything imports the router.

**R3 — Tailwind 4 under Vite is unchecked.** STACK §7 names it as one of two things a build session
hits on day one and should not have to decide alone: Tailwind currently runs through
`@tailwindcss/postcss` and `postcss.config.mjs`, and the Vite plugin story is different.
*Trigger:* W1's first `pnpm build` emits no styles, or dev HMR stops updating CSS.
*Check:* try `@tailwindcss/vite` first; the existing PostCSS config is the fallback and Vite reads it
natively.
*Mitigation:* W1 requires the decision to be written into `HANDOFF.md` either way, so the next reader
does not re-derive it from a config file.

**R4 — `persist()` in Safari for a non-installed site is unverified (register #13).** It decides how
hard the app must push installation and how loudly it must warn a Safari visitor who has cards.
*Trigger:* W5 has to write the warning copy and nobody can say what the browser actually does.
*Check:* call `persist()` then `persisted()` in a real Safari tab and in an installed web app, and
read what each returns. **Needs a Mac; cannot run in this container.**
*Mitigation:* write the copy from the pessimistic assumption and record the check as unrun. The
export in W5 is the mitigation that does not depend on the answer.

**R5 — The reported 10 MB per-file OPFS cap in WKWebView (register #4).** One third-party source
(`wendylabsinc/opfs-checker`) against WebKit's published per-origin policy of 15–20% of disk for
non-browser apps. If it is real, the ~47 MB dictionary cannot be imported into `opfs-sahpool` on
Safari and the web dictionary path fails on one of the two engines that matter.
*Trigger:* the import throws or truncates on desktop Safari or on an iPhone.
*Check:* import the real file into `opfs-sahpool` on desktop Safari and on an iPhone, before
committing to the web dictionary path. **`data.md` owns the check; it needs a Mac.**
*Mitigation:* `data.md`'s fallbacks — `sqlite3_deserialize` in memory (~45 MB of wasm heap) or the
bare-table variant. Either changes W6's budget, which is why W6 cites the register entry instead of
freezing a number.

**R6 — The first-load budget is indefensible.** Three font families, hanzi faces at 4.5–9 MB per full
weight, and a ~15 MB brotli dictionary on top. STACK §2.1 asks for the budget to be stated as one
number *before* committing to it, and §2.4 makes the installed PWA the entire desktop product while
§2.6 makes the web the funnel — so the number is load-bearing twice.
*Trigger:* W6's table sums to something the owner would not download.
*Check:* `core.md` C0's `pnpm font:coverage` (no hardware needed, run first) plus real byte counts
from `dist/`.
*Mitigation:* `unicode-range` subsets, one hanzi weight instead of two, and the dictionary behind a
banner and an explicit action rather than on first paint.

**R7 — The SPA fallback makes the smoke test unfalsifiable.** With every path returning 200
`index.html`, a status-only smoke passes against a build whose entry chunk 404s, and against routes
that no longer exist. This is the same class of failure as the untraced routes that shipped before —
a guard that looks green and checks nothing.
*Trigger:* a broken build passes `pnpm smoke`.
*Mitigation:* W2 asserts rendered per-route markers, not statuses, and proves it by deleting the entry
chunk and watching the smoke fail. That deliberate-failure demonstration is an acceptance criterion.

**R8 — The service worker caches the dictionary, or a stale `index.html`.** The first doubles tens of
megabytes on the most fragile storage the app has; the second is the exact failure the current
worker's network-first navigation rule was written to prevent, and it survives the move because one
`index.html` referencing dead hashed assets is worse than seven.
*Trigger:* `caches.keys()` contents include the dictionary artifact, or the first load after a deploy
renders a page that never hydrates.
*Mitigation:* W3's explicit deny rule with a test on the cache's actual entries, and network-first
navigations kept verbatim with their original reasoning.

**R9 — The four-casualty ledger loses one silently.** The tracing map is the likeliest, because its
purpose evaporates only *if* §5.5 resolves so that the client sends retrieved entries and the server
holds no dictionary. STACK §2.2 warns explicitly: if the server keeps its own copy of the SQLite
file, the cold-start and memory problem moves rather than vanishing and the plumbing returns in a new
form.
*Trigger:* `backend.md` decides the server keeps a dictionary, after `next.config.ts` and
`tests/unit/server/routes.test.ts` have been deleted.
*Mitigation:* W1's rule — delete the config and its guard in the same commit as the thing they
guarded — and W2's handover note making the API-side route-coverage check a named `backend.md`
deliverable.

**R10 — The client's credential and the server's CORS allowlist disagree.** Not the cookie: on the
web a `Domain=<apex>` cookie *would* cross from `app.<domain>` to `api.<domain>`, since they share a
registrable domain. The real failure is that W4's header (`X-Tangram-Access`) is a custom header, so
every cross-origin gated `POST` is preflighted, and a server that does not list it in
`Access-Control-Allow-Headers` — or that does not answer `OPTIONS` at all — 401s or blocks
everything. The Capacitor origins make the header mandatory rather than merely convenient: a WebView
on `capacitor://localhost` is genuinely cross-site to the API and would get no cookie.
*Trigger:* the gate works in development (same origin, no preflight) and fails everything in
production or in the phone build.
*Mitigation:* the header name is fixed in W4 and written into `HANDOFF.md` as the contract
`backend.md` consumes, and W4's criterion 6 runs the client against an API base **on a second local
port with a CORS allowlist**, asserting the preflight is answered before any of this is deployed.

**R11 — The palette gets built before it has earned its place.** STACK §2.4 states plainly that the
palette is not a v1 goal, because summoning needs a global hotkey and no browser can register one;
§5.1's test is a week of real study.
*Trigger:* `core.md` C9 starts before C7 has been used for a week, or before the owner has chosen.
*Mitigation:* W8's routing and keyboard layer is useful in either shell and lands first — W8a's
acceptance criteria close the phase with no palette in existence, and W8b's run when C9 lands. The
palette's *components* are C9's and are gated on §5.1; nothing in this plan is.

**R12 — The SEO condition fires and reverses three decisions at once (STACK §5.7).** For a Chinese
dictionary, per-word pages are the primary organic acquisition surface. If the *app* pages must be
indexed, the SPA (§2.2), the separate Astro site (§2.6) and part of §2.5 all reopen and the answer is
React Router framework mode with `prerender`.
*Trigger:* the owner wants `/word/打算` to be a crawlable page.
*Check:* the middle path first — Astro static word pages at the apex from the same `pnpm data`
output, with the app unchanged. **The measurement that decides it is Astro's build time and output
size at 124,188 headwords**, with HSK 1–6 (11,028 banded headwords already in `data/hsk.json`) as the
fallback cut. Nothing in the audits touched it.
*Mitigation:* W7 leaves `apps/site/` able to read the data output, which is what keeps the middle
path cheap.

**R13 — "Two to four days" is read as the cost of this plan.** It is the cost of W1 and W2, scoped by
STACK §2.2 to the client-side move with the server already existing, and it excludes the smoke
rewrite the audit did not itemise.
*Trigger:* a schedule built on it.
*Mitigation:* §5 opens by saying so. The dev/preview adapter is the reason W1 can hold to the number
despite the server not existing; everything after W2 is separate work.

## 7. Out of scope for v1

- **A Tauri shell**, until W9's three conditions are all true. Its only new capability is the global
  hotkey; everything else desktop needs, the installed PWA already has. Deferring it also defers
  three rendering engines to test, a signing subscription, and an update channel that can never be
  broken.
- **Electron, permanently** (STACK §2.4). 85–120 MB download and 150–250 MB idle against a UI that is
  text, fonts and keyboard handling, which all three system WebViews handle well; and the offline
  dictionary is precisely the thing that makes footprint matter more than usual.
- **SSR, prerendering, and React Router framework mode.** The app is a stateful client app with a
  local database; there is nothing to render on a server. §2.2 and §5.7 name the one condition that
  reverses this and it is filed as R12, not as a maybe.
- **Indexable per-word pages**, until the Astro build-time measurement in R12 has been taken. The
  middle path keeps them out of the app entirely, which is why deferring them costs nothing.
- **TanStack Router.** Genuinely nicer for typed search params, which the palette's query does use —
  but it costs a codegen Vite plugin and a dependency shipping several releases a week, against a
  router that is three tabs and a palette. §2.3 names the reversal condition.
- **`vite-plugin-pwa`.** The policy is the interesting part of this worker and a generated precache
  manifest does the wrong thing with a 15 MB dictionary by default. Recorded in W3 as the fallback if
  the hand-written worker becomes a drag, so the option is not rediscovered from scratch.
- **A Content-Security-Policy.** There is none in this repo today. W7 is what makes writing one cheap
  — after the split it applies to the app origin only — but writing it is not this plan's work, and a
  CSP shipped before the origins split would have to cover a marketing site too. **Note the one thing
  that makes it less deferrable than it was:** W4 moves the access secret from an `HttpOnly` cookie
  into script-readable storage, and a CSP is the mitigation that would normally offset that. The
  offsetting argument W4 relies on instead is that the gate protects spend on three routes, not
  learner data, and dies with real accounts. If it ever protects anything else, write the CSP first.
- **Multi-tab support.** `opfs-sahpool` holds an exclusive lock, so it is one connection per origin
  and a second tab must fall back to an in-memory database or a SharedWorker (STACK §2.5, hard part
  3). `data.md` owns the fallback; this plan does not design a multi-tab experience around it.
- **Firefox as a first-class install target.** No desktop PWA install, `persist()` prompts rather than
  granting silently, and its current group limits are unconfirmed. It should work; it is not what the
  storage story is designed around.
- **A Trusted Web Activity on Android and a Microsoft Store listing via PWABuilder.** Both are cheap
  extra distribution channels for the same PWA (AUDIT 2 says as much about TWA), and neither is the
  product. Revisit once the app is worth distributing.
- **Host-level authentication on the app's HTML.** The gate has always covered three API routes and
  never the page shell; W4 makes that visible rather than changing it. If the HTML itself must be
  private, that is basic auth at the host, and it is a deployment decision, not application code.
