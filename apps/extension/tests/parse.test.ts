import { describe, expect, it } from 'vitest';

import { parseJson3 } from '../src/core/parse/json3';
import { parseVtt } from '../src/core/parse/vtt';

describe('parseJson3', () => {
  it('reads events, drops window events and appends, and clips overlaps', () => {
    const cues = parseJson3({
      events: [
        { tStartMs: 0, dDurationMs: 100000 },
        { tStartMs: 1000, dDurationMs: 3000, segs: [{ utf8: '我们厂' }, { utf8: '自称' }] },
        { tStartMs: 2000, dDurationMs: 10, aAppend: 1, segs: [{ utf8: '\n' }] },
        { tStartMs: 3500, dDurationMs: 2000, segs: [{ utf8: '“铁西城”\n' }] },
      ],
    });
    expect(cues).toEqual([
      { startMs: 1000, endMs: 3500, text: '我们厂自称' },
      { startMs: 3500, endMs: 5500, text: '“铁西城”' },
    ]);
  });
});

describe('parseVtt', () => {
  it('reads WebVTT with settings, tags and multi-line cues', () => {
    const cues = parseVtt(
      'WEBVTT\n\nNOTE x\n\n1\n00:01:50.000 --> 00:01:52.200 line:85%\n<c.white>是江城大学的</c>\n中文系\n\n00:01:52.200 --> 00:01:55.000\n汉语言文学专业的大一新生\n',
    );
    expect(cues).toEqual([
      { startMs: 110_000, endMs: 112_200, text: '是江城大学的 中文系' },
      { startMs: 112_200, endMs: 115_000, text: '汉语言文学专业的大一新生' },
    ]);
  });

  it('reads SRT commas', () => {
    expect(parseVtt('1\n00:00:01,500 --> 00:00:02,000\nhi\n')).toEqual([{ startMs: 1500, endMs: 2000, text: 'hi' }]);
  });
});
