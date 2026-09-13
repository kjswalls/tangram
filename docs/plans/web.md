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
service worker cannot be built without `.next/`, and its offline story is a browser tab that Safari
evicts after seven days.

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
| Capacitor projects, native plugins, the Android hardware back button, fonts inside an app package | `ios.md`, `android.md` | Those plans consume this plan's `dist/`. This plan owes them a build that works from a non-`/` origin and a `navigate` boundary they can drive. |
| The server itself — framework, host, auth, sync, key custody, the new `/api/ask` request contract | `backend.md` | This plan owns only the *transport*: the configured API base, credentials mode, and the gate's client half. What is behind the base URL is not its business. |
| List import (clipboard / Pleco / Anki) | its own task, per STACK §7 | Scoped separately by product-decisions §9. |

**One thing this plan decides that STACK §2.2 explicitly left open: sequencing.** STACK §2.2 says the
Vite move and the SQLite move both touch `lib/dict/**` and `app/api/dict/**`, that nothing has
decided which lands first, and that the build plan must decide it explicitly. **Vite lands first.**
Three reasons. Everything after it is built on the new build system, and `core.md`'s own dependency
table says its C1 cannot start without a Vite + React Router skeleton. `@sqlite.org/sqlite-wasm` in a
dedicated worker with a `.wasm` asset is a bundler integration, and doing it twice — once against
Turbopack, once against Rolldown — is the only way to pay for it twice. And the argument for
dictionary-first (it deletes five routes the migration would otherwise carry) evaporates because of
W1's dev/preview API adapter: the eight existing handlers already take a standard `Request` and
return a standard `Response`, so carrying them across costs a plugin, not a rewrite.

## 3. What exists today

Read at `HEAD` of `claude/apps-ui-design-791zpq`. Everything below is a fact from the repo, not a
recollection.

**The build.** Next 16.3.4 with the App Router, React 19.2.8, Tailwind 4 through
`@tailwindcss/postcss` and `postcss.config.mjs`. `pnpm build` is
`pnpm data:ensure && next build && pnpm sw`. `engines.node` is `>=20.9`; `.nvmrc` says `22`; the
container is on **v22.22.2**. `@vitejs/plugin-react` **6.1.1** is already a devDependency (vitest uses
it) and declares `vite: ^8.0.0` as a peer — **Vite itself is not installed**, so adding it satisfies
a peer that is currently unmet.

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

**The API.** Eight route handlers, each `export async function GET|POST(request: Request):
Promise<Response>` — Web-standard signatures with no Next types in them. Five are dictionary routes
(`dict/decomp`, `dict/entries`, `dict/hsk`, `dict/search`, `dict/segment`); three reach a paid model
(`ask`, `examples`, `recall`). Nine files carry `export const dynamic = 'force-dynamic'`.
`lib/dict/client.ts` is the typed fetcher: same-origin relative paths, with an optional `baseUrl`
for server and test callers, and a `DictRequestError` whose `dataMissing` flag drives the banner.

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

**The PWA.** `public/manifest.webmanifest` (`id`/`start_url`/`scope` `/`, `display: standalone`,
`theme_color: #0f766e`, three icons in `public/icons/`, one `purpose: maskable` entry).
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

**Marketing.** There is none. No landing page, no apex content, nothing to migrate. §2.6's "separate
deployment" is therefore not a split of anything — it is a decision about origins taken at the only
moment it is free.

## 4. Dependencies

