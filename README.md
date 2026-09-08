# Tangram

Tangram closes the loop between looking a Chinese word up and actually keeping it: one
lookup box takes hanzi, pinyin (marks, numbers or neither), an English word or a whole
English sentence, and every answer is one tap from becoming a review card. Each card
carries the sentence or question it came from, so the back of the card is your context and
not a stranger's example. The dictionary is ground truth — hanzi, pinyin and tone marks are
rendered from dictionary rows the model cites by id, never from model prose.

Local-first: Next 16 App Router, React 19, and IndexedDB (Dexie) behind a repository
interface. Single user, works offline, no server database.

## Commands

```bash
pnpm dev          # next dev
pnpm build        # pnpm data:ensure && next build && pnpm sw
pnpm start        # serve the production build
pnpm lint         # eslint .            (next lint is gone in Next 16)
pnpm test         # vitest run          (unit, jsdom + fake-indexeddb)
pnpm e2e          # playwright test     (builds, then serves on $PORT, default 3000)
pnpm data         # build data/*.json from the upstream sources
pnpm data:ensure  # same, but only when data/dict.json is missing
pnpm sw           # generate public/sw.js (gitignored) from scripts/sw.template.js
```

Node >= 20.9 (`.nvmrc` says 22), pnpm 10.

## Data

`pnpm data` downloads CC-CEDICT (via the `cedict-json` package), the HSK 3.0 list, jieba
frequencies and Make Me a Hanzi decompositions, caches the raw files under
`TANGRAM_DATA_DIR/raw` (default `.cache/tangram/`), and writes `data/dict.json` and
`data/decomp.json`. Those JSON files are generated and gitignored; `pnpm data --force`
rebuilds them. `data/ATTRIBUTION.md` and `data/COPYING-*` are committed and are shown in
`/settings`. Without the JSON the dictionary routes answer
`503 {error:'dict-data-missing'}` and the shell shows a banner — nothing crashes.

## Environment

Copy `.env.example` to `.env.local`:

| Variable | Meaning |
|---|---|
| `ANTHROPIC_API_KEY` | Live AI answers. Absent → the FakeProvider (offline dictionary mode). |
| `TANGRAM_LLM_PROVIDER` | `fake` (default) or `anthropic`. |
| `TANGRAM_MODEL` | Model id for `AnthropicProvider`; empty uses its default. |
| `TANGRAM_DATA_DIR` | Where `dict.json` / `decomp.json` live. Empty → `<repo>/data`. |

The full design lives in [PLAN.md](PLAN.md); the verified upstream formats and pinned
versions are in [docs/data-sources.md](docs/data-sources.md).
