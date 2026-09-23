/**
 * A stand-in for "the artifact a returning browser already holds": this build's
 * bytes with 吗's two readings put back in the order they had before the HSK-band
 * tie-break (HANDOFF.md "The default reading"), written to a temporary file.
 *
 * Same filename, same schema, same `dict_version`, different bytes — which is
 * exactly the case a filename-keyed cache cannot see. The one thing a spec
 * reads to tell the two files apart is the first reading of 吗: `ma2` (má) in
 * the stale copy, `ma5` (ma) in the current one. Swapping two rowids keeps
 * `char_words` consistent, because both rows contain 吗.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const MA5 = '嗎|吗[ma5]';
export const MA2 = '嗎|吗[ma2]';
/** A sentence whose last token is 吗, the audit's example. */
export const MA_SENTENCE = '你想跟我一起去吗';

export function makeStaleArtifact(artifact: string, tag: string): { path: string; bytes: number } {
  const path = join(tmpdir(), `tangram-stale-${tag}-${process.pid}.sqlite`);
  writeFileSync(path, readFileSync(artifact));
  const db = new DatabaseSync(path);
  try {
    const rowid = (id: string) =>
      Number((db.prepare('SELECT rowid AS r FROM entries WHERE id = ?').get(id) as { r: number }).r);
    const [ma5, ma2] = [rowid(MA5), rowid(MA2)];
    if (!(ma5 < ma2)) throw new Error('this artifact does not put ma before má; the stale copy would not differ');
    db.exec(`UPDATE entries SET rowid = -1 WHERE rowid = ${ma5};
             UPDATE entries SET rowid = ${ma5} WHERE rowid = ${ma2};
             UPDATE entries SET rowid = ${ma2} WHERE rowid = -1;`);
  } finally {
    db.close();
  }
  return { path, bytes: readFileSync(path).byteLength };
}