| Needs | From | State it must be in |
|---|---|---|
| CLAUDE.md rewritten with the new command set and settle-first list | orchestrator, STACK §7 | **Before W0.** Today's CLAUDE.md documents `next dev`, `next build`, `.next/BUILD_ID` and a frozen-file list containing `next.config.ts` and `app/layout.tsx`. It is auto-loaded project instruction and outranks this plan until it changes. |
| Nothing at all from `data.md`, `core.md`, `ios.md`, `android.md` or `backend.md` | — | W0–W3 are pure build-system work in the Linux container. STACK §4 is explicit that everything web and desktop proceeds without a Mac or a phone. |
| The dictionary artifact's name and extension | `data.md` | **Before W3 ships.** The service worker must be told, by rule, never to cache it; a 15 MB brotli file in the HTTP cache *and* in OPFS is the same bytes twice. |
| `DictStore` readiness signal replacing the `/api/dict/hsk` HEAD probe | `data.md` (this is `core.md`'s R11) | Before W2's smoke asserts the banner's behaviour. Until then the dev/preview adapter keeps the probe answering. |
| The API base contract: origin, credentials mode, and where `lib/server/access.ts` lives | `backend.md` | **W4 defines the client half against the dev/preview adapter and hands the server half over.** W4 can complete without `backend.md` having started; it cannot be *deleted* until `backend.md` implements the same module. |
| `core.md` C0's font-coverage numbers | `core.md` | Before W6. The budget cannot be stated without them. |
| `core.md` C7's shells and screens | `core.md` | Before W8. W8 routes to screens that must already exist and must already be shell-agnostic. |
| The `core.md` §5.1 decision (page shell vs palette) | owner, after a week of real study | Before W8's palette half. W8's routing and keyboard layer is useful either way and can land first. |
| A Mac with desktop Safari | hardware, STACK §4 | For register #13 (`persist()` in a non-installed Safari tab) and register #4 (importing the real dictionary into `opfs-sahpool`). **Neither can run in the container**, and register #4 gates the whole web dictionary path, not only mobile. W5 and W6 record them as unrun rather than claiming them. |

**The hard ordering constraint against the sibling plans:** W0 relocates every path in the repo, and
`core.md` states that it writes today's paths and expects `web.md` to relocate them once,
mechanically. **W0 must therefore be the first commit after the CLAUDE.md rewrite, before `core.md`'s
C0.** W1 must land before `core.md`'s C1. Nothing else in this plan blocks anything else in that one.

## 5. Phases

Every phase ends the way PLAN.md §4 says: `pnpm lint`, `pnpm test`, the phase's e2e specs green, an
adversarial review, a commit. Each phase below adds acceptance criteria that are executable or
observable. Where a criterion is a measurement nobody has taken, it says so and names the number to
record rather than pretending a threshold was validated.

**The migration estimate, stated once.** AUDIT 4 put "rewriting `app/**` pages into route components,
replacing `next/link`/`useRouter`, moving three POST routes plus the gate to a small server, and
rewriting `build-sw.ts`" at **two to four focused days with AI assistance**, and STACK §2.2 scoped
that to the client-side move with the server already existing. That number is **supported for W1 and
W2 and for nothing else in this document.** W1's page and router work is genuinely small — nine files
import `next/*`, the route handlers are already Web-standard, and the tests carry over — and the
dev/preview adapter that replaces "the server already existing" is a plugin, not a service. The
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

**The part that actually breaks is path arithmetic, not the move.** These compute a repo root by
counting `..` and will be silently wrong afterwards: `scripts/build-sw.ts` (`resolve(dirname(...),
'..')`), `scripts/smoke.ts` (`resolve(fileURLToPath(import.meta.url), '../..')`),
`lib/server/route-inventory.ts` (takes `repoRoot` from its callers),
`tests/unit/server/routes.test.ts` (`resolve(__dirname, '../../..')`),
`tests/unit/pwa/manifest.test.ts` (`resolve(import.meta.dirname, '../../..')`),
`tests/unit/deps.test.ts` (`join(dirname(...), '..', '..')`), `tests/e2e/d/access-gate.spec.ts`
(`new URL('../../..', import.meta.url)`), `lib/dict/load.ts` (`resolve(process.cwd(), 'data')`).
Each one either moves with its file and keeps working, or is wrong in a way no type checker sees.

Also here, because they are one-line config facts that W1 should not have to argue: `engines.node`
becomes `>=22.22`, which React Router 8 requires (STACK §2.3, read from the changelog) and which the
container already satisfies at **v22.22.2** — one patch above the floor, which is worth noticing
because any build image on 22.21 fails. `.nvmrc` becomes `22.22`.

**Files.** `pnpm-workspace.yaml` (new), `package.json` (root: workspace scripts, `engines`, `.nvmrc`),
`apps/app/package.json` (the current one, minus what belongs at the root), and a `git mv` of `app/`,
`components/`, `lib/`, `public/`, `scripts/`, `tests/`, `middleware.ts`, `next.config.ts`,
`tsconfig.json`, `eslint.config.mjs`, `postcss.config.mjs`, `vitest.config.ts`,
`playwright.config.ts`. `data/`, `docs/`, `PLAN.md`, `HANDOFF.md`, `CLAUDE.md` stay at the root.

**Acceptance criteria.**

- `pnpm build`, `pnpm lint`, `pnpm test` and `PORT=3000 pnpm e2e` all pass from the workspace root,
  with the same test counts as before the move. **A changed test count is a failed phase**: this
  phase changes no behaviour.
- `git log --stat` for the phase shows renames and configuration edits only. `git diff -M --stat`
  reports no file with substantive content change outside the config files listed above.
- `pnpm smoke` against the built server still passes, which proves the `../..` arithmetic in
  `scripts/smoke.ts` and `route-inventory.ts` survived.
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
`<main>`) becomes the root route element. **Set `base` to a relative form**, because Capacitor and
Tauri serve the same `dist/` from a custom scheme or `http://localhost`, not from an apex path — get
this wrong now and both mobile plans discover it later.

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
This works because every handler already has the signature `(request: Request) => Promise<Response>`
with no Next types in it — that is a fact of the current code, not a hope. It reuses
`discoverApiRoutes()` from `lib/server/route-inventory.ts` to find them, so the inventory machinery
that STACK §2.2 calls "the fifth, smaller casualty" survives its first crossing.

