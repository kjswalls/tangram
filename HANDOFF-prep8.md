# Phase 8 prep — the shared surface

Written on `main` before the four builders start, in the tree they branch from.
Nothing here is a feature. It is the seams the four of you share, plus the one
default that changed underneath everyone (`shortTermSteps`), plus the list of
files that are frozen from now on.

Read this before your first edit. `pnpm lint`, `pnpm test` (647 unit, all
green), `pnpm build` and `PORT=3000 pnpm e2e` (90 specs, all green) pass on the
commit you are branching from.

---

## Why this phase exists (the audit, in one paragraph)

The spacing and testing effects are solid ground and the app is built on them.
FSRS is the best-evidenced scheduler available and we ship it — but with its
**population-default parameters**, which is leaving its main benefit unused: the
whole point of FSRS is that it can be fitted to *one* learner's review history.
And v1 ran it with `enable_short_term: false`, a deliberate deviation from
ts-fsrs's own default (`enable_short_term: true`, `learning_steps: ['1m','10m']`)
made so a session would always end cleanly. The cost was real: failing a
brand-new card and not seeing it again for a day is worse than seeing it again in
ten minutes. Both are addressed in Phase 8; this commit builds the surface.

---

## 1. `lib/srs/params.ts` — the one place FSRS parameters are built

**Nothing else in the app may call `fsrs()` or `generatorParameters()`.** Two
construction sites are two sets of parameters, and two schedulers that disagree
produce a card whose stored schedule its own review rows cannot reproduce. A
test would not catch that; a grep would, so the rule is written into CLAUDE.md.

```ts
buildParameters(settings?)      // FSRSParameters — the only generatorParameters() call
getScheduler(settings?)         // FSRS — the only fsrs() call, memoised per parameter set
describeParameters(settings?)   // "FSRS defaults" | "Optimized from your 1,240 reviews on 3 Mar"
resolveWeights(settings?)       // { w, source: 'default'|'optimized', fit, rejected }
isValidWeightVector(w)          // 17/19/21 finite numbers
isUsableFit(fit)                // valid AND heldOutLogLoss < baselineLogLoss
clampRetention(value)           // held inside 0.70–0.97
RETENTION_CHOICES               // the steps the settings control offers
DEFAULT_WEIGHTS                 // ts-fsrs `default_w` (21 — this build is FSRS-6)
```

`ParameterSettings` is a `Partial` of the three settings columns, not the row, so
the optimizer can score a candidate vector without inventing a `SettingsRow`.

**The weights are validated rather than trusted, and this is not paranoia:**
`generatorParameters` swaps a wrong-length vector for the defaults with only a
`console` warning, and *clamps a vector full of `NaN` to 0.001 and schedules with
it*. Both cases are covered in `tests/unit/srs/params.test.ts`. A stored fit that
fails validation, or that did not beat the population defaults on held-out
reviews, is ignored and `describeParameters()` says which of the two happened.

Call sites replaced (this was the whole of the "grep for them" work):

| Was | Now |
|---|---|
| `lib/srs/card.ts`: `FSRS_PARAMETERS`, module-level `getScheduler()` | gone; `gradeCard`, `previewGrades`, `replayCard` take an optional trailing `settings` and go through `params.ts` |
| `lib/db/dexie.ts` `grade()` | reads the settings row **inside the grade transaction** and passes it to `gradeCard` |
| `lib/srs/session.ts` `gradeOptions(state, now)` | `gradeOptions(state, now, settings?)` — the preview must run under the parameters the grade will |
| `components/review/review-session.tsx` | passes `settings` into `gradeOptions` |
| `tests/unit/srs/grade.test.ts` (replay through raw `fsrs()`) | `fsrs(buildParameters(settings))` |

There is no other `fsrs(`/`generatorParameters(` in `lib`, `app`, `components` or
`tests`. If you add one, you are adding a bug.

## 2. Schema — four settings columns, a widened `direction`, one index

`lib/db/schema.ts`:

