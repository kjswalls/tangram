// @vitest-environment node
/**
 * The built artifact, as standing assertions (docs/plans/data.md D1).
 *
 * `pnpm data:verify` is the full proof — 124,188 round trips, every posting
 * list, all seven HSK bands — and it takes ten seconds and the JSON oracle
 * beside it. This is the subset that belongs in `pnpm test`: the licence
 * boundary (criterion 6), the identity pragmas a store checks before trusting a
 * file, and the posting-list codec. There is no CI (CLAUDE.md), so a rule that
 * wants enforcing is a unit test or it is nothing.
 *
 * **This file runs under the `node` environment, not the suite's jsdom
 * default.** Vite refuses to bundle `node:sqlite` for the client environment
 * ("Cannot bundle Node.js built-in"), so every test that opens the artifact
 * carries the docblock above. D2's store tests will need the same.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterAll, describe, expect, it } from 'vitest';

import {
  APPLICATION_ID,
  SCHEMA_VERSION,
  artifactFile,
  decodeRowids,
  encodeRowids,
  splitSchema,
} from '@/lib/dict/artifact';
import { dataDir } from '@/lib/dict/load';
import { workspaceRoot } from '@/lib/server/roots';
import { dictArtifactPath, requireDictArtifact } from './data-required';

const manifest = requireDictArtifact();
const path = dictArtifactPath();
const db = new DatabaseSync(path, { readOnly: true });

afterAll(() => {
  db.close();
});

function scalar(sql: string): string | number | null {
  const row = db.prepare(sql).get() as Record<string, string | number | null>;
  return Object.values(row)[0];
}

describe('artifact identity', () => {
  it('is named for both versions, and says so inside as well', () => {
    expect(manifest.file).toBe(artifactFile(manifest.dictVersion, manifest.schemaVersion));
    expect(scalar("SELECT value FROM meta WHERE key = 'dict_version'")).toBe(manifest.dictVersion);
    expect(scalar("SELECT value FROM meta WHERE key = 'schema_version'")).toBe(
      String(SCHEMA_VERSION),
    );
  });

  it('carries the pragmas a store checks before trusting the file', () => {
    // These are the two cheap checks D4's import uses to tell "a corrupt
    // download" from "someone else's SQLite database at the same path", and
    // they are the reason `application_id` exists at all.
    expect(scalar('PRAGMA application_id')).toBe(APPLICATION_ID);
    expect(scalar('PRAGMA user_version')).toBe(SCHEMA_VERSION);
    expect(scalar('PRAGMA page_size')).toBe(4096);
  });

  it('holds no clock anywhere, which is what makes two builds byte-identical', () => {
    const rows = db.prepare('SELECT key, value FROM meta').all() as {
      key: string;
      value: string;
    }[];
    for (const row of rows) {
      expect(row.key, row.key).not.toMatch(/built|timestamp|_at$/);
      expect(row.value, row.key).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    }
  });
});

describe('the licence boundary is a property of the file, not a convention', () => {
  // PLAN.md §5 and CLAUDE.md: Make Me a Hanzi is LGPL-3.0-or-later, CC-CEDICT is
  // CC BY-SA 4.0, and keeping `decomp.json` a separate artifact is the entire
  // mechanism that stops the two merging.
  it('names no table or column for a decomposition fact', () => {
    const schema = (
      db.prepare('SELECT sql FROM sqlite_master WHERE sql IS NOT NULL').all() as {
        sql: string;
      }[]
    )
      .map((row) => row.sql)
      .join('\n');
    expect(schema).not.toMatch(/decomp|radical|stroke|makemeahanzi/i);
  });

  it('does not list Make Me a Hanzi among its own sources', () => {
    // It contributes nothing to this file. Claiming it as a source would have a
    // CC BY-SA artifact assert an LGPL provenance it does not have, which is the
    // opposite of a clean boundary. `data/ATTRIBUTION.md` is committed and
    // covers all three artifacts, including `decomp.json`.
    const sources = JSON.parse(
      scalar("SELECT value FROM meta WHERE key = 'sources'") as string,
    ) as { name: string; url: string; license: string }[];
    expect(sources.length).toBeGreaterThan(0);
    expect(JSON.stringify(sources)).not.toMatch(/makemeahanzi|Make Me a Hanzi/i);
    expect(sources.map((source) => source.name)).toContain('CC-CEDICT');
  });

  it('contains no IDS decomposition character anywhere in its bytes', () => {
    // ⿰⿱⿲⿳ and their neighbours are a Unicode block of their own and appear
    // nowhere in CC-CEDICT, so their absence from the raw file is a complete
    // check rather than a sample.
    const bytes = readFileSync(path).toString('utf8');
    for (const ids of '⿰⿱⿲⿳⿴⿵⿶⿷⿸⿹⿺⿻') expect(bytes, ids).not.toContain(ids);
  });
});

describe('char_words posting lists', () => {
  it('round-trips ascending rowids through the delta varint codec', () => {
    for (const rowids of [[1], [1, 2, 3], [5, 200, 201, 40_000, 124_188], [124_188]]) {
      expect(decodeRowids(encodeRowids(rowids))).toEqual(rowids);
    }
    expect(decodeRowids(encodeRowids([]))).toEqual([]);
  });

  it('spends one byte on a gap under 128 and refuses a list that does not ascend', () => {
    expect(encodeRowids([1, 2, 3, 4]).length).toBe(4);
    expect(() => encodeRowids([2, 1])).toThrow(/ascend/);
    expect(() => encodeRowids([1, 1])).toThrow(/ascend/);
  });

  it('refuses a truncated blob rather than returning a short list', () => {
    const blob = encodeRowids([1, 400]);
    expect(() => decodeRowids(blob.slice(0, blob.length - 1))).toThrow(/mid-varint/);
  });

  it('decodes a real row out of the artifact', () => {
    const row = db
      .prepare("SELECT n, rowids FROM char_words WHERE ch = ? AND script = 'simp'")
      .get('算') as { n: number; rowids: Uint8Array };
    const rowids = decodeRowids(row.rowids);
    expect(rowids.length).toBe(row.n);
    expect(rowids).toEqual([...rowids].sort((a, b) => a - b));
    const simps = rowids.map(
      (rowid) => (db.prepare('SELECT simp FROM entries WHERE rowid = ?').get(rowid) as { simp: string }).simp,
    );
    expect(simps.every((simp) => simp.includes('算'))).toBe(true);
    expect(simps).toContain('打算');
  });
});

describe('the schema file the builder and the verifier share', () => {
  it('splits into exactly two parts, tables then indexes', () => {
    const [tables, indexes] = splitSchema(readFileSync(new URL('../../../lib/dict/schema.sql', import.meta.url), 'utf8'));
    expect(tables).toContain('CREATE TABLE entries');
    expect(indexes).toContain('CREATE UNIQUE INDEX entries_id');
    expect(indexes).not.toContain('CREATE TABLE');
  });

  it('refuses a schema whose marker has gone', () => {
    expect(() => splitSchema('CREATE TABLE t (x)')).toThrow(/marker/);
  });
});

/**
 * `pnpm data:ensure`'s guard (criterion 3).
 *
 * `scripts/build-data.ts` used to return early when `data/dict.json` existed,
 * and `pnpm build` runs `data:ensure` — so after D1 any tree that already had
 * the JSON would never generate the `.sqlite`, and the normal developer path
 * would silently skip this phase's entire output while every gate stayed green.
 * That is the same shape as the `outputFileTracingIncludes` incident W0's
 * review caught, so the guard is asked by *running* it rather than by
 * re-deriving its logic here.
 */
