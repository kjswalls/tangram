# Deploying Tangram

One page, in the order you will need it. Everything here was measured on the
build container (4 shared vCPU, Node 22.22) unless it says otherwise; the things
that can only be checked against a real deployment are called out as such rather
than asserted.

**What this describes.** `apps/app` is a **static site** — `pnpm build` emits a
directory of files and nothing else. There is no framework runtime, no function,
no server-rendered page. `apps/server` is a separate deployable (`backend.md`)
and is not deployed by any of this; until it exists, **a deployed build has no
`/api/*` at all** — see §4 and §5.

> Rewritten for `web.md` W2. The previous version described a single-package
> Next.js repository with per-route serverless functions and a `middleware.ts`
> access gate; none of that exists. `HANDOFF.md` records the two phases that
> removed it.

---

## 1. The Vercel project

`apps/app/vercel.json` is checked in and carries the build command, the output
directory and every routing and header rule. Set these four things in the
dashboard once; everything else comes from the file, which is the point — a rule
in a file is reviewable and a rule in a text box is not.

| Setting | Value | Why |
|---|---|---|
| Root directory | `apps/app` | `vercel.json` lives there, and Vercel reads it from the root directory |
| Include files outside the root directory | **on** | `data/`, `scripts/` and `packages/` are at the workspace root and the build reads all three |
| Framework preset | **Other** / none | `vercel.json` sets `"framework": null`. There is no framework |
| Node.js version | 22.x | `engines` is `>=22.22`; `.nvmrc` says 22.22 |

Install is the detected `pnpm install` at the workspace root. The build command
and the output directory come from `vercel.json`:

```json
"buildCommand": "pnpm -w run data:ensure && pnpm run build",
"outputDirectory": "dist"
```

`pnpm -w run data:ensure` is the workspace-root script, so the dictionary is
generated into the workspace-root `data/` where `TANGRAM_DATA_DIR` points and
where three deployables read it. `pnpm run build` is then the **app's** build,
which copies the artifacts into `public/` and runs Vite.

There is no database and no Supabase project in this deployable. Every card,
review and setting lives in the browser's IndexedDB, so a deployment holds **no
user data at all** and a redeploy cannot lose any.

## 2. What the build does, and what it uploads

```
pnpm -w run data:ensure   →  data/dict-<schema>-<cedict>.sqlite, data/dict-manifest.json,
                             data/decomp.json, data/dict.json     (gitignored, generated)
pnpm run build            =  pnpm -w run dict:copy && pnpm -w run sw && vite build
```

`pnpm dict:copy` (`scripts/copy-dict.ts`) cleans any previous artifacts out of
`apps/app/public/`, verifies the source against `dict-manifest.json` — byte
length **and** SHA-256 — copies the three files in, and writes the brotli
sibling. It **fails the build** on a missing or mismatched artifact rather than
producing a `dist/` whose manifest points at nothing.

Measured, on a clean tree with an empty download cache:

| Step | Time |
|---|---|
| `pnpm data --force` (cold, including all four downloads) | **~5 s** |
| `pnpm dict:copy` — the brotli sibling at the default quality 9 | **~16 s** |
| `vite build` | **~0.5 s** |
| `pnpm build` at the workspace root, cold (typecheck + data + copy + sw + vite + server) | **~26 s** |

Vercel does not preserve `.cache/` between builds, so every build pays the cold
data build and the cold compression. `TANGRAM_DICT_BROTLI_QUALITY=11` trades 95
more seconds for 2.2 MB; see `scripts/copy-dict.ts` for the measured table.

**What lands in `dist/`,** beyond the app itself:

| File | Size | Served as |
|---|---|---|
| `dict-<schema>-<cedict>.sqlite` | 43.2 MB | content-addressed, immutable for a year |
| `dict-<…>.sqlite.br` | 16.9 MB | the same bytes, brotli, under `accept-encoding` |
| `dict-manifest.json` | 198 B | `no-cache` — it is the pointer at the filename above |
| `decomp.json` | 0.92 MB | `no-cache`; fetched lazily on the first character sheet |
| `assets/*` | ~730 KB | content-hashed by Vite |
| `sw.js`, `offline.html`, `manifest.webmanifest`, `icons/*` | small | see §3 |

The dictionary is **not** parsed on a server any more. It is fetched once by the
browser and imported into OPFS (`data.md` D4), so the per-route cold start and
the 1 GB function memory the previous version of this document specified are
gone with the functions.

## 3. The host rules, and the one test that catches their disappearance

