# HANDOFF — P3 (lists, queue, Today, settings, seed)

Written by the P3 builder on branch `p3`. Kept separate from `HANDOFF.md` so the three
parallel worktrees do not conflict on one file; the merge should fold whatever it needs
into the main document.

Owned and changed here: `lib/lists/**`, `lib/dev/**`, `lib/stores/lists.ts`,
`app/(today)/**`, `app/lists/**`, `app/settings/**` (the Licenses section is untouched),
`components/lists/**`, `tests/unit/lists/**`, `tests/e2e/p3/**`. No frozen file was
edited.

---

## What the phase decided

**The daily cap counts introductions, not offers.** `settings.introduced[dayKey]` goes up
when a spine card is *created* (`lib/lists/introduce.ts`), which is the only place it is
written. A card that was introduced and never graded stays in today's queue and is not
charged again — instead it lowers how many more may be drawn
(`drawLimit = newPerDay − introducedToday − ungraded spine cards`). So a learner who opens
Today ten times sees the same ten words, and one who never grades never accumulates more
than `newPerDay` untouched cards a day. `buildQueue` returns `drawLimit` alongside
`newRemaining` for exactly this reason.

**Opening `/` is what introduces the day's new words.** `loadToday` draws candidates,
creates their cards and charges the counter, so the number on Today and the cards `/review`
will offer are the same rows and cannot drift. The alternative (introduce at review time)
would have made Today's count a prediction. One consequence to know: visiting Today spends
the day's allowance even if you never study, which is what §3.3's "grade 10 new, reload →
no further spine cards today" implies. `loadToday({introduce: false})` reports the counts
without creating anything.

**`buildQueue`'s signature is a superset of the Phase 0 stub's, but its semantics changed.**
It still accepts `{now, settings, due, candidates}`; it now also accepts `cards` (the whole
live set, from `repository.allCards()`), `newCandidates` (entries with no card yet, in draw
order), and `newPerDay`/`introducedToday` directly. **The change P2 should know about:**
existing New-state cards are no longer capped by `newRemaining` — they are all offered, and
the cap applies to the *draw*. The Phase 0 test that asserted the old behaviour was rewritten
(`tests/unit/lists/queue.test.ts`). If `/review` calls `buildQueue`, pass `cards` and read
`queue.cards`.

**HSK membership is `entryId` rows, materialised per list, and `words` rows are never
created in bulk.** PLAN §3.3 says "a `words` row for every spine word"; that is 11,028
`EntrySnapshot`s for a dictionary the app already ships, so `list_members` stores entry ids
(`lib/lists/members.ts`) and a `words` row appears only when a card does. `/lists` fills the
seven bands in the background, band by band, so the page renders immediately and the counts
arrive in order; `ensureMembers` is idempotent and shares one in-flight promise per list.

**Every explicit Add joins "Looked up" through `lib/lists/looked-up.ts`, not through the
repository.** `repository.addCardFromEntry` is frozen and knows nothing about lists, so
`addCardTracked(repo, entry, context, senseIndex?, dictVersion?)` wraps it and joins the
list when `context.source` is `lookup`, `ask` or `reader`. **P1, P4 and P5 should add through
`addCardTracked`** (`@/lib/lists`), or the merge should fold the join into
`lib/db/dexie.ts` — P2 owns that file's internals, so it was left alone here.

**The auto-draw skips a band the learner is assumed to know.** `collectDrawCandidates` skips
bands at or below `settings.knownBand` as well as bands below `spineStartBand`, because
`wordState` already calls those words known and a queue that argues with the reader's colours
is a bug. User-list members are only filtered by "already met" (a card, or `known_words`):
a word you put in a list by hand is a word you asked for.

**`/api/dict/search` is called when it exists.** `EntrySource.search` tries
`/api/dict/search?q=&limit=` first and accepts `Entry[]`, `{entries}` or `{results}`; on a
non-OK response it falls back to scanning the HSK bands (11k words, ranked by
`scoreEntry`). Once P1 lands, drop the fallback or keep it as the offline path — see the
TODO in `lib/lists/entry-source.ts`.

**The demo seed is deterministic and wipes first.** `loadDemo()` marks HSK 1–2 known,
creates eight cards (two `reader` with sentence + offset + length, two `lookup`, one `ask`,
two `list`, one `seed`), replays backdated grades through `repo.grade(id, rating, at)` so at
least three are due and at least two are mid-learning, saves one 142-character paragraph to
`texts`, and warms `ask_cache` with two rows. `resetAll()` empties every table. Card entries
are named by CC-CEDICT id with a band-3 fallback, so a dictionary rebuild cannot leave the
demo empty.

