# Builder C — `/stats`, the retention dashboard

Branch `c`, cut from `a8fe928` (Phase 8 prep). Nothing frozen was edited; the two
files I touched outside my own area are one line each and are listed at the
bottom under **What the merge must know**.

---

## What is on the page

`/stats` is a client route with four panels, in this order, and it never writes:
opening Today introduces cards and opening Review grades them, so a dashboard
that changed the thing it measures would be its own worst data source.

**1. True retention.** The hero figure — the share of reviews graded Hard, Good
or Easy rather than Again — over the last 30 days, with all-time beside it. The
denominator is on screen in words (*"97 of 113 reviews recalled — cards already
in the Review state, last 30 days"*) and the reviews it leaves out are counted in
their own tile (*"Not counted: 119 learning-step reviews"*), so the two figures
add back up to the review log and anyone can check them.

Only reviews where `before.state === 2` (Review) count. This is the classic
mistake and it is worse now than it was in v1: with `shortTermSteps` defaulting
**true** (prep §5) the Learning and Relearning states actually occur, a new word
can be answered three times in ten minutes, and those answers are nearly all
successes. Fold them in and the headline drifts up toward 95% and stops
responding to the schedule at all. `tests/unit/stats/retention.test.ts` pins the
difference on the same rows: 50% counted properly, 83% counted naively.

Hard counts as a recall. Again is FSRS's only failure and is what its forgetting
curve is fitted against; scoring Hard as a miss would report a retention nothing
in the app is aiming for.

**2. Calibration.** Predicted recall against observed, by decile, over a
diagonal. Each dot's area is the reviews behind it and the count is written
beside it; a decile holding fewer than 10 reviews is **not drawn at all**, and
the reviews in it are reported under the chart (*"7 deciles held fewer than 10
reviews (23 in all) and are not drawn"*) rather than disappearing. Under the
chart, one plain sentence for the whole fit: *"Overall it predicted 95% and you
recalled 87% — the schedule is more optimistic than your answers."*

Three things about it that matter to **builder A**:

- The prediction is **recomputed from the weights in force now**, through
  `ts-fsrs`'s own `forgetting_curve` and `buildParameters(settings).w`. Nothing
  stored a prediction, and recomputing is the right choice anyway: after the
  optimizer writes a fit, the question is "how would today's parameters have
  scored my history", and only a recomputation answers that. So a fit that
  helped shows as dots moving onto the diagonal, and one that hurt shows as dots
  leaving it. Take a screenshot before optimizing and after.
- It has the **same denominator as true retention** (Review-state reviews only).
  A learning-step review's stability is minutes old and its predicted recall is
  ~1.0 by construction; a few hundred of those pile into the top decile and
  flatter the chart into meaninglessness.
- `lib/stats/calibration.ts` calls neither `fsrs()` nor `generatorParameters()`
  — `forgetting_curve` is a pure function of the weight vector, and the vector
  comes from `lib/srs/params.ts`. The CLAUDE.md rule is intact; `grep` still
  finds exactly one construction site.

**3. Workload.** Reviews per day for the last 30 and cards coming due for the
next 30, on one axis, split by a "today" rule. Same unit, so one scale: a
forecast means nothing without the recent load beside it. Today appears on both
sides of the line — reviews *done* today to the left, cards *still due* today
(including anything overdue) to the right — and nothing is double counted,
because a card reviewed today has been rescheduled and is no longer due today.

New cards are excluded from the forecast: a New card's `due` is the moment it
was created, so counting them would put every word ever added to a list on
today's bar and call it a review debt. What introduces a new card is the daily
cap on Today, not a due date. Overdue cards are folded onto today and the count
is said out loud, because dropping them would forecast a quiet week to someone
with 300 cards waiting — the exact failure this panel exists to prevent.

**4. Maturity.** The four state counts as stat tiles, then the stability
histogram, then the known count against `KNOWN_STABILITY_DAYS` (21) — the same
threshold the reader paints a word "known" at, so growth in the right-hand bars
is growth in the text Kirby can read.

Every chart carries a `<details>` table view with all of its numbers, including
the calibration deciles that were too thin to draw. No value on the page is
reachable only by hovering.

## The empty states, which are the point

The line these draw is between a **count** and a **rate** (`lib/stats/thresholds.ts`).
A count is exact at any size — "you did four reviews on Tuesday" is as true with
four rows in the database as with forty thousand — so workload and maturity have
no threshold at all and say plainly when there is nothing. A *rate* estimated
from a handful of trials is noise wearing a percent sign, so:

| Number | Floor | Below it |
|---|---|---|
| True retention | 30 Review-state reviews | "Not enough reviews yet. This needs about 30; you have 11 — 19 to go." |
| Calibration | 100 Review-state reviews | the same, and **not one dot is rendered** |
| One calibration decile | 10 reviews | the dot is not drawn; the reviews are reported and are in the table |

With `?seed=demo` — the state Kirby actually opens the app in — the demo's whole
history is seven backdated grades, most of cards still inside their learning
steps, so both rates are under the floor and the page says so. That is the first
e2e test.

## Design notes (the `dataviz` skill, applied)

The app's own tokens are a UI palette and two of them fail the data-viz gates
outright, so the charts use stepped versions of the same hues, validated with the
skill's script rather than eyeballed (the reasoning is in the header of
`components/stats/chart-tokens.tsx`):

- jade `#0f766e` sits **below** the OKLCH chroma floor (0.086) — it reads as gray
  in a 3px mark; `#5eead4` sits **above** the dark lightness band (L 0.855).
- Series pair in force: `#0d9488`/`#eb6834` light, `#12a695`/`#d95926` dark.
  Worst adjacent CVD ΔE 10.7 light / 13.5 dark, normal-vision 27.5 / 27.3, both
  marks ≥ 3:1 on the card surface — every check PASS in both modes.
- The stability histogram is *ordinal* (ordered buckets), so it takes a one-hue
  ramp, light→dark in light mode and dark→light in dark: monotone L, every
  adjacent ΔL ≥ 0.06, surface-nearest step 2.03:1 / 3.63:1 — PASS both modes.
- Chrome (grid, axis, ink) is wired to the app's own tokens, so the charts follow
  the page instead of carrying a second theme.

Forms follow the same procedure: retention is a hero figure (the only one on the
page) rather than a one-bar chart; the state counts are a KPI row rather than
four categorical hues; the workload chart carries a legend (two series) and one
direct label per series (the tallest column) with the rest in the crosshair
tooltip and the table. Charts are capped at 400–560px wide because an SVG's type
scales with its box — full-width on desktop turns 9px axis labels into 20px ones.
I rendered the page at 390px and 900px, light and dark, and fixed what that
showed: colliding decile labels (they now alternate above/below and the top one
hangs left of its dot), the "perfectly calibrated" label landing on the data, and
the "today" caption sitting under the tallest column's own value.

## Files

```
app/stats/page.tsx
components/stats/{stats-view,retention-panel,calibration-chart,workload-chart,
                  maturity-panel,primitives,chart-tokens}.tsx
lib/stats/{summary,retention,calibration,workload,maturity,thresholds,index}.ts
tests/unit/stats/{retention,calibration,workload,summary}.test.ts
tests/unit/stats/panels.test.tsx · tests/unit/stats/fixtures.ts
tests/e2e/c/stats.spec.ts
```

Green on the commit: `pnpm lint`, `pnpm test` (689 unit in 67 files, up from
647/62 — 42 new), `pnpm build`, `PORT=3003 pnpm e2e` (93 specs, up from 90).
Nothing was left listening on 3003.

## Honest limits

- **Calibration says nothing about a fit's own overfitting.** It scores the
  weights in force against *all* of the learner's reviews, including the ones a
  fit was trained on, so a heavily overfitted vector will look well calibrated
  here. That is builder A's held-out log loss to judge (`isUsableFit`), and the
  panel points at it by naming which weights are in force. If A wants a
  held-out calibration chart, `calibration(reviews, w)` already takes both
  arguments — pass the held-out slice.
- **Elapsed time is measured from `before.last_review`**, fractionally, not from
  `log.elapsed_days` (whole days upstream: a card answered 14 hours after a
  10-minute step is not "0 days elapsed", and the curve at t=0 is exactly 1.0).
  A row whose `before` has no `last_review` falls back to the stored integer.
- **The forecast is a snapshot of stored due dates.** It does not simulate the
  reviews between now and then, so a day 20 columns out is a floor, not a
  prediction: failing cards tomorrow adds to it. It also cannot know how many new
  cards Today will introduce.
- **`predictedRecall` is `null`, never 0, when a row cannot support one.** Zero
  would be a prediction of certain failure and would bend the curve.
- **One read, no refresh.** The page reads once on mount; grading in another tab
  needs a reload. A dashboard is not a live view and I did not build a poll.
- **The demo seed cannot exercise the drawn charts.** Its seven grades are below
  every floor by design, so the "numbers are right" e2e seeds its own synthetic
  history (20 graduated cards answered on six fixed days, plus three that lapse)
  through `window.__tangram.repo` and asserts the exact denominators.
- **DST is handled, and tested where it can fail.** The day windows are walked
  with `setDate`, not by adding 86,400,000ms; `tests/unit/stats/workload.test.ts`
  sets `TZ=America/New_York` for one block and shows the naive walk losing a day
  (29 keys for 30 columns) across fall-back. That block restores `process.env.TZ`
  after itself.

## What the merge must know

1. **`components/shell/nav.ts` gained one line** — `{ href: '/stats', label: 'Stats' }`
   between Lists and Settings. `app/layout.tsx` is frozen and untouched; the nav
   reads this list, which is where the brief said to put it. Seven links still
   fit a 390px phone (the smoke spec's own check passes, and my spec re-checks
   for horizontal overflow on `/stats`). If another builder also edits this file,
   the resolution is "keep both entries".
2. **`scripts/sw.template.js` gained `/stats` to `SHELL`** — one line, so the new
   route is precached like every other nav destination and works offline. This is
   builder D's neighbourhood: `tests/unit/pwa/manifest.test.ts` still passes
   unchanged (it checks containment, not the exact list), but its name still says
   "the six shell routes" and its loop still lists six. I deliberately did not
   edit another area's test; whoever merges may want to add `/stats` to that
   loop.
3. **No frozen file was touched**, and no repository query was added: everything
   comes from what prep put on the interface (`allReviewsChronological`,
   `allCards`, `cardCountsByState`, `stabilityHistogram`, `getSettings`).
   `reviewsBetween` is *not* used — the dashboard needs the whole log anyway for
   all-time retention and calibration, and slicing that one array in memory is
   both cheaper than a second index scan and the reason the three panels are
   provably looking at the same rows. It remains there for A's optimizer.
4. **`lib/stats/**` is safe to import from anywhere**: pure functions plus one
   `loadStats(repo)`, no Dexie, no `server-only`.
