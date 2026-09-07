# Tangram — v1 plan (finalized for the overnight build)

> Codename **Tangram** (七巧板): seven pieces, every shape. Components compose characters,
> characters compose words, words compose the sentence you actually wanted to say. It is a
> directory and a package name; renaming is a five-minute find-and-replace.

**Status.** Draft → adversarial review (18 finders × 3 lenses, merge, skeptic verification,
completeness critic; 50 agents) → this v2. Section 7 records what the review changed and what
it could not cover. Sections marked ⏳ are decisions deferred to Kirby; the build proceeds on
the stated default.

---

## 1. Thesis

Pleco owns *lookup in context*. Hack Chinese owns *review over curated lists*. Neither closes
the loop between them. Tangram is the loop:

```
read / ask  →  look up  →  becomes a card (carrying the sentence or question it came from)
     ↑                                                                    ↓
     └──────────  your known-word set shapes what you see next  ←─────────┘
```

Three commitments; everything else is subordinate:

1. **The lookup box is the front door.** One input: hanzi, pinyin (tone marks, numbers, or
   none), an English word, or a whole English sentence. No mode picker. It answers what a
   dictionary structurally cannot — which sense applies *here*, register, current usage, what
   a native would actually say — and every answer is one tap from being a card.
2. **Every card has provenance.** The sentence you met the word in, or the question you asked,
   travels with the card and is shown on its back. Not a stranger's example.
3. **The dictionary is ground truth; the model writes the prose.** Hanzi, pinyin and tone
   marks are rendered from dictionary rows the model *cites by id*. The model selects,
   explains, contextualizes. It never emits a headword for display. A learner cannot detect
   a wrong tone — that is why they are asking — so a hallucinated entry is the product
   failing at the one thing it is for. (Scope note: grounding catches invented words, not
   unidiomatic combinations of real words. That class is out of v1.)

## 2. Constraints discovered tonight → decisions

| Found | Decision |
|---|---|
| No Anthropic key in the container (the base URL present 401s) | `LLMProvider` interface. `FakeProvider` is the default and drives tests, the dev UI and the morning demo; `AnthropicProvider` is wired, unit-tested against a mocked HTTP layer, **never called live from here**. |
| `mdbg.net`, `kaikki.org`, `github.com` HTML and `api.github.com` are blocked; npm registry and `raw.githubusercontent.com` are reachable | Every data source is a verified exact URL (§3.1). Wiktionary deferred (⏳). |
| No Supabase project; Supabase MCP needs OAuth this session can't run | **Local-first.** IndexedDB via Dexie behind a repository interface; single user; reviews work offline. Supabase is a later data-layer swap only if the schema rules in §3.3 hold. |
| GitHub integration cannot create repos (403); session scoped to `kjswalls/v0-anchor` | Standalone repo at `/home/user/tangram` (own `main`). **Needs `kjswalls/tangram` created by Kirby** with the Claude GitHub App granted access; the history pushes there unchanged. Until then, after each phase: `git -C /home/user/tangram push --force <anchor-origin-url> main:refs/heads/claude/mandarin-srs-app-concept-vidblr` (parking only; never merged; deleted after the move). Nothing under `/home/user/v0-anchor` is edited; its `git status` stays clean. |
| Node 22 here; anchor CI pins 20; `cedict-json` pins `engines.node=22` | `engines.node: ">=20.9"`, no engine-strict; `cedict-json` is consumed only by the build script, never at runtime. |
| 4 CPUs → at most 2 concurrent agents | Phases are sized for two builders at a time; the third worktree in P1–3 queues. |
| pnpm 10 does not run `pre*`/`post*` scripts | No `prebuild`. `pnpm build` = `pnpm data:ensure && next build`; `pnpm data:ensure` generates only when `data/dict.json` is missing; `pnpm data --force` rebuilds. |

## 3. Architecture

**Stack** (pinned; installed in full in Phase 0 so no later builder edits `package.json`):
runtime `next@16.3.x react@19 react-dom@19 zustand@^5 zod@^3.25 dexie@^4.4 dexie-react-hooks@^4
ts-fsrs@^5.4.2 (not 6 beta) pinyin-pro@^3 @anthropic-ai/sdk@^0.124 clsx lucide-react`;
build-time `cedict-json tsx`; dev/test `typescript@^5.9 (not 7) tailwindcss@^4 @tailwindcss/postcss
vitest@^4 (not 5) @vitejs/plugin-react jsdom @testing-library/react @testing-library/jest-dom
fake-indexeddb@^6 @playwright/test@^1.63 eslint@^9 eslint-config-next@16`. `"type": "module"`.
Bundler: Next 16 default (Turbopack); if `next build` fails on it, switch to `--webpack` and
record why. `pnpm lint` = `eslint .` (`next lint` is gone in 16). Playwright uses
`executablePath: /opt/pw-browsers/chromium`; never `playwright install`.

