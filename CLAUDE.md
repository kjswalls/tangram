# Tangram

A local-first Mandarin lookup-and-SRS app: Next 16 App Router (React 19, Tailwind 4),
IndexedDB via Dexie behind a repository interface, no server database. The design of record
is [PLAN.md](PLAN.md) — §3 is the architecture, §4 the phase plan and the acceptance
criteria. Upstream data formats and the pinned dependency versions are in
[docs/data-sources.md](docs/data-sources.md). Read the relevant section before building.

## Commands

```bash
pnpm dev          # next dev
pnpm build        # pnpm data:ensure && next build   (Turbopack, the Next 16 default)
pnpm start        # serve the production build
pnpm lint         # eslint .                          (next lint no longer exists)
pnpm test         # vitest run                        (jsdom, tests/unit/**)
pnpm e2e          # playwright test                   (tests/e2e/**, builds then serves)
pnpm data         # generate data/*.json from upstream sources
pnpm data:ensure  # generate only if data/dict.json is missing
```

Node >= 20.9, pnpm 10. Playwright uses the container's Chromium via `executablePath:
/opt/pw-browsers/chromium` — **never run `playwright install`**. `pnpm e2e` occupies
`$PORT` (default 3000); worktrees use 3001/3002/3003.

## Frozen files

Phase 0 owns every surface the parallel phases share, so those files are **frozen** once
Phase 0 lands:

```
package.json          pnpm-lock.yaml        next.config.ts
lib/db/schema.ts      lib/db/repository.ts  lib/types.ts
app/layout.tsx        app/globals.css       components/ui/**
components/lookup/lookup-panel.tsx
configs: tsconfig.json, eslint.config.mjs, vitest.config.ts, playwright.config.ts,
         postcss.config.mjs
```

A builder that needs a frozen file changed **stops, writes the need into `HANDOFF.md`, and
continues without it**. The orchestrator applies it on `main` and merges forward. This is
what keeps two worktrees from fighting over the same file, so it is not negotiable — a
schema change in particular stops the build rather than landing in a branch.

`lib/types.ts` holds the dictionary `Entry` shape itself, not an import of it: freezing a
shape only works if the definition sits inside the frozen file. `lib/dict/types.ts` is a
re-export (`Entry` is `DictEntry` there) plus the route response bodies, so P1, which owns
`lib/dict/**`, cannot change the contract by accident.

Never hand-edit `pnpm-lock.yaml`; every dependency is already installed, so no phase after 0
should be touching `package.json` at all.

## Data and licences

`data/*.json` is **generated** by `pnpm data` and gitignored. `data/ATTRIBUTION.md` and
`data/COPYING-*` are **committed** and rendered in `/settings`.

The two JSON files are kept apart because their licences differ, and they must never be
merged:

- `data/dict.json` — CC-CEDICT (CC BY-SA 4.0) plus mechanical derivations (marked pinyin,
  HSK band, jieba frequency). Attribution and a modification notice ship with it. It is
  the only source that may feed a model prompt.
- `data/decomp.json` — Make Me a Hanzi `dictionary.txt` (LGPL-3.0-or-later, `COPYING`
  committed as `data/COPYING-makemeahanzi`). Character decomposition only; it never enters
  a card snapshot or `dict.json`. The repo's graphics/SVGs are Arphic PL and are not used.

The ask cache stores entry ids and sense indexes only, never gloss text, so dictionary text
is never redistributed verbatim from the cache.

## The repository seam (`lib/db`)

`lib/db/repository.ts` is an interface; `lib/db/dexie.ts` is the only implementation.
Everything above the db layer talks to the interface, which is what makes a later Supabase
swap a swap. The rules that keep it swappable:

- every row keys on a client-generated `id: string` (`crypto.randomUUID()`; Dexie `'id'`,
  never `'++id'`);
- every row has `createdAt`, `updatedAt` (epoch ms) and nullable `deletedAt` — soft delete,
  and `list*` filters tombstones;
- FKs are UUID strings with indexes;
- the Dexie instance is created lazily inside a `'use client'` module (`getDb()`, memoised
  on `globalThis`), never at import time. `server-only` never appears under `lib/db`, and
  importing `lib/db` under Node must not throw.

## Conventions

- `"type": "module"`; TypeScript strict; `@/*` maps to the repo root in both Next and
  Vitest.
- zod **3** (v4's API differs), vitest **4**, TypeScript **5.9**, ts-fsrs **5** — the pins
  in `docs/data-sources.md` are deliberate, not stale.
- FSRS runs with `enable_short_term: false`: every grade schedules at least a day.
- The dictionary loader throws `DictDataMissingError` when `data/` is absent; routes map it
  to `503 {error:'dict-data-missing', hint:'run pnpm data'}`. Missing data is a banner, not
  a crash — keep it that way.
- `HANDOFF.md` is append-only: add your section, never rewrite someone else's.
