# Deploying Tangram

One page, in the order you will need it. Everything here was measured on the
build container (4 shared vCPU, Node 22.22) unless it says otherwise; the things
that can only be checked against a real deployment are called out as such rather
than asserted.

**What this describes.** `apps/app` is a **static site** — `pnpm build` emits a
directory of files and nothing else. There is no framework runtime, no function,
no server-rendered page. `apps/server` is a separate deployable (`backend.md`)
and is not deployed by any of this; until it exists, **a deployed build has no
`/api/*` at all** — see §5.

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
   immutable`, `Content-Type: application/vnd.sqlite3`,
   `Vary: accept-encoding` — plus a rewrite to the `.br` sibling, with
   `Content-Encoding: br`, for a client that asks for it.
5. `dict-manifest.json`: **`no-cache`**. Rules 4 and 5 are two halves of one
   decision — an immutable pointer is a dictionary that can never be updated.

**Rule 4's negotiation is the one thing nothing local can prove.** Whether
Vercel honours a rewrite to a pre-compressed sibling for a 43 MB binary is not
established by any audit, and this repository does not assume it. `pnpm smoke`
against the deployment reads `content-encoding` and the transferred length off
the real response; §7 says what to record. If the host will not negotiate, the
`.br` is already uploaded under its own name and the fallback is for the
client's fetch to ask for it explicitly — that is a `data.md` change, recorded
as a question in `HANDOFF.md`.

## 4. Environment variables

The static build reads **one** variable, at build time:

| Variable | Required | Effect when absent |
|---|---|---|
| `VITE_API_BASE` | not yet | empty, i.e. same-origin. `web.md` W4 introduces it; until `backend.md` deploys a server there is nothing to point it at |
| `TANGRAM_DATA_DIR` | no | the workspace root's `data/`, found by walking up for `pnpm-workspace.yaml` |
| `TANGRAM_DICT_BROTLI_QUALITY` | no | 9 (§2) |

Everything else — `ANTHROPIC_API_KEY`, `TANGRAM_ACCESS_SECRET`, the four ask
timeouts, `TANGRAM_LLM_PROVIDER`, `TANGRAM_MODEL` — belongs to **`apps/server`**
and must never be set on this project. A model key in a static site's build
environment is a key in a bundle. `.env.example` lists them with the server.

## 5. The access gate — DOWN between `web.md` W1 and W4

`middleware.ts` performed the `?key=` → cookie exchange and Next invoked it.
There is no middleware in a static SPA and both are gone.

**Consequence, stated plainly:** on any deployment made in this window with
`TANGRAM_ACCESS_SECRET` set, the three routes that reach a paid model refuse
everyone and cannot be authorised from a phone. With the secret unset there is
no gate at all. **Do not deploy the model-backed routes before W4 lands.**

W4 rebuilds the client half as an `X-Tangram-Access` header that page script
attaches; `backend.md` B1 owns the enforcing half, on the server, matching the
gated paths **by prefix** (`wave-zero.md` §10a — `/api/ask/propose` and
`/api/ask/answer` sit under `/api/ask`, and an exact-string gate leaves the two
routes that actually spend money wide open). This section is rewritten by W4.

**The gate never protected the page HTML and now visibly does not.** A static
host serves the shell to anyone who asks. If the app's HTML itself must be
private, that is host-level protection (Vercel's Deployment Protection), not
application code.

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
pnpm smoke --base-url https://<your-app>.vercel.app
```

It walks every hashed asset in `dist/.vite/manifest.json`, the three files the
PWA needs, the dictionary's three, every page route in `src/routes.tsx`, and —
against whatever `--api-base` names — every API route. It asserts the headers
`vercel.json` promises, so a host that is not applying the file fails here
rather than in a learner's browser. It also runs inside `pnpm e2e`
(`tests/e2e/d/smoke.spec.ts`) against the local built server.

Then, by hand, the things a script cannot tell you:

1. **The artifact's real transfer**, which is a **measurement to record in
   `HANDOFF.md` and to feed into `web.md` W6's budget**:

   ```bash
   curl -sI -H 'accept-encoding: br, gzip' https://<app>/dict-<schema>-<cedict>.sqlite
   ```

   Record `content-encoding`, `content-length` against the 43,208,704-byte
   on-disk length, and `cache-control`. If `content-encoding` is not `br`, the
   pre-compression question goes into `HANDOFF.md` as a `data.md` question and
   the uncompressed number goes into W6's budget.

2. **The manifest is not being cached immutably.**
   `curl -sI https://<app>/dict-manifest.json` → `cache-control: no-cache`. If
   this one is wrong the dictionary can never be updated and nothing will look
   broken until it needs to be.

3. **A deep route renders.** Open `https://<app>/settings` directly — not by
   navigating to it — and check the attribution renders. That is the SPA
   fallback and the licence obligation in one.

4. **The PWA updated.** Open the deployment on the phone, pull to refresh once.
   Navigations are network-first, so a new deploy is picked up on the first
   online load; `sw.js` is served `no-cache` so the worker itself is never
   pinned to an old build.

And once, on the first deploy: install to the home screen, turn on airplane
mode, and do one review. That is the promise the whole service worker exists
for, and it is the only check that covers it.
