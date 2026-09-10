# Deploying Tangram to Vercel

One page, in the order you will need it. Everything here was measured on the
build container (4 shared vCPU, Node 22) unless it says otherwise; the two
things that could only be checked against a real deployment are called out as
such rather than asserted.

---

## 1. Import the repo

Vercel's Next.js preset is right out of the box. Confirm rather than change:

| Setting | Value | Why |
|---|---|---|
| Framework | Next.js | detected |
| Install command | `pnpm install` | detected from `pnpm-lock.yaml` |
| Build command | `pnpm build` | **do not** replace with `next build` — see §2 |
| Output directory | *(default)* | Next owns it |
| Node.js version | 22.x | `.nvmrc` says 22; `engines` allows ≥ 20.9 |
| Root directory | *(repo root)* | |

There is no database and no Supabase project. Every card, review and setting
lives in the browser's IndexedDB, so a deployment holds **no user data at all**
and a redeploy cannot lose any.

## 2. `pnpm build` generates the dictionary, and that is not optional

```
pnpm build = pnpm data:ensure && next build && pnpm sw
```

`data/dict.json` (33.5 MB) and `data/decomp.json` (0.9 MB) are **gitignored and
generated**, so they do not exist in a fresh checkout. `pnpm data:ensure` builds
them when `data/dict.json` is missing, which on Vercel is every build: it
downloads CC-CEDICT (from npm), the HSK 3.0 list and jieba's frequency table
(`raw.githubusercontent.com`) and Make Me a Hanzi's `dictionary.txt`, and writes
the two files. Replacing the build command with a bare `next build` produces a
deployment where every dictionary route answers
`503 {"error":"dict-data-missing"}` and the app shows one banner.

**How long.** Measured on a clean tree with an empty download cache:

| Step | Time |
|---|---|
| `pnpm data --force` (cold, including all four downloads) | **5.5 s** |
| `next build` + `pnpm sw` | **28 s** |
| `pnpm build` total, cold | **~34 s** |

Vercel does not preserve `.cache/` between builds, so every build pays the cold
5.5 s. It is small enough not to be worth caching.

The build must reach `registry.npmjs.org` and `raw.githubusercontent.com`. If a
future source is added, `scripts/build-data.ts` exits non-zero when a fetch
fails — the build breaks rather than deploying a half-built dictionary.

`pnpm sw` writes `public/sw.js` from `scripts/sw.template.js`, stamped with the
build id Next just generated. That stamp is what makes the service worker drop
the previous deploy's hashed chunks on activate, so it has to run *after*
`next build`, in the same command.

## 3. Environment variables

