/**
 * The local backup's round trip (docs/plans/web.md W5).
 *
 * **This is the test that replaces two rows of the wave-0 guard.** That guard
 * exists because the dangerous `exportAll` is not a missing one — it is one that
 * resolves a plausible empty `Snapshot`, which is a backup that silently
 * restores nothing and looks healthy in every test that does not assert
 * content. So this file asserts content, and the first case below is the guard's
 * spirit stated directly: a snapshot of a populated database is not empty.
 *
 * Two rules from the interface's doc comment are what the cases are shaped
 * around:
 *
 * - **Tombstones survive.** `exportAll`/`importAll` are the only two members
 *   allowed to see `deletedAt !== null` rows, because a round trip that drops
 *   them resurrects deleted cards on the next sync. The fixture therefore
 *   contains a soft-deleted list *and* a soft-deleted list member.
 * - **It is provable through the seam.** Nothing here opens a Dexie table.
 *   Everything is `Repository`: `exportAll()` is both the thing under test and
 *   the instrument, `resetAll()` is the wipe, and the domain accessors are what
 *   say the restored database behaves the same as the one that was dumped.
 *   Reaching past the seam into Dexie to check is what the criterion forbids —
 *   and it would also prove the wrong thing, since the guarantee is a
 *   `Repository`-level one.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { serializeSnapshot, snapshotCounts, snapshotFilename, snapshotSummary } from '@/lib/db/export';
import { parseSnapshot, SnapshotError, upgradeSnapshot, validateSnapshot } from '@/lib/db/import';
import type { Repository, Snapshot } from '@/lib/db/repository';
import { DB_VERSION, DEFAULT_CARD_DIRECTION, STORES } from '@/lib/db/schema';
import { context, DASUAN, freshRepository, KANKAN } from './fixtures';

let close: (() => void) | undefined;

function setup(): Repository {
  const { db, repo } = freshRepository();
  close = () => db.close();
  return repo;
}

afterEach(() => {
  close?.();
  close = undefined;
});

/**
 * A database with something in every store, including the two tombstones the
 * criterion names. Built entirely through the repository, so the fixture itself
 * is evidence that the seam can produce the rows the seam has to round-trip.
 */
async function seed(repo: Repository) {
  const card = await repo.addCardFromEntry(DASUAN, context(), 0, 'test-dict');
  await repo.addCardFromEntry(KANKAN, undefined, undefined, 'test-dict');
  await repo.grade(card.id, 3);

  const kept = await repo.createList({ name: 'Keep me', kind: 'custom' });
  await repo.addListMembers(kept.id, [DASUAN.id, KANKAN.id]);
  // A soft-deleted MEMBER of a live list: the tombstone the list itself cannot
  // stand in for, because `removeListMembers` writes `deletedAt` on the member
  // row while the list stays alive.
  await repo.removeListMembers(kept.id, [KANKAN.id]);

  // …and a soft-deleted LIST, which takes a different code path (`deleteList`).
  const dropped = await repo.createList({ name: 'Delete me', kind: 'custom' });
  await repo.addListMembers(dropped.id, [DASUAN.id]);
  await repo.deleteList(dropped.id);

  await repo.markKnown([KANKAN.id]);
  await repo.saveText({ title: 'A passage', body: '我打算明天去北京。' });
  await repo.setSettings({ newPerDay: 7 });
  await repo.askCache.set('cache-key-1', { entries: ['打算|打算[da3 suan4]'], senses: [0] });

  return { kept, dropped };
}

