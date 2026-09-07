# HANDOFF — P2 (Cards + review)

Branch `p2`. Owns `lib/srs/**`, `app/review/**`, `components/review/**`,
`lib/stores/review.ts`, `tests/unit/srs/**`, `tests/e2e/p2/**`. Nothing frozen was
touched, and `lib/db/dexie.ts` needed no change (see "Phase 0's `grade()` verified"
below).

## What landed

| File | What it is |
|---|---|
| `lib/srs/session.ts` | The session's pure core: queue assembly, `nextDueAt`, the four grade options with their intervals, `ratingFromKey` / `isRevealKey`, `emptyStateMessage`, `formatInterval` |
| `lib/srs/context.ts` | Provenance: `contextText`, `splitContext`, `maskFor`/`maskedContext`, `resolveContext` |
| `lib/srs/presentation.ts` | What a card shows: `cardFace` (script preference), `orderGlosses` (chosen sense first), `cardBack` |
| `lib/stores/review.ts` | The session store: load → reveal/peek → grade → re-query |
| `components/review/{review-session,review-card,grade-bar,context-line}.tsx` | The UI |
| `app/review/page.tsx` | The placeholder replaced by `<ReviewSession />` |

`lib/srs/card.ts`, `day.ts`, `states.ts` and `profile.ts` are untouched: every
exported signature Phase 0 created still stands, and `previewGrades` /
`replayCard` were already exactly what P2 needed.

## Decisions

**The review queue is `lib/lists/queue.ts`'s queue, not a second one.** The brief
is "due(now) plus New cards that were explicitly added"; `buildQueue` (P3's file,
already a working stub) is exactly that rule plus the spine draw capped by
`newPerDay − introducedToday`. `buildReviewQueue` in `lib/srs/session.ts` calls it
and takes `.cards`, so there is one implementation of "what is in today's queue"
and `/review` inherits P3's auto-draw ordering the moment it lands.
**P3 should know:** `/review` does *not* write `settings.introduced` — nothing
does yet. Whoever makes the daily cap persist (P3's "grade 10 new, reload, no
further spine cards today") should increment it inside `repository.grade()` or in
the queue builder, not in the review store, or the counter will only move for
cards graded on `/review`.

**A grade re-queries the database rather than advancing an index.** The schedule
the grade just wrote is what decides whether the card comes back, so re-reading
is the only way the session and the database cannot disagree. With
`enable_short_term: false` nothing can return inside a session, so the queue
always shortens and the session always terminates.

**The progress counter is `Card {graded + 1} of {graded + remaining}`.** Because
the queue is re-read, the denominator is the session's *known* total, not a
promise: an explicit Add made in another tab mid-session grows it, which is
honest. After a reload the counter starts over on what is left — a reload starts
a new session.

**Grade keys are gated on the flip.** 1–4 do nothing until the card is revealed:
you cannot rate a recall you have not attempted. Space and Enter flip; every
other key is ignored, as are all four grade keys while a grade is in flight, and
any key typed into an input. Tapping the card front flips it too.

**"Peek context" masks by character, and is hidden when it cannot.** The front
peek replaces the target with one `＿` per character (rendered as a redaction
block). When `context.offset/length` are absent *and* the headword is not found
in the sentence, `splitContext` returns null, the peek button is not rendered at
all, and the back shows the line unhighlighted — a peek that silently shows the
answer would be worse than none. The back tries the learner's script first, then
the other one, so a simplified sentence still highlights for a traditional
reader.

**`nextDueAt` ignores New cards.** A New card's `due` is its creation instant, so
it is always "in the past"; it is held out of the queue by the daily cap, not by
the clock. Counting it would make the empty state promise a card that will not be
offered until tomorrow. The empty state therefore reads "no cards are scheduled
yet" when the only thing left is capped-out New cards. If P3 wants "N new
tomorrow" there, it needs the introduced counter, not this function.

**Intervals are computed against the instant the queue was built** (`store.now`),
not `Date.now()` at render — `react-hooks/purity` forbids the latter, and a label
that drifts while the card sits on screen is a lie anyway.

**Phase 0's `grade()` verified, not changed.** `tests/unit/srs/grade.test.ts`
asserts it writes the new FSRS state, mirrors it into the indexed `due` column,
appends exactly one review row carrying the *pre-grade* state in both `before`
and `log`, stores every log date as epoch ms, never schedules under a day for any
rating, and that `fsrs(FSRS_PARAMETERS).reschedule(createEmptyCard(), rows)` —
ts-fsrs directly, not our helper — reproduces the stored card exactly. All of it
passed on the Phase 0 implementation. `listDue` and `listLearningSoon` were read
and are correct as written; `lib/db/dexie.ts` is unmodified.

## Needs (frozen files — nothing blocking)

Nothing. No frozen file needed a change:

- `Repository` has no review reader, which is right (the app needs none). The e2e
  fixtures read `reviews` through the `db` handle `window.__tangram` already
  publishes, so no interface change was required.
- `EntrySnapshot` carries everything the card back shows.

*Nice-to-have, not needed:* `repository.nextDue(now)` would let the empty state
avoid `allCards()`. At single-user scale `allCards()` is a few hundred rows read
once per load, so it is not worth unfreezing the interface for.

## Tests

- `tests/unit/srs/session.test.ts` — queue assembly (due first, oldest first,
  explicit adds bypass `newPerDay: 0`), `nextDueAt`, interval formatting, the
  four options ordered Again ≤ Hard ≤ Good ≤ Easy and never under a day, the
  keyboard map (1–4 only, everything else null), the empty-state wording.
- `tests/unit/srs/context.test.ts` — offsets, headword fallback, out-of-range
  offsets refused, masking, `resolveContext` across scripts.
- `tests/unit/srs/presentation.test.ts` — script preference, chosen sense first,
  HSK 7 labelled "7–9", phrase cards.
- `tests/unit/srs/grade.test.ts` — the verification above, including the FSRS
  replay.
- `tests/unit/srs/review-session.test.tsx` — the component against a real
  fake-indexeddb database: flip on space, grade on 3, other keys ignored, the
  re-query after a grade, the peek, the folded senses, both empty states.
- `tests/e2e/p2/review.spec.ts` (+ `fixtures.ts`) — seeded through
  `window.__tangram.repo`: the due walk with intervals and one review row per
  grade, a grade surviving a reload, the context sentence masked then marked, the
  chosen sense, both empty states, and an explicitly added New card.

`pnpm lint`, `pnpm test` (21 files, 183 tests), `pnpm build`, `PORT=3002 pnpm e2e`
(21 specs, including the Phase 0 smoke suite) all green; `npx tsc --noEmit` clean.
No server left running on 3002.

## For the merge

- Only `app/review/page.tsx` and `lib/stores/review.ts` are modified files; the
  rest are new. The only cross-lane import is `buildQueue` from
  `lib/lists/queue.ts` (P3's) — used, not edited.
- `tests/e2e/p2/fixtures.ts` is a helper, not a spec (Playwright's default
  `testMatch` only picks up `*.spec.ts`), and it re-declares its own 打算/看看
  entries rather than importing the unit fixtures, to keep Dexie out of the
  Playwright process.
- The post-merge integration spec ("look up 打算 → Add → /review shows 打算 →
  grade 3 → a `reviews` row exists") works against this: an Add from lookup
  writes `context.source = 'lookup'`, which is an explicit add and therefore
  always in today's queue.