**Layout**

```
tangram/
  app/                 layout.tsx (nav to all six routes), (today)/page.tsx, lookup/, review/,
                       read/, lists/, settings/, api/dict/*, api/ask/
  components/          ui/ (primitives), lookup/, review/, reader/, lists/, shell/
  lib/
    types.ts           Entry, Card, ListRef, HskBand, Token, AskResponse …
    dict/              load.ts (server loader), index.ts, search.ts, segment.ts, pinyin.ts, client.ts
    srs/               card.ts, day.ts, states.ts, profile.ts
    lists/             queue.ts, spine.ts
    db/                schema.ts (frozen), repository.ts (interface), dexie.ts (impl), get-db.ts
    ai/                provider.ts, fake.ts, anthropic.ts, prompts.ts, ground.ts, cache-key.ts
    reader/            sentence.ts, states.ts
    tts/               provider.ts, speech-synthesis.ts
    stores/            lookup.ts, review.ts, lists.ts, reader.ts
    dev/               seed.ts
  data/                generated: dict.json, decomp.json, ATTRIBUTION.md, COPYING-makemeahanzi (json gitignored, text committed)
  scripts/             build-data.ts
  tests/unit, tests/e2e
```

### 3.1 Data contract (Phase 0 output; frozen afterwards)

Sources — exact, verified reachable tonight:

| Source | URL | License |
|---|---|---|
| CC-CEDICT | npm `cedict-json@1.3.20251213` → `node_modules/cedict-json/cedict.json`, array of 124,188 `{traditional, simplified, pinyin:"da3 suan4", english[]}` | CC BY-SA 4.0 |
| HSK 3.0 | `https://raw.githubusercontent.com/ivankra/hsk30/master/hsk30-expanded.csv` — header `ID,Simplified,Traditional,Pinyin,POS,Level,WebNo,WebPinyin,OCR,CEDICT,Example`; `Level` ∈ {1,2,3,4,5,6,"7-9"}; skip rows with a non-empty `Example`; join via `CEDICT` column (`trad|simp[pinyin]`), fall back to `Simplified` picking the most frequent reading and logging it | MIT (Krasilnikov, Shawky, Pleco Inc. — carry the notice) |
| Frequency + POS | `https://raw.githubusercontent.com/fxsjy/jieba/master/jieba/dict.txt` — lines `word freq pos`; keep CJK-only rows | MIT |
| Decomposition | `https://raw.githubusercontent.com/skishore/makemeahanzi/master/dictionary.txt` — JSONL `{character, definition?, pinyin[], decomposition, radical, etymology?}`; also fetch `.../master/COPYING` | LGPL-3.0-or-later (dictionary.txt); graphics/SVG are Arphic PL and are **not** used |

`scripts/build-data.ts` (run with `tsx`) caches raw downloads under `TANGRAM_DATA_DIR/raw`
(default `.cache/tangram/` inside the repo, gitignored), skips existing files, exits non-zero if
any fetch fails, and prints `dict N · hsk matched/unmatched per band · freq matched · decomp N`.

Outputs:

- `data/dict.json` — `{ meta: {version, builtAt, sources[]}, entries: Entry[] }` where
  `Entry = { id, simp, trad, pinyinNum, pinyinMarked, glosses[], classifiers[], properNoun,
  isVariant, variantOf?, surname, pos?, hskBand?, freqRank?, freq? }`.
  - `id` = `trad|simp[pinyinNum]` (CC-CEDICT's natural key, identical to ivankra's `CEDICT`
    column). Unique across all entries; stable across snapshots.
  - `pinyinMarked` is mechanically derived (`lib/dict/pinyin.ts`: `u:`→`ü`, tone number →
    mark on the correct vowel, `r5`/erhua, capitalization preserved).
  - `glosses[]` has `CL:` lines stripped into `classifiers[]` (`['个']` for 打算);
    `isVariant` when every gloss is `variant of …`/`old variant of …`; `properNoun` when the
    pinyin is capitalized; `surname` when a gloss starts with `surname `.
  - `hskBand` is an integer 1–7; 7 is labelled "7–9". Within 7 the order is jieba frequency.
- `data/decomp.json` — `Record<char, {decomposition, radical, definition?}>`, kept separate
  from `dict.json` because its license differs; never merged into card snapshots.
- `data/ATTRIBUTION.md` and `data/COPYING-makemeahanzi` — committed, shown in `/settings`.

### 3.2 Dictionary service (server)