describe('exportAll', () => {
  it('returns every store, and is not the empty value the wave-0 guard was about', async () => {
    const repo = setup();
    await seed(repo);

    const snapshot = await repo.exportAll();

    expect(snapshot.format).toBe(1);
    expect(snapshot.dbVersion).toBe(DB_VERSION);
    expect(snapshot.createdAt).toBeGreaterThan(0);
    // Exactly the schema's stores — derived from `STORES`, so a store added
    // later is a failure here rather than a store silently missing from backups.
    expect(Object.keys(snapshot.rows).sort()).toEqual(Object.keys(STORES).sort());

    const counts = snapshotCounts(snapshot);
    // Every store has rows. This is the assertion the guard's "plausible empty
    // value" failure could not survive.
    for (const [store, count] of Object.entries(counts)) {
      expect(count, `${store} is empty`).toBeGreaterThan(0);
    }
    expect(snapshotSummary(snapshot)).toEqual({ cards: 2, reviews: 1 });
  });

  it('sees the tombstones the rest of the interface filters out', async () => {
    const repo = setup();
    const { kept, dropped } = await seed(repo);

    const snapshot = await repo.exportAll();

    // The seam's own accessors do not show them…
    expect((await repo.lists()).map((row) => row.id)).not.toContain(dropped.id);
    expect((await repo.listMembers(kept.id)).map((row) => row.entryId)).toEqual([DASUAN.id]);

    // …and the snapshot does, with `deletedAt` set.
    const deletedList = snapshot.rows.lists.find((row) => row.id === dropped.id);
    expect(deletedList, 'the soft-deleted list is missing from the snapshot').toBeDefined();
    expect(typeof deletedList?.deletedAt).toBe('number');

    const deletedMember = snapshot.rows.list_members.find(
      (row) => row.listId === kept.id && row.entryId === KANKAN.id,
    );
    expect(deletedMember, 'the soft-deleted list member is missing from the snapshot').toBeDefined();
    expect(typeof deletedMember?.deletedAt).toBe('number');
  });
});

describe('the round trip', () => {
  it('export → wipe → import restores the database byte for byte, tombstones included', async () => {
    const repo = setup();
    const { kept, dropped } = await seed(repo);

    const before = await repo.exportAll();
    const beforeBytes = serializeSnapshot(before);

    // The wipe goes through the seam too: `resetAll` is the `/settings` reset
    // and the demo seed's, i.e. the thing a learner can actually do to
    // themselves before reaching for a backup.
    await repo.resetAll();
    expect(await repo.allCards()).toEqual([]);
    expect(await repo.lists()).toEqual([]);
    expect((await repo.exportAll()).rows.cards).toEqual([]);

    await repo.importAll(before);

    const after = await repo.exportAll();
    // `createdAt` is when the dump was taken and is expected to differ; the rows
    // are what has to be identical, and the serializer is canonical (rows by
    // id, keys sorted) so this really is a byte comparison.
    expect(serializeSnapshot({ ...after, createdAt: before.createdAt })).toBe(beforeBytes);
    expect(after.rows).toEqual(before.rows);

    // And the same again read back through the domain API, because "the bytes
    // match" and "the app works" are two different claims.
    const cards = await repo.allCards();
    expect(cards.map((card) => card.entryId).sort()).toEqual([KANKAN.id, DASUAN.id].sort());
    const graded = cards.find((card) => card.entryId === DASUAN.id);
    expect(graded?.fsrs.reps).toBe(1);
    expect(graded?.context?.sentence).toBe('我打算明天去北京。');
    expect(await repo.allReviewsChronological()).toHaveLength(1);
    expect((await repo.getSettings()).newPerDay).toBe(7);
    expect(await repo.knownEntryIds()).toEqual([KANKAN.id]);
    expect((await repo.texts())[0]?.title).toBe('A passage');
    expect(await repo.askCache.get('cache-key-1')).toBeDefined();

    // The tombstones came back as tombstones — still invisible to the domain
    // API, still present in the dump. If the round trip had dropped them, the
    // deleted list would be back on screen and the removed member with it.
    expect((await repo.lists()).map((row) => row.id)).not.toContain(dropped.id);
    expect((await repo.listMembers(kept.id)).map((row) => row.entryId)).toEqual([DASUAN.id]);
    // `toBeDefined` first, then the timestamp: `undefined?.deletedAt` is
    // `undefined`, and `expect(undefined).not.toBeNull()` passes — so the
    // obvious spelling of this assertion is true of a round trip that dropped
    // the row entirely, which is the exact bug it is here to catch.
    const restoredList = after.rows.lists.find((row) => row.id === dropped.id);
    expect(restoredList, 'the soft-deleted list did not survive the round trip').toBeDefined();
    expect(typeof restoredList?.deletedAt).toBe('number');
    const restoredMember = after.rows.list_members.find(
      (row) => row.listId === kept.id && row.entryId === KANKAN.id,
    );
    expect(restoredMember, 'the soft-deleted member did not survive the round trip').toBeDefined();
    expect(typeof restoredMember?.deletedAt).toBe('number');
  });

  it('survives the file, not only the object', async () => {
    const repo = setup();
    await seed(repo);

    const before = await repo.exportAll();
    const file = serializeSnapshot(before);

    await repo.resetAll();
    await repo.importAll(parseSnapshot(file));

    const after = await repo.exportAll();
    expect(serializeSnapshot({ ...after, createdAt: before.createdAt })).toBe(file);
  });

  it('replaces rather than merges — this is restore, not sync', async () => {
    const repo = setup();
    await repo.addCardFromEntry(DASUAN, undefined, 0, 'test-dict');
    const snapshot = await repo.exportAll();

    // A card that exists only in the *current* database. A merge would keep it.
    await repo.addCardFromEntry(KANKAN, undefined, undefined, 'test-dict');
    expect(await repo.allCards()).toHaveLength(2);

    await repo.importAll(snapshot);

    const cards = await repo.allCards();
    expect(cards).toHaveLength(1);
    expect(cards[0]?.entryId).toBe(DASUAN.id);
  });

  it('leaves the database untouched when the import fails part-way', async () => {
    const repo = setup();
    await seed(repo);
    const good = await repo.exportAll();

    // A row that passes validation and then fails **inside** the write: a
    // function cannot be structured-cloned, so IndexedDB rejects it at
    // `bulkPut`, after the clear has already run. That is the shape of a quota
    // failure or of a damaged file that gets past the parser, and the answer
    // has to be that the learner still has their cards.
    //
    // It deliberately is NOT a row with a bad `id`: `validateSnapshot` catches
    // that before the transaction opens, so such a fixture would prove the
    // validator and say nothing about atomicity. (The validator's own case is
    // "never clears the database on a file it refuses", below.)
    const damaged = {
      ...good,
      rows: {
        ...good.rows,
        texts: [
          ...good.rows.texts,
          { ...good.rows.texts[0], id: 'uncloneable', body: (() => {}) as unknown as string },
        ],
      },
    };

    await expect(repo.importAll(damaged as Snapshot)).rejects.toThrow();

    const after = await repo.exportAll();
    expect(serializeSnapshot({ ...after, createdAt: good.createdAt })).toBe(serializeSnapshot(good));
  });
});

