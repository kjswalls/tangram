# HANDOFF — builder A (Phase 8): FSRS fidelity and personal optimization

Branch `a`, cut from `a8fe928` (Phase 8 prep). Three commits, one per item.
`pnpm lint`, `pnpm test`, `pnpm build` and `PORT=3001 pnpm e2e` are green on the
last of them.

---

## 1. The session honours `shortTermSteps` (commit "Phase 8 item 1")

Prep flipped the default to ts-fsrs's own `true`; this makes the app work with
it. `lib/srs/params.ts` already read the column, so nothing about *scheduling*
changed — what changed is everything downstream that assumed a grade could
never land inside a session.

**What moved**

| File | Change |
|---|---|
| `lib/srs/session.ts` | `emptyStateMessage` takes an `EmptyState` object and counts **minutes** inside the hour; new `MAX_SESSION_REPEATS`, `SESSION_RETURN_HORIZON_MS`, `deferredCardIds`, `sessionQueue`, `returningWithin`, `sessionRefreshDelay`; `nextDueAt` gained an exclusion set |
| `lib/stores/review.ts` | `repeats` (grades this session, per card), `deferred`, `attempts`, `returning`; the queue and every number the empty state quotes exclude set-aside cards |
| `components/review/review-session.tsx` | the refresh timer, the repeat notice, the new empty-state call |
| `lib/lists/queue.ts` | `due` sorts cards mid-step (FSRS Learning/Relearning) ahead of the overdue Review pile, then by due instant |

**The termination argument, since it is the dangerous part.** With the short
steps on, Again on a card in a learning step schedules it a minute out, so the
old "the queue can only shorten" invariant is gone. What replaces it: the store
counts grades per card, `deferredCardIds` sets a card aside at
`MAX_SESSION_REPEATS` (6), and set-aside cards are filtered out of the queue.
Every card can therefore be served a bounded number of times, and no new cards
appear mid-session, so the session terminates. The count is per session and is
cleared by `reset()` — leaving and coming back is the learner deciding to try
again, and the app has no business remembering a bad five minutes.

**The copy changed**, which is why `tests/e2e/p2/review.spec.ts`'s empty-state
regex was widened: it asserted the exact sentence this item rewrote. That is the
only file outside my lanes that I touched.

**Known limit.** The refresh timer is armed from the schedule the grade wrote.
Moving a card's `due` column behind the app's back does not re-arm it — nothing
in the product does that, but it is why the intra-session repeat cap is proved
in jsdom (`tests/unit/srs/review-session.test.tsx`, which can move the clock)
rather than in Playwright.

## 2. The optimizer (`lib/fsrs-optimize/`)

`ts-fsrs` ships **no** optimizer. `clipParameters` and `checkParameters` are
validation, not training, and there is nothing else in its exports — so the fit
is ours. Pure, dependency-free, no route, no worker.

