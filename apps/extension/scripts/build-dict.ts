/**
 * `pnpm -F extension dict` — the extension's dictionary, cut from Tangram's.
 *
 * Reads the workspace-root `data/dict.json` (written by `pnpm data`) through
 * the same index `scripts/dict-json.ts` builds for the app's verifier, so the
 * segmenter's frequencies, the per-headword reading order and the two stats
 * (`logTotal`, `maxLen`) are Tangram's numbers, not a re-derivation. Writes a
 * compact, simplified-only `public/dict.json`:
 *
 *   { version, stats: { logTotal, maxLen }, words: { 江城: [freq, [[pinyinNum, glosses, hsk, proper]]] } }
 *
 * CC-CEDICT is CC BY-SA 4.0; `data/ATTRIBUTION.md` is copied beside it by the
 * extension build and linked from the sidebar.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getDictIndex, headwordFreq, headwordTotals } from '../../../scripts/dict-json';

type CompactReading = [pinyinNum: string, glosses: string, hsk: number, proper: 0 | 1];

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '../public/dict.json');

const index = getDictIndex();
const { total, maxLen } = headwordTotals(index, 'simp');
const words: Record<string, [number, CompactReading[]]> = {};

for (const [word, ids] of index.bySimp) {
  const readings: CompactReading[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const entry = index.entries.get(id);
    if (!entry || entry.isVariant) continue;
    // Simplified and traditional variants of one reading collapse to one row.
    const key = `${entry.pinyinNum}|${entry.glosses.join('/')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    readings.push([
      entry.pinyinNum,
      entry.glosses.join('/'),
      typeof entry.hskBand === 'number' ? entry.hskBand : 0,
      entry.properNoun ? 1 : 0,
    ]);
  }
  if (readings.length === 0) continue;
  words[word] = [headwordFreq(index, ids), readings];
}

mkdirSync(dirname(out), { recursive: true });
const body = JSON.stringify({
  version: index.meta.version,
  stats: { logTotal: Math.log(total || 1), maxLen },
  words,
});
writeFileSync(out, body);
console.log(
  `dict ${Object.keys(words).length} simplified headwords, ${(body.length / 1e6).toFixed(1)} MB → ${out}`,
);