Be clear about what this adapter is and is not. **It is a bridge, not a product.** It exists so that
`/api/dict/*` keeps answering until `data.md` deletes those five routes, and so that `/api/ask`,
`/api/examples` and `/api/recall` keep answering until `backend.md` has a server. It never ships: it
is dev- and preview-only, it is not in `dist/`, and the phase that removes the last handler removes
it too.

*4. The harness, minimally.* `playwright.config.ts`'s `webServer.command` becomes
`pnpm build && pnpm preview --port $PORT` (AUDIT 4 says this is the only change Playwright needs; the
adapter is what makes it true). `vitest.config.ts` needs nothing — it already uses
`@vitejs/plugin-react` and the `@` alias, and vitest 4.1.11 accepts Vite `^6 || ^7 || ^8`.
`tests/e2e/c/sw-version.spec.ts` and `tests/e2e/d/access-gate.spec.ts` are Next-shaped and are
updated here to the extent needed to keep them green; their real rewrites are W3 and W4.

**Files.** New: `apps/app/index.html`, `vite.config.ts`, `src/main.tsx`, `src/routes.tsx`,
`vite-plugins/api.ts`. Rewritten: the eight page modules (into `src/routes/**`), `app/layout.tsx`'s
composition, the nine files importing `next/*`, `package.json` scripts, `tsconfig.json` (drop the
`next` plugin, `next-env.d.ts`, the `.next/types` includes), `eslint.config.mjs` (`eslint-config-next`
out; a plain typescript-eslint flat config in). Deleted: `next-env.d.ts`. `middleware.ts` stops
running the moment Next goes and is dead code from here until W4 deletes it — say so in a one-line
header rather than leaving a live-looking gate that does nothing. `next.config.ts` is a special case:

**`next.config.ts` must not be deleted early.** It also carries `outputFileTracingIncludes`, and
`tests/unit/server/routes.test.ts` imports it to prove no dictionary-reading route ships without its
data. That guard exists because `/api/examples` and
`/api/recall` shipped untraced and a human found it. **Delete the config and the test that guards it
in the same commit as the thing they guarded** — that is, when `data.md` deletes the dictionary
routes and `backend.md` owns the rest. Until then W1 keeps `next.config.ts` on disk purely as the
data the test reads, with a header saying so, or moves the four keys into a plain
`apps/app/tracing.config.ts`. Either is fine; silently dropping the test is not.

**Acceptance criteria.**

- `pnpm build` produces `apps/app/dist/` containing `index.html`, hashed assets, and no Next runtime.
  `grep -rn "next" apps/app/package.json` returns nothing.
- `grep -rn "from 'next" apps/app/{src,components,lib,app,tests,scripts}` returns nothing.
- `pnpm test` passes with a test count that differs from W0's only by the `deps.test.ts` table change
  and any spec explicitly listed in the commit message.
- `PORT=3000 pnpm e2e` passes the full suite, including `tests/e2e/smoke.spec.ts`'s seven routes and
  `tests/e2e/d/smoke.spec.ts`'s `runSmoke` over all eight API routes. The API cases passing is the
  proof that the adapter works.
- A hard refresh of a deep route (`/lists/<id>`) served by `vite preview` renders the list, not a
  404 — i.e. SPA fallback is on. Assert it in a spec, because it is a host behaviour that W2 has to
  reproduce in production and the preview server's default hides it.