**Settings write through on change.** No Save button; the queue reads the row, not the form.
`script` is persisted and read by nothing yet — deliberate, per §6.8.

---

## Needs (frozen files, or another phase's ground)

1. **`dictVersion` is `'unknown'` on every card the lists layer creates.** `EntrySnapshot`
   requires it, `repository.addCardFromEntry` takes it as a 4th argument, and no route
   exposes `meta.version` — `/api/dict/entries` and `/api/dict/hsk` return entries only.
   *Change wanted:* add `meta: {version}` to `EntriesResponse`/`HskResponse` (P1's routes,
   `lib/dict/types.ts` is not frozen), then pass it through `EntrySource` and
   `introduceCards({dictVersion})`, which already takes it.
2. **No way to remove a list or a member.** `Repository` (frozen) has `createList` and
   `addListMembers` but no delete or rename, so a custom list is permanent and a word cannot
   be taken out of one. *Change wanted:* `deleteList(id)`, `removeListMembers(listId, ids)`,
   `renameList(id, name)` — all soft deletes; `list_members` already has `deletedAt`.
3. **The ask-cache key in the seed is a placeholder.** `demoAskCacheKey` is
   `sha1(JSON.stringify([promptVersion, provider, query, context, estimatedBand]))` per
   §3.4's *description*; Phase 4 owns the real derivation. When it lands, import it in
   `lib/dev/seed.ts` and delete `demoAskCacheKey`, so the demo's two warm rows are cache
   *hits* rather than orphans. `lib/dev/sha1.ts` is a dependency-free SHA-1 (test vectors in
   `tests/unit/lists/seed.test.ts`) if P4 wants it.
4. **Two open tabs would double-introduce.** `ensureSystemLists` and `loadToday` guard
   against concurrent calls inside one page (an in-flight promise per repository), but two
   tabs are two JS contexts over one IndexedDB: they could create the system lists twice and
   each charge the counter. A uniqueness constraint would need a repository change (frozen).
   Single-user, single-tab is v1's premise; worth a `BroadcastChannel` or a `[kind+band]`
   unique index if it ever stops being.

## Merge notes

- `lib/lists/queue.ts` and `tests/unit/lists/queue.test.ts` replace the Phase 0 stub and its
  test; `lib/lists/spine.ts` is unchanged.
- `app/(today)/page.tsx` and `app/lists/page.tsx` replace their placeholders;
  `app/settings/page.tsx` gained one import and one `<SettingsForm />`, and its Licenses card
  and `app/settings/attribution.tsx` are byte-identical to Phase 0.
- `lib/stores/lists.ts` keeps every member the Phase 0 shell had (`lists`, `settings`,
  `loading`, `error`, `load`, `setActive`, `updateSettings`) and adds `views`, `busy`,
  `filling`, `markAllKnown`, `createCustomList`, `addWords`, `fillMembers`.
- `tests/e2e/p3/tangram.d.ts` types `window.__tangram` globally so specs need no casts; it
  must stay in step with `components/shell/test-hooks.tsx`.
- New route `/lists/[id]`. The nav (frozen) is unchanged — it is reached from `/lists`.
- Nothing here imports `lib/dict/load.ts` (server-only fs) outside tests: the lists layer
  reaches the dictionary through `EntrySource`, which is HTTP in the browser and a direct
  index read in unit tests.

## Running the suite in this container

`playwright.config.ts` sets `reuseExistingServer: true`, and **a leftover `next start` on the
port is reused silently.** If that server predates your last build, the HTML it serves points
at chunk hashes that no longer exist on disk: the CSS and the changed page chunks answer 500,
the page renders unstyled and never hydrates, and the failures look like flaky timeouts
anywhere React does the work (Today's counts stuck on "—", nav links measuring 17px). Seven
tests failed that way here before the cause was found.

`lsof` is **not installed** in this container, so `lsof -i :3003` prints nothing whether or
not the port is taken — it is not a check. Use:

```bash
ps -eo pid,lstart,args | grep '[n]ext-server'   # the server renames itself; "next start" won't match
curl -s -o /dev/null -m 3 -w '%{http_code}\n' http://localhost:3003/
```

and `kill -9 <pid>` before a run whose build differs. `pkill -f 'next start -p 3003'` does
not match: once running, the process is `next-server (v16.3.4)`.