All five live in `apps/app/vercel.json` and **nowhere else**. There is no server
in `dist/` to apply them and no framework config left to hold them, so deleting
one deletes the rule. `tests/unit/server/routes.test.ts` parses the file and
fails on any of them going missing, and `vite-plugins/headers.ts` applies the
same file to `pnpm dev` and `pnpm preview` so a wrong rule is wrong locally too.

1. **SPA fallback** — every navigation that is not a real file returns
   `index.html`. It deliberately excludes `/api/`, `/assets/` and any path with
   a file extension: a missing asset must **404**, not answer the document that
   references it, or a broken build looks healthy from the outside.
2. `/manifest.webmanifest` as `application/manifest+json; charset=utf-8`. Some
   installability checks refuse anything else.
3. `/sw.js` as `text/javascript; charset=utf-8`, `Cache-Control: no-cache,
   no-store, must-revalidate`, `Service-Worker-Allowed: /`. A worker at the root
   must be revalidated or a bad one is permanent.
4. The dictionary artifact: `Cache-Control: public, max-age=31536000,
   immutable`, `Content-Type: application/vnd.sqlite3`. Its brotli sibling,
   `dict-<…>.sqlite.br`, is served **under its own name** with the same
   immutable caching plus `Content-Encoding: br`, so a client that requests it
   gets the artifact's bytes transparently decoded.
5. `dict-manifest.json`: **`no-cache`**. Rules 4 and 5 are two halves of one
   decision — an immutable pointer is a dictionary that can never be updated.

**Rule 4 is NOT content negotiation, and the reason is worth reading once.**
The first version of this file negotiated: a `rewrites` entry sent
`/dict-<…>.sqlite` to the `.br` sibling when the request carried
`accept-encoding: br`, and a `headers` entry put `Content-Encoding: br` on the
same path under the same condition. Vercel consults `rewrites` **only after the
filesystem** — its own documentation says the `source` "should NOT be a file
because precedence is given to the filesystem prior to rewrites being applied" —
and the `.sqlite` is a real file in `dist/`. So the rewrite could never fire,
while the header, which decorates whatever the filesystem serves, still would:
every browser would have received 43 MB of raw SQLite labelled brotli and failed
to decode it. The dictionary would never have imported.

Every gate in the container was green, because `vite-plugins/headers.ts` was
applying the rewrite *before* Vite's static middleware — the opposite of the
host's order. That plugin now applies headers only, and
`tests/unit/server/routes.test.ts` refuses any rewrite whose `source` matches a
file in `dist/`, and any `content-encoding` header on a path the filesystem
serves verbatim.

**What this leaves open, as a `data.md` question rather than a decision taken
here** (`web.md` W2 names this fallback in as many words): the client has to ask
for `dict-<…>.sqlite.br` by name to get the ~17 MB instead of the 43 MB.
`data.md` D4 owns the fetch. Until it does, a first load transfers the full
43,208,704 bytes, and that number — not 13.9 MB, and not 16.9 — is what `web.md`
W6's budget should start from. `HANDOFF.md` carries it.

## 4. Environment variables

The static build reads **one** variable, at build time:

| Variable | Required | Effect when absent |
|---|---|---|
| `VITE_API_BASE` | **yes**, from `backend.md` B1 | empty, i.e. same-origin — which on this static host means **no API at all**, so ask, i+1 sentences and free recall are simply dead. Build-time, so changing it needs a redeploy. Set it to `https://api.<domain>` |
| `TANGRAM_DATA_DIR` | no | the workspace root's `data/`, found by walking up for `pnpm-workspace.yaml` |
| `TANGRAM_DICT_BROTLI_QUALITY` | no | 9 (§2) |

**`VITE_API_BASE` is required now, not "once the server is deployed".**
`backend.md` B1 moved `/api/ask`, `/api/examples` and `/api/recall` into
`apps/server` and deleted the dev/preview adapter that used to mount them on the
app's own origin. A build with this unset produces an app whose three
model-backed features fail silently — the ask panel reports a network error, the
card back shows no sentences, and free recall simply gives no suggestion,
because it was written to treat every failure as "no suggestion". `pnpm e2e`
bakes it in through `apps/app/.env.e2e`, which is also the working example.

Everything else — `ANTHROPIC_API_KEY`, `TANGRAM_ACCESS_SECRET`,
`TANGRAM_ALLOWED_ORIGINS`, the four ask timeouts, `TANGRAM_LLM_PROVIDER`,
`TANGRAM_MODEL` — belongs to **`apps/server`** and must never be set on this
project. A model key in a static site's build environment is a key in a bundle.
`.env.example` lists them with the server.

