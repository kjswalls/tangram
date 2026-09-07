import { describe, expect, it } from 'vitest';

import { hasUnknownReading, markSyllable, normalizePinyin, toMarked } from '@/lib/dict/pinyin';

describe('markSyllable — tone placement', () => {
  it('marks a when present', () => {
    expect(markSyllable('hao3')).toBe('hǎo');
    expect(markSyllable('shuang1')).toBe('shuāng');
    expect(markSyllable('kuai4')).toBe('kuài');
  });

  it('marks e when there is no a', () => {
    expect(markSyllable('lei4')).toBe('lèi');
    expect(markSyllable('xue2')).toBe('xué');
    expect(markSyllable('zhei4')).toBe('zhèi');
  });

  it('marks the o of ou', () => {
    expect(markSyllable('dou1')).toBe('dōu');
    expect(markSyllable('zhou1')).toBe('zhōu');
  });

  it('otherwise marks the last vowel', () => {
    expect(markSyllable('gui4')).toBe('guì');
    expect(markSyllable('liu2')).toBe('liú');
    expect(markSyllable('ju1')).toBe('jū');
    expect(markSyllable('zhuo2')).toBe('zhuó');
    expect(markSyllable('si1')).toBe('sī');
  });

  it('turns u: into ü and marks it', () => {
    expect(markSyllable('lu:4')).toBe('lǜ');
    expect(markSyllable('nu:3')).toBe('nǚ');
    expect(markSyllable('lu:e4')).toBe('lüè'); // e wins over ü
    expect(markSyllable('nu:5')).toBe('nü');
  });

  it('renders CC-CEDICT\'s "no known reading" placeholder as nothing', () => {
    expect(markSyllable('xx5')).toBe('');
    expect(toMarked('xx5 xx5')).toBe('');
    expect(hasUnknownReading('xx5')).toBe(true);
    expect(hasUnknownReading('da3 suan4')).toBe(false);
  });

  it('leaves the neutral tone unmarked', () => {
    expect(markSyllable('le5')).toBe('le');
    expect(markSyllable('zi5')).toBe('zi');
    expect(markSyllable('r5')).toBe('r'); // erhua
  });

  it('preserves capitalization', () => {
    expect(markSyllable('Bei3')).toBe('Běi');
    expect(markSyllable('Ou1')).toBe('Ōu');
    expect(markSyllable('Lu:4')).toBe('Lǜ');
  });

  it('passes non-syllables through', () => {
    expect(markSyllable('C')).toBe('C');
    expect(markSyllable('OK')).toBe('OK');
    expect(markSyllable('TV')).toBe('TV'); // the v is not a ü here
  });
});

describe('toMarked — whole readings', () => {
  it('joins syllables into the display form', () => {
    expect(toMarked('da3 suan4')).toBe('dǎsuàn');
    expect(toMarked('Bei3 jing1')).toBe('Běijīng');
    expect(toMarked('wo3 men5')).toBe('wǒmen');
    expect(toMarked('er2')).toBe('ér');
  });

  it('joins erhua onto the syllable before it', () => {
    expect(toMarked('hua1 r5')).toBe('huār');
    expect(toMarked('yi1 xia4 r5')).toBe('yīxiàr');
  });

  it('separates syllables that would otherwise be ambiguous', () => {
    expect(toMarked('xi1 an1')).toBe("xī'ān");
    expect(toMarked('xian1')).toBe('xiān');
    expect(toMarked("xi1 an1")).not.toBe(toMarked('xian1'));
  });

  it('breaks a name into words at CC-CEDICT\'s capitals', () => {
    // Each word of a name is capitalized upstream, so a mid-reading capital is a
    // word boundary; without it 少林寺 renders as the unreadable `ShàolínSì`.
    expect(toMarked('Shao4 lin2 Si4')).toBe('Shàolín Sì');
    expect(toMarked('San1 jiang1 Sheng1 tai4 Lu:3 you2 Qu1')).toBe('Sānjiāng Shēngtài Lǚyóu Qū');
    // A name that is one word stays one word.
    expect(toMarked('Bei3 jing1')).toBe('Běijīng');
  });

  it('keeps CC-CEDICT separators', () => {
    expect(toMarked('Ya4 dang1 · Si1 mi4')).toBe('Yàdāng·Sīmì');
    expect(toMarked('yi1 bu4 zuo4 , er4 bu4 xiu1')).toBe('yībùzuò, èrbùxiū');
    expect(toMarked('san1 C')).toBe('sān C');
  });
});

