# HANDOFF-prep — the shared seams for Phase 6 items 1 and 2

Written by the orchestrator on `main` **before** builders A, B and C start, so that
everything the three of them share exists, compiles and is tested on the commit their
worktrees branch from. Nothing here is a feature: every addition is a seam, a slot or a
setting. The features (the `/api/examples` route and the i+1 filter, the recall box and
the grading call, the per-token phrase front) are the builders' work.

`HANDOFF.md` stays append-only and is untouched by this file; fold this section into it
at the merge.

---

## Frozen for the builders after me

These files are **frozen**. A builder that needs one changed stops, writes the need into
`HANDOFF.md`, and continues without it — the orchestrator applies it on `main` and merges
forward (CLAUDE.md, "Frozen files").

```
package.json                      pnpm-lock.yaml
lib/ai/provider.ts                lib/ai/fake.ts
lib/ai/anthropic.ts               lib/ai/cache-key.ts
lib/ai/ground.ts                  components/review/review-card.tsx
lib/types.ts                      app/layout.tsx
components/ui/**                  app/globals.css
vitest.config.ts                  playwright.config.ts
eslint.config.mjs                 tsconfig.json
```

**Add no dependency.** `package.json` and `pnpm-lock.yaml` are unchanged by this commit
and must stay that way; everything the three phases need is already installed.

Not frozen, and deliberately so: `lib/ai/prompts.ts` (the wording of a prompt is the
builder's to tune, and it is imported by the frozen `anthropic.ts` rather than the other
way round), `lib/db/schema.ts` beyond the two fields below, `components/review/phrase-face.tsx`
(created here as a stub **for** builder C), `app/settings/settings-form.tsx`.

---

## 1. `lib/ai/provider.ts` — two more methods on `LLMProvider`

```ts
exampleSentences(
  entry: Entry,
  profile: LearnerProfile,
  senseIndex?: number,
  support?: readonly Entry[],
): Promise<{ sentences: { tokens: ({ entryId: string } | { text: string })[]; en: string }[] }>;

gradeRecall(
  entry: Entry,
  answer: string,
  senseIndex?: number,
): Promise<{ suggested: 1 | 2 | 3 | 4; why: string }>;
```

Zod schemas beside the existing ones: `exampleSentenceSchema`, `exampleSentencesSchema`,
`recallGradeSchema`, `gradeRecallSchema`; plus `MAX_EXAMPLE_SENTENCES` (4) and
`RECALL_GRADES` / `RecallGrade`.

- **Same citation discipline as `sayIt`.** A sentence is a list of `{entryId}` tokens in
  spoken order; the model never writes display hanzi or pinyin, and `lib/ai/ground.ts`
  renders both from the dictionary rows behind the cited ids. `renderPhrase` takes
  `{tokens, en, register}` — a sentence has no `register`, so pass `register: ''` (or
  destructure) when you reuse it; nothing else in `ground.ts` needed changing, and it is
  frozen.
- **`why` is plain prose, no CJK**, exactly like `interpretation` and `notes`. It is not
  scrubbed for you: run it through `scrubProse` (`lib/ai/ground.ts`) on the way to the
  screen, as the ask panel does — that is the only place `stripCjk` + `stripPinyin` live.
- **The fourth argument is why the fake can cite anything at all.** `support` is the pool
  the sentence may be built from — the learner's known words, or whatever the caller
  retrieved. A provider given none can still cite the target entry. It is last and
  optional so `exampleSentences(entry, profile)` remains a legal call; the plan's own
  wording for item 1 is "the prompt asks, the filter enforces", and `support` is what the
  prompt asks over. **The filter is still yours to write** — nothing in this commit drops
  a sentence whose token is outside the known set.
- `RecallGrade` is the same 1–4 vocabulary as `StoredRating` in `lib/db/schema.ts`, by
  value rather than by type: `provider.ts` may not import the database layer.

## 2. `lib/ai/fake.ts` — both implemented, deterministically, never empty

- `exampleEcho(entry, profile, support)` cites the target plus the best of `support`, one
  pairing per sentence, up to `EXAMPLE_SENTENCE_COUNT` (3). Ordering is
  known-words-first (`profile.knownSample`), then jieba `freqRank`, then id — so it is
  deterministic whatever order the caller passes. Proper nouns, variants and surnames are
  skipped. With **no** support it returns one single-token sentence rather than nothing:
  §3.4's "no query ever renders an empty panel" applied to a card back.
