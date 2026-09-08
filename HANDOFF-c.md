# HANDOFF-c — the debt list (builder C, branch `c`)

Five items, all recorded as known debt in `HANDOFF.md`, worked in the order the
brief gave them. Every one is done; each is its own commit.

| # | Commit | What |
|---|---|---|
| 1 | `1ca36de` | Phrase card fronts render their tokens, flagged |
| 2 | `8e17e1d` | A phrase card records the dictionary it was cut from |
| 3 | `30dc92c` | Two tabs can no longer double-introduce the day |
| 4 | `b4256e5` | The worker's cache name is the build's id |
| 5 | `72f558d` | The lists button says which kind of disabled it is |

Gates on `72f558d`: `npx tsc --noEmit` pass · `pnpm lint` pass, no warnings ·
`pnpm test` **506** in 52 files (478 before: +28) · `pnpm build` pass ·
`PORT=3003 pnpm e2e` **82/82** (78 before: +4). No server left running; port 3003
is free. `/home/user/v0-anchor` untouched.

---

## What the merge must know

### `lib/db/schema.ts` and `lib/db/repository.ts` changed (both frozen to A and B)

Every change is additive; no existing signature changed and no existing caller
needed editing.

- **`ListRow.systemKey?: string`** and **`systemListKey(kind, band)`** in
  `schema.ts`. `'looked-up'` or `'hsk:<band>'` for a system list, `undefined` for
  a list the learner made and for a tombstone.
- **`DB_VERSION` is now `2`**, and `STORES_V2` (= `STORES_V1` plus `&systemKey`
  on `lists`) is the current definition, exported as `STORES` too. `STORES_V1` is
  kept verbatim because Dexie needs v1 declared to upgrade a database that
  stopped there. **This is the one thing in this branch a merge could get wrong:
  if another branch also bumps the version, the two upgrades must be renumbered,
  not merged into one.**
- **`Repository.addPhraseCard` takes an optional fourth argument, `dictVersion`**
  — exactly as `addCardFromEntry` got one in Phase 0. Three-argument calls still
  compile and still stamp `'unknown'`.
- **`Repository.introduceCard(entry, context, dayKey, dictVersion?)`** returns
  `{card, created, settings}` (`IntroducedCard`), writing the card and charging
  `settings.introduced[dayKey]` in one transaction.
- **`Repository.bumpIntroduced(dayKey, count)`** does the counter's
  read-modify-write in one transaction. `count <= 0` is a no-op, never a
  decrement.

`lib/db/dexie.ts` implements all of it. Its internal `writeCard(...)` is the old
body of `addCardFromEntry`, extracted so `introduceCard` can run the same work
inside a *wider* transaction; `addCardFromEntry`'s behaviour is unchanged.

### `package.json` gained one script, and `public/sw.js` is now generated

- `"sw": "tsx scripts/build-sw.ts"`, and `"build"` is
  `pnpm data:ensure && next build && pnpm sw`. Nothing else in `package.json`
  changed; `pnpm-lock.yaml` is untouched and no dependency was added.
- **`public/sw.js` is gitignored.** The committed source is
  `scripts/sw.template.js`; the script substitutes `.next/BUILD_ID` for its
  `__TANGRAM_BUILD_ID__` placeholder. A fresh clone has no `public/sw.js` until
  something runs a build — which `pnpm e2e` does through its `webServer`. Anyone
  editing the worker edits the template.

### Files touched that are not on builder C's list

- `components/lookup/ask-panel.tsx` — one line, passing `ready?.dictVersion` into
  `addPhraseCardChecked` (item 2 does nothing in production without it).