describe('data:ensure regenerates rather than trusting dict.json', () => {
  const root = workspaceRoot();

  function status(dir: string): string {
    return execFileSync(
      'node',
      ['--import', 'tsx', resolve(root, 'scripts/build-data.ts'), '--print-artifact-status'],
      { cwd: root, env: { ...process.env, TANGRAM_DATA_DIR: dir }, encoding: 'utf8' },
    ).trim();
  }

  function scratch(): string {
    const dir = mkdtempSync(resolve(tmpdir(), 'tangram-ensure-'));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  it('says present for the real, complete data directory', () => {
    expect(status(dataDir())).toBe('present');
  });

  it('says absent when dict.json is there and the artifact is not', () => {
    const dir = scratch();
    writeFileSync(resolve(dir, 'dict.json'), '{}');
    writeFileSync(resolve(dir, 'decomp.json'), '{}');
    expect(status(dir)).toBe('absent');
  });

  it('says absent when the manifest names a schema version this tree does not build', () => {
    const dir = scratch();
    copyFileSync(resolve(dataDir(), 'dict.json'), resolve(dir, 'dict.json'));
    copyFileSync(resolve(dataDir(), 'decomp.json'), resolve(dir, 'decomp.json'));
    copyFileSync(path, resolve(dir, manifest.file));
    writeFileSync(
      resolve(dir, 'dict-manifest.json'),
      JSON.stringify({ ...manifest, schemaVersion: manifest.schemaVersion + 1 }),
    );
    expect(status(dir)).toBe('absent');
  });

  it('says absent when the artifact is the wrong length — a half-written file', () => {
    const dir = scratch();
    copyFileSync(resolve(dataDir(), 'dict.json'), resolve(dir, 'dict.json'));
    copyFileSync(resolve(dataDir(), 'decomp.json'), resolve(dir, 'decomp.json'));
    copyFileSync(path, resolve(dir, manifest.file));
    copyFileSync(resolve(dataDir(), 'dict-manifest.json'), resolve(dir, 'dict-manifest.json'));
    expect(status(dir)).toBe('present');
    truncateSync(resolve(dir, manifest.file), manifest.bytes - 4096);
    expect(status(dir)).toBe('absent');
  });
});
