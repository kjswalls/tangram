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

## 5. Cold start, function memory, and why tracing is per route

### Vercel does not give each route its own function

`@vercel/next` groups route handlers **whose function configuration matches** —
`maxDuration`, `memory`, `runtime`, `preferredRegion`, none of which this app
sets — into one Vercel Function, and documents the intent as "bundled into the
fewest number of Vercel Functions possible, to help reduce cold starts". For this
app that is **one function for all eight routes**: one container, one
`dict.json` parse, one set of lazy indexes, one warm-up.

That is load-bearing, not trivia. Everything in this section is a claim about
*one process*, and the Phase 9 warm-up (`lib/dict/warm.ts`) only pays off because
the instance the banner's `HEAD /api/dict/hsk` warms is the same instance that
answers the first lookup. Split one route out of the group and it gets its own
cold start and its own unwarmed indexes, with every test still green —
`tests/unit/server/route-config.test.ts` is what stops that shipping, and
`pnpm coldstart` (below) is what would catch it in production.

**How to see the layout without deploying.** The build output is the evidence, so
run the real builder and read what it emitted:

```bash
npx vercel build                                       # pinned: npx vercel@59 build
find .vercel/output/functions -name '*.func' | head    # what exists
find .vercel/output/functions -type l                  # which of those are aliases
```

A `.func` directory that is a **symlink** is not a function; it is another route
pointing at the one function they share. On this repo the only real directory is
`.vercel/output/functions/api/ask.func`, and `api/examples.func`,
`api/recall.func` and `api/dict/{hsk,search,segment,entries,decomp}.func` are all
symlinks to it; its `.vc-config.json` names `data/dict.json` once.

**`.next/server/app/api/**/route.js.nft.json` is not evidence about functions.**
Each of the eight routes emits one, and each lists `data/dict.json` — twice, as
it happens: sixteen mentions of one 33.5 MB file, counted on this container after
`pnpm build` — because tracing is declared and computed **per route** (see
"Tracing is declared per route" below). Reading those eight traces as eight
copies of the dictionary — and therefore eight functions, each with its own cold
start — is exactly the inference that produced Phase 9 v1's cancelled premise.
A group's file list is the *union* of its members' traces, deduplicated, so eight
traces naming one file still ship one file. Only `.vercel/output/functions` says how many functions there are.

### The dictionary is 33.5 MB of JSON, read at request time

A cold start is therefore a *process* event, not a route event. The first request
to reach a new instance pays the `dict.json` parse; the first request of each
*kind* then pays for the indexes it reads, which is what laziness is for and why
one route being slow to answer first is normal. Each instance memoises both on
`globalThis` for its own lifetime, and shares neither with any other instance.

Since Phase 9 a real session pays neither bill in front of the user: the app-open
probe (`HEAD /api/dict/hsk`) schedules `warmDictionary()`, so an instance builds
*everything* once, unattended, and the first lookup costs ~15 ms rather than
~1.5 s. Every figure in the two tables below describes an instance that never got
the probe.

> **The table immediately below is superseded as a set of numbers.** It was
> measured after Phase 8 by importing a route module in a freshly spawned `node`
> process. Phase 9 cycle A measured the same thing over HTTP against a fresh
> `next start` per sample — the harness to trust for anything a browser sees —
> and its figures run 25–40% lower. The two are not reconcilable sample by
> sample, and only four of these rows have been re-run; those four are the second
> table. What is unchanged is the *shape*: the parse dominates, a pinyin query is
> the expensive one, and laziness is what keeps the cheap routes cheap.

Measured by importing the route module in a fresh Node process, median of three
runs. "before" is eager index building; "after" is the lazy indexes Phase 8
shipped. Neither column has a warm-up in it:

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

Four of those rows re-measured over HTTP in cycle A, one fresh `next start` per
sample, each endpoint alone in its own process. The middle column is the same
world as "after" above — lazy indexes, no warm-up — and the right-hand column is
that request once the banner's probe has settled (HANDOFF.md, "Phase 9 —
cycle A"):

