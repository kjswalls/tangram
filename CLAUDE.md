# Tangram

A local-first Mandarin lookup-and-SRS app. **One React codebase, three destinations.**

- **One pnpm workspace.** `apps/app/` is the client; `apps/server/` is the small service;
  `apps/site/` is the marketing site; `packages/*` holds what more than one of them needs.
  `data/`, `scripts/`, `docs/`, `PLAN.md`, `HANDOFF.md` and this file stay at the **workspace root**,
  because three deployables consume `pnpm data`'s output.
- **The client is a plain SPA built by Vite 8**, routed by React Router 8 in data mode. Not Next, not
  SSR, not a framework runtime — `pnpm build` emits a directory of static files.
- **Phones are that same build wrapped by Capacitor 8.5.x**; desktop and wide web are that same build
  **installed as a PWA**. A Tauri shell is a later, optional addition whose only new capability is a
  global hotkey.
- **The dictionary is one prebuilt, read-only SQLite file**, identical on all three platforms,
  produced by `pnpm data` and *queried* rather than parsed into the heap. Native bundles it as an app
  asset; the web imports it into OPFS. Local writes (cards, reviews, lists, settings) keep going to
  Dexie/IndexedDB behind `lib/db/repository.ts`.
- **A small server** holds accounts, sync and the AI proxy, and is the only thing that ever sees the
  learner's model key.

**The decision record is [docs/STACK.md](docs/STACK.md)** — what was decided, why, what was rejected,
and what is still open. **The build briefs are [docs/plans/](docs/plans/README.md)** — one per
deliverable (`web`, `data`, `core`, `backend`, `ios`, `android`), with
[docs/plans/wave-zero.md](docs/plans/wave-zero.md) carrying the orchestrator's rulings on every seam
between them. **Where wave-zero and a plan disagree, wave-zero governs.** Read STACK.md, then
wave-zero.md, then your own plan in full — including its §4 dependency table — before running a phase.

## Commands

Run from the **workspace root** unless a command says otherwise. `pnpm -F app <script>` runs a
script inside `apps/app/`.

```bash
pnpm dev          # the app's dev server
pnpm build        # pnpm data:ensure (root) && the app's build
pnpm preview      # serve the production build
pnpm lint         # eslint
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest run                        (jsdom, tests/unit/**)
pnpm e2e          # playwright test                   (tests/e2e/**, builds then serves)
pnpm data         # generate data/*.json from upstream sources, into the ROOT data/
pnpm data:ensure  # generate only if the artifact is missing
pnpm sw           # generate the service worker, stamped with the build id
pnpm smoke        # hit every route of a built, running server; fails on any non-2xx
```

**`pnpm data` writes to the workspace-root `data/`, always.** Two files decide that:
`scripts/build-data.ts` writes it and `lib/dict/load.ts` reads it. `TANGRAM_DATA_DIR` is the
**authoritative** mechanism and the root `data` / `data:ensure` / `build` scripts set it to the
absolute workspace-root path; both files' defaults resolve the workspace root by walking up for
`pnpm-workspace.yaml`, which is the safety net for everything those scripts do not wrap — `pnpm -F
app dev`, `pnpm preview`, vitest, the Playwright web server, all of which run with cwd `apps/app/`.
Neither is cwd-relative, deliberately: a cwd-relative default reads `apps/app/data`, the writer's
matching default writes there, and **the two agree with each other in the wrong place while every
test still passes.** If you touch either file, check the invariant by running it, not by reading it
— and note that a bundler or a deployment that does not carry `pnpm-workspace.yaml` alongside
`data/` breaks the marker walk, which is why `apps/app/tracing.config.ts` traces both.