- Serving `dist/` from a subpath (e.g. `python3 -m http.server` behind a `/sub/` prefix, or the
  preview server's `base`) still boots the app. This is the Capacitor/Tauri criterion and it is
  cheap to check now and expensive to discover later.
- **Record in `HANDOFF.md`:** production bundle size (total, and the entry chunk), and `pnpm build`
  wall time against Next's measured 28 s for `next build` + `pnpm sw` (`docs/deploy.md`). Nobody has
  a Vite number; this is the first one.

---

### W2 — The built server is provably correct: host config, and the smoke machinery rebuilt

**Builds.** The two things a static SPA can get wrong that no unit test sees — the host's routing
and the host's headers — plus the replacement for the machinery that used to catch exactly this class
of bug.

*Host configuration.* Three requirements, expressed in whatever the chosen host's static config is
(today that is Vercel and a `vercel.json`; the host choice belongs with `backend.md` and the
orchestrator, the requirements do not):

1. **SPA fallback** — every navigation that is not a real file returns `index.html`.
2. `/manifest.webmanifest` served as `application/manifest+json; charset=utf-8`. Some installability
   checks refuse anything else; that is why the header exists today.
3. `/sw.js` served as `text/javascript; charset=utf-8` with `Cache-Control: no-cache, no-store,
   must-revalidate` and `Service-Worker-Allowed: /`. A worker at the root must be revalidated or a
   bad one is permanent.

*The smoke machinery.* `lib/server/route-inventory.ts` and `scripts/smoke.ts` exist because a route
can ship untraced and only a person opening the page notices. Their *purpose* — "every route is
exercised over HTTP on a built server" — survives; their implementation does not. It splits in two:

- **The SPA half, here.** `pnpm smoke` boots the built app and requests every entry in
  `src/routes.tsx` (derived, never copied — this is the same discipline that made `PAGE_CASES` read
  `NAV_ITEMS`), plus `/manifest.webmanifest`, `/sw.js` and `/offline.html`, and asserts the three
  header rules above. **It must assert rendered content, not status codes.** With SPA fallback
  everything returns 200 `index.html`, including routes that no longer exist and builds whose entry
  chunk 404s — a status-only smoke on an SPA is a test that cannot fail. Drive it with Playwright
  and assert a per-route marker in the DOM.
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

**Files.** `apps/app/vercel.json` or equivalent, `scripts/smoke.ts` (rewritten),
`lib/server/route-inventory.ts` (reduced to what the adapter and the coverage check still need),
`tests/unit/server/routes.test.ts` (rewritten around the route table and the host config),
`tests/e2e/d/smoke.spec.ts`, `docs/deploy.md` (rewritten for a static deployment).

**Acceptance criteria.**

- `pnpm smoke` fails when a route is added to `src/routes.tsx` with no case — demonstrate it by
  adding one, watching it fail, and removing it. The coverage half is what survived the last person;
  it must survive this one.
- `pnpm smoke` fails when the entry chunk is deleted from `dist/` — the deliberate proof that the
  content assertion is real and a 200 is not enough.
- A unit test parses the host config and asserts SPA fallback plus the three header rules. Deleting
  any one of them fails the test.
- `docs/deploy.md` describes a static deployment: what is uploaded, what the headers are, where the
  API base points, and an after-deploy checklist that ends in `pnpm smoke --base-url`.

---

### W3 — The service worker, stamped from Vite's own output

**Builds.** The replacement for `.next/BUILD_ID`, and the cache policy rewritten for a single-document
SPA with hashed assets.

**The stamp.** There is no `BUILD_ID` in a Vite build (STACK §2.2). Turn on Vite's build manifest and
stamp the worker with a **content hash over that manifest** rather than a random per-build id. This
is strictly better than what it replaces: `BUILD_ID` changes on every build, so a rebuild with
identical output purged a cache for nothing; a manifest hash changes exactly when the output changes,
which is what `scripts/build-sw.ts`'s own header says it always wanted. Keep the rest of that script
verbatim — the placeholder, the `[A-Za-z0-9_-]{1,64}` refusal, the "template is deliberately not
under `public/`" rule, the `dev` fallback. Read the manifest's exact filename off the installed Vite
rather than assuming it.

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
2. `/_next/static/**` becomes Vite's hashed asset directory. Cache-first with no revalidation, same
   reasoning: content-hashed paths mean a hit is always correct.
3. Navigations stay **network-first**, and the reason survives the move intact. Under SPA fallback
   there is one document, so a stale cached `index.html` references `assets/<old-hash>.js` that the
   new deployment no longer serves — the exact failure the current header describes, with one
   document instead of seven. `SHELL` therefore collapses from the seven nav routes to `/`,
   `/offline.html`, and the entry chunk and stylesheet read out of the build manifest.

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
with it **unchanged**. That module was written not to import `next/*`, on purpose, so that middleware,
handlers and tests ran one implementation; that decision is what makes this move free. It lands in a
shared workspace package that the dev/preview adapter imports today and `backend.md`'s server imports
tomorrow.

Its first job — trading `?key=<secret>` for a credential on a phone — needs a new mechanism, and the
right one is smaller than what it replaces. `access.ts`'s header states the reason for the cookie
exactly: *"a phone browser cannot set a request header."* In an SPA, JavaScript sets the header. So:
the client reads `?key=` at boot, keeps the secret, strips the parameter out of the URL exactly as
the middleware's redirect did (so it is not left in history, in a bookmark or in a `Referer`), leaves
`?access=granted|denied` behind as the only feedback a phone with no devtools can read, and sends the
secret as a request header on every call to the API base. `constantTimeEqual`, `accessSecret`,
`isAuthorizedValue` and `GATED_PATHS` are all reused; `accessCookie`, `clearAccessCookie` and
`readCookie` are deleted, and so is the `?key=` handling in `middleware.ts`.

**Two consequences to state rather than discover.** First, a cookie cannot cross from `app.<domain>`
to `api.<domain>` without third-party-cookie handling that Safari blocks by default — so the header is
not merely simpler, it is the only thing that works after W7 splits the origins. Second, **the gate
never protected the page HTML and now visibly does not.** The current matcher already excludes
`_next/static`, `sw.js`, `offline.html` and the manifest; a static host serves the shell to anyone who
asks. If the app's HTML itself must be private, that is host-level basic auth, not application code —
say which, in `docs/deploy.md`, rather than letting a reader assume the gate covers more than the
three paid routes it has always covered.

Also here: `lib/dict/client.ts` and the ask/examples/recall callers gain a configured base
(`import.meta.env.VITE_API_BASE`, empty in development so same-origin still works), and the
credentials/CORS mode is written down once. `backend.md` owns the server's CORS allowlist; this plan
owns the client's half and the fact that the two must agree.

**Files.** `middleware.ts` (deleted), `lib/server/access.ts` (moved to a shared package,
content unchanged apart from the deleted cookie helpers), new `src/access/client.ts`,
`lib/dict/client.ts`, `lib/ai/*` call sites, `tests/unit/server/access.test.ts`,
`tests/e2e/d/access-gate.spec.ts` (rewritten to drive the preview server with the secret set instead
of spawning `next start`).

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
- `tests/unit/server/access.test.ts` passes with the cookie helpers removed and nothing else changed.
- `grep -rn "next/server" apps/` returns nothing and `middleware.ts` no longer exists.

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
   `ios.md` and `android.md` reuse it; they do not rebuild it.

**Unverified, and it needs a Mac.** Register #13 — whether `persist()` is honoured in Safari for a
non-installed site, and current Firefox group limits — cannot be answered in this container. The check
is two lines: call `persist()` then `persisted()` in a real Safari tab and in an installed web app,
and read what each returns. Until someone runs it, the warning copy for Safari must be written from
the pessimistic assumption (not persisted, seven-day cap applies) and the phase must record in
`HANDOFF.md` that it is unrun.

**Files.** `src/pwa/install.ts`, `src/pwa/persist.ts`, `lib/db/export.ts` and `lib/db/import.ts` (over
`lib/db/repository.ts`, which is the seam that makes this a data-layer feature and not a screen),
`public/manifest.webmanifest` (`theme_color` / `background_color` from `core.md` C0's tokens),
`tests/unit/pwa/**`, `tests/unit/db/export.test.ts`, `tests/e2e/p6/pwa.spec.ts`.

**Acceptance criteria.**

- Unit: export → wipe the database → import → every card, review, list and setting is byte-identical
  by the repository's own queries, tombstones included. A round trip that drops soft-deleted rows is
  a round trip that resurrects deleted cards on the next sync.
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
it renders and the service worker can cache them like any other hashed asset. Self-hosted rather than
a font CDN, for three reasons that all matter here: an offline-first app cannot depend on a third
origin, the service worker's cache rules are written for same-origin responses (`response.type ===
'basic'` is the existing storability test), and Capacitor and Tauri ship the same files from a local
scheme where a CDN is simply unreachable.

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

**Files.** `src/styles/fonts.css`, the subset font files under `apps/app/public/fonts/`,
`scripts/font-subset.ts` (or the chosen tooling, documented), `vite.config.ts`,
`scripts/sw.template.js` (fonts are hashed assets and belong in the cache-first rule).

**Acceptance criteria.**

- A Playwright spec loads the app with the network throttled and asserts no request to a third-party
  origin is made for a font. `grep -rn "fonts.googleapis\|fonts.gstatic" apps/` returns nothing.
- Rendering a passage of real CC-CEDICT headwords produces no tofu: reuse `core.md` C0's coverage
  script output to build the sample, render it, and assert the measured advance width of each glyph
  is non-zero — or, if that proves flaky, screenshot-diff a fixed sample and review it. Say which was
  used.
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

- The app origin serves no marketing route and the apex serves no app route: a smoke case per origin
  asserting the other's paths 404.
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
of growing a second key system. The bindings product-decisions §10 asks for: Cmd/Ctrl+K opens the
palette, Enter runs the highlighted row, Cmd+Enter adds, Tab asks the whole question, Escape closes
and returns focus, arrows move.

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

**Acceptance criteria.**

- A unit test over the registry asserts no two bindings share a key combination in the same scope,
  and that every binding has a human-readable description (the help sheet is generated, so an
  undescribed binding is a bug).
- Playwright, keyboard only, no pointer: open the palette, type, arrow to a row, Enter, Escape, and
  land back where you started with focus on a visible element. Repeat with the palette closed to
  prove the global bindings do not fire inside the lookup input.
- A route change moves focus to the new heading and the announcer's live region contains the new
  route's name. Assert both.
- Scroll position is restored on back-navigation to a scrolled list.
- The same lookup URL (`/lookup?q=打算`) renders the same result in the tab shell and the palette —
  the URL-is-the-state criterion, and the mechanical proof that the two shells did not fork.

---

### W9 — Desktop: the PWA is the product, and the Tauri trigger is written down

**Builds.** A short phase, mostly a decision record plus two mechanical guarantees, so that adding a
Tauri shell later is a packaging job and not a porting job.

**The decision, restated because it is a sequencing decision and gets misread as a capability one**
(STACK §2.4): desktop v1 **is** the installed PWA from the same `dist/`. Zero extra build, zero extra
code. It gets a standalone window, a dock icon, offline operation, keyboard-first navigation, and —
the part that matters — a storage regime that exempts it from Safari's seven-day ITP cap and gets it
effectively-guaranteed persistence in Chromium. Until Tauri ships, do not describe it as a
differentiated desktop product. It is the same app, wider.

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
- Keeps `dist/` shell-agnostic, which is the same requirement Capacitor has: relative `base`, no
  absolute-origin assumptions, no dependency on a browser-only API on the critical path, and the API
  base configurable at build time. W1 already asserts the subpath criterion; this phase adds the
  standing check so it cannot regress.
- Records what is **not** being bought: Electron, ever (STACK §2.4 — 85–120 MB download, 150–250 MB
  idle, and Tangram's UI is text and keyboard handling, which all three system engines do well).

**Acceptance criteria.**

- `docs/desktop.md` exists and states the trigger as three testable conditions, the pinned versions,
  and the two storage hazards. A reader who has never seen this conversation can decide whether to
  pull the trigger from that page alone.
- A CI-able check asserts the build has no absolute-origin assumption: build, serve `dist/` from a
  subpath and from a second port, and boot the app in both. Same check as W1's, now standing.
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

**R10 — Two origins break the credential.** A cookie cannot cross from `app.<domain>` to the API
origin without third-party-cookie handling that Safari blocks by default.
*Trigger:* the gate works in development (same origin) and 401s everything in production.
*Mitigation:* already the design — W4 replaces the cookie with a request header, which is why that
change is a simplification rather than a regression. The CORS allowlist is `backend.md`'s and W4's
acceptance criteria run against a preview server with the secret set, on a second port, so the
cross-origin path is exercised before it is deployed.

**R11 — The palette gets built before it has earned its place.** STACK §2.4 states plainly that the
palette is not a v1 goal, because summoning needs a global hotkey and no browser can register one;
§5.1's test is a week of real study.
*Trigger:* W8's palette half starts before `core.md` C7 has been used, or before the owner has
chosen.
*Mitigation:* W8's routing and keyboard layer is useful in either shell and lands first; the palette
is the second half of the phase and is gated on the same decision `core.md` C9 is gated on.

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
  CSP shipped before the origins split would have to cover a marketing site too.
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
