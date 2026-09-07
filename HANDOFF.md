# HANDOFF

Append-only. Each contributor adds a section; never rewrite someone else's.

## Phase 0 decisions (scaffold)

Choices made where PLAN.md was silent, plus the corrections it needs.

**Routes.** There is no `app/page.tsx`. `/` is served by `app/(today)/page.tsx`, which is a
throwaway placeholder — the shell builder replaces its contents.

**`pnpm data:ensure` in the stub never fails.** `scripts/build-data.ts --ensure` exits 0
whether or not `data/dict.json` exists (it warns when missing), because `pnpm build` runs it
and the scaffold has to be green before builder A lands the real generator. Builder A should
keep the exit-0 contract for `--ensure` and make it *generate* when the file is missing;
without `--ensure` the stub prints "not implemented" and exits 1, as specified.

**Dependency versions.** Pinned exactly where docs/data-sources.md named a version:
`next 16.3.4`, `react`/`react-dom` `19.2.8`, `eslint-config-next 16.3.4`, `ts-fsrs 5.4.2`,
`@anthropic-ai/sdk 0.124.0`, `cedict-json 1.3.20251213`. Everything else is a caret range at
the documented floor. No package name in §3 was wrong; nothing needed correcting.
`lucide-react` had no pinned version — it resolves to `^1.42.0`.
Added beyond §3's list because TypeScript needs them: `@types/node`, `@types/react`,
`@types/react-dom`.

**pnpm build scripts.** `package.json` carries
`"pnpm": { "onlyBuiltDependencies": ["esbuild", "unrs-resolver"] }`. pnpm 10 blocks
postinstall scripts by default, and those two link native binaries that vitest/tsx and the
eslint import resolver need. Without it every install prints a warning and the resolver can
fail.

**ESLint.** Flat config imports `eslint-config-next/core-web-vitals` and
`eslint-config-next/typescript` directly — Next 16 ships flat presets, so there is no
`FlatCompat` and no `@eslint/eslintrc` dependency.

**tsconfig.** The first `next build` rewrote `tsconfig.json` (`jsx: react-jsx`, plus
`.next/dev/types/**/*.ts` in `include`); those values are committed as written back, so a
fresh clone does not churn the file. `include` covers `tests/e2e` too, so Playwright specs
are type-checked by `next build`; `vitest.config.ts` only picks up `tests/unit/**`, so the
two runners never collide.

**Build stayed on Turbopack.** `next build` passes on the Next 16 default; no `--webpack`
fallback was needed.

**Playwright.** `retries: 0`, `workers: 1`, `fullyParallel: false`, reporters `list` + `html`
(never auto-opened), `trace: 'on-first-retry'`, `webServer.timeout` 600 s (it runs a full
production build first), `reuseExistingServer: true`. Chromium comes from
`/opt/pw-browsers/chromium` via `launchOptions.executablePath`.

**Styling.** `app/globals.css` is `@import "tailwindcss"` plus a light/dark
background/foreground token pair and a body rule. It is a frozen file — the shell builder
owns its contents during Phase 0, and after that a change to it goes through this document.

**Not created here** (they belong to the Phase 0 builders): `data/ATTRIBUTION.md`,
`data/COPYING-makemeahanzi`, everything under `lib/`, `components/`, and the remaining
routes. `data/` and `lib/` exist as empty directories only.

## Phase 0 decisions (app shell + db + harness — builder B)

Choices made where PLAN.md was silent, and the two places I had to reconcile with
builder A's tree.

> **Superseded.** The definition now lives in the frozen `lib/types.ts` and
> `lib/dict/types.ts` re-exports it; `lib/dict/types.ts` is not frozen. See "Phase 0
> status (integration)" below.

**`Entry` is now an alias, not a second definition.** `lib/dict/types.ts` (builder A)
defines `DictEntry` and says `lib/types.ts` re-exports it as `Entry`. It does:
`lib/types.ts` re-exports `DictEntry as Entry` plus `HskBand`, `DictFile`, `DictMeta`,
`DictSource`, `DecompEntry`, `DecompFile`, `EntryId` from there, and owns only the
app-side vocabulary (`Token`, `CardContext`, `LookupRequest`, `ListRef`, `LearnerProfile`,
`AskResponse` and friends, `HSK_BANDS`, `hskBandLabel`, `parseEntryId`). There is exactly
one definition of an entry; both files are frozen, so integrator: nothing to reconcile,
just don't re-fork it.

**`TANGRAM_DATA_DIR` is the data directory itself**, not a root containing `data/`.
PLAN §3.2 ("reads `data/*.json` from `TANGRAM_DATA_DIR` or `process.cwd()`") can be read
either way; A's `dataDir()` in `lib/dict/load.ts` resolves the env var directly and
defaults to `<cwd>/data`, so that is the reading. I deleted my own duplicate helper —
`app/settings/page.tsx` imports `dataDir` from `@/lib/dict/load` and reads
`ATTRIBUTION.md` from there. One definition, no drift.

**`addCardFromEntry` takes a 4th optional argument, `dictVersion`.** `EntrySnapshot`
requires a `dictVersion` and the frozen 3-argument signature has nowhere to get one;
it defaults to `'unknown'`. The alternative (a repository-wide constructor argument)
would have made `getRepository()` need the dictionary, which is server-side.

**Adding is idempotent per `(entryId, senseIndex)`.** Tapping Add twice returns the same
card rather than making a duplicate; adding a *different* sense of the same entry makes a
second card. Nothing in the plan said, and duplicates are the worse failure.

**The repository interface has five members beyond §3.3's list**: `knownEntryIds()`,
`allCards()`, `wordByEntryId()`, `createList()` and `addListMembers()`. The profile builder
and the P3 lists UI cannot be written without them, and every one is a read or a create
that the Supabase swap implements trivially. Signatures also pinned where the plan was
loose: `markKnown` returns the rows it created, `setListActive` returns the updated row or
`undefined`, `grade(cardId, rating, now?)` returns `{card, review}`.

**`listLearningSoon` uses the reader's definition of "learning", not the FSRS state.**
With `enable_short_term: false` the Learning and Relearning states never occur — every
grade lands in Review (verified against ts-fsrs 5.4.2). So the query is "due within the
horizon and not yet consolidated": `state !== Review || stability < 21`. A state-based
implementation would always return `[]`.

**`elapsed_days` is not stored** on `FsrsCardState`. It is deprecated upstream and the
scheduler recomputes it from `last_review`, which §3.3 names as the only elapsed-time
source v1 trusts. `toFsrsCard()` passes 0 on the way in.

**`known_words` and `ask_cache` rows carry only `createdAt`.** The general rule in §3.3
says every row has `createdAt`/`updatedAt`/`deletedAt`, but the schema block spells those
two tables out without them and both are append-only. The block wins.

**`active` and `deletedAt` are deliberately not indexed.** IndexedDB cannot key a boolean
or a null, so tombstones are filtered in the repository, not by an index. Every FK is
indexed, plus the two compound indexes the plan names.

**Dexie table properties are named exactly like the stores** (`db.list_members`,
`db.known_words`, `db.ask_cache`), so the same identifiers survive into SQL later.

**`newId()` falls back to `getRandomValues`** when `crypto.randomUUID` is absent — jsdom
does not always ship it, and the ids must be client-generated UUIDs either way.

**`LookupPanel` is not a client component.** It holds no state, so it renders in either
tree and P1/P4 can pass whatever they need as elements. It accepts `children` (the
dictionary result body, with a placeholder when there is none) in addition to the
`query` / `context` / `slots.ask` contract — P1 needs somewhere to render results and the
shell is frozen.

**`getLearnerProfile(repo, bandSizes?)`.** `estimatedBand` can only be computed against
band sizes, which live in the dictionary on the server, so they are injected; without them
the estimate is `settings.knownBand`. `knownSample` is ordered by HSK band, not by
frequency as §3.3 says, because `EntrySnapshot` carries no `freqRank` — adding one would
have changed the frozen snapshot shape. Whoever wires the ask request can re-sort by
frequency there, where the dictionary is in hand.

**`lib/lists/queue.ts` is the stub the phase asked for**: due sorted, explicit adds always
offered, spine draws capped by `newPerDay − introducedToday`. The auto-draw *ordering*
(active user lists, then spine bands from `spineStartBand`, freq order, skipping variants
and proper nouns) is P3's, and the signature is built to take it.

**Stores never touch Dexie at import time.** `lib/stores/*` import the repository with a
dynamic `await import('@/lib/db/get-db')` inside their actions, so importing a store from
anywhere is free. `getDb()`/`getRepository()` are memoised on `globalThis`; `closeDb()`
exists for tests.

**Surface.** One accent (jade, `--accent`), a warm paper ground, `prefers-color-scheme`
dark, mobile-first, max-width 3xl. `app/globals.css` also defines a `.hanzi` utility
(serif CJK stack, looser line-height) — Chinese glyphs at Latin sizes are unreadable, and
every Chinese run in the app should use it.

**The 503 banner is e2e-tested by route interception**, not by renaming `data/`: the spec
fulfils `/api/dict/hsk*` with a 503 and asserts the banner, and a second spec asserts it
stays absent when the route answers. Renaming `data/` mid-suite would race builder A.
The banner shows on 503 only — a 404 (route not shipped yet) is silence.

**Left for the orchestrator / later phases**
- `app/page.tsx` does not exist and must not be created; `/` is `app/(today)/page.tsx`.
- `tests/unit/scaffold.test.ts` is the scaffold's environment check; harmless, delete it
  whenever it stops earning its place.
- Nothing is committed, per the rule.

## Phase 0 decisions (data + dictionary service — builder A)

> **Superseded.** The direction was flipped during integration: `lib/types.ts` defines the
> shape and `lib/dict/types.ts` re-exports it. See "Phase 0 status (integration)" below.

**The shared entry type lives in `lib/dict/types.ts`.** It is `DictEntry` (plus `EntryId`,
`HskBand`, `DictFile`, `DictMeta`, `DecompFile`, `DecompEntry`, and the two route response
shapes). The build script, the loader and the routes all import it from there, so
`lib/types.ts` should alias rather than redeclare it:

```ts
export type { DictEntry as Entry, EntryId, HskBand } from './dict/types';
```

`EntrySnapshot.dictVersion` is `meta.version` from `data/dict.json` — the CC-CEDICT
snapshot the entries came from (currently `1.3.20251213`), not an app version.

**`TANGRAM_DATA_DIR` is the directory that holds `dict.json`**, defaulting to
`<cwd>/data` — the same reading the scaffold's stub used. PLAN.md §3.2 phrases it as
"`TANGRAM_DATA_DIR` or `process.cwd()`", which left the raw-download cache ambiguous;
resolved as: raw sources go to `<TANGRAM_DATA_DIR>/raw` when the variable is set, and to
`<repo>/.cache/tangram/raw` (the path §3.1 names) when it is not. Both are gitignored.

**`pnpm data:ensure` now generates.** With `data/dict.json` present it prints one line and
exits 0; without it, it runs the full build. A failed download exits 1 with the URL and
status (verified against a 404), so `pnpm build` fails rather than shipping half a
dictionary. `pnpm data --force` re-downloads. Two builds from the same raw cache are
byte-identical apart from `meta.builtAt`.

