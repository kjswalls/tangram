# Builder D — deploy hardening

Branch `d`, cut from `a8fe928`. Four jobs: gate the routes that spend money,
cut the cold start, prove the production path over HTTP, and write the Vercel
story down. The whole story for an operator is **[docs/deploy.md](docs/deploy.md)**;
this file is what the *merge* needs to know.

Green on this branch: `pnpm lint`, `pnpm test` (678 unit, 65 files — 647 before,
so +31), `pnpm build`, `PORT=3004 pnpm e2e` (95 specs — 90 before, so +5).

---

## 1. Files I touched that are not mine alone

Read this section first; everything else is new files in my own lane.

| File | Change | Why it had to be there |
|---|---|---|
| **`package.json`** (FROZEN) | one line added to `scripts`: `"smoke": "tsx scripts/smoke.ts"` | The brief asks for `pnpm smoke`. Nothing else in the file is touched — no dependency, no lockfile change. Flagging it because the freeze rule says to. |
| `lib/dict/index.ts` | indexes built lazily; `glossTokens` rewritten as one scan; `builtIndexParts()` added | §2. The cold-start work has nowhere else to live. |
| `lib/dict/pinyin.ts` | `readingKeys()` appended (new export, nothing existing changed) | §2 |
| `next.config.ts` | comment only — points at the test and the script that now enforce the tracing map | mine by the brief |
| `app/api/{ask,examples,recall}/route.ts` | `requireAccess(request)` as the first statement of each handler; `GET()` → `GET(request)` on ask and examples | §3. **No route computes anything differently.** |
| `tests/unit/ai/route.test.ts`, `tests/unit/ai/examples-route.test.ts` | one line each: `GET()` → `GET(new Request('http://localhost/api/…'))` | the handshake handlers now take the request they have to inspect |

New files, all in my lane: `middleware.ts`, `lib/server/access.ts`,
`lib/server/route-inventory.ts`, `scripts/smoke.ts`, `docs/deploy.md`,
`tests/unit/server/{access,routes,cold-start}.test.ts`,
`tests/e2e/d/{access-gate,smoke}.spec.ts`, plus a block in `.env.example`.

Nothing under `lib/srs`, `lib/fsrs-optimize`, `lib/stats`, `lib/db`,
`components/` or `app/settings` was touched. No schema change, no dependency,
no lockfile change.

## 2. Cold start: measured, then reduced

**Before.** Every route independently read and parsed 33.5 MB of JSON and then
built all seven indexes — including the ones it never reads. On the build box:
**3.9–4.6 s and 280–292 MB RSS, per route, per cold instance.** (HANDOFF.md §
Phase 0 open question 4 recorded "≈2 s, ≈310 MB"; on this shared 4-vCPU box it
is closer to 4 s. Both are the same fact.)

**After.** Median of three fresh Node processes each:

| First request on a cold instance | before | after |
|---|---|---|
| `/api/dict/decomp` | 17 ms | 16 ms |
| `/api/dict/entries` | 4064 ms | **972 ms** |
| `/api/dict/hsk` (Today's first call) | 4141 ms | **1026 ms** |
| `/api/dict/segment` | 4373 ms | **1346 ms** |
| `/api/dict/search`, hanzi | 4610 ms | **1443 ms** |
| `/api/dict/search`, English | 4147 ms | **1698 ms** |
| `/api/dict/search`, pinyin | 3909 ms | **2429 ms** |
| every index (`/api/ask` warmed) | 4052 ms | **2348 ms** |

RSS after that first request: 171–177 MB (`entries`, `hsk`), ~205 MB
(`segment`, hanzi search), ~235 MB (English), ~265 MB (pinyin), down from
280–292 MB across the board.

Three changes:

1. **`DictIndex` is built one part at a time** — `LazyDictIndex` in
   `lib/dict/index.ts`, getters over `#sorted`/`entries`/`hanzi`/`pinyin`/
   `gloss`/`hsk`. **Nothing above that file changed**: `index.byGloss` still
   reads like a field, and the `WeakMap`s in `search.ts` and `segment.ts` still
   key on the same object across calls. This is the change that matters on
   Vercel specifically, where each route is its own process; under `pnpm start`
   one warm process serves everything and only the first request notices.
2. **`readingKeys(pinyinNum)`** in `lib/dict/pinyin.ts`. CC-CEDICT's pinyin is
   already syllable-split, so the query parser's DP does not need to run over
   it: the two pinyin indexes went 1310 ms → ~250 ms. It returns `null` for
   anything that is not plain numbered pinyin (742 readings, e.g. `A quan1 r5`,
   `san1 C`) and the caller falls back to `normalizePinyin`.
3. **`glossTokens` is one scan** instead of lowercase→replace→split→map→filter.
   ~210 ms over 195,550 glosses.

**Both fast paths are proved against the whole dictionary**, not against
examples — `tests/unit/server/cold-start.test.ts` compares `readingKeys` to
`normalizePinyin` on all 124,154 readings and the new `glossTokens` to the old
implementation (kept in the test as an oracle) on every gloss. Zero
disagreements. Laziness is proved too, which is what `builtIndexParts()` is
for: a fresh cache is walked through `hsk` → `segment` → English search →
pinyin search and the set of built parts is asserted at each step. A property
nobody can observe is a property that quietly stops holding.

**What I measured and did not do**, with the numbers, is in
[docs/deploy.md §5](docs/deploy.md). Short version: there is no dead field in
`dict.json` to drop (the biggest single field is `glosses` at 20% and every
response renders it); packing the three booleans would buy ~120 ms of a 650 ms
parse for a change to a frozen type and to the `pnpm data` contract; and a
precomputed key file would add a second artifact that can go stale for less
benefit than it looks, now that derivation is no longer the dominant cost. The
remaining floor is the 650 ms `JSON.parse` itself, and getting under **that** is
a storage-format change, not a tweak. I left it, and said so.

`pnpm data`'s outputs are byte-identical to before (checked: `entries` deep-equal
after a `--force` rebuild, only `meta.builtAt` differs). The dict/decomp licence
split is untouched — nothing new reads `decomp.json`, and nothing merges it.

## 3. The access gate

`TANGRAM_ACCESS_SECRET` set → `/api/ask`, `/api/examples`, `/api/recall` (GET
handshakes included) need a cookie. Unset → **nothing exists**: every function
short-circuits, and the whole test suite runs in that state.

- `lib/server/access.ts` is the logic and imports nothing from `next/*`, so
  middleware (Edge), the handlers (Node) and the unit tests run the same code.
- `middleware.ts` trades `?key=<secret>` for the cookie on any route, then
  **303s to the same URL with the key removed** (`?access=granted|denied`), so
  the secret is not left in history, a bookmark or a `Referer`. A wrong key also
  clears any cookie the device had.
- The handlers call `requireAccess` again. Middleware is one `matcher` edit away
  from silently not running, and that failure mode is an invoice.
- Constant-time compare, hand-rolled (`node:crypto` is not on Edge): no early
  exit, length folded into the same accumulator.
- A refusal is `401 {"error":"unauthorized"}` + `Cache-Control: no-store`. No
  hint, no stack, no echo. The secret is never logged.
- **The cookie carries the secret verbatim.** Deliberate: a synchronous check
  with no crypto in the request path, and rotation that actually works — change
  the variable and every cookie ever issued dies at once. The trade is stated in
  the module header and in docs/deploy.md: the cookie *is* the credential.
- A secret outside `[A-Za-z0-9._~-]` is refused as a cookie value rather than
  encoded (two spellings of one credential is a hole), and the visitor gets
  `?access=unusable`. docs/deploy.md gives the `openssl` line that satisfies it.
- Pages, dictionary routes, manifest, `sw.js` and `/offline.html` stay open —
  the PWA has to install and the offline session has to run without a key.

