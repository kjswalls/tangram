# HANDOFF — P5 (Reader / mining)

PLAN.md §3.5 and the §4 "Phases 4–5" P5 row. Everything below is a decision the
plan left open, a place I built on someone else's seam, or something the merge
needs to know. Nothing frozen was edited.

## What landed

```
lib/reader/sentence.ts              the sentence span around a token
lib/reader/states.ts                the colouring pass (wraps lib/srs/states.ts)
lib/stores/reader.ts                rewritten (P5 owns it)
lib/stores/lookup.ts                ONE optional field added — see "Frozen and shared" below
app/read/page.tsx                   placeholder replaced
components/reader/reader-view.tsx   compose box or reading view
components/reader/text-composer.tsx paste, save, reopen
components/reader/reader-screen.tsx the reading view and the tap → openLookup call
components/reader/reader-text.tsx   token rendering, one delegated click handler
components/reader/reader-lookup.tsx the panel: LookupPanel + EntryDetail + Mark known + Extend
components/reader/use-reader-index.ts  the live colouring inputs
tests/unit/reader/{sentence,states,store,paragraph}.test.ts
tests/e2e/p5/{reader.spec.ts,helpers.ts,paragraph.ts}
```

## Decisions the plan did not make

**A token's colour is the strongest state of its readings.** Segmentation never
truncates `entryIds` (§3.2), so 了 arrives carrying both `le` and `liǎo`. A
learner with a card for `le` has met the word, so the token is `learning`;
`known` beats `learning` beats `new`. `lib/reader/states.ts`, unit-pinned.

**A `word` token with no entry (`via: 'fallback'`) is `new`, not uncoloured.** It
is a word the learner demonstrably has not met — a name, a rare character. Only
`text` tokens (punctuation, Latin, whitespace) have no state at all, and those
are rendered plain and are not buttons, per §3.5.

**Only the bands at or below `settings.knownBand` are fetched.** `wordState` can
only act on `hskBand <= knownBand`, so pulling bands 3–7 would change no answer
and cost 9,000 rows. `ReaderIndex.bands` therefore covers bands 1..knownBand
only — do not read it as "this word's band".

**"Mark known" takes the token's most frequent reading, not all of them.**
`markKnown` also pushes any existing card out of the queue for a year
(`lib/db/dexie.ts`), so marking every reading of 了 known would evict a card for
`liǎo` that the learner is studying. The panel marks `entryIds[0]` — the reading
`EntryDetail` preselects — and says so in one line when the headword has more
than one. The token still recolours, because of the strongest-reading rule above.

**The colouring inputs are read with `useLiveQuery`, not a one-shot read.**
`dexie-react-hooks` was already a dependency with no consumer. The reader is the
one screen where the answer changes while you are looking at it: Add writes a
card, "Mark known" writes a `known_words` row, and `/settings` can move
`knownBand` in another tab. Dexie observes `cards`, `known_words` and `settings`,
so both recolour with no invalidation and no polling, and no re-segmentation. One
read per change, not one per token — the "single repository read" the row asks
for, kept true as the data moves.

**Segmentation lives in the store, not the view.** The tokens are part of the
state that has to survive a client-side navigation; keeping them in a component
would re-post the paragraph to `/api/dict/segment` on every trip back from
`/review`. `read()` is a no-op when `tokenizedBody === body`, and a response that
lands after the learner has typed something else is dropped (unit-tested) —
tokens index a string by offset, and stale ones would highlight the wrong
characters.

**Saving is not optional.** "Save and read" is one button: `repo.saveText` then
segment. The store survives navigation, the `texts` row survives a reload, and
there is no state in which a pasted page is lost to a refresh. Editing the body
clears `textId`, so an edit saves as a new row instead of overwriting the one on
the reopen list.

**The sentence keeps its terminator and drops the leading one.** `。！？；…\n`
and ASCII `.!?` bound it; `，`, `、` and `：` deliberately do not, because a
Chinese sentence commonly runs three clauses on commas and cutting there throws
away the context the card exists to carry. Same convention as
`sentenceAround` in `lib/dev/seed.ts`.

**The ≤200 cap windows around the target rather than truncating from the left.**
`offset`/`length` are re-derived after every trim and after the window, so
`sentence.slice(offset, offset + length)` is always the word — which is exactly
what `lib/srs/context.ts` highlights on the card back. A target longer than 200
characters is itself truncated, window starting at the word.