- **`dataset.ts`** — `allReviewsChronological()` → per-card chronological
  sequences. The delta-t is `log.elapsed_days`, the number the *scheduler*
  recorded (whole UTC calendar days, ts-fsrs's `dateDiffInDays`), with a fallback
  derived from `before.last_review`. Re-deriving it from timestamps would fit a
  model the app does not run. Two kinds of review are **replayed but never
  scored**: a card's first (there is no memory state to predict from) and a
  **same-day** one (`elapsed_days === 0`, where the forgetting curve returns 1
  by construction, so scoring it charges ~13.8 nats for every within-session
  lapse and measures how badly the session went rather than how the memory
  behaves). FSRS's own optimizer excludes same-day reviews for the same reason,
  and since `shortTermSteps` defaults on there are now a lot of them —
  `MIN_REVIEWS_FOR_FIT` therefore counts *long-term* reviews, which is the
  number that carries signal.
- **`loss.ts`** — replays each card through ts-fsrs's own
  `FSRSAlgorithm.next_state` and predicts recall with the exported
  **`forgetting_curve(w, elapsedDays, stability)`** (the parameter-vector
  overload, which reads the FSRS-6 decay out of `w[20]`). Objective is binary
  log-loss: Again is forgot, Hard/Good/Easy are recalled. Probabilities are
  clamped off 0 and 1; a candidate `next_state` refuses abandons that card and
  scores badly rather than returning `NaN` (`NaN < best` is false, so a silent
  one would end the search at whatever came first).
- **`optimize.ts`** — coordinate descent, shrinking step, with a line search in
  an accepted direction. Two things are not obvious and are load-bearing:
  1. **The step is a fraction of each weight's own magnitude, never of its legal
     range.** The ranges are wildly unlike each other (`w0..w3` run to 100,
     `w12` tops out at 0.25). An earlier version sized the step off the range
     and drifted a long way from weights it should have recovered.
  2. **A ridge pull towards the population defaults** (`RIDGE = 0.05`, relative
     units, mean over the vector). Several weights are barely identified by a
     few thousand reviews; without it the search walks them to their clamp
     bounds — `w3` pinned at 100 days of initial stability — for a fourth
     decimal of training loss. It applies to the **training objective only**;
     every number reported and the gate itself are pure held-out log-loss.
- **`previous.ts`** — the revert slot. See the schema note below.

### The safety rule

1. Split **chronologically**, never randomly (a random split leaks the future).
2. The search sees the **train half only**.
3. A fit is offered only if it beats **both** the weights in force **and** the
   population defaults on the held-out half.
4. At least `MIN_REVIEWS_FOR_FIT = 400` scorable reviews. The UI says this is a
   floor for signal, not a guarantee — real FSRS optimization wants well over a
   thousand.
5. `optimizeWeights` **never writes anything**. It returns a proposal.

### One thing the brief asked for that I did not implement literally

"A log of pure noise does not beat baseline and is therefore refused" is **not
true as stated, for a real reason**, and I did not force it to be. Ratings drawn
uniformly at random have a ~75% base recall rate that stock FSRS does not
predict; a fit that learns that base rate genuinely does better on held-out
data, because a constant base rate is real, generalizable signal. Refusing it
would mean refusing something correct. What I test instead, and what the rule is
actually for:

- **a log the population defaults already explain** (generated from `default_w`)
  is refused — there is nothing to find and the gate finds nothing;
- **a fit that chased noise** — the training half is random ratings, the
  held-out half is a real FSRS history — is refused, with the fitted loss
  clearly *worse* than the current one. This is the overfitting case the rule
  exists for, and the gate fires on it every seed I tried.

## 3. The panel (`components/settings/optimizer-panel.tsx`)

Mounted from `app/settings/settings-form.tsx` — **one line** inside the
Scheduling section, deliberately, so it is a trivial merge. It shows
`describeParameters()`, the scorable/total review counts, the floor copy when
below it, Run (with a percentage and a Cancel), both held-out losses, a
three-row worked-example table of what "Good" would schedule before and after,
Apply, and Revert.

Both losses shown are **held-out** and are labelled as such. Apply is a separate
press from Run.

---

## Frozen files: what I changed, and why it is safe

**`lib/srs/params.ts` — three additive exports. No existing signature changed.**

```ts
clipWeights(w, settings?): number[]                    // ts-fsrs's own clamp table
parametersForWeights(w, settings?): FSRSParameters     // a candidate's parameters
algorithmFor(params): FSRSAlgorithm                    // the bare memory model
```

They exist because `buildParameters` resolves weights off the settings row and
correctly refuses a fit that has not proved itself — and a fit cannot prove
itself without being scored first. The alternative was to fake a `SettingsRow`
carrying a fit with `heldOutLogLoss: 0, baselineLogLoss: 1` at every call site,
or to call `generatorParameters()`/`new FSRSAlgorithm()` from the optimizer,
which is the second construction site CLAUDE.md forbids. I added the one-line
note about that to the CLAUDE.md FSRS bullet.

## What the merge must know

1. **`emptyStateMessage` changed signature** — it now takes one `EmptyState`
   object, not `(next, now, waiting)`. Only `components/review/review-session.tsx`
   calls it.
2. **`nextDueAt` gained a third optional argument**; existing calls are fine.
3. **`buildQueue` changed the order of `queue.due`** — learning steps first,
   then by due instant. If C's dashboard or B's production cards assert on that
   order, this is why.
4. **`app/settings/settings-form.tsx` gained one import and one JSX line.** B is
   also in the Scheduling section (`settings-production-direction`); the panel
   sits directly above that checkbox.
5. **`tests/e2e/p2/review.spec.ts`** — one regex widened, for copy this branch
   changed.
6. **`CLAUDE.md`** — one sentence added to the FSRS convention bullet.

## The schema change I need and did not make

`settings.fsrsWeights` holds exactly one vector, so there is nowhere durable to
put the weights a fit replaced. The undo is therefore parked in `localStorage`
(`tangram.fsrs.previous`, `lib/fsrs-optimize/previous.ts`): per browser, one
deep, gone when site data is cleared. Reverting to the FSRS defaults is always
available regardless, and no review row is ever touched by either direction.

**The ask:** a `previousFsrsWeights: FsrsWeights | null` column on `SettingsRow`
(default `null`), which needs no Dexie version bump — `settings` is indexed on
`id` alone. `previous.ts` is the only file that would change; its three
functions are already the seam.

## Honest limits

- **The fit is only as good as coordinate descent with a ridge.** It reliably
  moves towards weights that generated a synthetic log (measured in relative
  units: 0.29 against the defaults' 0.47 on a 2,000-review log) and reliably
  beats the defaults on held-out data when there is something to find. It is not
  the Rust optimizer FSRS ships for Anki, and it does not claim to be.
- **`RIDGE` and the step schedule are tuned by hand** against synthetic logs.
  They are not derived from anything. A better fit is available to whoever wants
  to spend the time; the safety gate is what stops a worse one reaching Kirby.
- **The simulation uses the *current* `shortTermSteps`** for the whole history,
  because nothing records what the setting was at each past grade. For a log
  written entirely under one setting this is exact; across a change it is
  approximate.
- **Reviews are read into memory in one go.** A few thousand rows is nothing;
  a hundred thousand would want paging, and `reviewsBetween` is already there
  for whoever needs it.
- **The panel loads the whole review log on every `/settings` visit**, to count
  it. Cheap now, worth a second thought if the log ever gets large.
- **No `app/api/optimize` route**, deliberately: the data is in IndexedDB in the
  browser and there is nothing for a server to do.