Node **>= 22.22** (React Router 8's floor); pnpm 10. Playwright uses the container's Chromium via
`executablePath: /opt/pw-browsers/chromium` — **never run `playwright install`**. `pnpm e2e` occupies
`$PORT` (default 3000).

> **Migration state, as of `web.md` W4 and `data.md` D4.** Landed: the workspace and the Vite swap
> (W0, W1), the host config and the dictionary's web delivery (W2), the service worker's real cache
> name (W3), the access gate (W4), the SQLite dictionary and its Node and browser stores (D1–D4),
> the server and the frozen ask contract (`backend.md` B0 and B2's first commit), and wave 0's
> `Repository` interface diff. **The three debts this block used to name are discharged** — the gate
> is `packages/access` reading `X-Tangram-Access`, the worker's cache name is a hash of Vite's
> output, and `pnpm smoke` asserts content rather than status.
>
> Five things a builder must not read a green gate as having finished:
>
> - **The app still looks words up through the server.** `data.md` D4 built the browser store, but
>   **D6** is what points the app at it: `lib/dict/http-store.ts` and the five `app/api/dict/*`
>   routes are still the live path. Until D6, the SPA is not actually offline for lookup.
> - **The native dictionary stores are unproven**, and so is the web one on Apple platforms. D5a and
>   D5b need an Android phone and a Mac with a physical iOS 26 device; register #4 (the reported
>   10 MB per-file OPFS cap in WKWebView) is unanswered because the container has no Safari.
> - **There are no accounts, no sync and no AI proxy.** The three model-backed routes still run in
>   the app rather than `apps/server`, and `packages/ai/` holds only `schemas.ts` and `retrieve.ts`
>   — wave 0's move of the ten `lib/ai/**` modules has not run, and `backend.md` B1 gates on it.
> - **Backup, restore and sync are declared, not implemented.** The seven members wave 0 added to
>   `lib/db/repository.ts` throw; `web.md` W5 and `backend.md` B5 write the bodies. They throw on
>   purpose — see the guard in `tests/unit/db/repository.test.ts`.
> - **Two gloss searches exceed the 50 ms interactive budget** in wasm (`to` and `the`, at
>   89–100 ms) and are pinned by name at a 200 ms ceiling. `wave-zero.md` §10e is why the cap was
>   not lowered; any *other* interactive query over 50 ms fails the suite.
>
> `HANDOFF.md` has the full list with what each phase owes. Check `package.json` rather than
> assuming.

## Shared surfaces: frozen by a commit, not by a list

The old rule froze a hand-written list of files so that parallel overnight builders in one tree could
not fight over them. The purpose still holds — **two builders must not edit the same shared surface**
— but the list went stale, and the builders are now separate plans landing over weeks.

**The rule is now: a shared surface is frozen by a types-only first commit in the plan that owns it,
and every other plan gates on that commit rather than on the whole phase.** The owner lands the
declarations alone, first, with no implementation; the siblings start the moment that commit exists.
Three surfaces already work this way and are the pattern to copy:

- `data.md` **D1's first commit** — the `DictStore` / `SqlRunner` / `DictStatus` declarations.
- `backend.md` **B2's first commit** — the ask request/response contract.
- `wave-zero.md` **§5** — the single `lib/db/repository.ts` interface diff, carrying `web.md` W5's
  and `backend.md` B5's additions at once so neither rebases on the other.

**A builder who needs a change to a frozen surface stops, writes the need into `HANDOFF.md`, and
continues without it.** That part is unchanged and it is not negotiable — a schema change in
particular stops the build rather than landing quietly in a branch.

### The settle-first list

These are the surfaces that more than one plan reads. Each is frozen once its owner's types-only
commit lands; do not edit one because your phase would be easier if it were different.

| Surface | Frozen by |
|---|---|
| `packages/ai/**` — the provider contract, grounding, prompts, the cache key, `retrieve.ts` | `wave-zero.md` §5's move |
| `lib/db/repository.ts` | `wave-zero.md` §5's interface diff |
| `lib/db/schema.ts` | Phase 0; still authoritative |
| `lib/types.ts` | Phase 0; still authoritative |
| `lib/srs/params.ts` | Phase 0; still authoritative |
| `DictStore` / `SqlRunner` / `DictStatus` | `data.md` D1's first commit |
| The ask contract | `backend.md` B2's first commit |

`lib/types.ts` holds the dictionary `Entry` shape itself, not an import of it: freezing a shape only
works if the definition sits inside the frozen file. `lib/dict/types.ts` is a re-export (`Entry` is
`DictEntry` there) plus the route response bodies, so the plan that owns `lib/dict/**` cannot change
the contract by accident.

Never hand-edit `pnpm-lock.yaml`.

## What has not changed

[PLAN.md](PLAN.md) is superseded by `docs/STACK.md` on architecture (§3) and on the phase plan (§4).
It remains **authoritative** on four things, and no plan in the set re-argues them:

- **§3.1 — the data contract.** The dictionary `Entry` shape, `EntryId` (`trad|simp[pinyinNum]`),
  HSK bands, marked pinyin, frequency.
- **§3.3 — the schema rules.** See "The repository seam" below.
- **§3.4 — the grounding contract.** **The dictionary is ground truth and the model never emits a
  headword for display.** The model returns entry ids and sense indexes; every Chinese character and
  every pinyin syllable the learner sees is *rendered from the cited entry*, so a fabricated reading
  cannot reach the screen by construction. A cited id that is not in the retrieved set is dropped; a
  sense index out of range is dropped; CJK runs are stripped from prose fields; a token the model
  supplied as text is flagged "AI-generated, not in dictionary" on that token alone. This is the
  product's core promise, not an implementation detail.
- **§5 — the licence boundary.** See "Data and licences" below.

**There are no users and no data.** The owner has not used the app. **Schema changes are free.**
Nothing in this repo is a migration plan and nothing in it should become one — a document that
contains the word has misread the situation.

## Data and licences

`data/*.json` (and the SQLite artifact that replaces it) is **generated** by `pnpm data` and
gitignored. `data/ATTRIBUTION.md` and `data/COPYING-*` are **committed** and rendered in `/settings`;
that rendering is a licence obligation, not a nicety.

The sources are kept apart because their licences differ, and they must never be merged:

- **CC-CEDICT** (CC BY-SA 4.0) plus mechanical derivations (marked pinyin, HSK band, jieba
  frequency) — the dictionary proper. Attribution and a modification notice ship with it. It is the
  only source that may feed a model prompt.
- **Make Me a Hanzi** `dictionary.txt` (LGPL-3.0-or-later, `COPYING` committed as
  `data/COPYING-makemeahanzi`) → `data/decomp.json`. Character decomposition only; it **never** enters
  a card snapshot, the SQLite dictionary or a model prompt, and it stays a separate artifact for
  exactly that reason. The repo's graphics/SVGs are Arphic PL and are not used.
- **SQLCipher's BSD notice** must be reproduced in-app once the native SQLite plugin ships
  (`docs/STACK.md` §2.5) — add it to `data/ATTRIBUTION.md` alongside the other two.

The ask cache stores entry ids and sense indexes only, never gloss text, so dictionary text is never
redistributed verbatim from the cache.

## The repository seam (`lib/db`)

`lib/db/repository.ts` is an interface; `lib/db/dexie.ts` is the only implementation. Everything above
the db layer talks to the interface, which is what makes a later server swap a swap. The rules that
keep it swappable (PLAN.md §3.3):

- every row keys on a client-generated `id: string` (`crypto.randomUUID()`; Dexie `'id'`,
  never `'++id'`);
- every row has `createdAt`, `updatedAt` (epoch ms) and nullable `deletedAt` — soft delete,
  and `list*` filters tombstones;
- FKs are UUID strings with indexes;
- the Dexie instance is created lazily inside a `'use client'` module (`getDb()`, memoised
  on `globalThis`), never at import time. `server-only` never appears under `lib/db`, and
  importing `lib/db` under Node must not throw.

Be precise about what this seam is: it is a **data-layer swap** seam. Its schema rules are the
*precondition* for sync, not sync itself — there is no change feed, no per-row version and no
conflict policy until `backend.md` B5 adds them through the frozen interface diff.

## Conventions

- `"type": "module"`; TypeScript strict; `@/*` maps to the app root in both the bundler and Vitest.
- zod **3** (v4's API differs), vitest **4**, TypeScript **5.9**, ts-fsrs **5** — the pins in
  `docs/STACK.md` §6 and `docs/data-sources.md` are deliberate, not stale. Re-check a version row
  before you build on it; several were recorded from search summaries.
- **FSRS parameters are built in exactly one place: `lib/srs/params.ts`.** Nothing else may call
  `fsrs()`, `generatorParameters()` or `new FSRSAlgorithm(...)`. It reads `settings.requestRetention`,
  `settings.shortTermSteps` and `settings.fsrsWeights` (validated — a bad vector falls back to the
  population defaults), and grading, the interval previews, replay and the optimizer all go through
  it. `shortTermSteps` defaults **true**, which is ts-fsrs's own default: a failed card comes back in
  minutes, so a grade can schedule inside the session.
- The dictionary loader throws `DictDataMissingError` when the artifact is absent; the layer above
  maps it to a banner (`503 {error:'dict-data-missing', hint:'run pnpm data'}` on the routes that
  still exist). **Missing data is a banner, not a crash** — keep it that way.
- **There is no CI.** This repository has no `.github/` and no plan in the set creates one, so every
  rule that wants enforcement becomes a unit test under `tests/unit/`, not a workflow.
- `HANDOFF.md` is **append-only**: add your section, never rewrite someone else's. Record what you
  decided that your plan did not settle, and anything you found wrong in the plan set — the seven
  documents have been through two reconciliation rounds and a verifier still found eight open
  problems (`docs/plans/README.md`, register V1–V8).
- **Deploying is [docs/deploy.md](docs/deploy.md)** — env vars, the `TANGRAM_ACCESS_SECRET` gate on
  the three model-backed routes (unset means the gate does not exist), cold start and memory, and the
  after-deploy checklist. `pnpm smoke` is what proves a built server before it is trusted.