- `components/lists/list-card.tsx` — `data-mark-state` on the "Mark all known"
  button (item 5; the brief's "the UI genuinely reflects" half).
- `tests/e2e/p3/today.spec.ts` — the flaky spec itself (item 5).
- `tests/unit/settings/card-toggles.test.tsx` — one assertion,
  `expect(DB_VERSION).toBe(1)`, which item 3 makes false. It now pins what that
  test was actually about: the *settings store's* definition is `'id'` at both
  versions, which is why the two new settings fields needed no bump. If builder B
  also edits this file, this is the line to reconcile.
- `tests/unit/db/import.test.ts` — the same version pin, plus the v1/v2 store
  comparison.

---

## Item 1 — the phrase front (`components/review/phrase-face.tsx`)

The stub prep left is filled in. A phrase card's stored `PhraseToken[]` is drawn
one token at a time; the fallback to `snapshot.simp` survives for a snapshot with
no usable token array.

**The rule that decides the flag is not the stored flag alone.** A token with no
`entryId` is ungrounded *whatever the row says*, because the card this fix exists
for — one written before the Add-time refusal existed — carries no `unverified`
at all. The two cases are marked apart because they are different failures:

- no `entryId` → `data-ai-generated="true"`, "AI-generated: no dictionary entry
  stands behind this token";
- cited but `unverified` → `data-unverified="true"`, "Unverified: these
  characters are not a word this dictionary lists".

**No pinyin on the front.** The ask panel prints a reading under every token
because it is answering a question; this is the front of a review card, where the
reading is the answer. The flag travels as a marked glyph plus a warning line.

Testids: `phrase-face` (with `data-tokens`, `data-unverified`),
`phrase-face-token`, `phrase-face-warning`. `tests/unit/review/phrase-face.test.tsx`
(7 cases) and `tests/e2e/c/phrase-front.spec.ts` (2).

## Item 2 — `dictVersion` on a phrase card

Nothing is migrated, per the brief: no phrase card that matters exists yet, and a
phrase snapshot is never re-resolved, so a `'unknown'` row is inert.

`tests/unit/lists/seed.test.ts` gained the assertion. **Deviation worth knowing:**
the demo seed writes no phrase card, and giving it one would break the full-loop
integration spec, which adds *the same* sayIt phrase from the ask panel and would
find it already there. So the new case seeds the demo and then writes a phrase
card through `addPhraseCardChecked` with the source's `dictVersion` — the same
path the panel takes — and asserts that no card in the resulting database says
`'unknown'`.

## Item 3 — two tabs

Both halves are durable; neither is a `BroadcastChannel`.

- **The system lists.** `lists.systemKey` is unique, so the database refuses a
  second `'looked-up'` or a second `'hsk:3'`; `createList` does its
  read-then-insert inside one transaction, so the normal path returns the other
  tab's row rather than raising. The in-flight memo in `ensureSystemLists` stays
  as an optimisation and is no longer load-bearing.
- **A tombstone releases the key.** `deleteList` deletes the `systemKey` property
  when it tombstones, because deleting a system list is a *reset* —
  `ensureSystemLists` has to be able to make it again (HANDOFF.md), and a
  tombstone holding the unique key would make that impossible forever.
- **The upgrade repairs what the bug already did.** The v2 upgrade stamps keys in
  `createdAt` order and tombstones a duplicate a v1 database is already holding
  (the oldest row is the one the app has been using). Its `list_members` rows are
  left dangling under a dead list; they are unreadable and harmless.
- **The counter.** `introduceCards` no longer counts creations from a card set
  read before the draw — a set a second tab invalidates — and no longer does its
  own read-modify-write. Each candidate goes through `repo.introduceCard`, where
  "did this call create the card?" and "charge the day" are one transaction.
  `chargeIntroduced` (the seed's path) goes through `bumpIntroduced`.
  `IntroduceOptions.carded` is **gone**; `today.ts` no longer passes it.
- **One extra fix this turned up.** `loadToday` built its final queue from
  `cards-read-at-start + created-here`, so a tab whose words the *other* tab had
  just introduced reported `0 new` over rows that existed in the database — and
  sent the learner to a review it had said was empty. It now re-reads the card
  table whenever a draw ran.

`tests/unit/lists/two-tabs.test.ts` drives two `TangramDb` connections to one
fake-indexeddb database: concurrent `ensureSystemLists`, concurrent `loadToday`,
concurrent `introduceCards`, the constraint refusing a blind insert, the lost
update (`5 + 5` really is `10` — this one I checked fails on the old code, which
produced `5`), the no-decrement rule, the delete-and-recreate path, and the v1
upgrade with a duplicate in it.

## Item 4 — the worker's cache name

`activate` already deleted every cache that was not the current one; the current
one just never changed. It is now `tangram-<BUILD_ID>`, so a deploy purges the
previous build's chunks. Network-first navigation, `/offline.html`, the `/api`
bail-out and the `storable()` rule are byte-identical — the generator substitutes
one string and a unit test asserts that the rest of the file is the template
verbatim.

The template lives in `scripts/`, not `public/`: a placeholder-stamped worker
served at `/sw.template.js` is a second worker one URL away from the real one.
With no `.next/BUILD_ID` the stamp is `dev` and the script says so — `pnpm dev`
never registers a worker anyway (`components/pwa/register-sw.tsx`).

`tests/unit/pwa/manifest.test.ts` now reads the template (a fresh clone has no
`public/sw.js`); `tests/unit/pwa/build-sw.test.ts` covers the generator;
`tests/e2e/c/sw-version.spec.ts` asserts the *served* worker carries this build's
id and that the running worker's cache is the only `tangram-*` cache on the
origin.

## Item 5 — the intermittent spec

**The suspect in HANDOFF.md was wrong, and the real cause is worth reading.**
`busy` is per-list and never disabled another band's button. What disables it is
`allKnown`: `knownCount` comes from `wordState`, which calls any word at or below
`settings.knownBand` (2 by default) known — so HSK 1 and HSK 2 become "All known"
the moment the background fill materialises their membership, with nothing
clicked. The spec was racing that fill: click first and it worked, fill first and
the button was disabled for the whole 30 s of click retries. It reproduced under
load because load is what let the fill get there first.

Fixed on both sides the brief allowed. The button carries
`data-mark-state="busy" | "all-known" | "idle"`, so "wait, this is in flight" and
"there is nothing left to do" are no longer the same grey. The spec waits for the
band's count to appear — the real signal that the card's state is settled — then
clicks only an idle button and asserts the end state either way. No timeout was
raised, nothing is skipped, and the test still marks HSK 3 known and still asserts
the day's words come from band 4. It runs in ~2.4 s.

`tests/unit/lists/list-card.test.tsx` pins the three states.

---

## Still open, for whoever picks this up

- **Phrase cards still do not join the "Looked up" list** (`HANDOFF.md`, Needs 2):
  membership joins on `entryId` and a phrase has none. Untouched here.
- **The v2 upgrade leaves `list_members` rows under a tombstoned duplicate list.**
  Nothing reads them; a sweep would need a repository member of its own.
- **`PhraseFace` marks an uncited token; it cannot *unmark* one.** A phrase card
  whose token cites an entry that has since left the dictionary still draws
  clean — the snapshot is what a card renders from, by design (§3.3), and
  re-resolving it against a rebuilt dictionary is the thing card snapshots exist
  to avoid.
- **`public/sw.js` being generated means a reviewer reading the repo sees the
  template.** If anyone adds tooling that lints or serves `public/` from a clean
  checkout, it must run `pnpm sw` first.
