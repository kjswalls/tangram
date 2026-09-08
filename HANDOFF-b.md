# HANDOFF — builder B, the production direction (meaning → hanzi)

Phase 8, branch `b`, cut from `a8fe928`. Read the first section before merging;
the rest is what the feature is and where it stops.

---

## 1. For the merge: what I touched outside my own files

**`lib/lists/queue.ts`: NOTHING. Not one character.** Builder A owns it this
phase and the two of us do not collide there. That is not an accident — the
production direction needed no queue change because a production card is an
ordinary `cards` row:

- it is offered because `buildQueue` offers every live card, whatever its
  `direction`;
- it is *capped* at creation rather than at offer time, which is where the cap
  already lives (`drawLimit`), so the only thing I do with `queue.ts` is **read**
  `buildQueue({ now, cards, settings }).drawLimit` from `lib/srs/direction.ts`.
  If A changes that field's name or the shape of `QueueInput`, one call site in
  `addProductionTwins` follows it.

Files I edited that somebody else may also have edited:

| File | The whole of my change |
|---|---|
| `lib/stores/review.ts` | one import, and `queue: spaceDirections(summary.queue.cards)` in `load()`. Nothing else. A word's two directions are never adjacent in the queue — the answer to the second would be sitting on the back of the first. |
| `app/(today)/today-view.tsx` | one import, `const split = countByDirection(...)`, and one `<p data-testid="today-direction-split">` between the counts and the Start-review row. No existing element changed. |
| `components/review/review-card.tsx` | added a `data-direction` attribute and an optional `actions` slot (defaults to `null`, rendered on the back above the note). Both additive; a caller that knows neither renders the card that shipped in Phase 2. |
| `components/review/recall-input.tsx` | two new optional props, `label` and `placeholder`, whose defaults are the strings that were hard-coded. No behaviour changed — this is what let the production card *reuse* the box instead of forking it. |
| `components/review/review-session.tsx` | the `card.direction === 'production'` branch (`ProductionCard` instead of `ReviewCard`), the production grader wired into `RecallInput`, and `AddReverse` in the new `actions` slot. |
| `components/lists/list-detail.tsx` | mounts `<ProductionListToggle>` above the "Add a word" card; and `cardByEntry` now folds with `preferRecognition` instead of last-write-wins. |
| `lib/stores/lists.ts` | the same `preferRecognition` fold, three lines. |

The `preferRecognition` change matters more than it looks: a word can now have
two cards, and both of those maps were `for (…) map.set(entryId, card)`. Without
it a reverse card added this morning decides the *word's* state, and a word
learned in March renders "new" on the lists page.

New files, all mine: `lib/srs/direction.ts`, `lib/srs/direction-prefs.ts`,
`components/review/production-card.tsx`, `components/review/add-reverse.tsx`,
`components/lists/production-list-toggle.tsx`, and the tests in §5.

## 2. A frozen file I needed and did not touch

**`ListRow` wants a `production?: boolean` column** — the per-list "also study
production" flag belongs next to `active`, which is the other per-list switch
that changes what the queue does. `lib/db/schema.ts` is frozen for the four
Phase 8 builders (HANDOFF-prep8.md §6), so per the rule I stopped, wrote it
here, and continued without it.

What I did instead: the flag lives in `localStorage` behind three functions in
`lib/srs/direction-prefs.ts` (`readProductionLists` / `isProductionList` /
`setProductionList`), which is the entire seam. Adding the column turns that
file into three repository calls and changes nothing above it — the component
already treats the store as unreliable, because it is.

What is *not* at stake: the cards. Those go through the repository into
IndexedDB like everything else. Losing the key loses a preference; the twins
already made keep their schedules and the toggle comes back off.

## 3. What the feature is