- `requestRetention: number` — default **0.9** (FSRS's own default).
- `shortTermSteps: boolean` — default **true**. See §5; this is the changed one.
- `productionDirection: boolean` — default **false**.
- `fsrsWeights: FsrsWeights | null` — default **null**;
  `{ w, fittedAt, reviewCount, heldOutLogLoss, baselineLogLoss }`.
- `CardRow.direction` is now `CardDirection = 'recognition' | 'production'`, with
  `CARD_DIRECTIONS` and `DEFAULT_CARD_DIRECTION` exported beside it.
- `STORES_V3` = `STORES_V2` plus `[entryId+direction]` on `cards`. Every index
  `cards` already had is still there, so no existing query changes plan.

The four settings columns are **required**, not optional like the two Phase 6
toggles, because `getSettings` now merges `DEFAULT_SETTINGS` *under* the stored
row and writes the filled row back once. A reader never spells `?? 0.9` and never
has to guess whether `undefined` meant "off" or "not decided". The merge is a
repository rule, not a Dexie one, so it survives the Supabase swap.

### The migration conclusion — asked for explicitly

**Yes, this needed a Dexie version bump, and it is v3. No row is rewritten by it
and none is dropped.**

- The *settings* columns needed nothing: Dexie declares indexes, not shapes, and
  `settings` is indexed on `id` alone. IndexedDB does not police an unindexed
  field. (`tests/unit/settings/scheduling.test.tsx` asserts this, as its Phase 6
  sibling did.)
- The *`[entryId+direction]` index* did need one: an index is part of the schema,
  and Dexie will not add one without a version. Adding an index does **not**
  rewrite rows — IndexedDB builds it from what is already stored — and every
  `cards` row ever written carries `direction: 'recognition'` literally, so the
  new index covers Kirby's existing data as it stands.
- The v3 upgrade function is belt-and-braces on top of that: it stamps
  `DEFAULT_CARD_DIRECTION` onto any card row that somehow has no `direction`, so
  that no row can be invisible to a compound-index query. It touches nothing
  else, and a row that already has a direction is not rewritten.
- v1 and v2 remain declared verbatim, so a database that stopped at either
  upgrades through rather than being rebuilt.

The evidence is a test, not a claim: `tests/unit/db/queries.test.ts` › *a
database written before the direction index existed* opens a Dexie at the v2
stores, writes one card **with** a direction, one **without** and a review row,
closes it, reopens it as `TangramDb`, and asserts `verno === 3`, that both cards
and the review survive, that the unstamped row now answers `cardForEntry`, and
that it was stamped rather than dropped.

## 3. Repository — read-only queries you should not write yourself

`lib/db/repository.ts` (interface) + `lib/db/dexie.ts` (implementation). Every
existing signature still works; everything below is additive.

```ts
reviewsBetween(fromMs, toMs)   // half-open [from, to), oldest first
allReviewsChronological()      // every review, ordered by reviewedAt — the optimizer's input
cardCountsByState()            // { new, learning, review, relearning, total }, tombstones out
stabilityHistogram()           // STABILITY_BUCKETS with counts; New cards excluded
cardForEntry(entryId, senseIndex?, direction?)      // direction defaults 'recognition'
addCardFromEntry(entry, context?, senseIndex?, dictVersion?, direction?)
```

- `STABILITY_BUCKETS` is exported so the dashboard and the repository cannot
  disagree about what a bar means. The 21-day edge is `KNOWN_STABILITY_DAYS`, the
  same threshold the reader colours a word "known" at.
- `reviewsBetween` is half-open so consecutive windows tile without
  double-counting the row on the boundary.
- **Card identity is now (entryId, senseIndex, direction).** `addCardFromEntry`
  gained a fifth optional argument so that whoever builds the production
  direction does not need a frozen file changed. Asking for one direction never
  returns or disturbs the other, and idempotency holds per triple. A production
  card shares the `words` row with its recognition twin — same word, asked the
  other way round — and has its own FSRS state, because the two are learned at
  different rates and one schedule cannot serve both.
- `reviews` rows have no tombstone (append-only, §3.3), so nothing is filtered
  out of the two review reads.

Tests: `tests/unit/db/queries.test.ts` (11 cases).

## 4. Settings UI

`app/settings/settings-form.tsx` gained a **Scheduling** section above *On a
card*, following the form's existing write-through pattern (no Save button):

- `settings-request-retention` — a select over `RETENTION_CHOICES`
  (0.70–0.97, marking 90% as the FSRS default), with the plain sentence: *higher
  means more reviews and better retention; lower means fewer reviews and more
  forgetting*. A stored value outside the offered steps (an optimizer could write
  one) is added to the list rather than leaving the select blank.
- `settings-fsrs-source` — one line from `describeParameters()`.
- `settings-short-term-steps`, `settings-production-direction` — checkboxes.

**The optimizer UI is deliberately absent — it is builder A's.** The settings and
the `fsrsWeights` column are in place and read by `params.ts`; wire the "optimize
now" affordance to them.

## 5. What changed underneath everyone: `shortTermSteps` defaults TRUE

This is the item to read twice. It restores ts-fsrs's own default and undoes
v1's deviation. **Grading can now schedule a card minutes away rather than days**
— Again on a new card is 1m, Good is 10m, Easy graduates to 8d — and the FSRS
`Learning` (1) and `Relearning` (3) states now actually occur, where under v1
they never did.

Nothing was flipped back to keep a test green. Every existing test that asserted
the old behaviour was rewritten to assert the *new* truth, and none was marked
`.todo`:

| Test | Was | Now |
|---|---|---|
| `srs/card.test.ts` | "schedules at least a day for every rating" | a failed new card comes back inside the day by default; the ≥ 1 day claim is re-asserted with `{ shortTermSteps: false }`; a lapse is now counted from a card that has *graduated* (Easy), since a lapse is a failure from Review |
| `srs/grade.test.ts` | same, through the repository | `honours settings.shortTermSteps when it schedules` — the same grade on the same card lands a day out or minutes out depending on one column |
| `srs/session.test.ts` | `gradeOptions` days ≥ 1, interval `/(d\|mo\|y)/` | a learning step is labelled in minutes; the day-and-up claim re-asserted with the steps off; new `formatDelay` cases |
| `db/repository.test.ts` | "Again is at least a day out" | Again is a Learning step inside the minute, and a day out again with the steps off |
| `srs/review-session.test.tsx`, `e2e/p2/review.spec.ts` | due ≥ reviewedAt + 1 day; interval regex | the card moved, and by how much is the settings row's business; regex admits `m`/`h` |
| `db/import.test.ts`, `lists/two-tabs.test.ts` | version 2 | version 3, plus the v3-is-v2-plus-one-index assertion |

Two UI consequences of the label change, which are mine and are done:
`lib/srs/session.ts` gained `formatDelay(ms)` (`1m`/`10m`/`2h`, handing anything
≥ 1 day back to `formatInterval`), and `GradeOption` gained `ms` while `days` is
now honestly `0` for a step inside the day. A button that said `1d` over a
one-minute schedule was the alternative.

### Left for builder A — the queue, not the seam

These are real and are A's by the brief. None of them is a crash; all of them are
the queue not yet knowing that a card can come back inside a session.

1. **The session can now legitimately re-serve a card it just graded.**
   `lib/stores/review.ts` re-reads the queue after every grade with a fresh
   `now`; v1 leaned on the queue only ever shortening. It still terminates today
   (a 1–10 minute step outlasts the walk), but "the queue always shortens" is no
   longer a property — the module header says so now rather than claiming the old
   invariant.
2. **Nothing brings a matured learning card back on its own.** When the queue
   empties with a card due in nine minutes, the empty state stands until a
   reload. A timer, or a "1 card is coming back in 9 min" line, is the fix.
3. **`emptyStateMessage` floors at one hour** (`Math.max(1, ceil(diff / HOUR))`),
   so "next card in 9 minutes" renders as "next card in 1 hour". I left it: the
   copy and the refresh above are one decision, and it is yours. Its unit test
   pins the current wording, so change both together.
4. **Learning cards are not prioritised over new ones.** `buildQueue` sorts due
   by `due` and appends new cards; Anki-style, a matured learning step should
   usually come before introducing a brand-new word.
5. **`listLearningSoon(now, horizon)` now returns cards inside a 60-second
   horizon**, because that is what a learning step *is*. `lib/lists/today.ts` and
   anything showing "learning soon" counts may want a floor.
6. **The demo seed** (`lib/dev/seed.ts`) replays its backdated grades through
   `repo.grade`, so a single Good now leaves the card in `Learning` rather than
   `Review`. `wordState` calls both "learning", so no colour changed and the
   e2e suite is green — but if you assert on `fsrs.state` in new work, that is
   why it is 1.

## 6. Frozen for the four builders

Do not edit these. If you need one changed: **stop, write the need into your
`HANDOFF-<letter>.md`, and continue without it** — the orchestrator applies it on
`main` and merges forward. This is what stops four worktrees fighting over one
file, and a schema change in particular stops the build rather than landing in a
branch.

```
package.json          pnpm-lock.yaml        lib/srs/params.ts
lib/db/schema.ts      lib/db/repository.ts  lib/types.ts
app/layout.tsx        components/ui/**      app/globals.css
vitest.config.ts      playwright.config.ts  eslint.config.mjs      tsconfig.json
```

`lib/db/dexie.ts` is *not* frozen — but it is the only implementation of a frozen
interface, so a change there that the interface does not describe is a change
nobody else can see. Add the query to `repository.ts` first (via the orchestrator)
or you will have written a private one.

Worktree procedure: `pnpm install --offline --frozen-lockfile`, `data/*.json` and
`.cache` copied from `main`'s tree (they are gitignored and generated), ports
3001/3002/3003 for `pnpm e2e` — 3000 belongs to `main`.