- It does not pretend to compose Chinese, and its `en` says so. Two rules it keeps that
  the ask layer learned the hard way: the prose quotes **no gloss text** (a caller writes
  it into `ask_cache`, which holds ids, not dictionary text — CLAUDE.md §"Data and
  licences") and contains **no hanzi**.
- `recallEcho(entry, answer, senseIndex)` is token overlap against the entry's glosses,
  stemmed and stopworded (`recallWords`), scored on the **best single gloss** — an entry
  with eight senses is not eight things the learner failed to say. 0 → 1, under a third →
  2, under two thirds → 3, else 4; an empty answer is a blank (1), not a wrong answer.
  `why` counts words, never quotes them, and is ASCII by construction.

## 3. `lib/ai/anthropic.ts` — both wired the way the existing two are

Forced tool call, input schema derived from the zod schema, same model, same
`REQUEST_TIMEOUT_MS`, same `asProviderError` mapping, refusal → `ProviderError`. The
shared `call()` / `toolInputOrThrow()` / `parse()` helpers were extracted from `answer`
so the four methods cannot drift; `answer`'s behaviour and its error strings are
unchanged. Written after loading the `claude-api` skill: model id stays `claude-opus-5`
(no date suffix), `thinking` left unset so Opus 5 runs adaptive, no assistant prefill,
timeout in milliseconds. **It has still never made a live call from this container** —
every test injects `fetch`.

New in `lib/ai/prompts.ts`: `EXAMPLES_TOOL_NAME`, `RECALL_TOOL_NAME`,
`EXAMPLES_SYSTEM_PROMPT`, `RECALL_SYSTEM_PROMPT`, `examplesUserPrompt`, `recallUserPrompt`,
`examplesTool`, `recallTool` — every schema derivation inside a function, per that file's
temporal-dead-zone rule. The learner's typed answer travels fenced between `<<<` and
`>>>` and the prompt says to treat it as data, not as an instruction.

`zodToJsonSchema` gained three honest cases: a literal now emits its **value**
(`{type, enum:[value]}`) instead of only its type, a union of same-typed literals collapses
to one `enum` (so `suggested` reaches the model as `enum:[1,2,3,4]`), and a number's `max`
check emits `maximum`. Object unions — the `{entryId} | {text}` token — are unchanged.

## 4. `lib/ai/cache-key.ts` — three key spaces, one `ask_cache` table

`EXAMPLES_PROMPT_VERSION`, `RECALL_PROMPT_VERSION`, and
`examplesCacheKey({entryId, senseIndex?, estimatedBand, provider?, promptVersion?})` /
`recallCacheKey({entryId, senseIndex?, answer, provider?, promptVersion?})`, with their
payload builders exported for pinning.

- **The two new payloads are tagged (`'examples'`, `'recall'`) and are six elements long**,
  so they can never equal the ask payload's five. That is the collision argument, not the
  improbability of a sha1 clash.
- **The ask payload is deliberately left untagged.** It is already written into every warm
  row the demo seed ships and into any learner's database; tagging it now would orphan all
  of them.
- A recall key folds case and runs of whitespace in the answer — those are not what a
  learner meant — but nothing else.
- The module still imports no dictionary and no provider (only a *type* from `provider.ts`,
  erased at build): it runs in the browser.

## 5. `components/review/review-card.tsx` — two slots, and the phrase front

- `recall?: ReactNode` on the **front**, under the hanzi. It is wrapped in a div that
  stops click and keydown propagation: the front is a button that reveals on Enter or
  Space, and without this a keystroke into the answer box would flip the card it is about.
  It stays mounted after the flip, so the suggested grade can be read beside what was typed.
- `examples?: ReactNode` on the **back**, under the glosses and the "other senses" fold,
  above the classifiers.
- Both default to `null`, so `ReviewSession` renders exactly the card that shipped in
  Phase 2 until someone passes them. Testids: `card-recall`, `card-examples`.
- A phrase card's front is now `<PhraseFace card={card} />` from the **new**
  `components/review/phrase-face.tsx`. It is a stub: it renders `snapshot.simp` in the
  same `<h2 class="hanzi text-6xl …">` the card used, so nothing on screen moved.
  **Builder C fills it in** with per-token markup — that is the fix for "the review card
  still renders `snapshot.simp` rather than per-token markup" (HANDOFF.md, Phases 4–5
  review fixes, *Not done, and why*), and it lands without touching the frozen card.

## 6. `lib/db/schema.ts` — two settings, and no Dexie bump

```ts
examplesOnBack?: boolean;   // DEFAULT_SETTINGS: true
freeRecall?: boolean;       // DEFAULT_SETTINGS: false
```

**No Dexie version bump is needed, and that is confirmed rather than assumed.**
`STORES_V1.settings` is `'id'` — the store indexes its key and nothing else — and
IndexedDB does not police the shape of an unindexed field, so a new property on the
settings row needs no schema version. `DB_VERSION` stays 1. A unit case pins both facts
(`tests/unit/settings/card-toggles.test.tsx`).

Both fields are **optional on the interface**, and that is load-bearing: `getSettings`
returns the stored row as it stands (`lib/db/dexie.ts`), so a row written before this
commit carries neither key. Read them as `settings.examplesOnBack ?? true` /
`settings.freeRecall ?? false` — `undefined` means "not decided", never "off". A case
covers the legacy row.

## 7. `app/settings` — both toggles, in the existing form

Two checkboxes in their own "On a card" block under the number/select grid, written
through immediately like every other control there (no Save button). Testids:
`settings-examples-on-back`, `settings-free-recall`.

---

## One repair that was not on the list

`tests/unit/lists/today.test.ts:123` ("starts again after the study day rolls over") was
**red on a clean tree before any of this** — it went red on 2026-09-08 with no source
change. The repository stamps `createdAt` from the wall clock while `buildQueue` compares
that stamp against the *injected* `now` (`createdToday`, the backstop for a path that
forgot to charge the counter), so the fixture only held while the real date was still
behind its `NOW` of 2026-09-07. The test now backdates the cards it introduced to `NOW`,
which is what the scenario says happened, and it is time-independent from here. Production
is unaffected: there, `now` *is* the wall clock. No source file changed.

---

## Gates on this commit

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | pass |
| `pnpm lint` | pass, no warnings |
| `pnpm test` | pass — **478** in 48 files (451 before: +27, and the day-rollover repair) |
| `pnpm build` | pass (Turbopack) |
| `PORT=3000 pnpm e2e` | pass — **78/78** |

No server is left running; port 3000 is free. `/home/user/v0-anchor` was not touched.
`package.json` and `pnpm-lock.yaml` are unchanged.
