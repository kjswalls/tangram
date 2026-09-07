# HANDOFF — P1 (Dictionary + lookup)

Phase 1 of PLAN.md §4: search routing/ranking (§3.2), segmentation (§3.2), the two
routes, `/lookup`, and the lookup components. Everything in the P1 acceptance row is
covered by a test — `search()`/`segment()` by unit tests against the real generated
dictionary, and every route-named line by an e2e spec under `tests/e2e/p1/`.

## What landed

| File | What it is |
|---|---|
| `lib/dict/search.ts` | routing, ranking, grouping, paging. `search(q, {limit, cursor})` |
| `lib/dict/segment.ts` | run classification + max-probability DP. `segment(text, {script?})` |
| `lib/dict/decomp.ts` | `decomposeChars()` + the decomp response shape (new file; the endpoint is P1's) |
| `app/api/dict/search/route.ts` | `GET ?q=&cursor=&limit=` |
| `app/api/dict/segment/route.ts` | `POST { text, script? }` |
| `app/api/dict/decomp/route.ts` | `GET ?chars=` |
| `app/lookup/page.tsx` | replaced the placeholder; renders `<LookupView />` |
| `components/lookup/lookup-view.tsx` | the route: input, debounce, layout, panel |
| `components/lookup/search-results.tsx` | labelled sections, result rows, show more |
| `components/lookup/entry-detail.tsx` | panel body: readings, glosses, decomposition, Add |
| `lib/stores/lookup.ts` | search state added; `openLookup({query, context})` unchanged |
| `lib/dict/client.ts` | **appended** `fetchSearch`, `fetchSegment`, `fetchDecomp` |
| `tests/unit/dict/search.test.ts`, `tests/unit/dict/segment.test.ts`, `tests/e2e/p1/*` | tests |

**No frozen file was edited.** `components/lookup/lookup-panel.tsx` was left exactly as
Phase 0 wrote it — the body goes in as `children` and the ask slot is passed through
untouched, so nothing there can conflict with P4.

`lib/dict/client.ts` is the one file outside P1's listed paths that changed. PLAN.md §3.2
says it "holds typed fetchers" for all four dictionary routes, two of which are P1's, so
the fetchers went there rather than into a parallel module. The edit is append-only plus
three type-only imports at the top.

## Decisions the plan left open

**The 50-cap is split between sections, not taken off the front.** A flat "first 50 of the
concatenation" made two acceptance lines impossible: `he` has hundreds of readings before
他's gloss is reached and `sun` hundreds of glosses before 孙, so the trailing section never
appeared at all. Every non-leading section is now reserved `floor(limit / (sections + 1))`
= 16 of the 50 and the leading section takes the rest. Both answers show on page one.

**The cursor is per-section, `"34.16"`,** not a flat offset — that is the direct consequence
of the split. `SearchResult.offset` is the sum, i.e. results already shown.

**A headword both indexes matched is assigned to the section that ranked it higher**
(`dedupe()`), ties to the leading one. 孫 is `sun` the reading far more than it is the "Sun"
inside "surname Sun"; the same for 龍 and `long`. Doing this while ranking instead (claim on
first sight) let the leading section take the group and then cut it at the cap, which made
孙 vanish from `sun` altogether; doing it per page let page 2 repeat page 1.

**Glosses are split into senses before matching.** CC-CEDICT packs synonyms into one gloss
with semicolons and prefixes register notes: 他 is `"(third-person singular) (…) he; him;
his"`. `glossSenses()` splits on `;` and strips leading/trailing parentheticals, so `he` is
a whole-gloss match on 他 (HSK 1, rank 6) instead of a phrase match ranked below 怹 (rank
326,110). Without it the `he → 他` line reads as a technically-passing, practically-useless
result.

**Irregular plurals are lemmatised at query time only.** `stemToken` (Phase 0, and the
index is built with it) handles `-s/-ed/-ing`; `women → woman` and ten friends live in
`IRREGULAR` in `search.ts` and are applied to the query and to gloss text at compare time.
The gloss index itself is untouched, so no Phase 0 file had to change. This is what makes
`women → 女人` work; `women` is *also* a real gloss token (from idioms), which is why the
English section leads for it.

**Section order precedence:** typed tones (digits or marks) → pinyin first, unconditionally;
else an exact gloss token of ≥3 letters → English first (`sun`, `can`, `women`); else pinyin
first. PLAN.md §3.2 lists the ≥2-syllable rule and the gloss-token rule without saying which
wins, but its own examples settle it — `women` is two syllables *and* the English-first
example.

**`group.hskBand` is the lowest band of any reading** (what the badge shows — the headword's
easiest way in), while ranking uses the band of the *matched* reading. So searching `long`
ranks 弄 by its band-less `lòng` reading while the badge still says HSK 2 for 弄 the headword.

**Segmentation.** Script is inferred per call from characters the two scripts disagree
about (`detectScript`), ties → simplified; `entryIds` come from that script's index, so
traditional text yields traditional headwords. A CC-CEDICT word jieba never scored gets
`freq = 1` rather than the unknown-character floor, so a real word still beats a guess.
`MAX_WORD_CHARS = 16` bounds the DAG scan (CC-CEDICT proverbs run longer; nothing a reader
taps does). Text tokens carry `via: 'fallback'` and `entryIds: []` — `Token.via` is
`'entry' | 'fallback'` in the frozen `lib/types.ts` and has no third value for "not a word".

## Seams for later phases

- **P4:** `LookupView` takes `askSlot?: ReactNode` and passes it straight into the panel's
  `slots.ask`. `app/lookup/page.tsx` is a two-line server component — mount
  `<LookupView askSlot={<AskPanel />} />` there and nothing else changes. The slot renders
  below the dictionary body and the body never waits on it (§3.4). The smoke spec asserts
  `lookup-ask-slot` has count 0 until something fills it.
- **P5:** `openLookup({query, context})` still does exactly what Phase 0 promised — the view
  reacts to a store query set from anywhere and searches on mount, and `context` flows into
  the panel header and onto the card (`EntryDetail.contextFor` keeps a reader's `sentence`,
  `source` and offsets and only fills in a missing `query`).
- **Store additions:** `groups`, `sections`, `total`, `resultQuery`, `nextCursor`,
  `dictVersion`, `selectedKey`, `setSearch`, `appendSearch`, `clearSearch`, `select`.
  Nothing Phase 0 defined changed shape.
- **Test hook:** `[data-testid="search-results"]` carries `data-query`, the query the
  results on screen actually answer. Waiting on it is how the e2e specs avoid asserting on
  the previous query's results while a debounce is in flight.

## Needs (nothing blocking)

1. Nothing in a frozen file. No `package.json` change; no new dependency.
2. `data/decomp.json` now has a consumer (`/api/dict/decomp`), which answers open question 2
   in `HANDOFF.md`. It is displayed only — never written into a card snapshot, never near a
   prompt.
3. Worth knowing at merge: the first hanzi search in a process sorts the 120k headword keys
   into a prefix index (~0.2 s, memoised on the `DictIndex` via a `WeakMap`), and the first
   `segment()` sums frequencies over both headword maps. Both are once per process and drop
   with `resetDictCache()`.
4. The container's Chromium has no glyphs for the IDS characters (⿰⿱…) or some radicals, so
   the decomposition line screenshots as tofu here. It is a font gap in this image, not a
   rendering bug — the strings are correct in the DOM and asserted in the e2e spec.

## Checks

`npx tsc --noEmit` · `pnpm lint` · `pnpm test` (18 files, 168 tests) · `pnpm build` ·
`PORT=3001 pnpm e2e` (33 tests, including the 12 new P1 specs) — all green. No server left
on 3001.