describe('the serializer', () => {
  it('is canonical: the same rows in a different order are the same bytes', async () => {
    const repo = setup();
    await seed(repo);
    const snapshot = await repo.exportAll();

    const shuffled: Snapshot = {
      ...snapshot,
      rows: { ...snapshot.rows, cards: [...snapshot.rows.cards].reverse() },
    };

    // `backend.md` B5 reads the same rows from PostgREST and must produce a
    // byte-identical file. PostgREST's order is not Dexie's, so this property is
    // the whole reason the serializer sorts.
    expect(serializeSnapshot(shuffled)).toBe(serializeSnapshot(snapshot));
  });

  it('keeps array order inside a row, because a gloss list is a sequence', async () => {
    const repo = setup();
    await repo.addCardFromEntry(DASUAN, undefined, 0, 'test-dict');
    const snapshot = await repo.exportAll();
    const written = JSON.parse(serializeSnapshot(snapshot)) as Snapshot;
    const word = written.rows.words[0];
    expect(word?.snapshot.glosses).toEqual(DASUAN.glosses);
  });

  /**
   * The one number the learner weighs "it cannot be undone" against. Everything
   * else about a snapshot counts tombstones on purpose; this does not, because
   * the rest of the app's card count (`cardCountsByState`) does not either, and
   * two rules on one screen with an irreversible button between them is how a
   * learner approves the wrong thing.
   */
  it('counts LIVE cards in the confirmation, while the snapshot still carries the tombstones', async () => {
    const repo = setup();
    await repo.addCardFromEntry(DASUAN, undefined, 0, 'test-dict');
    const card = await repo.addCardFromEntry(KANKAN, undefined, undefined, 'test-dict');
    const list = await repo.createList({ name: 'Gone', kind: 'custom' });
    await repo.deleteList(list.id);

    // Tombstone a card through the seam: the only writer that does it is the
    // list delete above, so this one is done by hand through `importAll`'s own
    // round trip — export, mark, import — which is itself the seam.
    const snapshot = await repo.exportAll();
    const tombstoned: Snapshot = {
      ...snapshot,
      rows: {
        ...snapshot.rows,
        cards: snapshot.rows.cards.map((row) =>
          row.id === card.id ? { ...row, deletedAt: Date.now() } : row,
        ),
      },
    };
    await repo.importAll(tombstoned);

    const after = await repo.exportAll();
    expect(after.rows.cards).toHaveLength(2); // the tombstone is still in the dump…
    expect(snapshotSummary(after).cards).toBe(1); // …and not in the number on screen.
    expect((await repo.cardCountsByState()).total).toBe(1); // which agrees with the app.
  });

  it('names the file after the day the learner pressed the button', () => {
    const at = new Date(2026, 8, 16, 9, 30).getTime();
    expect(snapshotFilename({ format: 1, dbVersion: 3, createdAt: at, rows: {} as never })).toBe(
      'tangram-backup-2026-09-16.json',
    );
  });
});

