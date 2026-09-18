/**
 * The frozen dictionary surface (docs/plans/data.md D1, acceptance criterion 1).
 *
 * `core.md`'s gate table and `ios.md` §4 wait on D1's **first commit** rather
 * than on the phase, so the criterion is not "it compiles" but "a sibling plan
 * can write `const store: DictStore = fake` and have it type-check, against a
 * module with no implementation behind it". Both halves are checked here, in
 * the commit that freezes them, because a freeze nobody can test is a freeze
 * that quietly thaws.
 *
 * There is no CI (CLAUDE.md), so this is where that rule lives.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import * as decompStoreModule from '@/lib/dict/decomp-store';
import * as sqlModule from '@/lib/dict/sql';
import * as storeModule from '@/lib/dict/store';
import type { DecompCharacter, DecompStore } from '@/lib/dict/decomp-store';
import type { SqlQuery, SqlRunner, SqlValue } from '@/lib/dict/sql';
import type { DictStatus, DictStore } from '@/lib/dict/store';
import { SCHEMA_VERSION } from '@/lib/dict/artifact';
import { appRoot } from '@/lib/server/roots';

/** Exactly what a sibling plan writes on the day this commit lands. */
const fake: DictStore = {
  status: { state: 'ready', version: '1.3.20251213' },
  subscribe: () => () => {},
  open: async () => {},
  entries: async () => [],
  search: async (query) => ({
    query,
    route: 'english',
    groups: [],
    sections: [],
    total: 0,
    dictVersion: '1.3.20251213',
    offset: 0,
  }),
  segment: async (text) => ({ text, script: 'simp', tokens: [] }),
  hskBand: async () => [],
  readingCount: async () => 0,
  resolve: async () => {
    throw new Error('wave-zero.md §8b: declared, not implemented');
  },
  wordsContaining: async () => [],
};

const fakeRunner: SqlRunner = {
  query: async (batch) => batch.map(() => []),
  close: async () => {},
};

const fakeDecomp: DecompStore = {
  decompose: async (chars) => [...chars].map((char) => ({ char, entry: null })),
};

describe('the frozen DictStore surface', () => {
  it('accepts a hand-written fake, which is what core.md codes against first', async () => {
    expect(fake.status.state).toBe('ready');
    expect(await fake.search('plan')).toMatchObject({ query: 'plan', total: 0 });
    expect(await fake.segment('你好')).toMatchObject({ script: 'simp' });
    expect(fake.subscribe(() => {})).toBeInstanceOf(Function);
  });

  it('runs a SqlRunner batch and gets one result set per query', async () => {
    const batch: SqlQuery[] = [
      { sql: 'SELECT 1' },
      { sql: 'SELECT ?', params: [1 satisfies SqlValue] },
    ];
    expect(await fakeRunner.query(batch)).toHaveLength(2);
  });

  it('keeps decomposition behind its own interface, because its licence differs', async () => {
    const out: DecompCharacter[] = await fakeDecomp.decompose('打算');
    expect(out.map((row) => row.char)).toEqual(['打', '算']);
  });

  it('covers all four DictStatus states', () => {
    const states: DictStatus[] = [
      { state: 'absent' },
      { state: 'preparing', received: 1, total: 2 },
      { state: 'ready', version: 'x' },
      { state: 'failed', reason: 'corrupt', message: 'not this artifact' },
    ];
    expect(states.map((status) => status.state)).toEqual([
      'absent',
      'preparing',
      'ready',
      'failed',
    ]);
  });

  it('has no implementation behind it — the modules emit nothing at runtime', () => {
    // A types-only commit is checkable: every export erases, so the namespace
    // object is empty. The day someone adds a function to one of these three
    // modules this fails, which is the point — the implementation belongs in
    // `sqlite-store.ts` and the runners.
    expect(Object.keys(sqlModule)).toEqual([]);
    expect(Object.keys(storeModule)).toEqual([]);
    expect(Object.keys(decompStoreModule)).toEqual([]);
  });
});

describe('the frozen schema', () => {
  const schema = readFileSync(resolve(appRoot(), 'lib/dict/schema.sql'), 'utf8');

  it('declares every table and index the store queries', () => {
    for (const table of ['entries', 'gloss_fts', 'words', 'chars', 'char_words', 'meta']) {
      expect(schema, table).toMatch(new RegExp(`CREATE (VIRTUAL )?TABLE ${table} `));
    }
    for (const index of ['entries_id', 'entries_simp', 'entries_trad', 'entries_py_tl', 'entries_py_td', 'entries_hsk']) {
      expect(schema, index).toContain(index);
    }
  });

  it('leaves the index creation below a marker the builder can split on', () => {
    expect(schema.split(/^-- >>> indexes$/m)).toHaveLength(2);
  });

  it('is pinned to SCHEMA_VERSION, so a change here is a decision and not a slip', () => {
    // There is no CI, the schema is a settle-first surface, and an edit to it
    // changes the bytes of a 43 MB file that three platforms cache by filename.
    // Nothing else in the tree fails when the SQL changes and the version does
    // not — the artifact rebuilds happily, `PRAGMA user_version` still says 1,
    // and every store goes on trusting a file whose shape moved under it.
    //
    // So the text is pinned. When this fails: decide whether the change needs a
    // SCHEMA_VERSION bump in `lib/dict/artifact.ts` (it does if any store's
    // queries or an existing installed file are affected), then update the
    // digest below in the same commit.
    expect({
      schemaVersion: SCHEMA_VERSION,
      sha256: createHash('sha256').update(schema).digest('hex'),
    }).toEqual({
      schemaVersion: 1,
      sha256: '461972e05ab170ec54930cbfa1de96c73d96bf9a767adb4ecd346ca21bb4b6d1',
    });
  });

  it('never assigns user_version or application_id', () => {
    // They are `lib/dict/artifact.ts` constants. Both stores validate an opened
    // file against them, so a copy in the SQL would be a second source of truth
    // for the number that decides whether a file is this artifact at all.
    expect(schema).not.toMatch(/user_version\s*=/);
    expect(schema).not.toMatch(/application_id\s*=/);
  });

  it('carries no timestamp, so two builds of one snapshot are byte-identical', () => {
    expect(schema).not.toMatch(/built_at|builtAt|CURRENT_TIMESTAMP/);
  });
});