## Frozen and shared files

**Nothing frozen was edited.** `components/lookup/lookup-panel.tsx` is rendered,
not touched (P4 is in it). `components/lookup/entry-detail.tsx` (P1's) is
rendered, not touched: it already keeps an incoming context and only fills in the
missing `query`, so the reader's Add carries `{sentence, offset, length,
source:'reader', addedAt}` straight through `addCardChecked` — the "Looked up"
join and the context merge come free.

**`lib/stores/lookup.ts` gained one optional field: `entryIds`.** The task
assigned me this change. `LookupRequest` in the frozen `lib/types.ts` is a query
plus provenance, and a reader tap knows more than that — the DAG already resolved
the token to its readings *in context*, and asking the search router to re-derive
them from the bare string would let it guess differently (了 is `le` here because
of the words around it). So `LookupOpenRequest = LookupRequest & {entryIds?}`
lives in the store, `openLookup` stores it, and `setQuery`/`clearSearch`/
`closeLookup` clear it — a caller's ids answer the query they arrived with and
nothing else. `/lookup` ignores the field entirely, so P1's view is unaffected.
If P4's ask panel ever wants the same shortcut it is already there.

**Needs: none.** No frozen file needs a change for P5.

## For the merge

- `/read` mounts `ReaderView`, which is the only client boundary; the route is
  still statically rendered.
- The reader adds through `addCardChecked` (`lib/lists/looked-up.ts`), never the
  repository directly, so a reader Add joins "Looked up" and a repeat Add
  delivers its sentence onto an existing card, exactly as HANDOFF.md asks.
- A reader Add is an explicit source, so it never charges `settings.introduced`
  and is always in today's queue. Nothing in P5 creates a non-explicit card.
- `ReaderScreen` calls `closeLookup()` on unmount. The lookup store is a module
  singleton, and a reader context left armed would otherwise attach a stranger's
  sentence to the next card added from `/lookup`.
- The e2e specs copy the demo paragraph into `tests/e2e/p5/paragraph.ts` rather
  than importing `lib/dev/seed.ts` (Playwright would pull Dexie into Node).
  `tests/unit/reader/paragraph.test.ts` asserts the copy still matches the seed,
  so a change to `DEMO_PARAGRAPH` fails the unit suite rather than rotting the
  specs.
- `tests/e2e/p5/helpers.ts` re-exports `ready`/`resetApp` from
  `tests/e2e/p3/helpers.ts`; P3's file is imported, not modified.

## Known limits

- **Extend is a button, not a second tap.** §3.5 says "tap the next token to look
  up the concatenated span". A second tap is ambiguous with "look up that other
  word" — which is the far commoner intent — so the panel offers
  `Extend to <next token>` while it is open, and the span grows one word at a
  time. The lookup itself is what §3.5 asks for: `/api/dict/search` on the
  concatenation, exact headword first (`买` + `东西` → `买东西`, e2e-pinned).
- **The extended span is looked up by search, not by id**, because a
  concatenation is not a token and has no `entryIds`. If the dictionary has no
  headword for it the panel says so rather than showing a near miss.
- **A polyphone whose readings differ in traditional form** (`了` → `了`/`瞭`)
  shows the first reading's traditional headword in the panel's "traditional"
  line. The readings themselves are all listed and correct; only that one line
  picks a representative.
- **Two texts cannot be open at once**, and there is no delete for a saved text —
  the repository has no `deleteText`, and nothing in v1 asked for one.
- **No virtualisation.** A 2,000-character text is ~1,300 tokens, one delegated
  click handler, and one memoised token list; it renders and recolours without a
  visible pause in the container. A book-length text would want windowing.

## Checks

| Check | Result |
|---|---|
| `npx tsc --noEmit` | pass |
| `pnpm lint` | pass |
| `pnpm test` | pass — 32 files, 330 tests (46 added) |
| `pnpm build` | pass (Turbopack) |
| `PORT=3005 pnpm e2e` | pass — 62/62 (7 added) |

Screenshots at 1280×900 and 390×844 were taken against the production build:
tokens coloured, the panel beside the text on desktop and as a bottom sheet on a
phone, zero page errors and zero console errors on both.
