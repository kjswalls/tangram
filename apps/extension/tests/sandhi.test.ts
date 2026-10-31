import { describe, expect, it } from 'vitest';

import { applySandhi, tonesOf } from '../src/core/sandhi';

const run = (...words: [string, string][]) =>
  applySandhi(words.map(([text, pinyinNum]) => ({ text, pinyinNum })));

describe('applySandhi', () => {
  it('不 before a fourth tone becomes bú, across a word boundary', () => {
    expect(run(['不', 'bu4'], ['是', 'shi4'])).toEqual(['bu2', 'shi4']);
    expect(run(['不', 'bu4'], ['好', 'hao3'])).toEqual(['bu4', 'hao3']);
  });

  it('一 changes before what it counts', () => {
    expect(run(['一个', 'yi1 ge4'])).toEqual(['yi2 ge4']);
    expect(run(['一', 'yi1'], ['天', 'tian1'])).toEqual(['yi4', 'tian1']);
    expect(run(['一样', 'yi1 yang4'])).toEqual(['yi2 yang4']);
  });

  it('一 keeps yī in ordinals, numbers and at the end of a word', () => {
    expect(run(['第一', 'di4 yi1'], ['次', 'ci4'])).toEqual(['di4 yi1', 'ci4']);
    expect(run(['十一', 'shi2 yi1'], ['月', 'yue4'])).toEqual(['shi2 yi1', 'yue4']);
    expect(run(['统一', 'tong3 yi1'], ['了', 'le5'])).toEqual(['tong3 yi1', 'le5']);
    expect(run(['一', 'yi1'], ['二', 'er4'])).toEqual(['yi1', 'er4']);
  });

  it('leaves words without a reading alone', () => {
    expect(run(['，', ''], ['不', 'bu4'], ['对', 'dui4'])).toEqual(['', 'bu2', 'dui4']);
  });
});

describe('tonesOf', () => {
  it('reads tone numbers', () => {
    expect(tonesOf('Jiang1 cheng2 le5')).toEqual([1, 2, 5]);
  });
});
