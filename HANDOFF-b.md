# HANDOFF-b — free-recall grading (PLAN.md §4, Phase 6 item 2)

Builder B, on branch `b`, off `b419205` (the prep commit). Fold this into
`HANDOFF.md` at the merge; `HANDOFF.md` itself is untouched here, as briefed.

**The feature in one line:** type what you think the word means, and the app
suggests a grade you can always override.

---

## What is on the branch

| File | |
|---|---|
| `lib/ai/recall.ts` | **new.** The client-safe half: the 1–4 vocabulary by value, `requestRecallGrade` (the `/api/recall` call, which never throws), and the `recallReducer` state machine. |
| `app/api/recall/route.ts` | **new.** `POST {entryId, senseIndex?, answer} → {suggested, why, provider}`; 400 / 404 / 502 / 503 as below. |
| `components/review/recall-input.tsx` | **new.** The box that goes in the card's `recall` slot. |
| `components/review/review-session.tsx` | **modified** (5 lines of state, the slot, one prop). Not frozen, but **builder A will also be editing it** for the examples slot — see "What the merge must know". |
| `components/review/grade-bar.tsx` | **modified.** One optional prop, `suggested?: StoredRating \| null`, which rings a button and sets `data-suggested="true"`. It cannot press it. |
| `tests/unit/ai/recall*.{ts,tsx}` | **new**, 45 cases in 4 files. |
| `tests/e2e/b/recall.spec.ts` | **new**, 3 specs. |

Nothing frozen was touched: `lib/ai/{provider,fake,anthropic,cache-key,ground}.ts`,
`components/review/review-card.tsx`, `lib/db/schema.ts`, `app/settings/**`,
`package.json` and `pnpm-lock.yaml` are all as prep left them. No dependency added.

## The rule, and where it is enforced

*Nothing is ever auto-submitted*, and it is built so a race cannot break it:

1. **The suggestion has no path to a grade.** `RecallState` has no field a
   rating could be read out of, `recallReducer` returns nothing but a state, and
   `RecallInput` takes no grading callback and touches no store. `grade()` is
   still reached from exactly two places — a 1–4 key press and a `GradeBar`
   click. A unit case pins the shape of the state so that adding a `rating`
   field to it fails the suite.
2. **A late suggestion is a stale suggestion.** Every submit carries a
   `requestId` *and* the `cardId`; `settled` for either mismatch is the identity
   function. Above that, `ReviewSession` files the suggestion under the card id
   it was about and only shows it against that card, so a suggestion landing
   after the queue moved on cannot ring a button on the next word.
3. **The flip never waits.** `onReveal()` runs in the same turn as the submit,
   before the request starts. Provider failure, timeout, empty answer, no
   network: the card flips, four buttons are live, and the worst case on screen
   is one muted line, `No suggestion this time — grade it yourself.`
4. **A flipped card cannot be "recalled".** If the learner reveals the card
   another way (Space, the button, a click), the box closes and says so. A
   suggested 4 typed off the back of the card is the one grade this feature must
   never help anyone give themselves.

## The route

- `400` — no `entryId`, no (or blank) `answer`, or an answer over 400 chars. The
  client never sends a blank one (an empty box asks nobody, and that is unit
  tested at three levels), so a blank here is a caller bug worth naming.
  An out-of-range or non-integer `senseIndex` is **dropped**, not rejected:
  judging the answer against every gloss is the honest fallback.
- `404 unknown-entry` — the id is not in this dictionary build.
- `503 dict-data-missing` — same body every dictionary route gives.
- `502 provider-failed` / `provider-invalid` — the provider threw, hung past
  `RECALL_TIMEOUT_MS` (15 s, `TANGRAM_RECALL_TIMEOUT_MS` overrides), or returned
  something `gradeRecallSchema` rejects. A 7 never reaches a button.
- `why` is run through `scrubProse` (`lib/ai/ground.ts` — reused, not
  reimplemented) and flattened to one ≤320-char line. The client scrubs the
  same field a second time on the way in; the promise being kept is about what a
  learner is *shown*, not about what one route returns.