`lib/dict/load.ts`: `getDict()` memoised on `globalThis` (survives HMR), reads `data/*.json`
via `fs` from `TANGRAM_DATA_DIR` or `process.cwd()`; on missing data throws
`DictDataMissingError`; routes map it to `503 {error:'dict-data-missing', hint:'run pnpm data'}`
and the shell shows one banner. `next.config.ts` sets
`outputFileTracingIncludes: {'/api/dict/**': ['./data/**'], '/api/ask/**': ['./data/**']}`.

Indexes built once: `bySimp: Map<string, id[]>`, `byTrad`, `byPinyinToneless` and
`byPinyinToned` (sorted arrays with binary-search prefix lookup; `'`, `v`, `ü`, `u:` are
equivalent; spaces removed), and an inverted index over gloss tokens (lowercased, trivial
`-ing/-s/-ed` strip at build and query time; only real-word entries, not variants).

Routes (Phase 0 unless noted): `GET /api/dict/entries?ids=` · `GET /api/dict/hsk?band=n`
(ordered by freq) · `GET /api/dict/search?q=` (P1) · `POST /api/dict/segment` (P1).
`lib/dict/client.ts` holds typed fetchers.

**Search routing and ranking (P1).** (1) Any CJK → hanzi exact, then prefix, over both
scripts. (2) Else if `normalizePinyin(q)` fully parses into syllables → run BOTH the pinyin
index and the gloss index and return labelled groups; pinyin first when the query has tone
digits/marks, an apostrophe, or ≥2 syllables; English first when the exact query is a gloss
token of ≥3 letters (`women`, `can`). (3) Else English only. Ranking: tone-exact pinyin >
toneless > prefix; exact headword > prefix; whole-gloss match (`plan`) > inside a longer gloss
(`to plan`) > token-in-phrase; real words > variants > proper nouns; ties by HSK band asc then
freqRank asc; cap 50 with "show more". Results are grouped by headword so polyphones show
all readings.

**Segmentation (P1).** Classify runs: non-CJK (punctuation, Latin, digits, whitespace) pass
through as `{kind:'text'}` tokens, never looked up or colored. CJK runs are segmented by a
max-probability DP over the headword DAG scored by jieba frequency (jieba's algorithm
without the HMM; unknown single chars at a floor weight) — no WASM, no new dependency. Token
schema: `{ text, start, end, kind:'word'|'text', entryIds: string[] /* all readings, freq-
ordered, never truncated */, via:'entry'|'fallback' }`. Matches against whichever script the
input is in.

### 3.3 Schema v1 (`lib/db/schema.ts`, frozen after Phase 0)

Rules that make the Supabase swap a swap: every table keys on a client-generated
`id: string` (`crypto.randomUUID()`; Dexie `'id'`, never `'++id'`); every row has
`createdAt`, `updatedAt` (epoch ms) and nullable `deletedAt` (soft delete; repository `list*`
filters tombstones); FKs are UUID strings with indexes. The Dexie instance is created lazily
in a `'use client'` module (`getDb()` memoised on `globalThis`), never at import time;
`server-only` never appears under `lib/db`; importing `lib/db` under Node must not throw.

```
words        { id, entryId, snapshot: EntrySnapshot, createdAt, updatedAt, deletedAt }
             // EntrySnapshot = { simp, trad, pinyinMarked, pinyinNum, glosses[], classifiers[], hskBand?, dictVersion }
cards        { id, wordId, entryId, kind:'word'|'phrase', direction:'recognition',
               snapshot: EntrySnapshot | PhraseSnapshot, senseIndex?, note?,
               context?: { sentence?, question?, query?, offset?, length?, source:'lookup'|'ask'|'reader'|'list'|'seed', addedAt },
               fsrs: { state, due, stability, difficulty, reps, lapses, scheduled_days, learning_steps, last_review? },
               due /* ms, indexed */, createdAt, updatedAt, deletedAt }
reviews      { id, cardId, rating: 1|2|3|4, reviewedAt, before: fsrs, log: ReviewLog(ms dates), createdAt }   // index [cardId+reviewedAt]
lists        { id, name, owner:'system'|'user', kind:'hsk'|'looked-up'|'custom', band?, active, order, createdAt, updatedAt, deletedAt }
list_members { id, listId, wordId|entryId, order, createdAt, deletedAt }                                       // index [listId+entryId]
known_words  { id, entryId, createdAt }
texts        { id, title, body, createdAt, updatedAt, deletedAt }
ask_cache    { id /* = cache key */, response: ValidatedAskResponse(ids + indexes only), createdAt }
settings     { id:'singleton', newPerDay:10, spineStartBand:3, knownBand:2, dayRollover:4, script:'simp', provider:'fake', introduced: Record<dayKey, number> }
```

