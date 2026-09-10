# Phase 9 — warm the rest (consolidation cancelled)

Status: **plan v2, after adversarial review** (3 lenses, 16 confirmed findings, 1 refuted).
Nothing here is built. v1 proposed consolidating the eight API routes into one function; the
review showed the platform already does that, so v1 is cancelled and this is what remains.

## What the review established

**Vercel already deploys all eight route handlers as one function.** A reviewer ran the real
builder (`npx vercel@59 build`, Next 16.3.4) on a copy of this repo: `.vercel/output/functions/
api/ask.func` is the only real directory, and `api/examples.func`, `api/recall.func` and
`api/dict/{hsk,search,segment,entries,decomp}.func` are all symlinks to it; its config lists
`data/dict.json` once. `@vercel/next` groups route handlers whose config matches
(`maxDuration`, `memory`, regions — none of ours set any) into one lambda up to a 225 MiB
budget, and Vercel documents this as intended ("bundled into the fewest number of Vercel
Functions possible, to help reduce cold starts"). The per-route `.nft.json` traces that led
`docs/deploy.md` §5 to say "each route carries its own copy" are deduplicated by the group.

So the "four cold starts per session" table in v1 was wrong about the *cause*. What a
session actually pays, measured in one process (which is now a faithful stand-in for
production):

| Moment | What happens in the one warm process | Cost |
|---|---|---|
| App opens: banner `HEAD /api/dict/hsk` | Next auto-implements HEAD from GET, so this already loads the dictionary and builds the `sorted`, `entries`, `hsk` index parts | ~1.0 s, not awaited by the UI |
| First lookup | Builds `hanzi`, `pinyin`, `gloss` parts and the search headword cache | **~1.0–1.4 s, felt** |
| First reader paste | Builds the segmenter's DAG cache | **~0.1–0.3 s, felt** |
| First ask | Nothing new (retrieval reuses search) | ~0 |

The *effect* v1 was chasing is real — a ~1 s pause on the first lookup — but it is lazy index
construction inside one process, not a second cold start. Consolidation cannot touch it.
Finishing the warm-up can.

## Design

**No route changes. No URL changes. No new function.**

1. **`warmDictionary()`** — a new export in `lib/dict` that touches every index-part getter
   in order (`sorted → entries → hsk → hanzi → pinyin → gloss`) and then the two caches that
   live outside the parts vocabulary: `search.ts`'s headword cache and `segment.ts`'s DAG
   cache (both gain a small exported warm hook). It yields between parts
   (`await new Promise(r => setImmediate(r))`) so a request that lands on the same instance
   mid-build interleaves rather than waiting behind ~2 s. Returns the list of what it built.
2. **`HEAD` on `app/api/dict/hsk/route.ts`**, explicitly exported: validates `?band` and
   builds only what `hsk` needs inside the same `try`/`dictErrorResponse` as `GET` (so a
   missing `data/` is the same 503 the banner already keys on), responds with no body, and
   schedules the remainder with **`after()` from `next/server`** — Next 16 supports it in
   route handlers and Vercel backs it with `waitUntil`, so the work completes after the
   response instead of being frozen with the instance. v1's "no post-response work" sentence
   was wrong and is withdrawn. Because HEAD now answers before the rest is built, Today's own
   `GET /api/dict/hsk`, which the banner's probe races on a cold open, is not delayed.
3. **Diagnostic headers on dictionary responses:** `x-tangram-instance` (a `randomUUID()`
   generated once at module load) and `x-tangram-index-parts` (`builtIndexParts()` joined).
   Cheap, and they make the function layout and the warm-up state visible from a phone or
   the smoke script without a stopwatch.
4. **`scripts/coldstart-probe.ts`** (`pnpm coldstart --base-url … --key …`): issues the
   banner's HEAD, waits two seconds, then `GET entries`, `GET search?q=dasuan`, `POST
   segment`, and a repeat of each; prints latency, instance id and built parts per response.
   Refuses to run against a gated deployment without `--key`; treats any non-2xx as an
   invalid sample. Its verdict is the instance id (same on every response → one process),
   not a latency band. `GET /api/ask` is not in the sequence — it reads no dictionary.
5. **Function config: export nothing.** A `maxDuration` or `memory` on one route is exactly
   what splits it out of the shared group. A unit test asserts no `app/api/**/route.ts`
   exports either; if a ceiling is ever needed it goes in `vercel.json` for `app/api/**`.
   HANDOFF records the project's plan tier and whether Fluid compute is on (Fluid defaults:
   2 GB, 300 s; otherwise `docs/deploy.md` §5's figures apply).
6. **Correct the record.** `docs/deploy.md` §5 and the four in-repo comments that assert
   one-function-per-route are rewritten to: Vercel groups route handlers into shared
   functions (one for this app today); tracing is still declared per route because a group's
   files are the union of its routes' traces. Add `vercel build` + `find
   .vercel/output/functions -type l` to `docs/deploy.md` as the deterministic way to see the
   layout without deploying.

## Acceptance

- In one fresh process on a built server: `HEAD /api/dict/hsk?band=1`, wait for `after()`
  to settle, then the first `search`, `segment` and `entries` requests each complete in
  **< 20 ms in-process and < 300 ms over HTTP** (today: ~1.0–1.4 s, ~0.1–0.3 s, ~1.0 s).
- `HEAD` and `GET /api/dict/hsk` issued concurrently to one fresh process: the GET completes
  within 150 ms of its solo cold time.
- `HEAD /api/dict/hsk` with `TANGRAM_DATA_DIR` pointing at an empty directory → 503
  `{error:"dict-data-missing"}`; with `?band=99` → the same 400 as GET.
- Every existing smoke case and e2e spec passes unchanged; `pnpm smoke --base-url
  https://<app>.vercel.app --key …` passes after deploy and the timings go in HANDOFF.md.
- `pnpm coldstart` against the deployment shows one instance id across the sequence and the
  full parts list after the HEAD; those numbers, beside a run against the previous deploy,
  are the phase's result.
- The no-config unit test exists; `vercel build` locally shows one real `.func` under `api`.

## Not in this phase, with the reason

- **The catch-all consolidation** — cancelled; the platform already does it.
- **The ~650 ms parse floor** — needs a different data format (`docs/deploy.md` §5).
- **A client-side HSK subset** — would remove the network from most lookups, but means two
  implementations of one ranking rule unless the ranking module is shared; separate decision.
- **Postgres** — the right answer for a second user, overkill for one.

## Tradeoffs, stated

- The warm-up pays the full ~2.3 s of index building once per instance, off the critical
  path — but any request that reaches that instance during the build shares its CPU.
  Yielding between parts is the mitigation; the concurrent-GET acceptance line is the proof.
- Concurrent traffic can still start a second instance that has not been warmed. Single-user
  premise; noted.
- Exporting `HEAD` replaces Next's auto-implemented HEAD on that one route only; every other
  GET route keeps the automatic one.
- Rollback is one `git revert`; no data, schema or URL changes.

## Amendment — after the cycle A review

Two lines above did not survive contact with a stopwatch, and are replaced rather
than quietly left standing.

**"Yielding between parts is the mitigation" (Tradeoffs) was wrong.** The parts are
150–450 ms of uninterruptible synchronous work each, so six yields across a 1.2 s
warm-up hand the loop back six times: measured worst stall 400 ms, and a `GET
/lookup` issued the instant the probe answered cost **1.30 s** against a 80 ms
baseline — the whole process, static files included, not just the dictionary
routes. The mitigation is now **yielding inside each part**: `lib/dict/incremental.ts`
builds every index in ~2k-entry slices and `warmDictionary()` hands the loop back
between them (937 steps, worst stall 23–25 ms, same `GET /lookup` 53 ms).

**"the concurrent-GET acceptance line is the proof" was wrong too**, and the
acceptance line it names is kept only as a regression check. A GET issued
*concurrently* with the HEAD is parsed and answered off the HEAD's own synchronous
build, before `after()` ever fires, so that measurement cannot observe the
warm-up's cost no matter how badly the warm-up behaves. The line that can:

- **A request issued ~50 ms after the HEAD *response resolves*** — which is when a
  user's first tap actually lands — completes in **under 100 ms**, measured for a
  route that reads no dictionary (`GET /lookup`) as well as for a cheap dictionary
  route (`GET /api/dict/entries`). Cycle A's numbers: `/lookup` 84 / 63 / 83 ms,
  `/entries` 19 / 26 / 14 ms, against a no-probe baseline of `/lookup` 75–82 ms.
- **The unit test** `tests/unit/dict/warm.test.ts` bounds the *longest* gap between
  1 ms timer ticks across a warm-up (p99 < 30 ms, worst < 150 ms). Its predecessor
  asserted `ticks > 0`, which 400 ms stalls satisfy.

Item 6 ("correct the record") is partly landed with this cycle: `docs/deploy.md` §5
and the two in-repo comments that asserted one function per route now say what
`vercel build` shows, §5's cold-start table is marked as superseded and names its
harness, and the warm-instance memory figure (311 MiB) is recorded beside the
per-route ones. `scripts/coldstart-probe.ts`, the diagnostic headers and the
no-`maxDuration` test (items 3–5) are still not built.

## Amendment — after cycle B

Design items **3, 4, 5 and the rest of 6** are built (HANDOFF.md, "Phase 9 — cycle B").
Two things the plan implied and this cycle had to decide:

- **The probe's gate check is `GET /api/ask`.** Item 4 says that route is not in the
  sequence because it reads no dictionary; that is also what makes it the safe preflight,
  since it cannot warm anything the samples measure. It is a gate check, not a sample.
- **A deployment with no diagnostic headers is a legitimate run.** The acceptance line
  asks for the probe's numbers "beside a run against the previous deploy", and the
  previous deploy has no headers at all — so the verdict says the latencies cannot be
  shown to come from one process, and exits 0. Only a *mix* of stamped and unstamped
  responses is an error.

Every Design item now stands built except the last acceptance bullet, which needs a real
Vercel deployment: `pnpm coldstart` against the app, beside the same run against the
previous deploy.