| Endpoint, alone in a fresh process | lazy, no warm-up | after the warm-up |
|---|---|---|
| `GET /api/dict/entries?ids=…` | 615 ms | **14 ms** |
| `GET /api/dict/hsk?band=1` | 675 ms | **17 ms** |
| `POST /api/dict/segment` | 953 ms | **21 ms** |
| `GET /api/dict/search?q=dasuan` (pinyin) | 1777 ms | **16 ms** |

The rows the newer harness has not re-run — hanzi and English search, `/api/ask`,
`/api/dict/decomp` — stand on the Phase 8 table alone.

Resident memory after that first request fell with the same change: 280–292 MB
before, and 171–177 MB for `entries`/`hsk`, ~205 MB for `segment` and hanzi
search, ~235 MB for English search, ~265 MB once the pinyin indexes are up (the
Phase 8 harness, one route per process).

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

### Seeing it from outside: three headers and `pnpm coldstart`

Everything above is a claim about *one process*: one parse, one set of indexes,
one warm-up. From outside, that is invisible — a fast response and a slow one
look the same whether they came from the same instance or from two. So every
dictionary response carries three headers (`lib/dict/diagnostics.ts`):

| Header | What it is |
|---|---|
| `x-tangram-instance` | a `randomUUID()` minted once at module load — the same value on every response from one process, a different one from any other |
| `x-tangram-index-parts` | `builtIndexParts()` at response time: empty on a 503, `sorted,entries,hsk` on a process that has only answered the banner's probe, all six once every *index part* is built |
| `x-tangram-dict-warm` | `dictionaryWarm()` — `yes` only when the six parts **and** the two caches outside that vocabulary (search's headword indexes, the segmenter's DAG statistics) are built |

The third is not a restatement of the second. `warmDictionary()` builds two caches
that are keyed off the index object rather than stored in it, so
`builtIndexParts()` cannot see them by construction: a process can report all six
parts while a first reader paste still pays ~145 ms to build the DAG statistics.
That is exactly what a warm-up frozen half-way leaves behind, so "settled" is read
off `x-tangram-dict-warm` and the parts list is the partial picture beside it.

They are on the 400s and the 503s too, which is where they are worth the most,
and they carry nothing else — a random id, a fixed six-word vocabulary, and a
two-word flag.

`pnpm coldstart` replays the opening of a session against a deployment and reads
them back:

```bash
export TANGRAM_ACCESS_SECRET=…      # once, if the deployment is gated
pnpm coldstart --base-url https://<your-app>.vercel.app
```

**Run it against an instance nothing has touched yet.** The subject is a *cold*
start, so any earlier request — `pnpm smoke`, a browser opening the app, a health
check, or a previous run of this script — has already paid the bill the run exists
to watch being paid, and every number would then be a warm number under a cold
run's labels. The probe detects that (a HEAD that already lists all six parts, or
one that answers in under 100 ms — far under a cold `dict.json` parse), says `this
instance was already warm before the probe ran`, and exits non-zero so the run
cannot be quoted. That is also why §7 runs it *before* `pnpm smoke`.

It issues the banner's `HEAD /api/dict/hsk?band=1`, waits two seconds for
`after()` to settle, then a first `entries`, `search` and `segment`, then each
again — printing latency, instance id, built parts and the warm flag per response.
**Its verdict is the instance id, not a latency band:** one id across the sequence
means one process answered everything and the numbers are a like-for-like series;
more than one means more than one function or instance and the numbers are not
comparable. The success line also names what it did *not* see: four of the eight
routes (`/api/ask`, `/api/examples` and `/api/recall` carry no header, and
`/api/dict/decomp` is stamped but never sampled), and any second instance serving
concurrent traffic, which seven sequential requests cannot reveal. A non-2xx is an
invalid sample rather than a slow one, and against a gated deployment it refuses to
run without a key — from `--key` or from `$TANGRAM_ACCESS_SECRET`, the same
fallback `pnpm smoke` uses. `GET /api/ask` is not sampled — it reads no dictionary
— it is only the gate check, so a refusal still issues that one request; what it
never issues is a dictionary sample.

