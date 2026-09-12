/**
 * The three importer parsers (`lib/lists/import/parse.ts`): plain text, Pleco
 * flashcard exports and Anki plain-text exports. Pure — no dictionary.
 */
import { describe, expect, it } from 'vitest';

import {
  cleanWord,
  detectFormat,
  parseAnki,
  parseImport,
  parsePlain,
  parsePleco,
  splitHeadword,
  splitTabRecords,
  stripHtml,
} from '@/lib/lists/import/parse';

const PLECO = [
  '//Lists/HSK 1',
  '你好\tnǐhǎo\thello',
  '学习[學習]\txuéxí\tto study; to learn',
  '了\tle\t(modal particle)',
  '',
  '打算\tda3suan4\tto plan',
].join('\n');

const ANKI = [
  '#separator:tab',
  '#html:true',
  '#guid column:1',
  '#notetype column:2',
  '#deck column:3',
  '#tags column:7',
  'abc123\tChinese\tHSK\t你好<br>\t<b>nǐ hǎo</b>\thello\thsk1',
  'def456\tChinese\tHSK\t"跑步 [sound:paobu.mp3]"\tpǎobù\t"to run<br>jog"\t',
  'ghi789\tChinese\tHSK\t<div>了</div>\t\t"modal<br>particle"\tgrammar',
].join('\n');

describe('splitTabRecords', () => {
  it('splits on tabs and keeps the line each record started on', () => {
    expect(splitTabRecords('a\tb\nc\td\n')).toEqual([
      { line: 1, fields: ['a', 'b'] },
      { line: 2, fields: ['c', 'd'] },
    ]);
  });

  it('honours Anki quoting: a quoted field may hold tabs, newlines and doubled quotes', () => {
    const records = splitTabRecords('x\t"one\ttwo\nthree ""q"""\ty\nnext\tz');
    expect(records).toEqual([
      { line: 1, fields: ['x', 'one\ttwo\nthree "q"', 'y'] },
      { line: 3, fields: ['next', 'z'] },
    ]);
  });

  it('ignores carriage returns', () => {
    expect(splitTabRecords('a\tb\r\nc\r\n')).toEqual([
      { line: 1, fields: ['a', 'b'] },
      { line: 2, fields: ['c'] },
    ]);
  });
});

describe('cell cleaning', () => {
  it('strips tags, sound references and entities', () => {
    expect(stripHtml('<b>你好</b><br>[sound:x.mp3]&nbsp;&amp;')).toBe('你好  &');
  });

  it('splits a simp[trad] headword and leaves a reading in brackets alone', () => {
    expect(splitHeadword('学习[學習]')).toEqual({ word: '学习', alt: '學習' });
    expect(splitHeadword('学习【學習】')).toEqual({ word: '学习', alt: '學習' });
    expect(splitHeadword('了[le]')).toEqual({ word: '了[le]' });
    expect(splitHeadword('你好')).toEqual({ word: '你好' });
  });

  it('takes the hanzi run out of a decorated cell, and passes pinyin through', () => {
    expect(cleanWord('你好 (nǐ hǎo)')).toBe('你好');
    expect(cleanWord('“跑步”')).toBe('跑步');
    expect(cleanWord('  nǐhǎo ')).toBe('nǐhǎo');
    expect(cleanWord('<i></i>')).toBe('');
  });
});

describe('detectFormat', () => {
  it('sees Pleco by its headword-pinyin-definition columns', () => {
    expect(detectFormat(PLECO)).toBe('pleco');
  });

  it('sees Anki by its header block, or by HTML in tabbed fields', () => {
    expect(detectFormat(ANKI)).toBe('anki');
    expect(detectFormat('你好\t<b>hello</b>\n跑步\t<i>to run</i>')).toBe('anki');
  });

  it('falls back to plain text', () => {
    expect(detectFormat('你好\n跑步\nnihao')).toBe('plain');
    expect(detectFormat('你好, hello\n跑步, to run')).toBe('plain');
    expect(detectFormat('')).toBe('plain');
  });
});

describe('parsePlain', () => {
  it('takes one word per line, hanzi or pinyin', () => {
    const parsed = parsePlain('你好\n\n了\nxuéxí\n  跑步  \n');
    expect(parsed.rows.map((row) => row.word)).toEqual(['你好', '了', 'xuéxí', '跑步']);
    expect(parsed.rows.map((row) => row.line)).toEqual([1, 3, 4, 5]);
    expect(parsed.skipped).toBe(2);
  });

  it('takes the first cell of a comma- or tab-separated line', () => {
    const parsed = parsePlain('你好, hello\n跑步\tto run\n学习，xuéxí，to study\n吃、to eat');
    expect(parsed.rows.map((row) => row.word)).toEqual(['你好', '跑步', '学习', '吃']);
  });

  it('keeps a second cell that is a reading as the row’s pinyin hint', () => {
    const [row] = parsePlain('了, liǎo, to finish').rows;
    expect(row.pinyin).toBe('liǎo');
    expect(row.definition).toBe('to finish');
  });
});

describe('parsePleco', () => {
  it('reads headword, pinyin and definition, and skips category lines', () => {
    const parsed = parsePleco(PLECO);
    expect(parsed.rows).toHaveLength(4);
    expect(parsed.skipped).toBe(2);
    expect(parsed.rows[0]).toMatchObject({ word: '你好', pinyin: 'nǐhǎo', definition: 'hello' });
    expect(parsed.rows[2]).toMatchObject({ word: '了', pinyin: 'le' });
    expect(parsed.rows[3]).toMatchObject({ word: '打算', pinyin: 'da3suan4', definition: 'to plan' });
  });

  it('splits a simp[trad] headword into the word and its other script', () => {
    const row = parsePleco(PLECO).rows[1];
    expect(row.word).toBe('学习');
    expect(row.alt).toBe('學習');
    expect(row.pinyin).toBe('xuéxí');
  });

  it('is what parseImport picks for that shape', () => {
    expect(parseImport(PLECO).format).toBe('pleco');
  });
});

describe('parseAnki', () => {
  it('skips the header block and the guid/notetype/deck columns it declares', () => {
    const parsed = parseAnki(ANKI);
    expect(parsed.rows.map((row) => row.word)).toEqual(['你好', '跑步', '了']);
    expect(parsed.skipped).toBe(6);
  });

  it('strips HTML and sound tags from every field', () => {
    const [hello, run, le] = parseAnki(ANKI).rows;
    expect(hello.pinyin).toBe('nǐ hǎo');
    expect(hello.definition).toBe('hello');
    expect(run.pinyin).toBe('pǎobù');
    expect(run.definition).toBe('to run jog');
    expect(le.pinyin).toBeUndefined();
    expect(le.definition).toBe('modal particle');
  });

  it('never takes the tags column for a word or a definition', () => {
    const text = '#separator:tab\n#tags column:2\n你好\thsk1 greeting\n';
    const [row] = parseAnki(text).rows;
    expect(row.word).toBe('你好');
    expect(row.definition).toBeUndefined();
  });

  it('handles a headerless export: first field is the hanzi', () => {
    const parsed = parseAnki('你好\t<b>hello</b>\n跑步\t<i>to run</i>');
    expect(parsed.rows.map((row) => row.word)).toEqual(['你好', '跑步']);
    expect(parsed.rows[0].definition).toBe('hello');
    expect(parseImport('你好\t<b>hello</b>\n跑步\t<i>to run</i>').format).toBe('anki');
  });
});