`lib/db/repository.ts` (interface, frozen): `addCardFromEntry(entry, context?, senseIndex?)`,
`addPhraseCard(tokens, en, context)`, `listDue(now)`, `listLearningSoon(now, horizonMs)`,
`grade(cardId, rating, now)` (writes card + review row), `newCandidates(limit)`,
`markKnown(entryIds)`, `lists()`, `listMembers(listId)`, `setListActive(id, bool)`,
`saveText`, `texts()`, `getSettings`, `setSettings`, `askCache.get/set`, `resetAll()`.

**FSRS.** `ts-fsrs` with `fsrs({ enable_short_term: false })` in v1 — every grade schedules
≥ 1 day, so a session ends cleanly and "Again" means "tomorrow". Elapsed time derives from
`last_review`/`reviewedAt`, never `elapsed_days`. Replay =
`fsrs().reschedule(createEmptyCard(), reviews.map(r => ({rating, review: new Date(r.reviewedAt)})))`;
a P2 unit test asserts it reproduces the stored card state. Keyboard 1–4 → `Rating` 1–4; the
four buttons show the interval each would schedule (from `repeat()`).

**Day.** `todayKey(now)` in `lib/srs/day.ts`: the browser's local calendar day rolling over
at local 04:00 (`settings.dayRollover`). Used by the introduced counter, the seed and the
Today counts; `due` comparisons use instants, never day keys.

**Queue (`lib/lists/queue.ts`).** `due(now)` = `state != New && due <= now`, sorted by due.
New cards are created lazily — a `words` row for every spine word, a `cards` row only when
introduced or explicitly added. Explicit Add (lookup, ask, reader) creates a card in state
New and is *always* in today's queue; the `newPerDay` cap applies only to spine auto-draw.
Auto-draw order: (1) unstarted explicit adds, (2) unstarted words in active user lists in
list order, (3) active spine bands from `settings.spineStartBand` upward, freq order within
band, skipping `isVariant`/`properNoun`. `introducedToday` = `settings.introduced[todayKey]`,
persisted. FSRS never sees lists; the queue builder does. After grading 10 new cards and
reloading, no further spine cards are offered today; an explicitly added word still appears.

**Reader/known states (`lib/srs/states.ts`, unit-tested).** No card and not known → `new`;
card in New/Learning/Relearning, or Review with `stability < 21` → `learning`; Review with
`stability ≥ 21`, or in `known_words`, or `hskBand ≤ settings.knownBand` → `known`.
"Mark known" (token panel, list action) writes `known_words` and, if a card exists, sets it
to Review with high stability and not due. `getLearnerProfile()` in `lib/srs/profile.ts`
returns `{ estimatedBand: knownBand or the highest band with ≥80% known/learning,
knownSample: string[] (≤200 simp, freq-ordered) }`; it feeds the ask request and the band badge.

### 3.4 Grounded ask (P4)

Request `POST /api/ask { query, context?, profile: {estimatedBand, knownSample[]} }` —
the profile travels with the request because it lives in the client's IndexedDB.

Provider contract (`lib/ai/provider.ts`):
- `proposePhrases(query, context) → { candidates: string[] }` (≤ 8 Chinese words/phrases).
- `answer(retrieved: Entry[], profile, query, context) → AskResponse` (schema-enforced).

Pipeline: (1) merged dictionary search on the query; for English/sentence input also
`proposePhrases`, segment each candidate, union every token's entries into the retrieved set
(cap 40). (2) `answer` receives the retrieved entries (id, simp, trad, pinyinMarked, glosses)
and returns
```
{ interpretation: string,                                   // plain prose, no CJK
  matches: [{ entryId, senseIndex, whyThisOne }],           // entryId ∈ retrieved; senseIndex in range
  sayIt:   [{ tokens: [{entryId} | {text}], en, register }],// zh + pinyin are RENDERED from cited entries
  notes:   string[] }                                       // plain prose
```
(3) Validation (`lib/ai/ground.ts`): drop matches whose id is not in the retrieved set or
whose senseIndex is out of range; render each `sayIt` phrase from its cited entries
(`polyphone: true` where the simp form has several readings, so the UI shows a hint);
`{text}` tokens display the model's string with an "AI-generated, not in dictionary" flag on
that token only; additionally segment the rendered phrase and mark any run of ≥2 consecutive
fallback single-chars, or any single-char token whose only gloss is "used in …"/"variant of",
as unverified; strip CJK runs from prose fields. Unit tests: `随看随买` and `绝绝子` render
unverified tokens; `我随便看看` does not; an injected `'bogus'` id is dropped; a fake response
carrying a wrong pinyin cannot change what is displayed (by construction).