Proved end to end by `tests/e2e/d/access-gate.spec.ts`, which starts a **second**
`next start` on `PORT+100` with the secret set (reusing the `.next` the suite
already built) and drives refused → `?key=` → cookie → 200. Also verified by
hand against a real server: 401 body, `set-cookie` attributes, both redirects.

> **Next 16 deprecation.** The build prints `The "middleware" file convention is
> deprecated. Please use "proxy" instead.` I kept `middleware.ts` — it is what
> the brief names, it demonstrably works, and swapping conventions blind is not
> what a hardening branch should do on its last hour. Migration is a rename plus
> the export name (`npx @next/codemod@canary middleware-to-proxy .`);
> `tests/e2e/d/access-gate.spec.ts` is what will tell you it still runs.

## 4. Proving the production path

`pnpm smoke [--base-url URL] [--key SECRET]` hits **20 things** on a built,
running server — all 11 API handlers (including the `HEAD /api/dict/hsk` probe
`components/shell/data-banner.tsx` actually makes), the six nav pages, and
`sw.js` / `manifest.webmanifest` / `offline.html` — and fails on any non-2xx.
Cases chain: the search runs first and hands its entry id to `entries`,
`examples` and `recall`, so nothing depends on a hard-coded id that a CC-CEDICT
snapshot could stop containing.

Two guards so this does not rot:

- `checkRouteCoverage()` enumerates `app/api/**/route.ts`, reads the methods
  each one exports, and **refuses to run** if any has no case. It runs in
  `pnpm smoke`, in `tests/unit/server/routes.test.ts` and in the e2e spec.
- `untracedDictRoutes()` walks each route's import graph and fails if one
  reaches `lib/dict/load.ts` without an `outputFileTracingIncludes` key covering
  it. That is the `/api/examples` + `/api/recall` bug, turned into a test.

`tests/e2e/d/smoke.spec.ts` runs the same `runSmoke` against the suite's own
built server, so it is wired into `pnpm e2e` and not a script to remember.

Verified by hand this session: all eight route `.nft.json` files list
`data/dict.json` and `data/decomp.json`, so the current tracing map is correct
as well as enforced.

## 5. Things the merge should know, and things left undone

1. **`package.json` gained one line.** See §1.
2. **`GET` on `/api/ask` and `/api/examples` now takes a `Request`.** Two unit
   test call sites were updated. If A/B/C add a call to either handshake, it
   needs a `Request`.
3. **`/api/ask`'s 30 s answer deadline can outlive a Vercel function timeout**
   on a small plan, and then the platform kills the function instead of the
   route returning its own 502. I did not add `export const maxDuration` — the
   brief limits my edits in `app/api/**` to the gate, and the value depends on
   Kirby's plan. docs/deploy.md §6 says to raise the limit or lower
   `TANGRAM_ASK_ANSWER_TIMEOUT_MS`, which needs no rebuild.
4. **Each of the eight functions carries its own ~34.4 MB copy of `data/`**,
   because `outputFileTracingIncludes` globs `./data/**` for all of them. Well
   inside the 250 MB unzipped limit, and narrowing it (`decomp` only needs
   `decomp.json`; nothing else needs it) would save ~40 MB of upload for a real
   risk of a 500 the day somebody adds a decomposition read. Left conservative
   on purpose.
5. **No pointer to `docs/deploy.md` was added to `README.md` or `CLAUDE.md`** —
   both are shared and would conflict with three other branches. One line in
   each is worth adding at merge.
6. **I could not verify anything against Vercel.** No account, no network to it.
   Everything about serverless behaviour here is inference from the build
   artefacts (`.nft.json`) plus the documented Next behaviour, and docs/deploy.md
   §7 marks the one item — "the dictionary is really in the bundle" — that only
   a real deployment can settle.
7. **`tests/unit/server/cold-start.test.ts` calls `resetDictCache()`**, so it
   must not run in the same file as anything that assumes a warm cache. It is
   its own file for that reason.