**Derived pinyin.** `lib/dict/pinyin.ts` is hand-rolled (no `pinyin-pro` at runtime) so the
same code runs in the build, the server and the browser. Decisions PLAN.md did not fix:
`pinyinMarked` joins the syllables of one reading (`da3 suan4` → `dǎsuàn`) and inserts the
orthographic apostrophe when the next syllable starts with a/e/o (`Xi1 an1` → `Xī'ān`, so it
stays distinct from `xiān`); CC-CEDICT's `·` and `,` separators are kept; Latin runs (`san1 C`)
keep a space. `normalizePinyin` folds `ü`/`u:`/`v` onto `u`, keeps `5` as a real tone in
`toned`, and on a query that is not pinyin returns `toneless === toned === letters` with
`fullyParsed: false` rather than guessing.

**HSK join.** Rows with a non-empty `Example` are skipped (21). The `CEDICT` column is the
key; 18 rows fall back to the simplified headword, and the fallback picks the reading whose
pinyin agrees with the HSK row's `Pinyin` before falling back to jieba frequency — matching
on frequency alone cannot separate two readings of one word, since jieba scores the word,
not the reading. Every fallback is printed. `Level` `7-9` is band `7`; a word listed in two
bands keeps the lower one. 28 multi-word HSK rows (`车上`, `不太`) have no CC-CEDICT entry at
all and stay unbanded.

**Entry flags.** `properNoun` requires a *toned* capitalized syllable, so the `C` of `3C`
does not count. `isVariant` needs every gloss to be some flavour of "variant of …";
`variantOf` is set only when the referenced id exists in the same snapshot. The gloss
inverted index skips variants (per §3.2) and stems `-ing`/`-ed`/`-s` at build and query time
via the exported `stemToken`.

**Routes.** `/api/dict/entries` takes ids repeated (`?ids=a&ids=b`) or comma-separated;
comma-splitting ignores commas inside `[...]`, because a proverb's pinyin contains one. Empty
list or more than 200 ids → 400; unknown ids are dropped, not an error. `/api/dict/hsk`
rejects a band outside 1–7 with 400. Both answer `503 {error:'dict-data-missing', hint:'run
pnpm data'}`. Both set `export const dynamic = 'force-dynamic'` so a build with no `data/`
cannot prerender a 503 into the output. `next.config.ts` already carried the
`outputFileTracingIncludes` §3.2 asks for — nothing was added to it.

**Cost of loading.** `data/dict.json` is 35 MB (124,188 entries) and `decomp.json` 0.9 MB.
First `getDictIndex()` in a process costs ≈2 s and settles around 310 MB RSS; both are
memoised on `globalThis`, so it happens once per server process, not per request. P1's
`search.ts`/`segment.ts` should build on `getDictIndex()`, `exactIds`, `prefixIds` and
`glossIds` rather than re-reading the file.

**`pnpm data` output (2026-09-07 snapshot):** dict 124,188 entries · hsk 11,028 banded
(matched/unmatched per band: 1 → 513/1, 2 → 772/5, 3 → 973/2, 4 → 1003/2, 5 → 1073/1,
6 → 1144/3, 7-9 → 5638/14; 21 Example rows skipped, 18 fallback joins) · freq 89,679 entries
matched from 348,974 jieba words · decomp 9,574 characters.

**Not verified here:** the routes were exercised by calling their handlers with a `Request`,
not over HTTP — builder B owns `pnpm build`/`pnpm e2e`, and two concurrent Next builds
corrupt `.next`. A `curl /api/dict/hsk?band=1` check is still worth one command after the
next build.

## Phase 0 status (integration — orchestrator's integrator)

Phase 0 is whole and green. Every acceptance line in PLAN.md §4 is now either a test that
runs in `pnpm test` / `pnpm e2e` or a command exercised here.