Add from a match → word card with `senseIndex` and `note = whyThisOne`; the back shows the
chosen sense first, others collapsed. Add from a sayIt phrase → a `phrase` card whose snapshot
is the rendered tokens (each citing its entry), plus the option to add its cited words
individually. Cache key = sha1 of `(promptVersion, provider, query, context, estimatedBand)`;
cached responses hold ids and indexes only and are re-resolved against the dictionary at
render, so dictionary text is never redistributed verbatim from the cache.

`FakeProvider` implements both methods with canned data for a demo set — at minimum
"how do I say I'm just browsing" (→ 我随便看看 / 我只是看看), 看 with context `我看了一下` vs
`你看着孩子`, a pinyin query, a reader tap — and, for any other query, a deterministic
retrieval echo (interpretation from the top entry's glosses, `matches` = top 5 retrieved,
`sayIt = []`), so **no query ever renders an empty panel**. The panel shows a persistent
"Offline dictionary mode — set `ANTHROPIC_API_KEY` for AI answers" badge whenever the fake is
active. `AnthropicProvider` uses the Messages API with a forced tool call for the structured
output; the builder reads the `claude-api` skill before writing it and records the chosen
model id in `.env.example` as `TANGRAM_MODEL`. It is selected when `TANGRAM_LLM_PROVIDER=anthropic`
and a key is present.

The dictionary result renders immediately and independently; the ask panel loads into a slot
asynchronously. A slow or failing provider never blocks lookup.

### 3.5 Reader (P5)

Paste text → `texts` row → segment → tokens rendered with the state from §3.3 (`known` /
`learning` / `new`; `text` tokens untappable) → tap opens the lookup panel via
`openLookup({query: token.text, context: {sentence, offset, length}})` where sentence = the
maximal run around the token bounded by `。！？；…\n` and ASCII `.!?`, trimmed, ≤200 chars.
"Add" creates a card whose `context` is that sentence; the review back highlights the target.
"Mark known" recolours the token immediately. "Extend" (tap the next token to look up the
concatenated span, exact match) only if the phase runs on time.

### 3.6 TTS and PWA (P6)

`TTSProvider` interface; `SpeechSynthesisProvider.available()` resolves after `voiceschanged`
(500 ms timeout) and the button renders disabled with a tooltip when no `zh*` voice exists;
e2e asserts presence/disabled state only. PWA = hand-written `public/sw.js` (cache-first for
`/_next/static/**` and the shell, network-only for `/api/**`) registered from a client
component; no PWA dependency. **Neither can be verified in this container.**

## 4. Phases

Every phase ends with: `pnpm lint`, `pnpm test`, `pnpm build`, the phase's e2e specs green;
an adversarial review panel (three lenses — correctness, data integrity, and UX-as-Kirby-
would-use-it with screenshots from the e2e specs) whose confirmed findings are fixed before
the phase commits; a commit on `main`; the parking push (or the real push once the repo exists).

### Phase 0 — Scaffold, data, shared surface
Two builders in the same tree on disjoint paths after a short serial scaffold.

*Scaffold (serial):* `create-next-app`-equivalent Next 16 app; full dependency list from §3
installed; `package.json` scripts `dev · build (= data:ensure && next build) · start · lint ·
test · e2e · data · data:ensure`; `engines.node`, `.nvmrc`, `.gitignore` (`node_modules`,
`.next`, `data/*.json`, `.cache/`, `.env*.local`, `test-results`, `playwright-report` — NOT
`data/ATTRIBUTION.md`/`data/COPYING-*`), `.env.example` (`ANTHROPIC_API_KEY=`,
`TANGRAM_LLM_PROVIDER=fake`, `TANGRAM_MODEL=`, `TANGRAM_DATA_DIR=`), `vitest.config.ts`
(jsdom, `tests/unit/setup.ts` importing `fake-indexeddb/auto` and jest-dom), Tailwind 4,
eslint config, `playwright.config.ts` (`webServer: pnpm build && pnpm start -p $PORT`,
`PORT` from env, default 3000; Chromium at `/opt/pw-browsers/chromium`; `reuseExistingServer`),
`README.md`, `CLAUDE.md` (commands, the frozen-file rule, `pnpm data`, the license boundary,
the schema-change-stops-the-build rule).

*Builder A — data + dictionary service:* `scripts/build-data.ts` per §3.1; `lib/dict/pinyin.ts`
(numbered↔marked, normalization; unit-tested on `u:`, `ü`, `v`, tone digits, marks, neutral
tone, apostrophes, capitals); `lib/dict/load.ts`, `index.ts` (indexes), `client.ts`;
`/api/dict/entries`, `/api/dict/hsk`; `data/ATTRIBUTION.md`.
*Builder B — app shell + db + harness:* `lib/types.ts`; `lib/db/schema.ts`, `repository.ts`,
`dexie.ts`, `get-db.ts` with working CRUD; `lib/srs/card.ts` (`newCard`), `day.ts`, `states.ts`,
`profile.ts`; typed stub `lib/lists/queue.ts`; `app/layout.tsx` with nav to all six routes
(unbuilt routes render a one-line "coming in Phase N" page), `app/(today)/page.tsx` placeholder
(explicitly no `app/page.tsx`), `app/settings/page.tsx` stub with a Licenses section reading
`data/ATTRIBUTION.md`; `components/ui/*` primitives; `lib/stores/*` pre-created;
`components/lookup/lookup-panel.tsx` shell with `<LookupPanel query context? slots={{ask?}}>`
and `openLookup()` store action; `tests/e2e/smoke.spec.ts` visiting all six routes.