describe('reading a file that is not what it claims', () => {
  const envelope = (over: Record<string, unknown> = {}) => ({
    format: 1,
    dbVersion: DB_VERSION,
    createdAt: Date.now(),
    rows: Object.fromEntries(Object.keys(STORES).map((store) => [store, []])),
    ...over,
  });

  it('refuses a truncated download rather than throwing SyntaxError at the learner', () => {
    expect(() => parseSnapshot('{"format":1,"rows":{"cards":[')).toThrow(SnapshotError);
    try {
      parseSnapshot('not json at all');
    } catch (error) {
      expect((error as SnapshotError).problem).toBe('not-json');
      expect((error as SnapshotError).message).toMatch(/not readable/i);
    }
  });

  it('refuses a newer envelope format and a newer schema', () => {
    expect(() => validateSnapshot(envelope({ format: 2 }))).toThrow(/newer version/i);
    expect(() => validateSnapshot(envelope({ dbVersion: DB_VERSION + 1 }))).toThrow(/newer version/i);
    try {
      validateSnapshot(envelope({ dbVersion: DB_VERSION + 1 }));
    } catch (error) {
      expect((error as SnapshotError).problem).toBe('future-schema');
    }
  });

  it('refuses a file with a store missing — a restore that would empty it', () => {
    const rows = Object.fromEntries(
      Object.keys(STORES)
        .filter((store) => store !== 'reviews')
        .map((store) => [store, []]),
    );
    try {
      validateSnapshot(envelope({ rows }));
      expect.unreachable('a snapshot with no reviews store must be refused');
    } catch (error) {
      expect((error as SnapshotError).problem).toBe('missing-store');
      expect((error as SnapshotError).message).toContain('reviews');
    }
  });

  /**
   * The sharpest refusal in the file, and the one nothing else would catch.
   *
   * IndexedDB silently omits a row from an index when the key path holds a
   * value that is not a valid key — no error, no rejection. A restored card
   * whose `due` is a string is listed by `allCards()`, counted by
   * `cardCountsByState()`, and never returned by the due queue: the restore
   * reports success, the card count is right, and Practice is empty forever.
   * `backend.md` B5 feeds the same door from PostgREST, which returns numerics
   * as strings by default, so this is a real shape rather than a hostile one.
   */
  it('refuses a card whose `due` is not a number, because IndexedDB would just hide it', async () => {
    const repo = setup();
    await seed(repo);
    const good = await repo.exportAll();

    // Proof of the mechanism first, so the refusal below is anchored to a fact
    // rather than to a belief about IndexedDB.
    const stringDue = {
      ...good,
      rows: {
        ...good.rows,
        cards: good.rows.cards.map((card) => ({ ...card, due: String(card.due) as unknown as number })),
      },
    };
    expect(() => validateSnapshot(stringDue)).toThrow(/damaged “due”/);

    for (const due of [null, undefined, 'x', Number.NaN]) {
      const damaged = {
        ...good,
        rows: { ...good.rows, cards: good.rows.cards.map((card) => ({ ...card, due })) },
      };
      expect(() => validateSnapshot(damaged as unknown as Snapshot), String(due)).toThrow(
        SnapshotError,
      );
    }

    // …and the database is untouched by the attempt.
    await expect(repo.importAll(stringDue as unknown as Snapshot)).rejects.toThrow(SnapshotError);
    expect(await repo.allCards()).toHaveLength(2);
  });

  it('refuses two rows with the same id, which bulkPut would collapse and call success', async () => {
    const repo = setup();
    await seed(repo);
    const good = await repo.exportAll();
    const doubled = {
      ...good,
      rows: { ...good.rows, texts: [...good.rows.texts, { ...good.rows.texts[0] }] },
    };
    expect(() => validateSnapshot(doubled)).toThrow(/same id/);
  });

  it('refuses a row nested deeper than any row shape goes', () => {
    const rows = Object.fromEntries(Object.keys(STORES).map((store) => [store, []]));
    let deep: unknown = 'bottom';
    for (let i = 0; i < 40; i += 1) deep = { deep };
    // Otherwise it imports, and every LATER export throws `RangeError` inside
    // the recursive canonical form — a permanently broken backup button with no
    // way out through the UI.
    expect(() =>
      validateSnapshot(envelope({ rows: { ...rows, texts: [{ id: 't', body: deep }] } })),
    ).toThrow(SnapshotError);
  });

  it('refuses a row with no id, and an unknown table', () => {
    const rows = Object.fromEntries(Object.keys(STORES).map((store) => [store, []]));
    expect(() =>
      validateSnapshot(envelope({ rows: { ...rows, texts: [{ title: 'no id' }] } })),
    ).toThrow(/damaged row/i);
    expect(() => validateSnapshot(envelope({ rows: { ...rows, sessions: [] } }))).toThrow(
      /unknown table/i,
    );
  });

  it('refuses anything that is not an envelope at all', () => {
    for (const value of [null, 42, 'hello', [], {}, { format: 1 }]) {
      expect(() => validateSnapshot(value)).toThrow(SnapshotError);
    }
  });

  it('never clears the database on a file it refuses', async () => {
    const repo = setup();
    await seed(repo);
    const before = await repo.exportAll();

    await expect(repo.importAll({ format: 9 } as unknown as Snapshot)).rejects.toThrow(SnapshotError);

    const after = await repo.exportAll();
    expect(serializeSnapshot({ ...after, createdAt: before.createdAt })).toBe(
      serializeSnapshot(before),
    );
  });
});