**One of the server's variables is this project's problem anyway, and it is the
one that will bite first.** `TANGRAM_ALLOWED_ORIGINS` on the server has to name
*this* deployment's origin, exactly — scheme, host and port, no trailing path.
A custom request header makes every cross-origin `POST` a preflighted one, so an
origin missing from that list fails every gated call before the handler is
reached, and the browser reports it as a CORS error rather than as anything
about the API. Deploying the app to a new origin means editing a variable on the
*server*. `capacitor://localhost` and `http://localhost` — the two Capacitor
WebView origins — are built in and need no configuration.

## 5. The access gate

**The problem.** `/api/ask`, `/api/examples` and `/api/recall` reach a paid
model. With a key set and nothing in front of them, anybody who finds the URL
can spend your money by POSTing to them in a loop. Nothing else in the app costs
anything: the dictionary is the visitor's own CPU, and every card lives in the
visitor's own browser.

**Where it runs.** `TANGRAM_ACCESS_SECRET` belongs to the **server**
(`apps/server`, `backend.md`), never to this static project — §4. Each handler
calls `requireAccess` from `@tangram/access` as its first line, and
`backend.md` B1 adds the layer in front of them. That front layer matches the
gated paths by **prefix**, not by exact string, and the reason is not
stylistic: `backend.md` B2's frozen contract adds `/api/ask/propose` and
`/api/ask/answer` — the two routes that actually spend the money — underneath
`/api/ask`, and an exact-string gate leaves both open with the secret set while
every existing test passes (`wave-zero.md` §10a). `isGatedPath` is that rule;
`tests/unit/server/access.test.ts` names both children explicitly.

**The credential is a header now: `X-Tangram-Access`,** carrying the secret
verbatim exactly as the cookie did. Set `TANGRAM_ACCESS_SECRET` to a URL-safe
random string:

```bash
openssl rand -base64 24 | tr '+/' '-_' | tr -d '='
```

Use only `A-Z a-z 0-9 . _ ~ -`. The client stores and sends the value verbatim,
and refuses to store anything outside that alphabet.

**Authorising a phone**, which is the whole reason there was ever a cookie — a
phone browser cannot set a request header, but page script can:

1. Visit `https://<your-app>/?key=<the secret>` once.
2. The key is taken out of the URL **immediately**, so it is not in your
   history, not in a bookmark and not in the `Referer` of the next link you tap.
   The app then presents it to `GET /api/ask` once and rewrites the URL with
   the verdict: `?access=granted` means the server accepted it and the phone is
   set up; `?access=denied` means it was wrong, and any credential that device
   held is **revoked**, because arriving with a bad key is an attempt to change
   the key; `?access=unverified` means the check could not be completed (no
   network), and the key is kept rather than thrown away.
3. The secret lives in `localStorage` under `tangram.access.secret`.

**A change in posture, stated rather than buried.** The credential used to be an
`HttpOnly` cookie. It is now script-readable, attached by page script, and there
is no CSP in this repository. That is acceptable for exactly one reason: this
gate protects **spend on three routes**, not user data — every card, review and
setting lives in the learner's own IndexedDB and was never behind it — and it is
superseded by real accounts (STACK §2.8). Why a header rather than keeping the
cookie, when a cookie *would* cross from `app.<domain>` to `api.<domain>`: a
Capacitor WebView on `capacitor://localhost` or `http://localhost` is cross-site
to the API and gets no cookie at all, and iOS, Android and the desktop shell all
consume the same build. A header also avoids credentialed CORS everywhere.

**CORS is not optional and it is the server's.** A custom request header makes
every cross-origin POST a *preflighted* one: the browser sends `OPTIONS` first,
and a server that does not answer it with `X-Tangram-Access` in
`Access-Control-Allow-Headers` fails every gated call before the handler is
reached. `tests/e2e/d/access-gate.spec.ts` drives exactly that against a second
local origin, because a same-origin run proves none of it.

**What is gated and what is not.** The three paid routes, `GET` handshakes
included. The pages, the dictionary, the manifest, the service worker and
`/offline.html` stay open: the PWA has to install, and the offline review
session has to work, without anyone typing a key. **The gate never protected the
page HTML and now visibly does not** — a static host serves the shell to anyone
who asks. If the HTML itself must be private, that is Vercel's Deployment
Protection, not application code.

**Rotating.** Change the variable and redeploy. Every issued secret stops
working at the same instant — there is no session store to fall out of sync
with — and every device visits `?key=` once more.