*Acceptance (all executable):* `pnpm data` prints counts and every one of the 7 bands has >0
joined words; `tests/unit/data.test.ts` asserts 打算 has `pinyinNum 'da3 suan4'`,
`pinyinMarked 'dǎsuàn'`, `hskBand 2`, positive `freqRank`, `classifiers ['个']`, no `CL:` gloss,
and `decomp['打']` exists; ids are unique; the two 绿 entries have distinct ids and only `lu:4`
carries band 2; a unit test imports every runtime dependency; a unit test creates a card
through the repository under fake-indexeddb; `import 'lib/db'` under Node does not throw;
`curl /api/dict/hsk?band=1` returns >0 entries; renaming `data/` yields the 503, not a crash;
smoke e2e passes; `pnpm build` passes.

*Frozen after Phase 0:* `package.json`, `pnpm-lock.yaml`, `lib/db/schema.ts`,
`lib/db/repository.ts`, `lib/types.ts`, `app/layout.tsx`, `components/ui/**`,
`app/globals.css`, `components/lookup/lookup-panel.tsx`, `next.config.ts`, configs. A builder
that needs a change to a frozen file **stops, writes the need into `HANDOFF.md`, and continues
without it**; the orchestrator applies it on `main` and merges forward.

### Phases 1–3 — parallel worktrees (2 at a time)

Worktree procedure: `git worktree add ../tangram-p1 -b p1 main && cd ../tangram-p1 && pnpm
install --offline --frozen-lockfile && pnpm data` (raw downloads are cached, so this is
seconds); ports 3001/3002/3003. Merge: orchestrator merges `p1`, `p2`, `p3` into `main` with
`--no-ff`; a conflict outside the owning paths is a rule violation resolved by taking `main`'s
frozen file; then `pnpm install --frozen-lockfile && pnpm data:ensure && pnpm test && pnpm e2e`
on the merge commit; then the post-merge integration spec: *look up 打算 → Add → Today shows 1
new → /review shows 打算 → grade 3 → a `reviews` row exists → nav reaches every route*.