describe('a snapshot cut at an older DB_VERSION', () => {
  it('stamps the card direction v3 added, so a restored card is not invisible', async () => {
    const repo = setup();
    await repo.addCardFromEntry(DASUAN, undefined, 0, 'test-dict');
    const current = await repo.exportAll();

    // What a v2 dump looks like: the same rows, without the column v3 declared
    // an index over.
    const old: Snapshot = {
      ...current,
      dbVersion: 2,
      rows: {
        ...current.rows,
        cards: current.rows.cards.map((card) => {
          const rest: Record<string, unknown> = { ...card };
          delete rest.direction;
          return rest as unknown as typeof card;
        }),
      },
    };

    expect(upgradeSnapshot(old).rows.cards[0]?.direction).toBe(DEFAULT_CARD_DIRECTION);

    await repo.resetAll();
    await repo.importAll(old);

    // The proof that the stamp matters: `cardForEntry` reads the compound
    // `[entryId+direction]` index, and IndexedDB does not index a row whose key
    // path is missing. Without the upgrade this card exists and cannot be found.
    const found = await repo.cardForEntry(DASUAN.id, 0, DEFAULT_CARD_DIRECTION);
    expect(found?.entryId).toBe(DASUAN.id);
  });

  /**
   * The v1 → v2 half, and it is the same failure one store over: `systemKey` is
   * a column, and a `lists` row without it is invisible to the unique index —
   * so `ensureSystemLists` makes all eight system lists again and the restored
   * members hang off the orphans. `web.md` W5's first pass stamped only
   * `direction` and its comment claimed v2 was a pure index declaration;
   * the adversarial review read `TangramDb`'s v2 `.upgrade()` and found it
   * stamping the key.
   */
  it('stamps the system-list key v2 added, so a restore does not duplicate the eight lists', async () => {
    const repo = setup();
    // `createList` writes `systemKey` itself, so a v1 dump is forged by taking
    // it back off — which is exactly what a database that stopped at v1 holds.
    const looked = await repo.createList({ name: 'Looked up', kind: 'looked-up' });
    const current = await repo.exportAll();
    expect(current.rows.lists.find((row) => row.id === looked.id)?.systemKey).toBe('looked-up');

    const v1: Snapshot = {
      ...current,
      dbVersion: 1,
      rows: {
        ...current.rows,
        lists: current.rows.lists.map((row) => {
          const rest: Record<string, unknown> = { ...row };
          delete rest.systemKey;
          return rest as unknown as typeof row;
        }),
      },
    };

    const upgraded = upgradeSnapshot(v1);
    expect(upgraded.rows.lists.find((row) => row.id === looked.id)?.systemKey).toBe('looked-up');

    await repo.resetAll();
    await repo.importAll(v1);

    // The real failure, stated as the app meets it: `createList` is idempotent
    // per natural key and finds the existing row **through the `systemKey`
    // index**. Without the stamp the restored row is invisible to that index,
    // so this call makes a second "Looked up" and the restored members hang off
    // the orphan.
    const again = await repo.createList({ name: 'Looked up', kind: 'looked-up' });
    expect(again.id).toBe(looked.id);
    expect(await repo.lists()).toHaveLength(1);
  });

  it('keeps the oldest of two rows claiming one system key, and retires the later one', () => {
    // Mirrors the v2 upgrade's own rule: the oldest row is the one the app has
    // been using, and a restore that kept both would fail the unique index.
    const base = { kind: 'looked-up' as const, name: 'Looked up', owner: 'user' as const, active: true, order: 0 };
    const v1: Snapshot = {
      format: 1,
      dbVersion: 1,
      createdAt: 0,
      rows: {
        ...(Object.fromEntries(
          Object.keys(STORES).map((store) => [store, []]),
        ) as unknown as Snapshot['rows']),
        lists: [
          { ...base, id: 'newer', createdAt: 200, updatedAt: 200, deletedAt: null },
          { ...base, id: 'older', createdAt: 100, updatedAt: 100, deletedAt: null },
          { ...base, id: 'gone', createdAt: 50, updatedAt: 50, deletedAt: 60 },
        ],
      },
    };

    const lists = upgradeSnapshot(v1).rows.lists;
    // Input order is preserved — a function that reorders its input cannot be
    // compared against anything.
    expect(lists.map((row) => row.id)).toEqual(['newer', 'older', 'gone']);
    expect(lists.find((row) => row.id === 'older')?.systemKey).toBe('looked-up');
    expect(lists.find((row) => row.id === 'newer')?.systemKey).toBeUndefined();
    expect(lists.find((row) => row.id === 'newer')?.deletedAt).not.toBeNull();
    // A tombstone never holds the key: deleting a system list is a reset, and
    // `ensureSystemLists` has to be able to make it again.
    expect(lists.find((row) => row.id === 'gone')?.systemKey).toBeUndefined();
  });

  it('leaves a current snapshot alone', async () => {
    const repo = setup();
    await seed(repo);
    const snapshot = await repo.exportAll();
    expect(upgradeSnapshot(snapshot)).toBe(snapshot);
  });
});

describe('a backup that has been edited by hand', () => {
  it('cannot change the shape of the object it is serialised into', () => {
    // `JSON.parse` gives `__proto__` an OWN property, and a serializer that
    // copies keys onto a `{}` literal would assign the prototype instead. The
    // canonical form has to come back with it as data.
    const hostile = JSON.parse(
      '{"format":1,"dbVersion":3,"createdAt":0,"rows":{"words":[],"cards":[],"reviews":[],"lists":[],"list_members":[],"known_words":[],"texts":[{"id":"t","__proto__":{"polluted":true}}],"settings":[],"ask_cache":[]}}',
    ) as Snapshot;

    const written = serializeSnapshot(validateSnapshot(hostile));
    expect(written).toContain('__proto__');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