| Variable | Required | Effect when absent |
|---|---|---|
| `ANTHROPIC_API_KEY` | no | `FakeProvider` answers; the app works offline-style, and the ask panel says so |
| `TANGRAM_LLM_PROVIDER` | no | `fake`. The live provider needs **both** this set to `anthropic` and a key |
| `TANGRAM_MODEL` | no | `claude-opus-5` (`lib/ai/anthropic.ts`) |
| `TANGRAM_ACCESS_SECRET` | **yes, once a key is set** | no gate: the paid routes are open to anyone with the URL (§4) |
| `TANGRAM_DATA_DIR` | no | `<cwd>/data`, which is what the build writes |
| `TANGRAM_ASK_ANSWER_TIMEOUT_MS` | no | 30 000 (§6 — check this against your plan's function timeout) |
| `TANGRAM_ASK_PROPOSE_TIMEOUT_MS` | no | 8 000 |
| `TANGRAM_EXAMPLES_TIMEOUT_MS` | no | 20 000 |
| `TANGRAM_RECALL_TIMEOUT_MS` | no | 15 000 |

Set them for **Production and Preview**. A preview deployment with the key and
without the access secret is the same open wallet as production, on a URL that
is just as guessable.

## 4. The access gate

**The problem.** `/api/ask`, `/api/examples` and `/api/recall` reach the model.
With `ANTHROPIC_API_KEY` set and nothing in front of them, anybody who finds the
URL can spend your money by POSTing to them in a loop. Nothing else in the app
costs anything: the dictionary routes are CPU, and every card lives in the
visitor's own browser.

**The gate.** Set `TANGRAM_ACCESS_SECRET` to a URL-safe random string:

```bash
openssl rand -base64 24 | tr '+/' '-_' | tr -d '='
```

Use only `A-Z a-z 0-9 . _ ~ -`. The cookie carries the value verbatim, and
anything that would need encoding is refused rather than encoded (a credential
with two spellings is a credential with a hole in it).

**Authorising a phone**, which is the whole reason it is a cookie and not a
header — a phone browser cannot set a header:

1. Visit `https://<your-app>.vercel.app/?key=<the secret>` once.
2. You land on the same page with `?access=granted` in the URL. A one-year
   `HttpOnly; SameSite=Lax; Secure` cookie is now stored. The key is gone from
   the address bar, so it is not in your history, not in a bookmark, and not in
   the `Referer` of the next link you tap.
3. `?access=denied` means the key was wrong — and it also **clears** any cookie
   that device had, because a wrong key is an attempt to change the key.

**What is gated and what is not.** The three paid routes, `GET` handshakes
included. The pages, the dictionary routes, the manifest, the service worker and
`/offline.html` stay open: the PWA has to install, and the offline review
session has to work, without anyone typing a key.

**Rotating.** Change the variable and redeploy. Every cookie ever issued stops
working at the same instant — there is no session store to fall out of sync
with — and every device visits `?key=` once more.

**What a refusal looks like.** `401 {"error":"unauthorized"}`, `Cache-Control:
no-store`, and nothing else: no hint, no stack, no echo of what was sent. The
secret is never logged and never appears in a response body.

**Two layers, on purpose.** `middleware.ts` refuses the request before it
reaches a handler, and `lib/server/access.ts`'s `requireAccess` refuses it again
inside each handler. A `matcher` is one careless edit away from not matching,
and the failure mode of a gate that quietly stopped running is an invoice.

> **Note for whoever upgrades Next.** Next 16 prints
> `The "middleware" file convention is deprecated. Please use "proxy" instead.`
> The gate works today; the migration is a file rename plus renaming the export
> (`npx @next/codemod@canary middleware-to-proxy .`). When you do it, re-run
> `tests/e2e/d/access-gate.spec.ts` — it starts a second server with the secret
> actually set and drives the whole `?key=` → cookie → 200 flow, so it is what
> tells you the gate still runs.

**With no secret set, none of this exists.** `pnpm dev`, `pnpm test` and
`pnpm e2e` run in exactly that state, which is deliberate: a gate that changed
local behaviour would be switched off within a week.

## 5. Cold start, function memory, and why tracing is per-function

### The dictionary is 33.5 MB of JSON, read at request time

Each function instance parses `data/dict.json` once and builds its indexes once,
memoised on `globalThis` for the life of that instance.

**Vercel does not give each route its own function.** `@vercel/next` groups route
handlers whose config matches — `maxDuration`, `memory`, regions, none of which
this app sets — into one Vercel Function, "to help reduce cold starts". Verified
rather than assumed: `npx vercel@59 build` on this repo produces exactly one real
directory, `.vercel/output/functions/api/ask.func`, and `api/examples.func`,
`api/recall.func` and `api/dict/{hsk,search,segment,entries,decomp}.func` are all
symlinks to it. To see the layout for yourself without deploying:

```bash
npx vercel@59 build
find .vercel/output/functions -maxdepth 3 -name '*.func'        # what exists
find .vercel/output/functions -maxdepth 3 -type l               # which are aliases
```

So all eight routes share one process and one set of indexes, and this section's
earlier claim that each pays its own cold start was wrong. What is still true is
that a *cold instance* pays for the parse, and that the first request of each kind
pays for the indexes it reads — which is what laziness is for, and why one route
being slow to answer first is normal.

> **These numbers are superseded.** The table below was measured after Phase 8 by
> importing a route module in a freshly spawned `node` process. HANDOFF.md's
> "Phase 9 — cycle A" section measures the same thing over HTTP against a fresh
> `next start` per sample, which is the harness to trust for anything a browser
> sees; its figures run 25–40% lower than these. The two are not reconcilable
> sample by sample and this table has not been re-run with the newer harness. What
> is unchanged is the *shape*: the parse dominates, a pinyin query is the
> expensive one, and laziness is what keeps the cheap routes cheap.
>
> Since Phase 9 the far more important change is that a real session does not take
> this path at all: the app-open probe (`HEAD /api/dict/hsk`) schedules
> `warmDictionary()`, so an instance builds *everything* once, unattended, and the
> first lookup costs ~15 ms rather than ~1.5 s. The figures below describe an
> instance that never got the probe.

Measured (median of three runs, one fresh Node process each — the closest honest
stand-in for a cold lambda, since `pnpm start` serves every route from one warm
process):

| First request on a cold instance | before | after |
|---|---|---|
| `/api/dict/decomp` | 17 ms | 16 ms |
| `/api/dict/entries` | 4064 ms | **972 ms** |
| `/api/dict/hsk` — the Today page's first call | 4141 ms | **1026 ms** |
| `/api/dict/segment` — the reader | 4373 ms | **1346 ms** |
| `/api/dict/search`, hanzi query | 4610 ms | **1443 ms** |
| `/api/dict/search`, English query | 4147 ms | **1698 ms** |
| `/api/dict/search`, pinyin query | 3909 ms | **2429 ms** |
| everything (`/api/ask` after a few queries) | 4052 ms | **2348 ms** |

Resident memory after that first request fell with it: 280–292 MB before, and
now 171–177 MB for `entries`/`hsk`, ~205 MB for `segment` and hanzi search,
~235 MB for English search, ~265 MB once the pinyin indexes are up.

Those per-route figures are also the "no probe" world. With the Phase 9 warm-up,
every instance ends up holding every index: measured on a built server, RSS is
126 MiB idle, 215 MiB after a lone `GET /api/dict/hsk?band=1`, and **311 MiB**
once the warm-up has settled — whatever the session goes on to do. That is the
honest number to size against now.

Three changes, in order of what they bought:

1. **Lazy indexes** (`lib/dict/index.ts`). `/api/dict/hsk` was building the
   47,000-key English inverted index it will never read.
2. **`readingKeys`** (`lib/dict/pinyin.ts`). The dictionary's own pinyin is
   already syllable-split, so the query parser's dynamic-programming split does
   not need to run over it: 1310 ms → ~250 ms for the two pinyin indexes. The
   fast path declines anything that is not plain numbered pinyin (742 readings
   like `A quan1 r5`) and falls back; a test proves the two agree on all
   124,154 readings in the build.
3. **A one-pass `glossTokens`.** ~210 ms over 195,550 glosses. Same output on
   every gloss in the dictionary, proved against the old implementation kept in
   the test as an oracle.

**A pinyin query is the expensive one** and that is inherent: PLAN.md §3.2 has
it search the pinyin index *and* the gloss index, so it ends up building
everything.

### What was measured and *not* done

- **A leaner runtime file.** Per-field byte shares of `dict.json`: `glosses`
  20.1%, `id` 10.0%, `pinyinNum` 9.6%, `pinyinMarked` 9.2%, the three booleans
  (`properNoun`/`isVariant`/`surname`) 18.8% together, `classifiers` 6.0%,
  `simp`+`trad` 9.0%, `freqRank`+`freq` 7.0%, everything else under 1%. There is
  no dead weight to drop: every one of those is read either by search ranking or
  by a response the UI renders. Packing the three booleans into one flags field
  would cut ~19% of a 650 ms parse — ~120 ms — in exchange for changing `Entry`
  (a frozen type) and the `pnpm data` output contract. Not worth it; not done.
- **A precomputed index format.** Emitting the pinyin and gloss keys from
  `scripts/build-data.ts` would remove most of the remaining derivation, but it
  adds a second multi-megabyte artifact to parse and a second thing that can go
  stale against `dict.json`. After (2) and (3) the derivation is no longer the
  dominant cost — the 650 ms `JSON.parse` and the map building are — so it would
  buy much less than it looks. Left alone deliberately.
- **The real floor** is the parse: read + `JSON.parse` of 33.5 MB is ~650 ms and
  no amount of index laziness touches it. Getting under that needs a different
  storage format (a binary index, or a real database) — an architectural change,
  not a tweak, and it is not in this phase.

### Function memory

Give the functions **at least 1 GB**. Peak RSS is ~310 MiB once an instance is
warm (it used to be ~180–290 MB, per route, before the warm-up made every
instance build everything), plus the Next runtime, so 1 GB is still comfortable;
on Vercel memory and CPU are allocated together, so a larger size also shortens
the parse directly. If a
route ever 502s with no log line, out-of-memory during the dictionary load is
the first thing to check.

### Tracing is declared per route — every new dictionary-reading route needs an entry

`next.config.ts`:

```ts
outputFileTracingIncludes: {
  '/api/dict/**': ['./data/**'],
  '/api/ask/**': ['./data/**'],
  '/api/examples/**': ['./data/**'],
  '/api/recall/**': ['./data/**'],
}
```

A route that calls `getDict()` and is **not** listed here works perfectly under
`next dev` and under `pnpm start` — the file is simply on disk in both — and
500s in the deployment, on that route alone. `/api/examples` and `/api/recall`
shipped exactly that way; nothing caught it but a person opening the page.

So it is no longer left to memory:

- `tests/unit/server/routes.test.ts` walks each route's import graph and fails
  if one reaches `lib/dict/load.ts` without a key covering it, and
- `pnpm smoke` refuses to run at all if a handler in `app/api/**` has no case.

Each of the eight routes therefore *traces* its own ~34.4 MB copy of `data/`
(each route's `.nft.json` lists it). They are not eight copies in the output: the
routes share one function, whose file list is the union of its members' traces,
and `.vercel/output/functions/api/ask.func/.vc-config.json` names `data/dict.json`
once. That is well inside the 250 MB unzipped per-function limit — and it is the
group's 225 MiB budget, not the per-route trace, that would decide if the app ever
grew enough to be split.

## 6. Function timeout vs the ask deadline

`/api/ask` waits up to **30 s** for the model (`ANSWER_TIMEOUT_MS`), `/api/examples`
20 s, `/api/recall` 15 s. If your Vercel plan's function timeout is *lower* than
that, the platform kills the function first and the panel shows a generic
failure instead of the route's own 502.

Either raise the function's max duration to comfortably above 30 s, or lower the
deadlines with `TANGRAM_ASK_ANSWER_TIMEOUT_MS` and friends — they exist for
exactly this, and take effect without a rebuild.

## 7. After a deploy: what to check

Run the smoke script against the deployment. It hits every API route, every nav
page, and the three files the PWA needs, and fails on any non-2xx:

```bash
pnpm smoke --base-url https://<your-app>.vercel.app --key "$TANGRAM_ACCESS_SECRET"
```

It also runs inside `pnpm e2e` (`tests/e2e/d/smoke.spec.ts`) against the local
built server, so a route that forgets its tracing entry fails there rather than
in production.

Then, by hand, the three things a script cannot tell you:

1. **The dictionary is in the bundle.** `GET /api/dict/hsk?band=1` returns 200
   with entries, not `503 {"error":"dict-data-missing"}`. This is the one thing
   that can only be confirmed against a real deployment: file tracing is a build
   artefact and `pnpm start` reads `data/` off the disk either way. A 503 here
   means `pnpm build` was not the build command, or a route is missing its
   `outputFileTracingIncludes` entry.
2. **The gate is on.** `curl -i https://<app>/api/ask` → `401
   {"error":"unauthorized"}`. If it answers 200, `TANGRAM_ACCESS_SECRET` did not
   reach that environment.
3. **The PWA updated.** Open the deployment on the phone, pull to refresh once,
   and check `/settings` renders. Navigations are network-first, so a new deploy
   is picked up on the first online load; `sw.js` is served `no-cache` so the
   worker itself is never pinned to an old build.

And once, on the first deploy: install to the home screen, turn on airplane
mode, and do one review. That is the promise the whole service worker exists
for, and it is the only check that covers it.