| Phase | Owns | Acceptance (each route line is a spec under `tests/e2e/<phase>/`) |
|---|---|---|
| **P1 Dictionary + lookup** | `lib/dict/search.ts`, `segment.ts`, `app/api/dict/search`, `app/api/dict/segment`, `app/lookup/**`, `components/lookup/**` (except the frozen panel shell), `lib/stores/lookup.ts` | 打算 is the first result for `dasuan`, `da3suan4`, `dǎsuàn`; top 3 for `plan`; appears for prefix `dasu`; `long` returns both 龙 and 长; `sun` → 孙 and 太阳; `he` → 他 and 和; `women` → 女人 in top results; trad input works; results show HSK band and readings grouped; 了 shows both `le` and `liǎo`; Add on a polyphone requires choosing a reading; Add creates a card with `context.query`. Segment: `我打算明天去北京` → 我/打算/明天/去/北京; `他有意见` → 他/有/意见; `研究生命的起源` → 研究/生命/的/起源; `他把手表给我了` contains 把/手表; `我想了一下` yields 了 with two entry ids; `你好吗？` yields a `text` token for `？` that is not looked up. |
| **P2 Cards + review** | `lib/srs/**` (except frozen stubs' signatures), `app/review/**`, `components/review/**`, `lib/stores/review.ts`, `lib/db/dexie.ts` internals | `/review` walks `due(now)` with keyboard 1–4; buttons show intervals; grades persist and reschedule via FSRS; grade a card, reload: the next card is shown and the graded one is not; a `reviews` row per grade; replay test reproduces card state; a card with `context` shows the sentence on its back with the target highlighted; empty state says when the next card is due. |
| **P3 Lists + queue + Today** | `lib/lists/**`, `app/lists/**`, `app/(today)/**`, `app/settings/**`, `components/lists/**`, `lib/stores/lists.ts`, `lib/dev/seed.ts` | Seven HSK system lists + "Looked up" appear; custom list create/add works; `setListActive`; Today = due + `newPerDay − introducedToday` per §3.3; set N=3 in /settings → Today shows 3 new; grade 10 new, reload: no further spine cards today; "Mark HSK 1–3 known" → today's new cards come from band 4; `loadDemo()` and `resetAll()` on /settings and via `?seed=demo`: marks HSK 1–2 known, creates ~8 cards with `context` from each source, replays backdated reviews so ≥3 are due and ≥2 learning, stores one sample paragraph in `texts`, pre-warms `ask_cache` with the fake's demo answers; after `loadDemo()` Today shows 3 due and N new and /review offers a card with a context sentence. |

### Phases 4–5 — parallel worktrees

| Phase | Owns | Acceptance |
|---|---|---|
| **P4 Grounded ask** | `lib/ai/**`, `app/api/ask/**`, `components/lookup/ask-panel.tsx` (new; fills the panel's `ask` slot), `tests/unit/ai/**` | Per §3.4: the demo query renders ≥1 surviving match and ≥1 sayIt after validation; grounding unit tests; Add from a match → card whose back shows the chosen sense first; Add from a sayIt → phrase card; offline badge shows when the fake is active; `AnthropicProvider` compiles, is selected by env, and passes a unit test against a mocked HTTP layer; cache hit on repeat query with same context, miss when context differs. |
| **P5 Reader** | `lib/reader/**`, `app/read/**`, `components/reader/**`, `lib/stores/reader.ts`, `tests/unit/reader/**` | Paste a paragraph → tokens colored; with `knownBand=2`, HSK 1–2 tokens render `known`; tap opens the panel with the sentence as context; Add yields a card whose review back shows that sentence with the target highlighted; Mark known recolours immediately; the pasted text survives navigation (store + `texts`). |

Neither P4 nor P5 edits `package.json`, `lib/db/**`, or the frozen panel shell.

### Phase 6 — stretch, in order; each stops at the cut line
1. **i+1 sentences** on the card back: generate, then *filter* every token against the known
   set (the prompt asks, the filter enforces). 2. **Free-recall grading**: type the meaning;
   the provider suggests a 1–4 grade the user can override; never auto-submits. 3. **TTS**
   button (§3.6). 4. **PWA** shell caching (§3.6). 5. Full-loop e2e: look up → add → review →
   read → add-from-text → ask → add phrase.

**Not in v1, on purpose:** camera/OCR; tone scoring (v1.x: a pitch-contour *overlay* with no
judgment; scoring is a bought API — Azure pronunciation assessment or iFlytek); confusion-pair
detection (needs weeks of review data); compounding mnemonics; listening direction; Supabase
sync; multi-user; textbook lists; Wiktionary/MoeDict tabs (registry-ready, data deferred).

## 5. Dictionaries — what Pleco has, what you can get, and how licensing works

**Pleco's edge is licensed, not built.** Its good dictionaries are commercial titles:

| Dictionary | Owner | Path |
|---|---|---|
| ABC Chinese–English (DeFrancis) | Wenlin Institute / Univ. of Hawaii Press | Commercial license, negotiated; expect real money and months |
| 现代汉语规范词典 (Guifan) | FLTRP + 语文出版社 (Pleco licenses via FLTRP) | Commercial, via publisher |
| Oxford Chinese | OUP | Commercial |
| Tuttle Learner's | Tuttle | Commercial |
| 现代汉语词典 | Commercial Press | Licensed to no one, Pleco included; Guifan is the nearest Pleco has |

None of that is a weekend, and none of it is where the wedge is. What *is* available:

| Source | License | Use and limits |
|---|---|---|
| **CC-CEDICT** (via `cedict-json`) | CC BY-SA 4.0 | Base bilingual dictionary. Kept in its own file, unedited except mechanical derivations (marked pinyin), with a modification notice and attribution in `data/ATTRIBUTION.md` and on `/settings`. AI prose is the model's own expression around attributed entries, not a copy of the dictionary; caches hold ids, not gloss text. |
| **HSK 3.0 word list** | Standard GF0025-2021 issued by the MoE + State Language Commission (2021). Extraction: ivankra/hsk30, MIT incl. Pleco Inc. notice — carried in the licenses panel | Spine. ⏳ CLEC issued a revised exam syllabus in Nov 2025 with fewer words at levels 1–5; "HSK 3.0" is now ambiguous — swap the data when you care. |
| **jieba `dict.txt`** | MIT | Frequencies, POS, and the segmentation weights. Commercially safe, unlike SUBTLEX-CH / BCC (research-only). |
| **Make Me a Hanzi** | `dictionary.txt`: LGPL-3.0-or-later (COPYING; derived from Unihan + CJKlib). `graphics.txt`/SVGs: Arphic Public License | v1 uses only decomposition, in its own `data/decomp.json` with COPYING alongside; stroke order later, with APL text shipped. |
| **Wiktionary** (Chinese entries via kaikki.org) | CC BY-SA 4.0 + GFDL 1.1+ | The real upgrade: sense-split definitions, etymology, usage notes, examples. One-way compatible with CC-CEDICT's BY-SA 4.0. **Deferred** — blocked from this container. |
| **MoeDict** — 重編國語辭典修訂本 via g0v/moedict-data | CC BY-ND 3.0 TW (MoE allows format conversion; text must display unedited). Do not ingest 兩岸詞典 (BY-NC-ND) | Monolingual, Traditional-centric; display-only tab; `derivatives:'verbatim-only'` so it never enters a prompt. Deferred. |
| **Unihan** | Unicode License | Per-character readings, variants, radical/stroke. Deferred. |
| **Tatoeba** | CC BY 2.0 FR | Example sentences, attribute per sentence. Deferred (blocked). |
| **Chinese Grammar Wiki** | CC BY-NC-SA 3.0 | Non-commercial means no revenue of any kind, ads included; SA would bind model output using it as context. Not ingested; link out if ever wanted. |

**Design consequence.** "Multiple dictionaries" is a registry: `DictionarySource` declares
`id, license, attribution, derivatives: 'allowed' | 'verbatim-only', lookup()`; results group
by source; `/api/ask` retrieves only from `derivatives:'allowed'` sources; `verbatim-only`
sources render in their own tab and never enter a model prompt, an i+1 generator, or a grading
prompt. v1 ships CC-CEDICT; the rest are drop-ins; a commercial title is one more entry (with
server-side, un-cached content) when there are users worth negotiating for.

**The wedge, restated.** A mediocre dictionary plus context beats an excellent dictionary
without it. Nobody switches off Pleco for a better ABC; they switch for "answer the question
I actually have about this word in this sentence."

## 6. ⏳ Decisions deferred to the morning (build proceeds on the defaults)

1. **Codename** — default *Tangram*. Alternates: *Inkstone* (砚), *Lantern*.
2. **Repo** — create `kjswalls/tangram` (empty, private), grant the Claude GitHub App access;
   the standalone history is pushed there as `main`; then delete the parking branch on anchor.
   Vercel: new project on the new repo; `data/` is generated at build (`pnpm build`).
3. **Persistence** — local-first IndexedDB, single user. Supabase later; §3.3 is the seam.
4. **Model + key** — `AnthropicProvider` has never made a live call from here. Set
   `ANTHROPIC_API_KEY` and `TANGRAM_LLM_PROVIDER=anthropic` in `/home/user/tangram/.env.local`
   (or the repo's `.env.local` on your machine). `TANGRAM_MODEL` default is in `.env.example`.
5. **Spine start band** — default 3; `knownBand` default 2. Both in `/settings`.
6. **HSK data vintage** — 2021 standard list; swap for the Nov 2025 syllabus if you want.
7. **Wiktionary / MoeDict** — download on your machine and drop into `data/`; registry-ready.
8. **Simplified vs traditional** — simplified primary with trad shown; setting exists.
9. **Orchestrator model** — this session cannot switch its own model; builders and reviewers
   were run on Opus as asked.

## 7. Review log

Confirmed and folded in (20 findings + 8 gaps): HSK source and band model; executable Phase 0
acceptance; four-file data contract and license boundary; Make Me a Hanzi is LGPL; Phase 0 now
owns every shared surface so P1–3 are genuinely disjoint, with a frozen-file rule and a
post-merge integration spec; merged pinyin/English search routing with ranking; stable entry
ids; Schema v1 with UUIDs, soft deletes, FSRS replay, lazy Dexie; per-token grounding with
senseIndex and phrase cards; classifier/variant/proper-noun fields; full dependency list;
polyphones never truncated; DP segmentation with `text` tokens; queue semantics under ts-fsrs
with a persisted daily counter and `enable_short_term:false`; spine start band, known words,
learner profile, reader states; provenance in the card shape and a "Looked up" list; P4/P5
ownership; a FakeProvider that never renders an empty panel; ask cache keyed on context and
prompt version; profile travels with the request; attribution surfaces; Playwright from Phase
0; worktree procedure and caching; a dictionary loader with 503 on missing data; the demo
seed; a defined day boundary. Accepted without verification (verifier blocked by a
classifier): no `prebuild` under pnpm 10; pinyin derivation from `u:` input; the ask request
carrying the profile; the cache key; provider mechanism; phrase cards; lookup independent of
ask; the attribution notice. Refuted: Vercel tracing (kept anyway, it is one line); reader
text loss (the store keeps it; `texts` kept for the seed). **Unreviewed:** Phase 6 — all
three of its finders were blocked; it is stretch and stays stretch.