**What a refusal looks like.** `401 {"error":"unauthorized"}`, `Cache-Control:
no-store`, and nothing else: no hint, no stack, no echo of what was sent. The
secret is never logged and never appears in a response body.

**With no secret set, none of this exists.** `pnpm dev`, `pnpm test` and
`pnpm e2e` run in exactly that state, which is deliberate: a gate that changed
local behaviour would be switched off within a week.

## 6. Storage, not function memory

The previous version of this document budgeted per-route function memory for a
33.5 MB JSON dictionary parsed on every cold instance. There are no functions.
What replaces it is **the learner's device**:

- ~43 MB in OPFS for the imported dictionary, plus ~17 MB transferred on the
  first load if rule 4's negotiation works and ~43 MB if it does not.
- IndexedDB for every card, review, list and setting.

`web.md` W5 owns `navigator.storage.persist()` and the export that makes an
evicted origin recoverable; W6 owns the first-load budget as one number. Neither
has run.

## 7. After a deploy: what to check

Run the smoke script against the deployment. It needs no browser, which is why
it is still a `tsx` CLI:

```bash
pnpm build                      # so there is a build manifest to check assets against
pnpm smoke --base-url https://<your-app>.vercel.app --api-base https://api.<domain>
```

**`--api-base` is what covers both halves**, and it is not optional dressing:
this deployable emits no functions, `vercel.json`'s fallback deliberately
excludes `/api/` so those paths 404 on the app's origin, and every API case
would fail against a perfectly healthy deployment without it. Use `--no-api`
only when there is no server to point at yet; a run with neither flag fails by
construction.

The API has a smoke of its own, and it is the one that proves the gate:

```bash
TANGRAM_ACCESS_SECRET=<the secret> \
  pnpm -F server smoke --base-url https://api.<domain> --gate on
```

`--gate on` runs every gated case **twice** — once with no credential expecting
401, once with it expecting the route's own status — which is `backend.md` B1's
first acceptance criterion exactly. `--gate off` asserts the open behaviour of a
deployment with no secret set. Whether a gate exists is a property of the
server's environment rather than of the route, so it is stated rather than
guessed: a smoke that accepted either would not notice a gate that had stopped
existing. Its POST cases send an empty body and expect the route's own 400,
deliberately: these three routes cost money on every successful call, and a
deploy check that billed the owner would stop being run. Pass the secret in the
environment rather than with `--key`; `--key` works, and warns, because pnpm
echoes the resolved command line twice per run.

It walks every hashed asset in `dist/.vite/manifest.json`, the three files the
PWA needs, the dictionary's four, and every page route in `src/routes.tsx` —
checking that each page serves **this build's** document, anchored to the local
manifest rather than to the deployment's own `/`. It asserts the headers
`vercel.json` promises, so a host that is not applying the file fails here
rather than in a learner's browser. Anything it could not check (no build
manifest, no local `data/`, `--no-api`) it says so, loudly, rather than passing
quietly. It also runs inside `pnpm e2e` (`tests/e2e/d/smoke.spec.ts`) against
the local built server, where the API half does run.

Then, by hand, the things a script cannot tell you:

1. **Both dictionary paths**, which is a **measurement to record in
   `HANDOFF.md` and to feed into `web.md` W6's budget**:

   ```bash
   curl -sI https://<app>/dict-<schema>-<cedict>.sqlite      # expect 43,208,704, no encoding
   curl -sI https://<app>/dict-<schema>-<cedict>.sqlite.br   # expect ~16.9 MB, content-encoding: br
   ```

   Record `content-length` and `cache-control` for both, and `content-encoding`
   for the sibling. The canonical path must carry **no** `content-encoding`: a
   raw file labelled with one is undecodable, and is the defect §3 describes.

2. **The manifest is not being cached immutably.**
   `curl -sI https://<app>/dict-manifest.json` → `cache-control: no-cache`. If
   this one is wrong the dictionary can never be updated and nothing will look
   broken until it needs to be.

3. **A deep route renders.** Open `https://<app>/library` directly — not by
   navigating to it — and check the attribution renders. That is the SPA
   fallback and the licence obligation in one. (`/settings` is not a route:
   `core.md` C7 folded the settings, the lists and the licences into the
   Library tab.)

4. **The PWA updated.** Open the deployment on the phone, pull to refresh once.
   Navigations are network-first, so a new deploy is picked up on the first
   online load; `sw.js` is served `no-cache` so the worker itself is never
   pinned to an old build.

And once, on the first deploy: install to the home screen, turn on airplane
mode, and do one review. That is the promise the whole service worker exists
for, and it is the only check that covers it.