describe('normalizePinyin', () => {
  it('folds marks, digits and plain letters onto the same keys', () => {
    for (const query of ['dǎsuàn', 'da3suan4', 'da3 suan4', 'DaSuan', 'dasuan']) {
      expect(normalizePinyin(query).toneless).toBe('dasuan');
    }
    expect(normalizePinyin('dǎsuàn').toned).toBe('da3suan4');
    expect(normalizePinyin('da3 suan4').toned).toBe('da3suan4');
    expect(normalizePinyin('dasuan').toned).toBe('dasuan');
  });

  it('treats u:, v and ü as the same vowel', () => {
    const keys = ['lu:4', 'lv4', 'lü4', 'lǜ'].map((q) => normalizePinyin(q));
    for (const key of keys) {
      expect(key.toneless).toBe('lu');
      expect(key.toned).toBe('lu4');
    }
    expect(normalizePinyin('nǚ').toned).toBe('nu3');
  });

  it('splits syllables, and an apostrophe forces the split', () => {
    expect(normalizePinyin('xian').syllables).toEqual([{ base: 'xian', tone: null }]);
    expect(normalizePinyin("xi'an").syllables).toEqual([
      { base: 'xi', tone: null },
      { base: 'an', tone: null },
    ]);
    expect(normalizePinyin('xi1an1').syllables).toEqual([
      { base: 'xi', tone: 1 },
      { base: 'an', tone: 1 },
    ]);
    expect(normalizePinyin('xian1').syllables).toEqual([{ base: 'xian', tone: 1 }]);
  });

  it('parses erhua and the neutral tone', () => {
    expect(normalizePinyin('hua1r5').syllables).toEqual([
      { base: 'hua', tone: 1 },
      { base: 'r', tone: 5 },
    ]);
    // The neutral tone is a real tone in `syllables` but not in the `toned` key:
    // no tone mark can write it, so `wǒmen` has to reach `wo3 men5`.
    expect(normalizePinyin('le5').toned).toBe('le');
    expect(normalizePinyin('wǒmen').toned).toBe(normalizePinyin('wo3 men5').toned);
    expect(normalizePinyin('wo3men').toned).toBe('wo3men');
    expect(normalizePinyin('hua1r5').toned).toBe(normalizePinyin('huār').toned);
  });

  it('splits where pinyin orthography says the split is, not at the longest match', () => {
    // A vowel-initial syllable inside a word needs an apostrophe (Xi'an), so
    // `gunao` can only be gu-nao — `gun ao` is not writable pinyin.
    const bases = (q: string) => normalizePinyin(q).syllables.map((s) => s.base);
    expect(bases('gunao')).toEqual(['gu', 'nao']); // 一股脑 yīgǔnǎo
    expect(bases('chana')).toEqual(['cha', 'na']); // 一刹那 yīchànà
    expect(bases('nanbannu')).toEqual(['nan', 'ban', 'nu']); // 男半女
    // An explicit break still wins, and an unambiguous run is left alone.
    expect(bases('xian')).toEqual(['xian']);
    expect(bases("xi'an")).toEqual(['xi', 'an']);
    expect(bases('xi1an1')).toEqual(['xi', 'an']);
  });

  it('reports whether the whole query is pinyin', () => {
    expect(normalizePinyin('nihao').fullyParsed).toBe(true);
    expect(normalizePinyin('Bei3 jing1').fullyParsed).toBe(true);
    expect(normalizePinyin('women').fullyParsed).toBe(true); // also an English word
    expect(normalizePinyin('hello').fullyParsed).toBe(false);
    expect(normalizePinyin('打算').fullyParsed).toBe(false);
    expect(normalizePinyin('').fullyParsed).toBe(false);
    expect(normalizePinyin('plan!').fullyParsed).toBe(false);
  });

  it('still yields a prefix key when the query is not pinyin', () => {
    expect(normalizePinyin('hello').toneless).toBe('hello');
    expect(normalizePinyin('打算').toneless).toBe('');
  });

  it('round-trips every reading it produced marks for', () => {
    const numbered = 'nu:3 hai2';
    const marked = toMarked(numbered); // nǚhái
    expect(normalizePinyin(marked).toned).toBe(normalizePinyin(numbered).toned);
  });
});
