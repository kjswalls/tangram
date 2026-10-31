import { describe, expect, it } from 'vitest';

import { pickChinese, pickEnglish, timedtextUrl } from '../src/content/adapters/youtube';

const track = (languageCode: string, kind = '') => ({ baseUrl: 'https://www.youtube.com/api/timedtext?v=x&lang=' + languageCode, languageCode, kind, name: languageCode });

describe('track choice', () => {
  it('prefers human simplified Chinese over traditional and auto-generated', () => {
    expect(pickChinese([track('zh', 'asr'), track('zh-TW'), track('zh-Hans')])?.languageCode).toBe('zh-Hans');
    expect(pickChinese([track('zh', 'asr'), track('zh-TW')])?.languageCode).toBe('zh-TW');
    expect(pickChinese([track('en')])).toBeUndefined();
  });

  it('prefers human English', () => {
    expect(pickEnglish([track('en', 'asr'), track('en-GB')])?.languageCode).toBe('en-GB');
  });
});

describe('timedtextUrl', () => {
  it('borrows the signing params, never the language', () => {
    const url = new URL(
      timedtextUrl(
        'https://www.youtube.com/api/timedtext?v=abc&lang=zh-Hans&sig=1',
        'https://www.youtube.com/api/timedtext?v=abc&lang=en&pot=TOKEN&c=WEB&fmt=srv3',
        'en',
      ),
    );
    expect(url.searchParams.get('lang')).toBe('zh-Hans');
    expect(url.searchParams.get('pot')).toBe('TOKEN');
    expect(url.searchParams.get('c')).toBe('WEB');
    expect(url.searchParams.get('fmt')).toBe('json3');
    expect(url.searchParams.get('tlang')).toBe('en');
  });
});
