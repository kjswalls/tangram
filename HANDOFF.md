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