Prefer the environment variable to `--key`. `--key` exists for the case where the
variable is not exported, and passing it puts the secret in the process list
(`/proc/<pid>/cmdline`, `ps`) and in shell history. A `--base-url` carrying
`?key=…` — the URL the device-authorisation flow above tells you to visit — is
disarmed rather than used: the key is lifted out into the cookie and only the
origin is printed and requested.

**The comparison run.** The phase's result is this probe against the new
deployment *beside* the same run against the one before it, so run it once against
the previous deployment's immutable URL (`https://<project>-<hash>.vercel.app`,
from `vercel ls` or the dashboard — the alias always points at the newest build)
and once against the alias. Any build from before Phase 9 carries no headers at
all, and the probe's `no x-tangram-instance on any response … predates the
diagnostic headers` verdict is the *expected* answer there, not a failure. It
still exits 1 by default, because a deployment that lost the headers for any other
reason (the wrapper dropped from a route, a proxy stripping `x-tangram-*`) looks
identical; pass `--allow-unstamped` for that one deliberate run.

If the ids ever differ, the first thing to look at is whether a route has grown a
`maxDuration`, `memory`, `runtime` or `preferredRegion` export: that is exactly
what makes one route's function configuration differ from the rest and splits it
into its own function, with its own cold start and its own unwarmed indexes. If a
ceiling is genuinely needed it belongs in a `vercel.json` covering `app/api/**`, so
every route keeps the same configuration.
`tests/unit/server/route-config.test.ts` fails the build before that can ship by
accident.

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
`next dev` and under `pnpm start` — the file is simply on disk in both — and in
the deployment it is relying on a route it happens to be grouped with having
asked for the same files. `/api/examples` and `/api/recall` shipped exactly that
way; nothing caught it but a person opening the page.

So it is no longer left to memory:

- `tests/unit/server/routes.test.ts` walks each route's import graph and fails
  if one reaches `lib/dict/load.ts` without a key covering it, and
- `pnpm smoke` refuses to run at all if a handler in `app/api/**` has no case.

Each of the eight routes therefore *traces* its own ~34.4 MB copy of `data/`
(each route's `.nft.json` lists it), and that is still the right shape to declare
even though there is one function — because what ships is the **union** of the
group's traces, deduplicated. A per-route entry is how a route states its own
requirement instead of inheriting someone else's, and the day the group is ever
split — a stray `maxDuration`, or growth past the 225 MiB budget — the route that
never declared its files is the one that 500s, in the deployment only.
`.vercel/output/functions/api/ask.func/.vc-config.json` names `data/dict.json`
once: one copy, well inside the 250 MB unzipped per-function limit, and it is that
group budget rather than the per-route trace that decides when a split happens.

## 6. Function timeout vs the ask deadline

`/api/ask` waits up to **30 s** for the model (`ANSWER_TIMEOUT_MS`), `/api/examples`
20 s, `/api/recall` 15 s. If your Vercel plan's function timeout is *lower* than
that, the platform kills the function first and the panel shows a generic
failure instead of the route's own 502.

Either raise the function's max duration to comfortably above 30 s, or lower the
deadlines with `TANGRAM_ASK_ANSWER_TIMEOUT_MS` and friends — they exist for
exactly this, and take effect without a rebuild.

## 7. After a deploy: what to check

**`pnpm coldstart` goes first, before anything else touches the deployment.** It
is the check that the deployment is still one warm process rather than several
cold ones, and it can only see that on an instance whose first request is its own
— `pnpm smoke` warms the process it runs against, and so does a browser opening
the app (§5). Run it against a URL nothing has touched since the deploy:

```bash
export TANGRAM_ACCESS_SECRET=…      # once, if the deployment is gated
pnpm coldstart --base-url https://<your-app>.vercel.app
```

If it reports `this instance was already warm before the probe ran`, the run
measured nothing: wait for the deployment to scale back to nothing, or redeploy,
and run it again first.

Then the smoke script against the same deployment. It hits every API route, every
nav page, and the three files the PWA needs, and fails on any non-2xx:

```bash
pnpm smoke --base-url https://<your-app>.vercel.app
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
