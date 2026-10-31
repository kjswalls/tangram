import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { Dictionary, type CompactDict } from '../src/core/dict';

const file = resolve(import.meta.dirname, '../public/dict.json');

// Needs `pnpm data` + `pnpm -F extension dict`; skipped on a fresh clone rather than failing.
describe.skipIf(!existsSync(file))('Dictionary (real data)', () => {
  const dict = existsSync(file) ? new Dictionary(JSON.parse(readFileSync(file, 'utf8')) as CompactDict) : null!;
  const words = (text: string) => dict.segmentLine(text).map((word) => word.text);

  it('keeps words MyMandarin split apart', () => {
    // 中文系 isn't a CC-CEDICT headword, so the local pass gives 中文 + 系: still
    // words, not single characters. The AI pass is what merges it.
    expect(words('是江城大学的中文系')).toEqual(['是', '江城', '大学', '的', '中文', '系']);
    expect(words('汉语言文学专业的大一新生')).toEqual(
      expect.arrayContaining(['语言', '文学', '专业', '新生']),
    );
  });

  it('applies tone changes in the display pinyin', () => {
    const [bu, shi] = dict.segmentLine('不是');
    expect(bu?.pinyin ?? shi?.pinyin).toBeDefined();
    const joined = dict.segmentLine('不是').map((word) => word.pinyin).join(' ');
    expect(joined).toContain('bú');
  });

  it('passes punctuation through untouched', () => {
    const line = dict.segmentLine('我们厂自称“铁西城”');
    expect(line.filter((word) => word.kind === 'text').map((word) => word.text)).toEqual(['“', '”']);
  });
});