**Entry/DictEntry reconciled — the definition moved into the frozen file.** There was
already exactly one definition, but it lived in `lib/dict/types.ts`, which PLAN.md §4 does
*not* freeze while it *does* freeze `lib/types.ts` — so the frozen contract sat in a file
P1 owns and may edit. The direction is now flipped: `lib/types.ts` defines `EntryId`,
`HskBand`, `Entry`, `DictSource`, `DictMeta`, `DictFile`, `DecompEntry` and `DecompFile`;
`lib/dict/types.ts` re-exports them under the dictionary layer's names (`Entry as
DictEntry`) and keeps only what the routes need (`DictDataMissingBody`, `EntriesResponse`,
`HskResponse`). Every existing import site still compiles unchanged — `lib/dict/*` and
`scripts/build-data.ts` keep importing `DictEntry` from `lib/dict/types`, the app keeps
importing `Entry` from `lib/types`. The re-export is type-only, so nothing is added to any
runtime bundle and there is no import cycle (`lib/dict/types.ts` → `../types` only).

**One test added.** `tests/unit/deps.test.ts` covers "a unit test imports every runtime
dependency", which nothing covered. It dynamically imports all twelve `dependencies` and
asserts its loader table equals `package.json`'s dependency list, so adding a dependency
without proving it loads fails the suite. `next` is imported as `next/server` (the root
export is not usable) and `react-dom` as `react-dom/client`.

**No `package.json` change was needed.** No builder left a "Needs" note requiring one;
`pnpm install --frozen-lockfile --offline` still resolves with the lockfile untouched.

**Frozen-file list checked.** `CLAUDE.md`'s list matches PLAN.md §4 exactly
(`package.json`, `pnpm-lock.yaml`, `lib/db/schema.ts`, `lib/db/repository.ts`,
`lib/types.ts`, `app/layout.tsx`, `app/globals.css`, `components/ui/**`,
`components/lookup/lookup-panel.tsx`, `next.config.ts`, configs). Added a note there
pointing at where `Entry` now lives.

**`.gitignore` checked** with `git check-ignore`: `data/*.json` and `.cache/` are ignored;
`data/ATTRIBUTION.md` and `data/COPYING-makemeahanzi` are not.

### What passes (all run on this tree, in this order)

| Check | Result |
|---|---|
| `npx tsc --noEmit` | pass |
| `pnpm lint` | pass |
| `pnpm test` | pass — 14 files, 113 tests |
| `pnpm data` | pass, 2.2 s from the warm raw cache |
| `pnpm build` | pass (Turbopack; `data:ensure` found `data/dict.json`) |
| `pnpm e2e` | pass — 12/12, chromium at `/opt/pw-browsers/chromium` |
| `curl /api/dict/hsk?band=1` | HTTP 200, **511 entries** (了 le · 是 shì · 在 zài) |
| `curl /api/dict/entries?ids=打算\|打算[da3 suan4]` | HTTP 200, `pinyinMarked: dǎsuàn`, `classifiers: ['个']` |
| `mv data data-renamed` → fresh `next start` | every route still **200**; both dict routes `503 {"error":"dict-data-missing","hint":"run pnpm data"}`; the banner "Dictionary data is missing. Run pnpm data to build it." renders in a real browser with **zero page errors** |
| `pnpm data:ensure` on the renamed-away tree | regenerated `dict.json`/`decomp.json`/`COPYING-makemeahanzi`, byte-identical to the originals apart from `meta.builtAt` |
| `pnpm install --frozen-lockfile --offline` | pass |

`data/ATTRIBUTION.md` is the one file under `data/` the build does **not** write — it is
hand-authored and committed, which is right, but it means a `rm -rf data` is not fully
undone by `pnpm data`. A fresh clone is fine because the file is in git.

No server is left running; port 3000 is free. `/home/user/v0-anchor` is untouched and its
`git status` is clean.

### Data counts (2026-09-07 snapshot, reproduced here)

`dict 124188 entries · hsk 11028 banded · freq 89679 matched from 348974 jieba words ·
decomp 9574 characters`. Per band, matched/unmatched: 1 → 513/1, 2 → 772/5, 3 → 973/2,
4 → 1003/2, 5 → 1073/1, 6 → 1144/3, 7-9 → 5638/14; 21 `Example` rows skipped; 18 fallback
joins. All seven bands are non-empty, asserted in `tests/unit/data.test.ts`.
`dict.json` is 35 MB, `decomp.json` 0.9 MB.

### Open questions for the morning

1. **The build's per-band "matched" numbers are row counts, not entry counts** — they sum
   to 11,116 while the dictionary carries 11,028 banded entries (511 · 752 · 957 · 991 ·
   1064 · 1131 · 5622), which is why `/api/dict/hsk?band=1` returns 511 and the log says
   513. A headword listed in two HSK bands is counted as matched in both and keeps the
   lower band, exactly as builder A specified. Not a defect; worth knowing before anyone
   shows "words in this band" in the UI, where the entry count is the honest one.
2. **`data/decomp.json` has no consumer yet.** It is built, tested and licence-separated,
   but nothing reads it until a character panel exists (not scheduled in any phase).
3. **`tests/unit/scaffold.test.ts`** is now redundant with `tests/unit/db/import.test.ts`
   and `tests/unit/deps.test.ts`. Left in place; delete it whenever it annoys someone.
4. **The 35 MB dictionary is loaded whole** (≈2 s, ≈310 MB RSS, memoised per process). Fine
   for a single-user local app and for Vercel's Node runtime; if P1's search makes cold
   starts painful, the split is dictionary-data-per-index, not a code change above it.
5. Everything in PLAN.md §6 is still open — the repo to push to, the model + key, the
   codename. Nothing in this tree depends on any of them.

## Phase 0 review fixes (orchestrator, after the three-lens review)

Every confirmed finding from the Phase 0 review panel, what was done, and how it was
re-verified. Six were blocking/major; the minors were all cheap enough to take. Frozen
files changed here on purpose — this is the last edit before the freeze takes effect:
`lib/db/schema.ts` (one optional field) and `lib/db/repository.ts` (a comment).

**Major — a double-tapped Add made two cards.** `addCardFromEntry`'s read-check-write
now runs inside `db.transaction('rw', db.words, db.cards, …)` (`lib/db/dexie.ts`), so
overlapping calls serialise and the second sees the first card. Verified:
`Promise.all([add, add])` under fake-indexeddb gave `{sameId: false, cards: 2, words: 2}`
before and `{sameId: true, cards: 1, words: 1}` after; the case is now
`tests/unit/db/repository.test.ts` › "survives a double tap", and it still fails if the
transaction wrapper is removed (checked by removing it).

**Major — the spine skip would have dropped 113 HSK words.** Decision: the
`isVariant`/`properNoun` skip in §3.3's auto-draw applies **only to entries with no
`hskBand`**. A banded word is on the syllabus; 中国 · 汉语 · 北京 are `properNoun` and
一点儿 · 一块儿 · 小孩儿 are `isVariant` (CC-CEDICT glosses them "erhua variant of …"),
six of them in band 1. The rule is now executable, not prose: `lib/lists/spine.ts`
(`spineEligible`), with `tests/unit/lists/spine.test.ts` asserting that no banded entry is
skipped and that 中国 and 一点儿 are offered. PLAN.md §3.3 is amended to match. *Not*
taken: narrowing `isVariant` so "erhua variant of" stops counting. The review's stated
benefit was restoring 一点儿 to the gloss index, but its only gloss *is*
`erhua variant of 一點|一点[yi1 dian3]` — indexing it adds the tokens "erhua", "variant",
"of" and still cannot answer "a little". It would meanwhile change what `isVariant` means
for P1's "real words > variants" ranking, so the flag keeps its plain meaning.

**Major — a tone-marked query could not match a neutral-tone word.** `normalizePinyin`
drops tone 5 from the `toned` key (`wo3 men5`, `wǒmen`, `wo3men` → `wo3men`); tone 5
survives in `syllables`, where it is real information. Both sides of the index derive from
the same function, so nothing was rebuilt. Verified: 632 of the 11,028 banded entries carry
a neutral syllable; `exactIds(byPinyinToned, normalizePinyin('wǒmen').toned)` now contains
`我們|我们[wo3 men5]` (`tests/unit/dict/index.test.ts`), and `pinyin.test.ts` pins
`normalizePinyin('wǒmen').toned === normalizePinyin('wo3 men5').toned`. This reverses the
earlier builder-A note "keeps 5 as a real tone in `toned`".

**Major — `EntrySnapshot` had no `freqRank`.** Added as an optional field (no Dexie
version bump, no index), copied in `toEntrySnapshot`, and `buildLearnerProfile` now sorts
`knownSample` by `freqRank` ascending with band as the tiebreak — which is what §3.3 asked
for, and it has to happen client-side because the ≤200 truncation does. Verified by
`tests/unit/srs/profile.test.ts` › "orders the sample by frequency" and a repository test
that the rank reaches the snapshot.

**Major — 83 entries kept their classifier inline in the gloss.** `scripts/build-data.ts`
now strips the `(CL:…)` suffix as well as the standalone `CL:` line, pushing both into
`classifiers[]` (deduped). Verified after `pnpm data`:
`entries.filter(e => e.glosses.some(g => /CL:/.test(g)))` is 0 (was 83, 60 of them banded),
`山|山[shan1]` has `classifiers: ['座']` and the gloss `mountain; hill`, and no entry lost
its last gloss. Pinned in `tests/unit/data.test.ts`. `data/ATTRIBUTION.md`'s modification
notice now describes both forms — before this it was inaccurate for those 83.

**Major — the nav overflowed a 390px phone.** The row wraps instead of scrolling
(`flex-wrap`, no `overflow-x-auto`) and the links are tighter and taller
(`px-1.5 py-2 sm:px-2`). At 390px the six links now measure
`Today@12+53 · Lookup@67+62 · Review@131+62 · Read@195+47 · Lists@244+44 · Settings@290+69`
— right edge 359, `navScrollW === navClientW === 366`, height 36px (was 28), still one row.
`tests/e2e/smoke.spec.ts` › "the nav fits a 390px phone" asserts every link's right edge is
inside the viewport and that the document does not scroll sideways.

**Minor — display pinyin ran multi-word names together.** `toMarked` now emits a space
before a non-initial capitalised syllable, which is where CC-CEDICT's convention puts a
word break: `Shàolín Sì`, `Sānjiāng Shēngtài Lǚyóu Qū`, `Wúwáng Hé Lǘ`; `Běijīng` and
`Yàdāng·Sīmì` are unchanged. 7,972 entries gained a space. *Not* taken: breaking long
proverbs by syllable count — `kàoshānchīshān, kàoshuǐchīshuǐ` still runs on, because a
"longer than ~4" rule has no principle behind it and proverbs are not headwords a learner
studies as a word.

**Minor — the parser preferred an impossible split.** `parseChunk` tries orthographically
legal boundaries first (a vowel-initial syllable inside a word needs an apostrophe), then
falls back: `gunao → gu nao`, `chana → cha na`, `yinanbannu → yi nan ban nu`,
`fengengyun → fen geng yun`, while `xian`, `xi'an` and `xi1an1` are unchanged. Index keys
come from numbered pinyin, where every boundary carries a digit, so the index is untouched.

**Minor — `xx5` rendered as the pinyin "xx".** It is CC-CEDICT saying it has no Mandarin
reading. `toMarked` renders it as the empty string and the 34 entries carrying it are left
out of both pinyin indexes (`hasUnknownReading` in `lib/dict/pinyin.ts`). Verified:
`々|々[xx5]` now has `pinyinMarked: ''` and `exactIds(byPinyinToneless, 'xx')` is `[]`.

**Minor — the 503 banner downloaded 160 KB to read a status code.** `DataBanner` probes
with `method: 'HEAD'`. Verified against a running server: `GET` 200/159,928 bytes, `HEAD`
200/0 bytes; with `data/` renamed away, HEAD answers 503 and the banner renders in a real
browser. Note for the next reviewer: Chromium logs a HEAD response as
`net::ERR_ABORTED` in the network panel (it has no body to read) — the `fetch` promise
still resolves with the status, which is all the banner reads.

**Minor — `pos` is HSK-only.** Decision (b) of the two offered: jieba supplies frequency
only. Its tags (`n`, `v`, `nr`) are a different vocabulary from the HSK list's
(`V/N`, `Adj`, `M`), and merging them would make one field mean two things. The dead
`JiebaWord.pos` is gone, PLAN.md §3.1's jieba row now reads "Frequency", and
`tests/unit/data.test.ts` pins the vocabulary P4 can rely on: `pos` exists only on banded
entries (9,694 of 11,028 — 1,334 banded rows have an empty HSK `POS` cell, e.g. 一些) and
every slash-separated tag is one of Adj Adv Aux Conj Intj M N Num Phonetic Pr Prefix Prep
Pron Suffix V.

**Minor — `listLearningSoon`'s docstring described impossible states.** Corrected in the
frozen `lib/db/repository.ts`: it is "due within the horizon and not yet consolidated",
and with `enable_short_term: false` the FSRS Learning/Relearning states never occur.

**Minor — every page 404'd on `/favicon.ico`.** Added `app/icon.svg` (a tangram square in
the jade accent); Next emits the `<link rel="icon">` itself, so `app/layout.tsx` is
untouched. Verified: one icon link on every route, `/icon.svg` 200, and zero console
errors on all six routes at 390px and 1280px.

**Minor — the licences page rendered raw Markdown in a `<pre>`.** Done now rather than
left to P3: `app/settings/attribution.tsx` (a ~120-line renderer for exactly what
`ATTRIBUTION.md` uses — headings, unwrapped paragraphs, bullets, rules, fenced licence
texts, inline code/bold/links) and the page renders through it. Fenced licence text keeps
its `<pre class="font-mono">`, so the MIT and LGPL notices still display verbatim.
`tests/unit/settings/attribution.test.ts` covers the unwrapping; the e2e spec asserts the
page shows a real CC-CEDICT heading and never the literal `## CC-CEDICT`. P3 owns
`app/settings/**` and may replace this wholesale.

**Minor — the settings copy claimed `pnpm data` writes ATTRIBUTION.md.** It does not; the
file is committed. The fallback now says so and names `git checkout data/ATTRIBUTION.md`,
and the stale comment at the top of the page is replaced with the real reason the page is
dynamic (`TANGRAM_DATA_DIR` can move `data/`).

**Minor — HANDOFF's two stale `Entry` paragraphs.** Each now carries a one-line
`> Superseded` blockquote pointing at the integration section, added by the orchestrator;
the paragraphs themselves are untouched, so the append-only rule holds.

### Checks after the fixes

| Check | Result |
|---|---|
| `npx tsc --noEmit` | pass |
| `pnpm lint` | pass |
| `pnpm test` | pass — 16 files, 129 tests |
| `pnpm data` | pass, 3.7 s from the warm raw cache; same counts as before (124,188 entries · 11,028 banded · 89,679 freq · 9,574 decomp) |
| `pnpm build` | pass (Turbopack) |
| `pnpm e2e` | pass — 14/14 |
| `curl -I /api/dict/hsk?band=1` | 200, 0 bytes (GET: 200, 159,928 bytes) |
| `mv data data-renamed` → fresh `next start` | all six routes 200, both dict routes 503, banner renders, settings shows the "restore it with git checkout" fallback |

`test-results/` was cleared by the e2e run, so the review panel's screenshots and
`shoot-normal.json` are gone; the measurements above were re-taken against a fresh
production server on port 3100, which is stopped. No server is left running.

---

## Phases 1–3 (merged) — decisions, needs, TODOs

Written by the merge/integration agent. `p1`, `p2` and `p3` are merged into `main`
with `--no-ff` in that order, and `HANDOFF-p1.md` / `HANDOFF-p2.md` /
`HANDOFF-p3.md` are folded into this section and deleted — one document again.

**No merge conflict occurred.** The three branches touched disjoint file sets; the
worktree path discipline held and no frozen file was edited by any builder. The one
real collision was semantic, not textual, and is recorded under "The queue" below.

### P1 — dictionary search, segmentation, `/lookup`

- **Routing** (`lib/dict/search.ts`): CJK → hanzi exact then prefix over both scripts;
  a query that fully parses as pinyin → *both* the pinyin and gloss indexes as labelled
  sections; otherwise English. Section order: typed tones → pinyin first; else an exact
  gloss token of ≥3 letters → English first (`sun`, `women`); else pinyin first.
- **The 50-cap is split between sections**, each trailing section reserved 16, and the
  cursor is per-section (`"34.16"`). A flat cap made `he → 他` and `sun → 孙` impossible:
  the leading section ate the whole page.
- **A headword both indexes match is assigned to whichever ranked it higher** (孫 is `sun`
  the reading, not the "Sun" in "surname Sun"). Claiming while ranking made 孙 vanish;
  deduping per page made page 2 repeat page 1.
- **Glosses are split into senses** on `;` with parentheticals stripped, so `he`
  whole-matches 他 (HSK 1) instead of ranking 怹 above it. **Irregular plurals**
  (`women → woman`) are lemmatised at query time only — the Phase 0 gloss index is
  untouched.
- **Segmentation** (`lib/dict/segment.ts`): jieba's max-probability DP over the headword
  DAG scored by `log(freq/total)`, no HMM, unknown single chars at the floor weight,
  script inferred per call. Tokens carry every reading, freq-ordered; offsets are UTF-16
  and survive surrogate pairs. A `text` run (punctuation, Latin) is `via: 'fallback'`
  with no entry ids — `Token.via` has no third value.
- `group.hskBand` is the *lowest* band of any reading (the badge shows the headword's
  easiest way in) while ranking uses the band of the *matched* reading.
- **Seams:** `LookupView` takes `askSlot?: ReactNode` straight into `slots.ask`, so P4 is
  a one-line change in `app/lookup/page.tsx`; `openLookup({query, context})` is unchanged,
  so a reader context (P5) flows into the panel and onto the card.
- **Cost:** the first hanzi search in a process sorts the 120k headword keys into a prefix
  index (~0.2 s, memoised on the `DictIndex` via a `WeakMap`); the first `segment()` sums
  frequencies over both headword maps. Once per process; `resetDictCache()` drops both.
- The container's Chromium has no glyphs for the IDS characters (⿰⿱…), so the
  decomposition line screenshots as tofu here. Font gap in this image, not a bug — the
  strings are correct in the DOM and asserted in the e2e spec.

### P2 — cards and the review session

- **The review queue is `lib/lists/queue.ts`'s queue, not a second one.**
  `buildReviewQueue` (`lib/srs/session.ts`) delegates to `buildQueue`, so "what is in
  today's queue" has one implementation and `/review` inherited P3's auto-draw ordering
  the moment it landed.
- **A grade re-queries the database rather than advancing an index.** The schedule the
  grade just wrote decides whether the card returns; with `enable_short_term: false`
  nothing can come back inside a session, so the queue only shortens.
- **Grade keys are gated on the flip.** 1–4 are inert until the card is revealed — you
  cannot rate a recall you have not attempted. Space/Enter flip; every other key, and any
  key typed into an input, is ignored.
- **"Peek context" masks by character and is hidden when it cannot mask.** With no offsets
  *and* no occurrence of the headword in the sentence, the peek button is not rendered at
  all: a peek that silently shows the answer is worse than none.
- **`nextDueAt` ignores New cards** (their `due` is their creation instant), so the empty
  state says "no cards are scheduled yet" when only capped-out New cards remain.
- **Intervals are computed against the instant the queue was built**, not `Date.now()` at
  render (`react-hooks/purity`, and a label that drifts on screen is a lie).
- **Phase 0's `grade()` was verified, not changed** (`tests/unit/srs/grade.test.ts`): the
  new FSRS state, the mirrored `due` column, exactly one review row carrying the pre-grade
  state in both `before` and `log`, epoch-ms log dates, never under a day, and a
  `fsrs(FSRS_PARAMETERS).reschedule(...)` replay straight from ts-fsrs that reproduces the
  stored card.

### P3 — lists, the queue, Today, settings, the demo seed

- **The daily cap counts introductions, not offers.** `settings.introduced[dayKey]` goes
  up when a card is *created* (`lib/lists/introduce.ts`, the only writer), and
  `drawLimit = newPerDay − introducedToday − ungraded spine cards`.
- **Opening `/` is what introduces the day's new words**, so Today's count and the cards
  `/review` offers are the same rows. `loadToday({introduce: false})` reports without
  creating. Consequence: visiting Today spends the day's allowance even if you never study.
- **HSK membership is `entryId` rows, materialised per band.** PLAN §3.3's "a `words` row
  for every spine word" was *not* followed: that is 11,028 snapshots of a dictionary the
  app already ships. A `words` row appears only when a card does.
- **The auto-draw skips bands at or below `settings.knownBand`** as well as bands below
  `spineStartBand` — a queue that argues with the reader's colours is a bug. User-list
  members are filtered only by "already met".
- **Settings write through on change**; no Save button, and the queue reads the row, not
  the form. `script` is persisted and read by nothing yet (deliberate, §6.8).
- **The demo seed is deterministic and wipes first**: HSK 1–2 known, eight cards across
  every provenance, backdated grades replayed through `repo.grade`, one paragraph in
  `texts`, two warm `ask_cache` rows.

### The queue: the one place two phases disagreed

P3 rewrote `buildQueue` into a superset (still accepts `{now, settings, due, candidates}`;
now also `cards`, `newCandidates`, `newPerDay`, `introducedToday`) and **changed its
semantics**: existing New cards are no longer capped — they are all offered and instead
lower `drawLimit`. P2's `tests/unit/srs/session.test.ts` still asserted the Phase 0 stub's
rule ("a spine card is held back when the cap is spent") and was the only test that failed
on the merge. Resolved in P3's favour, because P3 owns the file and the new rule is what
makes §3.3's "grade 10 new, reload → no further spine cards today" true without lying to a
learner who never grades. The spec was rewritten to the surviving guarantee — **an explicit
add is never behind a spine card** — plus a new case pinning that the cap governs `draws`,
not cards that already exist.

### What the merge wired

1. **`/api/dict/search` now answers the lists layer's word search.**
   `EntrySource.search` (`lib/lists/entry-source.ts`) calls P1's route through
   `fetchSearch` and flattens its *groups* — one per headword, readings and all — in P1's
   own order, so "add a word to this list" and the lookup box rank a query identically.
   The HSK-band scan stays as the offline fallback for a 503 or a network failure; an
   empty answer from the route is an answer, not a reason to pull 11k rows over the wire.
   P1's response body is `{groups, sections, …}` — neither of the two shapes P3 guessed —
   so without this the fallback ran forever and silently.
2. **Every Add joins "Looked up".** `components/lookup/entry-detail.tsx` adds through
   `addCardTracked` (`lib/lists/looked-up.ts`) instead of calling
   `repository.addCardFromEntry` directly. P4 and P5 must do the same.
3. **`meta.version` on the entry-bearing dict routes** (HANDOFF-p3 Needs 1).
   `/api/dict/entries` and `/api/dict/hsk` now answer `{meta:{version}, …}`;
   `EntrySource` records it and exposes `dictVersion()`, and `today.ts` /
   `queueFromList` pass it into `addCardFromEntry`. Cards the lists layer creates record
   the real CC-CEDICT snapshot instead of `'unknown'`. `SearchResult.dictVersion` already
   carried it, so the lookup path was already correct.
4. **`deleteList` / `removeListMembers` / `renameList` on the repository**
   (HANDOFF-p3 Needs 2). Added to the **frozen** `lib/db/repository.ts` and implemented in
   `lib/db/dexie.ts`; all three are soft deletes, and `deleteList` tombstones the list and
   its membership in one transaction so no member row is orphaned under a dead list. A
   custom list can now lose a word and be deleted from `/lists/[id]` (two clicks, no
   `confirm()`); `renameList` has no UI yet. Deleting a *system* list is a reset, not a
   removal — `ensureSystemLists` recreates it on the next visit.

### Frozen files changed by the merge

`lib/db/repository.ts` only, for item 4 above (three added members, no signature changed).
`lib/db/schema.ts`, `lib/types.ts`, `app/layout.tsx`, `components/ui/**`,
`components/lookup/lookup-panel.tsx`, `app/globals.css`, `package.json`,
`pnpm-lock.yaml`, `next.config.ts` and the configs are untouched; no dependency was added.

### Two e2e specs were repaired, both racing rather than wrong

- `p3/lists.spec.ts` "the active toggle persists" reloaded on the strength of the
  *optimistic* checkbox, racing Dexie's write against the navigation that kills the page
  performing it. It now polls the stored row before reloading, which is what "persists"
  means.
- `p3/lists.spec.ts` "a custom list … filled by search" matched `Add 跑步` loosely; with
  the search now coming from `/api/dict/search`, 跑步机 and 跑步者 are on screen too and
  the locator was ambiguous. Fixed with `exact: true` — the extra results are the
  improvement, not the defect.

### `tests/e2e/integration.spec.ts` — the post-merge spec

PLAN §4's integration walk, with no fixture: reset from `/settings` with `newPerDay: 0`
(so the spine draw is off and "1 new" is exactly the word looked up, which is also §3.3's
rule that an explicit Add ignores the cap) → look up `dasuan` on `/lookup` → Add → the card
carries `context.query`, `source: 'lookup'` and a real `dictVersion`, and the entry is in
"Looked up" → `/` shows 1 new and names 打算 → Start review → `/review` shows 打算 → Space,
then `3` → exactly one `reviews` row for that card with `before.state === 0`, and the card
is rescheduled into the future. A second test walks the nav through all six routes.

### Still open after the merge

1. **The ask-cache key in the seed is a placeholder.** `demoAskCacheKey` in
   `lib/dev/seed.ts` implements §3.4's *description* of the key. **Phase 4 owns the real
   derivation**: import it there and delete the placeholder, or the demo's two warm rows
   are orphans rather than cache hits. `lib/dev/sha1.ts` is a dependency-free SHA-1 if P4
   wants it.
2. **Two open tabs could double-introduce.** `ensureSystemLists` and `loadToday` guard
   within one page (an in-flight promise per repository), but two tabs are two JS contexts
   over one IndexedDB: they could create the system lists twice and each charge the
   counter. Single-user, single-tab is v1's premise; the fix is a `BroadcastChannel` or a
   `[kind+band]` unique index, which needs a schema change.
3. **`renameList` has no caller.** The repository can do it; no UI asks.
4. **`/review` still does not write `settings.introduced`** — nothing but
   `introduceCards` does, which is correct (the counter counts creations), but it means the
   empty state cannot say "N new tomorrow" without reading that counter.
5. **P4's ask slot and P5's reader are unmounted seams**, both one line away
   (`app/lookup/page.tsx`, `openLookup`).
6. `data/decomp.json` now has a consumer (`/api/dict/decomp`), closing open question 2 of
   the Phase 0 section.

### Checks on the merge commit

| Check | Result |
|---|---|
| `pnpm install --frozen-lockfile` | pass, no-op |
| `pnpm data:ensure` | pass — `data/dict.json` present |
| `npx tsc --noEmit` | pass |
| `pnpm lint` | pass |
| `pnpm test` | pass — 28 files, 273 tests |
| `pnpm build` | pass (Turbopack) |
| `PORT=3000 pnpm e2e` | pass — 54/54, including the 2 integration specs |

No server is left running; port 3000 is free. `/home/user/v0-anchor` was not touched.

**Running the suite in this container:** `playwright.config.ts` sets
`reuseExistingServer: true` and a leftover `next start` on the port is reused *silently* —
if it predates your last build it serves HTML pointing at chunk hashes that no longer
exist, and the failures look like flaky timeouts anywhere React does the work. `lsof` is
not installed, and the process renames itself, so `pkill -f "next start"` misses it. Check
with `ps -eo args | grep next-server` and `curl -s -o /dev/null -w '%{http_code}'
http://localhost:3000/` before a run.

---

## Phases 1–3 review fixes

Written by the fix agent between the merge and Phase 4, from the adversarial review of
the merged Phases 1–3. Eight confirmed blocking/major findings and ten minors; every one
below was reproduced first and re-verified against the reviewer's own evidence after the
change. Two frozen files were edited (see "Frozen files" at the end).

### The three bugs that mattered

**1. An Add on a word that already had a card was a silent no-op.**
`addCardFromEntry` returned the existing row and dropped the incoming `context`, so a
word the spine drew this morning could not be given the sentence a reader tapped it in,
the question an ask answered, or the query a lookup typed — while the panel said "Added
to your cards — it carries '…'". Now the repository *merges*: fields the stored context
is missing are filled in, and a non-explicit `source` is promoted to the explicit one
that asked (`mergeCardContext`, `lib/db/dexie.ts`). Nothing already recorded is
overwritten, so a reader card that is later looked up keeps saying `reader` and keeps its
sentence. Verified end to end: the spine draws 了 `{source:'list'}`; adding 了 liǎo from
`/lookup` leaves one card whose context is now
`{source:'lookup', query:'了', addedAt:…}`, and the panel says "Already in your cards —
it now carries '了'." — not "Added". This is the seam P4 and P5 depend on: an Add from
the ask panel or the reader now reaches the card even when the queue got there first.

**2. `newPerDay` was not a cap.** `settings.introduced` was charged only by
`introduceCards`, and `buildQueue` subtracted *ungraded* non-explicit cards, so any card
created another way (the demo seed, a list's "Add to queue") was free until it was graded
and then handed its slot back: the demo drew 7 next to 3 seeded cards, and grading all ten
produced three more — 13 new on a 10/day setting. Two halves to the fix:

- every non-explicit creation now charges the counter — `queueFromList` routes through
  `introduceCards`, and `loadDemo` charges its own `list`/`seed` cards through the new
  `chargeIntroduced` (both in `lib/lists/introduce.ts`);
- `buildQueue` counts `max(introducedToday, non-explicit cards created today)` and
  subtracts, on top of it, only the *earlier days'* ungraded introductions. The `max` is
  deliberate belt-and-braces: a future creator that forgets the counter still cannot widen
  today's cap by grading.

Verified: demo → `/` shows 10 new (3 seeded + 7 drawn) with `introduced` at 10 → grade all
ten → reload → 0 new, nothing created, 15 cards total (was 18). The backlog rule that PLAN
§3.3 asks for is unchanged and still tested: two untouched cards from yesterday mean two
fewer draws today.

**3. `/review` and Today disagreed about what today is.** Only `loadToday` introduced
cards, so a fresh `/review` said "Nothing due — no cards are scheduled yet." while `/` was
holding ten new words for the same learner, and the demo showed "Card 1 of 7" or "Card 1
of 14" depending on which page was opened first. `useReviewStore.load()` now goes through
`loadToday` and takes `summary.queue.cards`, so whichever route is opened first introduces
and the other agrees. Opening `/review` therefore spends the day's allowance exactly as
opening Today does (§3.3's documented consequence). The empty state gained a way onward —
links to Today and Lookup — and says so when the draw itself failed (`waiting`,
`drawError`). Verified: fresh database, `newPerDay: 3`, straight to `/review` → "Card 1 of
3"; grade all three → empty, and `/` then shows 0 new and 3 of 3 introduced.

### The rest of the confirmed findings

- **The lookup panel now tells the truth about the card.** `EntryDetail` asks
  `cardForEntry` on mount, so the button reads "Already a card" for a reading that is one
  (per reading — 了 le and 了 liǎo answer differently), and after an Add it distinguishes
  *added* / *already there, now enriched* / *already there* instead of claiming "Added"
  for all three (`addCardChecked` in `lib/lists/looked-up.ts` reports `created` and
  `contextApplied`). The settled state also offers "Review now" and "see it on Today",
  which is the loop's next step and was previously a dead end.
- **`wordState` asks the card before the band** (`lib/srs/states.ts`). The band is a guess
  about words never touched, so a word with a card is `learning`, not `known` because HSK
  says it is easy. A `known_words` row still wins over both — that is what "Mark known"
  writes, and it is why a demo learner who declares HSK 1–2 known and then adds 打算 by
  hand still sees `known` there: the row says so. Pinned by a unit case.
- **The lists index counts the way the detail page badges.** `readViews`
  (`lib/stores/lists.ts`) runs `wordState` over the same three inputs (a `known_words`
  row, the card, the list's band) instead of counting `known_words` alone. Verified after
  the demo plus a lookup Add: index "6 words · 2 known", detail shows exactly two `known`
  badges. A custom list holding banded words is the one case that can still differ — the
  detail page knows each entry's real band and the index only knows the list's.
- **The demo seed records the real dictionary snapshot.** `loadDemo` passes
  `source.dictVersion?.()`, so its cards and their `words` rows carry `1.3.20251213`
  rather than `'unknown'`; asserted in `tests/unit/lists/seed.test.ts` and in
  `tests/e2e/p3/seed.spec.ts`.
- **A seeded card is no longer reviewed before it was added.** `demoContext` dates
  `addedAt` behind the oldest replayed review. `cards.createdAt` is still the seed instant
  because the repository seam owns that stamp — the seed header now says so, and
  consumers must not read `createdAt` as a learning start date.
- **`shi` no longer buries 是.** The "English first when the query is a gloss token" rule
  fired on any token appearing anywhere in a gloss, and CC-CEDICT romanises inside its
  English ("jiang shi", "lüshi form"), so 39 entries made `shi` an "English word" and the
  pinyin section — 是 事 十 试 市 使, all HSK 1–3 — was squeezed into its reserved 16 rows.
  `isGlossToken` now requires the query to be a whole *sense* of some entry (`glossTier`
  ≤ 1). `sun`, `can`, `women`, `plan` are unchanged; `shi` and `ta` lead with pinyin and
  are pinned by a test.

### Minors folded in

Settings number fields clamp to their own min/max and ignore an empty box (clearing
"New cards per day" used to store 0 and report "Saved"; 300 used to store 300 under
`max={200}`). Today and the list rows preview three senses joined with "; " as the search
rows do, because CC-CEDICT's first gloss for a single-character spine word is usually the
wrong sense ("被 — quilt", "时 — o'clock"). On a phone the lookup panel appears only once a
result is picked, so the first hit is at the top of the results rather than ~200px down
(desktop's two-column sticky layout is untouched). The stale `TODO(merge)` in
`word-search.tsx` and the two pointers to the deleted `HANDOFF-p3.md` are gone.
`schema.ts`'s `list_members.wordId` comment now says what is true — always `null` in v1,
membership joins on `entryId` — and `system-lists.ts` says what is actually lazy (the
`lists` rows and `words`; `list_members` is filled for all seven bands by the first visit
to `/lists`).

### Not fixed, and why

- **`readViews` still reads every membership row on each `load()`** (8 × `toArray()`,
  11,028 rows after the first `/lists` visit). The repository seam has no `count`, and
  `knownCount` now needs the entry ids anyway. Left as it is, documented rather than
  half-changed.
- **`list_members.wordId` is still never written.** Every join in the app is on `entryId`
  and the compound index is `[listId+entryId]`; the comment now matches the code. P4/P5:
  do not read `wordId`.
- **Two open tabs can still double-introduce**, and now `/review` is a second door to the
  same draw. Unchanged from "Still open" #2 — the fix needs a schema change.

### For P4 and P5

- Add through `addCardTracked` / `addCardChecked` (`lib/lists/looked-up.ts`), never
  `repository.addCardFromEntry` directly. A repeat Add on an existing card now *delivers*
  its sentence or question, and `addCardChecked` tells you whether a card was created so
  your copy can be true.
- Any card you create that is **not** an explicit add (`lookup`/`ask`/`reader`) must charge
  the day: go through `introduceCards`, or call `chargeIntroduced`. `buildQueue` will
  charge you anyway for cards created today, so the only thing skipping it buys is a
  wrong-looking counter.
- `/review` introduces. If you write a spec that seeds its own cards, switch the spine off
  (`setSettings({ newPerDay: 0 })`) as `tests/e2e/p2/fixtures.ts` now does, or your queue
  is ten words longer than you think.

### Frozen files changed

- `lib/db/repository.ts` — one member added, `cardForEntry(entryId, senseIndex?)`, plus a
  paragraph on `addCardFromEntry` documenting the context merge. No signature changed.
- `lib/db/schema.ts` — comment only, on `list_members.wordId`. No shape changed, no
  migration.

### Checks after the fixes

| Check | Result |
|---|---|
| `npx tsc --noEmit` | pass |
| `pnpm lint` | pass |
| `pnpm test` | pass — 28 files, 283 tests (was 273: 10 added) |
| `pnpm build` | pass (Turbopack) |
| `PORT=3000 pnpm e2e` | pass — 55/55 (was 54: 1 added) |

No server is left running; port 3000 is free. `/home/user/v0-anchor` was not touched.

## Phases 4–5 (merged) — decisions, needs, TODOs

`p4` (grounded ask) and `p5` (reader) merged into `main` with `--no-ff`, in that order.
**No conflicts, in either merge.** The two worktrees touched exactly one file in common —
neither of them: P4's one sanctioned edit was `components/lookup/lookup-panel.tsx`, P5's
was `lib/stores/lookup.ts`, and no other path appears in both diffs. `HANDOFF-p4.md` and
`HANDOFF-p5.md` are folded in below and deleted.

### What P4 built (grounded ask, §3.4)

```
POST /api/ask ──► search(query)                    ── the dictionary answers first
                  proposePhrases(query, context)   ── only for English / sentence input
                  segment(candidate) → token entries
                  mergeRetrieved(...)  ≤ 40        ── SEARCH_HEAD=16 reserved head
                  provider.answer(retrieved, profile, query, context)
                  askResponseSchema.safeParse      ── shape
                  ground(...)                      ── truth
              ──► { provider, promptVersion, dictVersion, response, entries, retrieved }

GET  /api/ask ──► { provider, promptVersion, model? }
```

`response` is the only thing the client caches: ids, indexes, flags and the model's prose,
never dictionary text. On a cache hit the panel refetches the cited entries from
`/api/dict/entries` and re-renders — §3.4's "re-resolved against the dictionary at render",
and it is an e2e spec rather than a claim.

**Module split, and why it matters.** `provider.ts` / `fake.ts` / `anthropic.ts` /
`prompts.ts` are **server-only** (the Anthropic SDK refuses to construct in a browser-like
environment). `ground.ts` and `cache-key.ts` are **pure** — no dictionary, no SDK, no
`process.env` — and are the only two `ask-panel.tsx` imports. Import `@/lib/ai` from the
server; import those two by path from a client component. An `export *` of the barrel into a
client component would drag the 35 MB dictionary loader and the SDK into the browser bundle.

`provider.ts` ↔ `anthropic.ts`/`fake.ts` is a deliberate module cycle (the implementations
need the schemas and `ProviderError`). It is safe **only** because nothing in those files
evaluates a `provider.ts` binding at import time — which is why the tool schema in
`prompts.ts` is derived inside `answerTool()` rather than sitting in a top-level constant. A
`const TOOL = zodToJsonSchema(askResponseSchema)` there is a temporal-dead-zone crash on
first import, not a type error. Keep the derivation lazy.

> **Superseded in part.** Rule 3 below flagged 太贵了, 我爱你 and 我很累 — see
> "Phases 4–5 review fixes", *The unverified flag stopped crying wolf*.

**The unverified rule is wider than §3.4's wording, on purpose.** The plan says "a run of ≥2
consecutive *fallback* single-chars". Taken literally that flags nothing in the two cases the
same paragraph demands be flagged: 随, 看, 绝 and 子 are all real CC-CEDICT headwords, so
随看随买 and 绝绝子 segment into `via: 'entry'` tokens and no fallback occurs. `unverifiedSpans`
(`lib/ai/ground.ts`) implements instead: (1) any `via: 'fallback'` word token — the plan's
case, kept; (2) a single-char token whose only gloss is "used in …" / "variant of …" /
"see …" — the plan's other case, kept; (3) **a run of ≥2 consecutive single-character tokens,
unless every character in the run is among the ~100 most frequent words**
(`COMMON_SINGLE_RANK`, on jieba's `freqRank`). Rule 3 catches the invented compounds; the
frequency escape hatch keeps it off ordinary sentences (我看了一下 is 我 rank 8 · 看 81 ·
了 1 · 一下, not flagged; 随 is 904 and 绝 is 1834, flagged). Unit-tested both ways; if a
reviewer prefers the literal reading it is one exported constant and one function.

Other P4 calls the plan did not make: **a phrase citing an unretrieved id is dropped whole**,
not rendered with a hole (matches are dropped individually, as the plan says; a sentence with
a missing word teaches nothing); **`{text}` tokens are `unverified` as well as `aiGenerated`**
(the same claim from two directions, and the UI needs the second to warn at phrase level);
**the two demo contexts for 看 answer with different entries** (kān vs kàn) *and* a different
sense index, which is the confusion a learner actually has; **`proposePhrases` failing is not
an ask failing** — it is retrieval help, so the route logs and carries on, and only `answer()`
failing is a 502; **retrieval widened for English sentences**, because P1's gloss index ANDs
its tokens and `search("how do I say I'm just browsing")` returns exactly nothing —
`mergedSearch` falls back to the individual words and the 40-cap reserves a 16-entry head so
a broad query cannot crowd out the proposed phrases. **Model:** `DEFAULT_MODEL =
'claude-opus-5'`, recorded in `.env.example`; structured output is a forced tool call and the
input schema is derived from the zod schema by a narrow zod-3 walker that throws rather than
emit a lie to the model. **It has never made a live call from this container.**

### What P5 built (the reader, §3.5)

`lib/reader/sentence.ts` (the sentence span), `lib/reader/states.ts` (the colouring pass),
a rewritten `lib/stores/reader.ts`, and `components/reader/**`. Decisions the plan left open:

- **A token's colour is the strongest state of its readings.** Segmentation never truncates
  `entryIds` (§3.2), so 了 arrives carrying both `le` and `liǎo`; a card for `le` means the
  learner has met the word. `known` beats `learning` beats `new`.
- **A `word` token with no entry (`via: 'fallback'`) is `new`, not uncoloured** — a name or a
  rare character is a word the learner demonstrably has not met. Only `text` tokens have no
  state, and they are rendered plain and are not buttons.
- **Only bands ≤ `settings.knownBand` are fetched.** `wordState` cannot act on a higher band,
  so pulling 3–7 would change no answer and cost 9,000 rows. `ReaderIndex.bands` is therefore
  **not** "this word's band".
- **"Mark known" takes the token's most frequent reading, not all of them.** `markKnown`
  evicts any existing card for a year, so marking every reading of 了 would evict a `liǎo`
  card the learner is studying. The token still recolours, by the strongest-reading rule.
- **The colouring inputs are a `useLiveQuery` over `cards`/`known_words`/`settings`**
  (`dexie-react-hooks` was already a dependency with no consumer). Add and "Mark known"
  recolour in place with no invalidation, no polling and no re-segmentation — one read per
  change, not one per token.
- **Segmentation lives in the store, not the view**, so a trip to `/review` and back does not
  re-post the paragraph; `read()` is a no-op when `tokenizedBody === body`, and a response
  that lands after the body changed is dropped (tokens index a string by offset).
- **Saving is not optional** — "Save and read" is one button, so no state exists in which a
  pasted page is lost to a refresh. Editing the body clears `textId`, so an edit saves as a
  new row rather than overwriting the one on the reopen list.
- **The sentence keeps its terminator and drops the leading one**; `，`, `、` and `：` do not
  bound it, because a Chinese sentence commonly runs three clauses on commas and cutting
  there throws away the context the card exists to carry. The ≤200 cap **windows around the
  target** rather than truncating from the left, and `offset`/`length` are re-derived after
  every trim, so `sentence.slice(offset, offset + length)` is always the word.
- **Extend is a button (`Extend to 东西`), not a second tap** — a second tap is ambiguous with
  "look up that other word", the far commoner intent. The lookup itself is what §3.5 asks
  for: `/api/dict/search` on the concatenation, exact headword first. An extended span has no
  `entryIds`, so it is looked up by search; if the dictionary has no headword the panel says
  so rather than showing a near miss.

### The seams the merge wired

1. **The ask panel is inside the reader, and it knows the sentence.** P4's one sanctioned edit
   made `<AskPanel>` the *default* content of `LookupPanel`'s ask region when no `ask` slot is
   injected (its own testid, `lookup-ask`; an injected slot still wins and still reads
   `lookup-ask-slot`). P5's `ReaderLookup` renders `<LookupPanel query context>` with no slot.
   So a reader tap gets the ask panel asking about that token **with the tap's sentence as
   context**, and neither builder edited the other's file. Nothing was needed here but the
   proof: the full-loop spec asserts it.
2. **A card added from the ask panel inside the reader carries both sentence and question.**
   `askContextFor` already merged the incoming `sentence` with the `question`. What it also
   carried was the tap's `offset`/`length` — **and that was wrong.** The span points at the
   token that was tapped, and `lib/srs/context.ts` highlights `sentence.slice(offset, offset +
   length)` *in preference to* searching for the headword. An ask answers with words the tap
   did not name (a second sense, a whole phrase), so the card back would have underlined the
   wrong characters with total confidence. The span now travels only when the sentence
   actually reads as the word being added at that position (`headwordForms`, simplified and
   traditional); otherwise it is dropped and `resolveContext` locates the headword itself,
   which is right or visibly absent, never quietly wrong. A phrase card never inherits a span.
3. **The demo seed's warm `ask_cache` rows use the real key.** `demoAskCacheKey` and
   `DEMO_PROMPT_VERSION` are **deleted** from `lib/dev/seed.ts`; `loadDemo` now awaits
   `askCacheKey` from `@/lib/ai/cache-key` — the same function the panel runs in the browser,
   not a second copy of the formula that a test had to keep honest. `cache-key.ts` imports
   only a *type* from `provider.ts`, so nothing server-side follows it into the seed's bundle.
   `tests/unit/lists/seed.test.ts` now pins the strong form of the invariant: the key
   `loadDemo` actually wrote is the key the panel derives for the same question at the band
   the demo leaves the learner on (`knownBand` 2, which is `DEFAULT_SETTINGS`), so a drift
   makes the demo call the provider instead of quietly orphaning a row.

### The full-loop spec

`tests/e2e/integration.spec.ts` gained a second test spanning all five phases: `/settings`
Load demo → `/lookup` "how do I say I'm just browsing" → the ask panel answers **from the
seeded cache** (`data-cached="true"` — this is seam 3's assertion) → Add the sayIt as a phrase
card → `/read` the demo paragraph → tap 附近 → the reader panel carries the sentence *and*
shows the ask panel (seam 1) → Add → `/review` walks the session, offering both new cards, the
mined one with its sentence in `context-back` and 附近 in `context-target` → `reviews` rows
exist for both → Today reads 0 due / 0 new with Start review dead. The P1–P3 loop test above
it is unchanged.

The session is walked rather than asserted on the first card: the demo's own due cards come
first, and `buildQueue` orders `[...due, ...newCards]`. `newPerDay: 0` is set after the demo
so the walk is about the two cards the spec mined, not the ten the spine would draw.

### Frozen files changed

- `components/lookup/lookup-panel.tsx` — P4's one sanctioned edit, carried through the merge
  unchanged. Nothing else frozen was touched by either builder or by the merge.
- `lib/stores/lookup.ts` is not frozen, but it is shared: it gained one optional field,
  `entryIds` (`LookupOpenRequest extends LookupRequest`), cleared by `setQuery`/`clearSearch`/
  `closeLookup`. A reader tap knows more than a query — the DAG already resolved the token to
  its readings *in context*, and asking the search router to re-derive them from the bare
  string would let it guess differently (了 is `le` here because of the words around it).
  `/lookup` ignores the field.

### Fixed on the way through

- **Two stale assertions retired.** `tests/e2e/p1/lookup.spec.ts` and `tests/e2e/smoke.spec.ts`
  asserted `lookup-ask-slot` count 0 "until Phase 4 fills it". Both still passed and both were
  stale in intent — nobody injects the slot. They now say what is true: on `/lookup` with a
  query the `lookup-ask` region and the `ask-panel` are visible; on a bare `/lookup` neither
  region exists, because there is nothing to ask about.
- **A real race in `tests/e2e/p2/review.spec.ts:121`** ("the chosen sense leads"), which both
  the P5 builder and this merge saw fail once and pass on a re-run. `seed()` reloads the page,
  so the session is still loading when it returns; that test pressed Space immediately, and a
  keystroke into a page with no card never reveals anything. It now waits for the front. This
  is the *only* test in the file that pressed a key without first asserting something visible.

### Needs, still open

1. **`addPhraseCard` cannot record a `dictVersion`.** The frozen repository signature takes
   none and `lib/db/dexie.ts` stamps `'unknown'`. Word cards from the ask panel do carry the
   real snapshot version. Fixing it is a frozen-file change (a fourth argument, exactly as
   `addCardFromEntry` got one in Phase 0) and was not worth spending on this merge.
2. **Phrase cards do not join the "Looked up" list.** Membership joins on `entryId` and a
   phrase has none. The panel's "add N words individually" does join them.
3. **`getLearnerProfile` runs without `bandSizes`** in the panel, so `estimatedBand` is
   `settings.knownBand` rather than a measured band. Band sizes live in the dictionary on the
   server; a count route or a field on the ask response would improve it — and would change
   the cache key, so it wants an `ASK_PROMPT_VERSION` bump when it lands (and the demo seed's
   warm rows re-derive for free now, which is the point of seam 3).
4. **Picking a result on `/lookup` re-asks.** *(Fixed in the review below: the
   ask stays keyed to what was typed, via `LookupPanel`'s new `askQuery`.)* `LookupPanel`'s `query` is the typed query until
   a result is picked and the headword after that, which is the intended reading of "ask about
   what the panel is showing" but costs a second call. If it is wrong the fix is in
   `lookup-view.tsx`, not in the panel.
5. **Two texts cannot be open at once, and a saved text cannot be deleted** — the repository
   has no `deleteText` and nothing in v1 asked for one. **No virtualisation** either: ~1,300
   tokens render and recolour without a visible pause, but a book would want windowing.
6. **A polyphone whose readings differ in traditional form** (了 → 了/瞭) shows the first
   reading's traditional headword in the reader panel's "traditional" line. The readings
   themselves are all listed and correct; only that one line picks a representative.

### For Phase 6

- The reader adds through `addCardChecked` (`lib/lists/looked-up.ts`), never the repository
  directly, and a reader Add is an explicit source, so it never charges `settings.introduced`.
- `ReaderScreen` calls `closeLookup()` on unmount. The lookup store is a module singleton and
  a stranded reader context would otherwise attach someone else's sentence to the next
  `/lookup` Add. Any new screen that calls `openLookup` owes the same.
- The e2e specs copy the demo paragraph into `tests/e2e/p5/paragraph.ts` (Playwright would
  drag Dexie into Node otherwise); `tests/unit/reader/paragraph.test.ts` fails if the copy
  drifts from `lib/dev/seed.ts`. The full-loop spec imports that copy too.
- `tests/unit/ai/{anthropic,provider,prompts,route}.test.ts` carry `// @vitest-environment
  node`: the SDK refuses to construct under jsdom, and the route handlers are server code.

### Checks on the merge commit

| Check | Result |
|---|---|
| `pnpm install --frozen-lockfile` | no-op, lockfile up to date |
| `pnpm data:ensure` | `data/dict.json` present |
| `npx tsc --noEmit` | pass |
| `pnpm lint` | pass |
| `pnpm test` | pass — 39 files, **392** tests (283 before P4/P5) |
| `pnpm build` | pass (Turbopack); `/api/ask` is `ƒ`, as the dictionary routes are |
| `PORT=3000 pnpm e2e` | pass — **67/67**, run twice clean (55 before P4/P5) |

No server is left running; port 3000 is free. `/home/user/v0-anchor` was not touched.

---

## Phases 4–5 review fixes

Written after the three-lens adversarial review of the merged phases. Fifteen
findings were verified and fixed — seven blocking/major on the ask pipeline,
six on the two UIs, and eight minors that were cheap enough to take. Every
grounding attack the review demonstrated is now a permanent test
(`tests/unit/ai/attacks.test.ts`, `tests/unit/ai/route-provider.test.ts`).
Nothing here was disputed: all fifteen reproduced.

### The dictionary is ground truth — the holes in that claim

**Blocking — a phrase's own prose was never scrubbed.** `ground()` passed
`sayIt[].en` and `.register` through untouched while every other prose field went
through `stripCjk`, so a model could answer with
`en: '我隨便看看 (wǒ suíbiān kànkan)'` and the panel printed the hanzi *and* the
reading as plain text with no flag — and `addPhraseCard` then wrote the same
string onto the card's back. Both now go through the prose scrubber, and a
phrase whose `en` was nothing but hanzi is dropped rather than shown with an
empty gloss. `renderPhrase` scrubs them a second time on the way to the screen,
because a cache row written before this existed is re-rendered through it.

**Major — prose could still carry a reading.** `stripCjk` removes ideographs;
pinyin is the other half of the same claim, and "pronounced sui1 bian1" or
"read it as suíbiān" reached the panel intact. A learner cannot detect a wrong
tone — that is the whole reason they are asking (§1) — so `stripPinyin` now
takes tone-marked and tone-numbered pinyin out of `interpretation`, `notes`,
`whyThisOne`, `en` and `register`. Two decisions inside it:

- **The trigger is the tone, never bare letters.** Half of English is a legal
  toneless syllable (`men`, `hen`, `long`, `song`), so only a word carrying a
  tone mark or a trailing 1–5 fires the rule. `scrubProse('The men can hang on
  to a long song')` is unchanged; `'It is pronounced hěn hǎo.'` becomes
  `'It is pronounced.'`
- **A toned syllable takes its untoned neighbours with it**, within one run
  (whitespace, apostrophe or hyphen only — a comma ends the run). `kán kan`
  goes whole instead of leaving `kan` behind. A note with nothing left to say
  after that is dropped.

The syllable inventory is CC-CEDICT's own, extracted once from `data/dict.json`
and frozen into `lib/ai/ground.ts` as a string constant: the module is imported
by a client component and may not touch the dictionary.

**Minor, same family — `stripCjk` missed the lookalikes.** Kangxi radicals
(⼀ is U+2F00 and renders identically to 一), the CJK Radicals Supplement,
Bopomofo (a plausible thing to reach for when a learner mentions Taiwan),
enclosed CJK, and Extensions G/H are all in `CJK_RUN` now, with a case each.

**Blocking — an AI `{text}` token could become a review card.** "Add as a phrase
card" was not gated on the flag. `snapshot.simp` is the joined token text and
`cardFace` returns it as `face.primary`, which `review-card.tsx` renders at 6xl
with no flag anywhere on the review path (`grep -rn unverified components lib`
found nothing there) — while `pinyinMarked` was built from the *dictionary*
tokens only, so the back read a syllable short. 我 + `{text:'隨便'}` + 看看
became a card whose front said 我隨便看看 and whose back said `wǒ kàn kan`.

The fix is at the Add, not on the review card: a phrase with any unverified,
AI-generated or missing token cannot be added at all — the button reads
"Not verified — cannot add" and the warning offers the cited words instead.
Underneath it, `addPhraseCard` now writes `?` for a token with no reading rather
than dropping it, so no card can ever have a back shorter than its front.

**Major — the flag fired on ordinary sentences.** Rule 3 ("a run of ≥2 single
characters unless all are in the ~100 most frequent") flagged 12 of 30 everyday
phrases — 太贵了, 我爱你, 我很累, 我饿了, 我先走了 — because frequency cannot
separate 随 (904) from 贵 (1957). A warning that fires on 我 and 了 teaches the
learner to ignore warnings, which is expensive on the day it is right. The rule
now splits by *citation*:

- a run of **uncited** singles (a `{text}` token the segmenter split, a
  `via:'fallback'` character) keeps the old frequency rule;
- a run of **cited** singles is flagged only on the shape that says "compound":
  a character repeated within two positions (随…随, 绝绝), minus the two
  reduplications Chinese actually forms that way (AA 看看/走走, A一A 看一看).

Verified over the real dictionary: 太贵了 · 我爱你 · 请给我水 · 我很累 · 我饿了 ·
我很忙 · 我先走了 · 我错了 · 我很冷 · 我懂了 · 太热了 · 别动 · 看一看 · 说说 ·
走走 · 我随便看看 all come back clean, while 随看随买 and 绝绝子 — the two cases
§3.4 names — are still flagged, and 我 + `{text:'超爱'}` + 我 flags only the
model's own token. `unverifiedSpans` takes a third argument (the cited spans)
and `ground()` computes it from the rendered tokens.

**Major — `polyphone` counted rows, not readings.** CC-CEDICT keeps a row per
traditional variant and per capitalised proper noun, so 后 (后/後/Hòu), 里, 面,
出, 于, 云, 周, 布, 范 and 仿 all have several entries and *one* reading — and
every sayIt containing one of them rendered " · polyphone" with a tooltip
telling the learner to check which reading. `lib/dict/index.ts` gained
`readingCount(simp)` (distinct normalised `pinyinNum`), the route and the test
helper both call it, and a test pins 后/里/面/出 as not polyphone and 看/发 as
polyphone.

**Major — a schema-valid answer could ground to nothing.** Writing the Chinese
into `interpretation` and citing an id it was never given is the commonest thing
a live model does, and it produced `{interpretation:'', matches:[], sayIt:[]}` →
HTTP 200 → a heading over an empty section → cached, so the query stayed empty
for ever. The route now falls back to `ground(retrievalEcho(retrieved), …)` when
all three are empty and marks the response `cacheable: false`; the panel skips
`askCache.set` for it and renders an explicit line (`ask-empty`) if an answer
still comes back with nothing in it. §3.4's "no query ever renders an empty
panel" is a promise about the screen, so the dictionary answers instead.

**Major — the cache stored gloss text.** `retrievalEcho` built its
interpretation out of the top entry's reading and its first three glosses
("Offline: the closest dictionary entry reads suíbiàn — as one wishes; as one
pleases; at random"), and `response` is exactly what the client writes into
`ask_cache`. §3.4 ("cached responses hold ids and indexes only"), §5 ("caches
hold ids, not gloss text") and the seed's own comment all say otherwise, and
*every* non-demo query under the fake — the only provider that has ever run —
broke it. The echo now names the entries without quoting them; the panel renders
the glosses from the entries it fetched, which is where they were already coming
from. `tests/unit/ai/fake.test.ts` asserts no gloss and no reading appears in
the echo's prose.

**Major — nothing had a deadline.** A provider that never resolved left the
route pending for ever and the panel on "Thinking about …" with no way out but
retyping; `proposePhrases` was awaited inside the retrieval `try`, so "retrieval
help is optional" covered a rejection but not a hang. Both calls are now raced
against a timeout (`PROPOSE_TIMEOUT_MS` 8 s → `candidates: []`,
`ANSWER_TIMEOUT_MS` 30 s → the existing 502 shape), both overridable by env
(`TANGRAM_ASK_PROPOSE_TIMEOUT_MS`, `TANGRAM_ASK_ANSWER_TIMEOUT_MS`) — which is
what lets a test prove the deadline exists in 40 ms instead of 30 s. The panel
carries its own 35 s backstop for the network itself and says "The ask took too
long" rather than failing silently.

### The two UIs

**Blocking — on a phone the answer was hidden until a result was picked.**
`lookup-view.tsx` wrapped the whole panel column in `selected ? '' : 'hidden
md:block'`. An English sentence has no headword to pick, so at 390px the learner
got "Nothing matched" / "No matches" and nothing else: the §1 front door, the
phrase card and "Add this sense" were all unreachable, and the panel was in the
DOM the whole time with `display:none`. The column is now hidden only when the
box is empty, and sits *after* the results until something is selected (so the
old reason for the `order-1` swap — an empty card pushing the first hit down the
screen — still holds). An e2e case at 390px asserts the ask panel and its sayIt
are visible for the sentence query.

**Major — picking a result wiped the answer you were reading.** `LookupPanel`'s
`query` fed both the header and the ask, so selecting 打算 out of a `dasuan`
search re-asked with the headword: a second provider call, and under the fake it
fell through to the offline echo, so the demo's Say-it line vanished ~600 ms
after the click (and on a phone was never on screen at all). `LookupPanel` now
takes an optional `askQuery` — **the second sanctioned edit to that frozen
file** — and `/lookup` passes the typed query. The header still follows the
pick.

**Major — the panel showed the previous word's answer under the new word's
heading.** `setState({status:'loading'})` ran inside the debounced `run()`, so
for 500 ms after a query change the old answer, its matches and its Add buttons
were all still live: pressing one wrote a 附近 card whose "From the sentence"
line was about 每天, and the learner never even saw "Added" because the card
unmounted when the real answer landed. The ready state now records what it
answers (`answered: {query, contextJson}`) and staleness is *derived in render*
(no setState in an effect): a stale answer shows "Thinking about …" and no Add
buttons, and `data-status` reads `loading`. `addMatch` also snapshots its
provenance at click time.

**Major — "Add as a phrase card" was not idempotent.** `addPhraseCard` does a
bare `db.cards.add` and the button's disabled state is per-mount, so asking the
same question after a reload and pressing Add again made a second identical card
and the review session offered both. The frozen repository has no
`phraseCardFor` to ask, so the check lives one layer out, beside the "Looked up"
join it resembles: `phraseCardFor` / `addPhraseCardChecked` in
`lib/lists/looked-up.ts`, keyed on the phrase's own characters. The panel probes
on mount and says "Already in your cards" before it is pressed.

**Major — "add N words individually" queued words the app calls known.** It
added every cited token with no `senseIndex` and never looked at `known_words`
or `knownBand`, so the demo's three words became 我 (HSK 1, known under the
demo's own band 2) plus a second 随便 card beside the sense-specific one from
"Add this sense" — `undefined` and `0` are different cards by design. Now: a
token already known, or inside `settings.knownBand`, is skipped and reported
("1 added · 我 · 随便 already known"), and a token that is *also* one of the
answer's matches is added at that match's sense, so the two paths land on one
card. A single "Add this sense" is untouched — that is the learner choosing.

**Major — "Mark known" and "Add card" could both be true.** The reader's
`marked` was local state, so it said "Mark known" over a word that already was
one, and after marking, `Add card` was still offered: pressing it queued the
word for today while the `known_words` row stayed, so the reader painted it
known, the queue served it, and the Looked-up list read "known · Queued".
Two changes: `ReaderLookup` reads the known set live (`useLiveQuery`), like the
colouring does; and an *explicit* Add now calls a new
`Repository.unmarkKnown(entryIds)` — **a frozen-file addition**
(`lib/db/repository.ts` + `lib/db/dexie.ts`), because the two states are
contradictory and nothing could leave the first one. Adding is the learner
saying they want to study the word, so it wins. A spine draw (`source:'list'`)
leaves the known set alone.

**Major — the reader panel reopened on a stale selection.** `ReaderScreen`
cleared the lookup store on unmount but not `useReaderStore.selected`, so after
a trip to `/review` (or the Edit view) the panel reopened on the last tapped
token with no sentence and no `entryIds`: it re-searched the bare string and an
Add from it carried no provenance at all. The selection and the context are one
piece of state now and die together. `tests/unit/reader/screen-selection.test.tsx`
mounts the screen, unmounts it and asserts all three are gone.

### Minors taken

- **The cache key ignored half the context the prompt sees.** `askContextKey`
  collapsed to `sentence ?? question ?? query`, so two asks that differed only
  in `question` shared a row. It is the whole tuple now; a bare string (the
  seed's shape) still means the sentence, pinned by the existing test.
- **Grounding is bounded**: matches deduped on (entryId, senseIndex) — the
  panel's React key — notes capped at 8, tokens per phrase at 32, prose
  truncated at 2,000 characters, and notes keyed by index rather than by text.
- **A failed `GET /api/ask` is no longer memoised.** One transient error used to
  pin `provider: 'fake'` for the life of the page, which keyed every later cache
  row wrongly and painted the offline badge over a live answer. The panel also
  refuses to cache when the handshake was the fallback or when the answering
  provider is not the one the key was derived for.
- **"Nothing matched" no longer contradicts the answer beside it.** The status
  line for a query with no headword hit now says the Ask panel takes the whole
  question.
- **A "context" that is only the headword is not context.** `resolveContext`
  returns null when the provenance line equals a headword form, so a card no
  longer offers "Peek context" that reveals ＿＿; and `askContextFor` omits
  `question` when the query *is* the headword being added (which is why the P4
  spec now asserts `context.question` is undefined for the 看 ask).
- **A failed save is no longer swallowed.** `save()` returns a boolean and
  "Save and read" only reads when it worked — `read()` cleared `error` and
  unmounted the only box that shows it.
- **The stale `askSlot` comments** in `app/lookup/page.tsx` and
  `lookup-view.tsx` now say what is true: the ask panel is `LookupPanel`'s
  default ask content and the slot is an override hook.

### Frozen files changed here

- `components/lookup/lookup-panel.tsx` — the optional `askQuery` prop (its
  second sanctioned edit; the first was P4's default ask content).
- `lib/db/repository.ts` — `unmarkKnown(entryIds)`, with the reason in the
  docstring.
- `lib/db/dexie.ts` is not frozen, but it implements both of those and the
  phrase-snapshot `?` placeholder.

### Not done, and why

- **`addPhraseCard` still stamps `dictVersion: 'unknown'`** (open item 1 of the
  merge). It needs a fourth argument on the frozen signature and no rendering
  depends on it — a phrase snapshot is never re-resolved.
- **The review card still renders `snapshot.simp` rather than per-token
  markup.** The reviewer offered either that or refusing the Add; refusing is
  the one that cannot be got round by a card written before the rule existed.
  A phrase card in a database from before this fix can still show an unflagged
  invented character.
- **`retrievalEcho`'s `matches` are still "dictionary match"** for every entry,
  which is honest for a dictionary ranking but is not an explanation.

### Checks after the fixes

| Check | Result |
|---|---|
| `npx tsc --noEmit` | pass |
| `pnpm lint` | pass, no warnings |
| `pnpm test` | pass — 43 files, **420** tests (392 before) |
| `pnpm build` | pass (Turbopack); `/api/ask` still `ƒ` |
| `PORT=3000 pnpm e2e` | pass — **74/74** (67 before) |

No server is left running; port 3000 is free. `/home/user/v0-anchor` was not
touched.

---

## Phase 6 — TTS and the PWA shell (stretch, items 1–2 of 4)

Worked in order on `main`. Items 1 and 2 landed; items 3 (i+1 example sentences)
and 4 (free-recall grading) were **not started** — the session ran out of wall
clock at the item-2 boundary, which is where it was told to stop rather than
leave a half-written provider method behind.

### 1. TTS — `03bc8da`

`lib/tts/provider.ts` is the seam (`available(): Promise<boolean>`,
`speak(text, opts?)`); `lib/tts/speech-synthesis.ts` implements it over the Web
Speech API; `components/tts/speak-button.tsx` is the button, on the **review card
back** (next to the pinyin) and in the **lookup entry detail** header.

Three things are load-bearing and are not obvious from the code shape:

- `available()` calls `getVoices()` once and, only when that list is empty,
  waits for `voiceschanged` with a **500 ms** timeout. Chrome fills the list
  late; headless Chromium never fills it at all, so the second case has to
  resolve `false` on the timer rather than hang a button in "pending" forever.
- The match is `zh*` (and `cmn*`), not `zh-CN`. Matching the exact tag reports
  "no voice" on a machine that has three.
- `speak()` calls `synth.cancel()` before it enqueues. The utterance queue is
  global and additive, so without the cancel a double tap plays the word twice
  back to back.

The tooltip sits on a wrapping `<span>`, because `Button` sets
`disabled:pointer-events-none` and a disabled button never receives the hover
that shows a `title`.

**Unverifiable here: audio.** Headless Chromium ships no speech-synthesis voices,
so `tests/e2e/p6/tts.spec.ts` asserts exactly what can be observed — the button
is present on both surfaces, disabled, `data-tts-status="unavailable"`, and says
"No Chinese voice available in this browser". Nobody has heard this app speak.
First thing to check on a real machine: that the picked voice reads the *card's*
script (a `zh-TW` voice reading simplified is fine; the reverse is not).

### 2. PWA shell — `eee44cb`

`public/manifest.webmanifest` (name Tangram, `start_url`/`scope` `/`,
standalone, the app's SVG icon copied to `public/icons/tangram.svg`, one entry
`purpose: maskable`), a hand-written `public/sw.js`, and
`components/pwa/register-sw.tsx` mounted in the root layout. No PWA dependency —
`package.json` and the lockfile are untouched.

`app/layout.tsx` gained `metadata.manifest`, `appleWebApp`, `viewport.themeColor`
and the registration component; `next.config.ts` gained a `headers()` block.
Both are frozen files and both edits are inside the mandate given for this phase.

The worker's rules are ordered and the order matters:

1. **`/api/**` returns before `respondWith`** — never cached. The cache that
   belongs in front of the ask route is `ask_cache` in IndexedDB, which stores
   ids rather than gloss text (CLAUDE.md); a second, dumber HTTP cache there
   would serve one profile's grounded answer to another.
2. **`/_next/static/**` is cache-first with no revalidation** — the paths are
   content-hashed, so a hit is always correct and a miss is a new build.
3. **Navigations are cache-first with a background refresh**, falling back to
   the network and then to the cached `/`. This is the offline review session.

The cache name is versioned (`tangram-v1`) and `activate` deletes every cache
that is not the current one — that is also how a stale shell pointing at chunk
hashes that no longer exist gets collected. **Bump `VERSION` whenever the shell
or `sw.js` changes.** Only `response.ok && response.type === 'basic'` is ever
stored, so an opaque cross-origin or partial response cannot poison the shell.

Registration is **production-only** on purpose: a service worker under `next dev`
caches chunks Turbopack is still rewriting, and the symptom is a dev server
serving yesterday's page with no visible reason. `pnpm build && pnpm start` —
what the e2e `webServer` runs — is where it registers.

**Unverifiable here: install and offline.** There is no way to trigger an install
prompt, no Lighthouse, and the e2e never goes offline.
`tests/e2e/p6/pwa.spec.ts` asserts the manifest is served as
`application/manifest+json`, parses, is linked from the document, and that its
icon 200s; and that `sw.js` is served as no-store javascript, registers, and
reaches `state === 'activated'`. Whether iOS accepts the SVG-only icon set is
untested — if it does not, generate PNGs at 192/512 into `public/icons` and add
them to the manifest; nothing else changes.

### Gates

| Gate | Result |
|---|---|
| `pnpm lint` | pass |
| `pnpm test` | pass — **438** in 45 files (431 before; +11 TTS, +7 PWA, minus none) |
| `pnpm build` | pass (Turbopack), run as the e2e `webServer` |
| `PORT=3000 pnpm e2e` | **77 passed, 1 failed** of 78 (74 before; +2 TTS, +2 PWA) |

### The one red spec — read this first next session

`tests/e2e/p3/today.spec.ts:49` ("marking HSK 1–3 known moves the day's new words
to band 4") fails on the **"Mark all known"** button being disabled for 30 s of
click retries. It:

- **passes** when `tests/e2e/p3/today.spec.ts` runs on its own (verified twice);
- **fails** when the whole `tests/e2e/p3` directory runs in sequence (verified
  against a standing `pnpm start`, with no p6 spec in the run at all);
- **also failed** on the TTS commit alone, before `sw.js` or any layout change
  existed — and TTS touches no code that `/lists` or `/` renders.

So it is ordering/timing dependent, not caused by the speaker button or the
worker, but it was reported green at 74/74 in the Phases 4–5 handoff, so
something about this run is slower or dirtier than that one. `disabled` on that
button is `busy[list.id] || allKnown` (`components/lists/list-card.tsx:66`), and
`busy` is per-list, so the suspect is a `markAllKnown` for an earlier band still
in flight — thousands of member rows — while the loop has moved on to the next
card. Reproduce with `PORT=3000 pnpm exec playwright test tests/e2e/p3`, and fix
it before reading anything into a Phase 6 e2e number.

### Not started

- **Item 3, i+1 example sentences.** Plan of record if someone picks it up:
  `exampleSentences(entry, profile)` on `LLMProvider` returning
  `{sentences: [{tokens: [{entryId}|{text}], en}]}`; a `POST /api/examples` that
  runs the *same* grounding as `/api/ask` and then **filters** — every token must
  cite an entry in the learner's known set or the target entry itself, or the
  sentence is dropped whole. The prompt asks; the filter enforces. Cache in
  `ask_cache` under its own `promptVersion` prefix so an i+1 miss cannot be
  served an ask hit.
- **Item 4, free-recall grading.** Optional "What does it mean?" field on the card
  front behind a `/settings` toggle (default off); on flip,
  `gradeRecall(entry, senseIndex?, answer) → {suggested, why}` highlights a button
  and shows the reason, and **nothing is submitted** until the user presses a key
  or a button. The no-auto-submit rule is the whole feature — a grade the app
  chose for you is not a self-assessment.

No server is left running; port 3000 is free. `/home/user/v0-anchor` was not
touched; `package.json` and `pnpm-lock.yaml` are unchanged.
