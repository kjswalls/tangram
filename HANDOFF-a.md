# HANDOFF-a — Phase 6 item 1: i+1 example sentences

Builder A, on branch `a` off `b419205` (the prep commit). Nothing frozen was touched:
`lib/ai/{provider,fake,anthropic,cache-key,ground}.ts`, `components/review/review-card.tsx`,
`lib/types.ts`, `lib/db/schema.ts`, `package.json` and `pnpm-lock.yaml` are byte-identical to
the branch point. No dependency was added. No live model call was made from this container.

## What shipped

| File | What it is |
|---|---|
| `lib/ai/examples.ts` | **new** — the filter, the known set, the cached shape. Pure and browser-safe. |
| `app/api/examples/route.ts` | **new** — `GET` handshake, `POST` pipeline, and `examplesFor()` with the provider injected. |
| `components/review/example-sentences.tsx` | **new** — the card-back block: cache, fetch, render. |
| `components/review/review-session.tsx` | **modified** — passes the `examples` slot, gated on `settings.examplesOnBack`. Four lines plus a comment. |
| `tests/unit/ai/examples.test.ts` | 10 cases — the filter and the known set. |
| `tests/unit/ai/examples-route.test.ts` | 14 cases — the route, including a provider that breaks the rules. |
| `tests/unit/ai/examples-card.test.tsx` | 6 cases — what is drawn, and when the network is spared. |
| `tests/e2e/a/examples.spec.ts` | 3 specs — the flip is never blocked, the promise holds against real `known_words`, the toggle removes the block. |

## The shape of it

**The prompt asks; the filter enforces, and it enforces twice.** The route offers the
provider the target entry plus the learner's known words (`support`), and then *two*
independent gates decide what reaches a browser:

1. `lib/ai/ground.ts`, unchanged and reused — a sentence is a `sayIt` phrase with an empty
   `register`, so a citation outside `retrieved` is already gone and everything that
   survives is **rendered from dictionary rows**. There is no second renderer, and the card
   back calls the same `renderPhrase` the ask panel does;
2. `keepSentence` (`lib/ai/examples.ts`) — drops the whole sentence for an uncited `{text}`
   token, for any citation that is neither the target nor in the known set, for anything
   grounding flagged `unverified`, and for a sentence that never mentions the target.

The two sets are the same by construction today (the model is only ever offered words the
learner knows), and they are still checked separately on purpose: the day a live provider
needs a wider pool — a particle the learner has not formally met — the promise on the card
back must not silently widen with it. A sentence is shown **whole or not at all**; there is
no trimming path anywhere.

**Known-set membership is `wordState` (`lib/srs/states.ts`)** — the reader's own rule, called,
not restated. `knownHeadwords()` keeps only `state === 'known'`, which is deliberately
**stricter than `LearnerProfile.knownSample`**: the profile counts *learning* words too,
because its job is to describe a learner to a model rather than to promise anything, and a
sentence containing a word you are still learning is not a sentence made of words you know.

**Client → server.** `POST /api/examples { entryId, senseIndex?, profile, known? }`. `known`
is the strict set (≤ `KNOWN_SAMPLE_LIMIT`, truncated client-side exactly as the profile is);
it is **optional**, and a bare `{entryId, profile}` request — the body PLAN.md names — still
works, falling back to `profile.knownSample`. That fallback is the one deviation from the
literal route contract in the brief, and it is additive: the documented body is legal and
tested.

`503` on a missing `data/` build, `400` on a malformed body, `404` for an id this dictionary
does not have, `502` for a provider that throws, hangs (20 s, `TANGRAM_EXAMPLES_TIMEOUT_MS`)
or answers off-schema — the same vocabulary `/api/ask` answers in.

**The card back.** The slot only mounts once the card is revealed, so the fetch starts *at*
the flip and the flip never waits for it (the e2e delays the route by three seconds and reads
the glosses and the grade buttons while the request is still in flight). Cached in `ask_cache`
under prep's `examplesCacheKey`; the row holds ids only and the hanzi is re-fetched from
`/api/dict/entries` at render, so no dictionary text is redistributed from the cache. Hidden
entirely — not styled away — when `settings.examplesOnBack` is false; `undefined` on a legacy
settings row reads as **on**, per prep §6.

**An empty answer is a normal answer**, not an error: one quiet line, and `cacheable: false`
so it is never written to the cache. A beginner who knows too few words for a sentence to be
buildable gets the line today and sentences later, with no cache row standing in the way.

## Things the merge should know

- **`review-session.tsx` is the only shared file I touched.** If builder C is putting the
  recall box on the same card, the two conflicts are one import line and one prop on
  `<ReviewCard>`. My prop is `examples={examplesOnBack ? <ExampleSentences key={card.id} … /> : null}`
  and the `examplesOnBack` line above it; both are additive.
- **`withDeadline` (`lib/ai/examples.ts`) is a public copy of a private helper.**
  `app/api/ask/route.ts` has the same seven lines as a module-private `withTimeout`. I did not
  edit the ask route (not mine, and a route importing another route is fragile), so a small
  cleanup for whoever merges: point the ask route at `withDeadline` and delete its copy.
- **The examples cache key does not include the known set** (prep's design: promptVersion,
  provider, entryId, senseIndex, estimatedBand). So within one band, the sentences a learner
  saw on Monday are the sentences they see on Friday, even though they know more words by
  then. It self-corrects when the band estimate moves. If that ever feels stale, the fix is a
  key part, not a filter change — and it would orphan existing rows, which is why I did not
  take it.
- **Support is capped at 40 entries** (`SUPPORT_CAP`), frequency-ordered before the cut, out
  of ≤200 headwords the client sends. A live provider therefore sees a good working
  vocabulary, not the learner's whole lexicon.
- **`selectProvider` is mocked in `tests/unit/ai/examples-route.test.ts`** (partial mock, the
  real schemas kept) so a stub can cite a word the learner does not know, write its own
  characters, throw, hang and answer off-schema. That mock is the only way "the filter
  enforces" can be tested at all — the fake never misbehaves. Nothing in `lib/ai/**` was
  changed to make it possible.
- **No speak button on a sentence.** `SpeakButton` renders a visible "No voice" label when
  the browser has no Mandarin voice, and two of those under a card back is noise. Worth adding
  when TTS is verifiable somewhere.
- A **phrase card** renders no block at all (no entry to be about), and the component returns
  `null` before any fetch.

## Gates

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | pass |
| `pnpm lint` | pass, no warnings |
| `pnpm test` | **508** in 51 files (478 in 48 at the branch point: +30) |
| `pnpm build` | pass (Turbopack) |
| `PORT=3001 pnpm e2e` | **81/81** (78 at the branch point: +3) |

Server killed, port 3001 free. `/home/user/v0-anchor` untouched.

**One environmental note for whoever re-runs the suite.** While three builders share four
CPUs, `pnpm test` intermittently fails 3–12 cases with `Test timed out in 5000ms`, always on
the first `data/dict.json` load in a worker (`tests/unit/dict/*`, `tests/unit/lists/draw`,
`tests/unit/ai/ground`). It reproduces **on a clean tree with my work stashed** — I checked —
so it is load, not this branch. The clean full-suite run recorded above was taken at low load;
at load average 8 the same command fails. Nothing here changes the 35 MB load path.
