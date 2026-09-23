/**
 * The artifact's identity and its one hand-rolled encoding (docs/plans/data.md D1).
 *
 * Imported by the builder, the verifier and every store, which is the point:
 * the numbers that decide whether an opened file *is* this dictionary live in
 * exactly one place. `lib/dict/schema.sql` deliberately does not repeat them.
 *
 * Nothing here touches the filesystem — it is imported by the browser and
 * native stores as well as by `scripts/`.
 */

/**
 * Bumped by any change to `schema.sql`. Stamped into `PRAGMA user_version`, into
 * the filename, and into `meta.schema_version`; a store that opens a file whose
 * `user_version` differs treats it as the wrong artifact rather than reading it.
 */
export const SCHEMA_VERSION = 1;

/**
 * `PRAGMA application_id`, 'TGM1' as big-endian ASCII. A wrong file — some other
 * app's SQLite database that happens to land at the same path — is then
 * *detected* rather than misread, and the check costs one page.
 */
export const APPLICATION_ID = 0x54474d31;

export const MANIFEST_FILE = 'dict-manifest.json';

/**
 * The line `schema.sql` is split on. Everything after it is created once the
 * rows are in, so 124k inserts do not each maintain six live B-trees.
 */
export const SCHEMA_INDEX_MARKER = /^-- >>> indexes$/m;

/** `schema.sql` → [tables and virtual tables, indexes]. Throws if the marker is gone. */
export function splitSchema(sql: string): [string, string] {
  const parts = sql.split(SCHEMA_INDEX_MARKER);
  if (parts.length !== 2) {
    throw new Error('schema.sql has no `-- >>> indexes` marker, or has more than one');
  }
  return [parts[0], parts[1]];
}

/**
 * `dict-1-1.3.20251213.sqlite`. Two version numbers because the schema changes
 * independently of the CC-CEDICT snapshot.
 *
 * **The filename is not the artifact's identity, and no cache may key on it
 * alone.** `data.md` D1 said every cache key would be the whole filename; that
 * holds only while the bytes change exactly when the schema or the snapshot
 * does, and they do not. `pnpm data` pulls the HSK list and the jieba
 * frequencies from `master`, and the reading order moved on its own (HANDOFF.md
 * "The default reading") — both change the bytes and keep the name. So a browser
 * keys on the manifest's sha256 as well: `artifactPoolName` for the copy in
 * OPFS, `artifactFetchPath` for the HTTP cache. The native stores will need
 * the same when D5a and D5b land.
 */
export function artifactFile(dictVersion: string, schemaVersion: number = SCHEMA_VERSION): string {
  return `dict-${schemaVersion}-${dictVersion}.sqlite`;
}

/** Enough of the sha256 to tell two builds apart; the whole digest is in the manifest. */
const POOL_DIGEST_CHARS = 16;

/**
 * The name a browser stores the artifact under in its OPFS pool:
 * `/dict-1-1.3.20251213-cb893d8856faa18d.sqlite`.
 *
 * The manifest's sha256 is in it, so an artifact rebuilt under the same filename
 * is a different pool file, the stored one is not `present`, and the worker
 * sweeps it and imports the new one. Before this the pool name was
 * `/${manifest.file}` and a changed artifact was never fetched again.
 *
 * It still matches the worker's `ARTIFACT_PATTERN` (`/dict-<n>-….sqlite`), so the
 * sweep and the offline re-open find it. A manifest with no digest — nothing the
 * build writes — falls back to the bare filename rather than inventing one.
 */
export function artifactPoolName(manifest: Pick<DictManifest, 'file' | 'sha256'>): string {
  if (!manifest.sha256) return `/${manifest.file}`;
  const stem = manifest.file.replace(/\.sqlite$/, '');
  return `/${stem}-${manifest.sha256.slice(0, POOL_DIGEST_CHARS)}.sqlite`;
}

/**
 * The path a browser fetches the artifact from, relative to the build output:
 * `dict-1-1.3.20251213.sqlite?sha256=<digest>`.
 *
 * The host serves `dict-*.sqlite` with `immutable` and a one-year `max-age`
 * (`web.md` W2 rule 4), which is only true of a URL whose bytes never change. The
 * query makes it true: the path still names the one file every host rule and
 * the service worker's deny rule match on, and the URL — which is what the HTTP
 * cache keys on — changes whenever the bytes do. Without it a browser that
 * already cached the old artifact would import it again under the new pool
 * name, and the old readings would be back.
 */
export function artifactFetchPath(manifest: Pick<DictManifest, 'file' | 'sha256'>): string {
  if (!manifest.sha256) return manifest.file;
  return `${manifest.file}?sha256=${encodeURIComponent(manifest.sha256)}`;
}

/**
 * `data/dict-manifest.json`. No `builtAt`: a wall clock would change the file's
 * bytes on every run and make D1's byte-identity criterion unachievable.
 * Gitignored by `data/*.json`, deliberately — committing a hash of something
 * nobody has generated is a stale fact waiting to happen.
 */
export interface DictManifest {
  file: string;
  bytes: number;
  sha256: string;
  schemaVersion: number;
  dictVersion: string;
}

/**
 * What `hsk_sort` holds for a banded entry with no jieba rank.
 *
 * `index.ts` re-sorts each HSK band by `freqRank ?? Number.MAX_SAFE_INTEGER`, so
 * those entries come last. SQLite orders NULLs *first*, so the sentinel is
 * folded into a column rather than written as `NULLS LAST` or an expression
 * index: the ordering stays a plain index scan on every SQLite the artifact may
 * meet, including whichever one is inside the SQLCipher iOS pod.
 */
export const HSK_SORT_SENTINEL = Number.MAX_SAFE_INTEGER;

/**
 * `char_words.rowids` — ascending entry rowids as LEB128 deltas.
 *
 * The obvious shape, one row per (character, script, entry), is 636,088 rows and
 * costs +22.4 MB; this costs +1.4 MB for the same information (data.md D1). The
 * first value is stored whole, every later one as its gap from the previous, so
 * a dense posting list spends one byte per entry.
 */
export function encodeRowids(rowids: readonly number[]): Uint8Array {
  const out: number[] = [];
  let previous = 0;
  for (const rowid of rowids) {
    let delta = rowid - previous;
    if (delta <= 0) throw new Error(`char_words postings must ascend strictly: ${rowid}`);
    previous = rowid;
    while (delta >= 0x80) {
      out.push((delta & 0x7f) | 0x80);
      delta >>>= 7;
    }
    out.push(delta);
  }
  return Uint8Array.from(out);
}

/** The inverse. Throws on a truncated blob rather than returning a short list. */
export function decodeRowids(blob: Uint8Array): number[] {
  const out: number[] = [];
  let previous = 0;
  let i = 0;
  while (i < blob.length) {
    let delta = 0;
    let shift = 0;
    let byte: number;
    do {
      if (i >= blob.length) throw new Error('char_words posting list ends mid-varint');
      byte = blob[i];
      i += 1;
      delta += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while (byte & 0x80);
    previous += delta;
    out.push(previous);
  }
  return out;
}