`gradeRecallWith(provider, entry, answer, senseIndex?)` is exported so the tests
can hand the route a provider that throws, hangs, or answers with hanzi in the
prose — the three things it exists to absorb. No live model call was made from
this container, and the route reaches Anthropic only through `selectProvider()`,
which needs both `TANGRAM_LLM_PROVIDER=anthropic` and a key.

## Deliberate deviations

- **No cache.** `recallCacheKey` / `RECALL_PROMPT_VERSION` (prep, §4) are left
  unused on purpose, and the reason is licence-shaped rather than performance-
  shaped: a recall row's payload would be the model's `why`, and a live model
  asked "why is this answer worth a 3" will quote the gloss it is comparing
  against. `ask_cache` is documented as holding ids and sense indexes and no
  dictionary text (CLAUDE.md, "Data and licences"), and I would rather leave a
  key builder unused than be the commit that puts gloss prose in that table.
  The hit rate argues the same way: a key folds in the exact answer text, so a
  hit needs the learner to retype the same sentence for the same card. If the
  merge wants caching, cache `suggested` and drop `why`, or tag the row so the
  licence claim stays true.
- **`GradeBar` gained a prop.** The brief says the suggested button is
  highlighted, which cannot be done from inside the slot. It is additive and
  defaults to `null`, so every existing caller renders the bar that shipped.
- **`withTimeout` is duplicated.** `/api/ask` keeps a private copy; lifting them
  both into `lib/ai` means editing that route, which is not mine this week. Ten
  lines, flagged here for the merge.
- **The box is offered on word cards only.** A phrase card has `entryId: null`
  (`addPhraseCard`, `lib/db/dexie.ts`) and its meaning is the English on its
  back, so there is nothing to grade an answer against. Builder C owns the
  phrase front; if phrase recall is ever wanted it wants a different route.

## What the merge must know

1. **`components/review/review-session.tsx` will conflict with builder A.** My
   change is four hunks, all additive: a `useState` for the suggestion plus its
   `useCallback`, the `freeRecall` / `suggested` derivations under `const card`,
   a `recall={…}` prop on `<ReviewCard>`, and `suggested={suggested}` on
   `<GradeBar>`. A's examples slot is the same file and the same component.
   Take both; nothing here and nothing there shares a line except the
   `<ReviewCard …>` call itself.
2. **The `RecallInput` is keyed on `card.id`** at the call site. It is also
   correct without the key (staleness is derived from the `cardId` in the
   reducer state, not from an effect) — but keep the key: it is what aborts the
   previous card's request rather than leaving it to settle unread.
3. **Testids added:** `recall`, `recall-answer`, `recall-submit`,
   `recall-thinking`, `recall-suggestion` (`data-suggested="1|2|3|4"`),
   `recall-why`, `recall-no-suggestion`, `recall-missed`; and
   `data-suggested="true"` on one `grade-N` button.
4. **`tests/unit/ai/recall-input.test.tsx` and `recall-session.test.tsx` are
   component tests living under `tests/unit/ai/`** rather than a `review/`
   directory, because `tests/unit/ai/recall*` is this builder's owned path and
   `tests/unit/srs/` is shared. Move them at the merge if that reads better.
5. **`vitest` is flaky under three builders on four CPUs.** Twelve *unrelated*
   dictionary-loading files (dict, lists, ai/route, …) time out at vitest's
   5 s default the first time a worker parses `data/dict.json` while the box is
   busy — reproduced on files this branch never touched, and gone at
   `--maxWorkers=2` or with the other builders idle. Nothing was changed for it
   (`vitest.config.ts` is frozen); if it bites the merge, a `testTimeout` bump
   there is the fix.

## Gates on this branch

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | pass |
| `pnpm lint` | pass, no warnings |
| `pnpm test` | pass — **523** in 52 files (478 before: **+45**) |
| `pnpm build` | pass (Turbopack); `/api/recall` in the route table |
| `PORT=3002 pnpm e2e` | pass — **81/81** (78 before: +3) |

No server left running; port 3002 free. `/home/user/v0-anchor` untouched.
Nothing pushed.