A word can carry a **second card** asked the other way round: the meaning on the
front, the hanzi recalled. It is a separate `cards` row with its own FSRS state
(`direction: 'production'`, prep's schema), because the two directions are
different memories learned at different rates and one schedule cannot serve
both. Nothing coordinates them; grading one cannot move the other, and there is
a unit test and an e2e that say so from both ends.

**Creation is deliberate, three ways in, and the setting is not one of them.**
`settings.productionDirection` only reveals the controls:

1. **"Add the reverse"** on the back of a recognition card
   (`components/review/add-reverse.tsx`), which is where the learner has just
   seen the meaning and knows whether they could have written it. One press, one
   card, idempotent per (entryId, senseIndex, direction). It does **not** spend
   the daily allowance, on the same rule §3.3 has always applied to an explicit
   add: the cap exists to stop the spine introducing more than was asked for,
   not to overrule what was asked for by hand.
2. **"Also study production" on a list** (`components/lists/production-list-toggle.tsx`),
   which is the one that could do damage — ninety words is ninety cards if
   nothing stops it. It creates at most the day's remaining new-card allowance
   (`buildQueue(...).drawLimit`), **charges** the counter for what it made
   exactly as `queueFromList` does, and reports the rest as waiting. It only
   twins words whose recognition card has actually been started
   (`requireStarted`): producing a word you have never once recognised is not
   the next step. While it is on, opening the list tops it up again — the same
   bargain Today already strikes, where opening the page is what introduces the
   day's words.
3. `addProductionTwins()` itself, for anything later that wants the same rules.

**Turning the setting on adds nothing to today's load.** That is the acceptance
line the brief asked for and it is tested twice (unit: `loadToday` with the
setting on creates no production card; e2e: the card table is empty after the
switch is thrown).

### The card

`components/review/production-card.tsx`. The front shows the chosen sense first
(as the recognition back orders it), then the other senses, then the sentence
the word was mined from with the target **blanked** — and there is no pinyin and
no classifier on it, because the reading is most of the answer.

Hiding the word is more than not printing it, and each of these is a separate
leak that is closed and tested:

- a gloss can quote the headword ("variant of 打算[da3 suan4]"), so glosses are
  run through `maskTargets`, which takes the bracketed CC-CEDICT reading with it;
- a sentence whose target cannot be located has nothing to blank, so it is not
  shown at all;
- a sentence that says the word *twice* is blanked only where the offset points,
  so the masked line is re-checked (`revealsTarget`) and dropped if the word
  survives it.

### The answer

The box is Phase 7's `RecallInput`, unchanged apart from two copy props. What is
swapped is the `request` seam it already had: `productionRecallRequest` grades
against the headword **in the browser**.

- exact match → Good (3), **no request at all**;
- the other script → Good (3), and it says so ("that is the traditional form,
  and it counts"). A learner set to simplified who writes 學習 has produced the
  word;
- the word inside a longer answer → Good (3);
- an answer with no hanzi in it (pinyin, English) → Again (1), locally;
- **one character off** (edit distance ≤ 1, or ≤ 2 for a word longer than four
  characters) → this is the only case that reaches `/api/recall`, and if that
  answers nothing the local reading — Hard (2), "One character off." — stands;
- anything else → Again (1), locally. A different word is not a near miss and
  does not cost a request.

Phase 7's rule is untouched: nothing here can submit a grade. The suggestion
rings a button; the learner presses one. The e2e types an exact answer, watches
the ring land on 3, presses 2, and reads the review row back.

## 4. Honest limits

- **The near-miss provider call asks a meaning question about a produced word.**
  `LLMProvider.gradeRecall(entry, answer, senseIndex)` was built to judge an
  English answer against the glosses, and its `why` is CJK-scrubbed by the
  route. Handing it hanzi is defensible (it has the entry and the answer, and
  "is what they wrote acceptable for this word?" is a real question) but it is
  not what the prompt was written for, and the `FakeProvider` — the only grader
  in this container — is a stemmed-word-overlap counter that will usually say
  Again. A proper fix is a `direction` on the provider contract and a second
  prompt; that is `lib/ai/**`, which I do not own this phase. Until then the
  local reading is what a learner actually sees offline, and it is right.
- **Turning `settings.productionDirection` off does not retire existing
  production cards.** They keep coming up in the queue. I chose that over
  silently hiding due cards: a scheduled card is a commitment, and a Today count
  that disagrees with the database is worse than a card the learner has to
  delete. There is no "delete all reverse cards" affordance — nothing in the app
  deletes a card yet.
- **The per-list toggle tops up when the list page is open**, not from Today.
  With the column from §2 it could run in `loadToday` and would not need the
  page at all.
- **Sense-level twins are supported but not offered.** `twinKey` is
  (entryId, senseIndex), so a card about sense 2 gets its own reverse — but only
  "add the reverse" can make one, and only for the sense the card in front of
  you is about.
- **No `senseIndex` on the bulk path's twins beyond what the recognition card
  carries.** It inherits, which is right, but it means a list of cards added
  without a sense produces reverses without a sense.
- **`spaceDirections` is a display order, not a scheduling rule.** It pulls the
  next card about a different word forward when it can; in a queue holding one
  word's two directions and nothing else, they are still adjacent. There is
  nothing better to do there.
- The i+1 example block is offered on the production back as well (it contains
  the answer, so the back is the only place it could go). It is the same
  component and the same `examplesOnBack` setting.

## 5. Tests

Unit (`pnpm test`): **703 passing, 69 files** — 647 before, so 56 are new.

| File | What it pins |
|---|---|
| `tests/unit/srs/direction.test.ts` (30) | the grader (exact / other script / contained / pinyin / near / wrong), `normalizeProduced`, `editDistance`, `maskTargets` and `revealsTarget`, `countByDirection`, `spaceDirections`, `preferRecognition`, `planProductionTwins` (limit, senses, tombstones, phrase cards, `requireStarted`, list order), and `productionRecallRequest` — including a fallback that **throws if it is called** for an exact match |
| `tests/unit/srs/direction-schedule.test.ts` (7) | against a real Dexie: two rows over one `words` row, `cardForEntry` per direction, idempotency, **grading one direction does not move the other** in any field, `loadToday` with the setting on creates nothing, and the cap (creates one, charges one, reports one pending) |
| `tests/unit/srs/direction-prefs.test.ts` (5) | the localStorage seam: round trip, mangled values, no storage at all, a store that throws on write |
| `tests/unit/review/production-card.test.tsx` (7) | the front never contains the answer — including the gloss that quotes the headword, the sentence that says it twice, and the sentence whose target cannot be located |
| `tests/unit/review/production-session.test.tsx` (2) | the real session and store: the production card is drawn, an exact answer is graded with `fetch` stubbed to **throw**, the learner's different grade is what lands in `reviews`, the twin does not move; and "add the reverse" appears only with the setting on |
| `tests/unit/lists/production-toggle.test.tsx` (3) | the toggle: hidden until the setting is on, capped and charged, remembered across a remount, and off deletes nothing |
| `tests/unit/lists/today-directions.test.tsx` (2) | Today counts the two directions apart, and says nothing at all until there is a production card |

E2E (`PORT=3002 pnpm e2e`): `tests/e2e/b/production.spec.ts`, 3 specs — the
whole loop through the UI (settings → add the reverse → the blanked front → an
exact answer with `/api/recall` routed to fail if it is touched → grade → the
twin's due date is unmoved), the other-script acceptance plus the Today split,
and the list toggle under the cap.

**A note for whoever writes the next list spec:** use `resetApp` from
`tests/e2e/p3/helpers.ts`, not `openReview`, when the daily allowance matters.
`openReview` navigates to `/review` *before* it resets, so the page's own
`loadToday` can land a spine draw — and its charge against `introduced` — after
the reset. That cost me a red run.
