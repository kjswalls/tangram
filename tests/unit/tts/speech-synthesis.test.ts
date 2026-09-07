/**
 * The TTS provider (PLAN.md §3.6).
 *
 * Everything here is about the two failure shapes the browser actually
 * produces: a voice list that is empty until `voiceschanged` fires, and a voice
 * list that is empty forever because the browser has no voices (headless
 * Chromium). The first must resolve late and true; the second must resolve on
 * the timeout and false, not hang.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SpeechSynthesisProvider, isChineseVoice, pickChineseVoice } from '@/lib/tts/speech-synthesis';

type Voice = SpeechSynthesisVoice;

function voice(lang: string, name = lang, isDefault = false): Voice {
  return { lang, name, default: isDefault, localService: true, voiceURI: name } as Voice;
}

class FakeSynth {
  voices: Voice[] = [];
  spoken: { text: string; lang: string; rate?: number; voice: Voice | null }[] = [];
  cancels = 0;
  #listeners: (() => void)[] = [];

  getVoices(): Voice[] {
    return this.voices;
  }
  addEventListener(_type: string, fn: () => void): void {
    this.#listeners.push(fn);
  }
  removeEventListener(_type: string, fn: () => void): void {
    this.#listeners = this.#listeners.filter((l) => l !== fn);
  }
  cancel(): void {
    this.cancels += 1;
  }
  speak(u: { text: string; lang: string; rate?: number; voice: Voice | null }): void {
    this.spoken.push(u);
  }
  /** What the browser does once its voice list has loaded. */
  load(voices: Voice[]): void {
    this.voices = voices;
    for (const fn of [...this.#listeners]) fn();
  }
  get listenerCount(): number {
    return this.#listeners.length;
  }
}

class FakeUtterance {
  text: string;
  lang = '';
  rate: number | undefined;
  voice: Voice | null = null;
  constructor(text: string) {
    this.text = text;
  }
}

function make(synth: FakeSynth, timeoutMs = 500) {
  return new SpeechSynthesisProvider({
    synth: synth as unknown as SpeechSynthesis,
    utteranceCtor: FakeUtterance as unknown as typeof SpeechSynthesisUtterance,
    timeoutMs,
  });
}

describe('voice matching', () => {
  it('accepts every tag that reads hanzi and rejects the rest', () => {
    for (const lang of ['zh', 'zh-CN', 'zh-TW', 'ZH-HK', 'zh_CN', 'cmn-Hans-CN']) {
      expect(isChineseVoice({ lang }), lang).toBe(true);
    }
    for (const lang of ['en-US', 'ja-JP', '', 'zhu-XX']) {
      expect(isChineseVoice({ lang }), lang).toBe(false);
    }
  });

  it('prefers the voice the browser marks default', () => {
    const picked = pickChineseVoice([voice('en-US'), voice('zh-TW'), voice('zh-CN', 'Ting', true)]);
    expect(picked?.name).toBe('Ting');
  });

  it('is null when nothing Chinese is installed', () => {
    expect(pickChineseVoice([voice('en-US'), voice('ja-JP')])).toBeNull();
  });
});

describe('available()', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('answers immediately when voices are already there', async () => {
    const synth = new FakeSynth();
    synth.voices = [voice('en-US'), voice('zh-CN')];
    await expect(make(synth).available()).resolves.toBe(true);
    expect(synth.listenerCount).toBe(0);
  });

  it('waits for voiceschanged when the first call is empty', async () => {
    const synth = new FakeSynth();
    const provider = make(synth, 5_000);
    const pending = provider.available();
    synth.load([voice('zh-CN')]);
    await expect(pending).resolves.toBe(true);
    // The listener is removed once it has answered.
    expect(synth.listenerCount).toBe(0);
  });

  it('gives up after the timeout instead of hanging (headless Chromium)', async () => {
    const synth = new FakeSynth();
    const started = Date.now();
    await expect(make(synth, 50).available()).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('is false when the browser has no speechSynthesis at all', async () => {
    const provider = new SpeechSynthesisProvider({ synth: undefined, utteranceCtor: undefined });
    await expect(provider.available()).resolves.toBe(false);
  });
});

describe('speak()', () => {
  it('cancels the in-flight utterance before queueing the next one', async () => {
    const synth = new FakeSynth();
    synth.voices = [voice('zh-CN')];
    const provider = make(synth);
    await provider.speak('打算');
    await provider.speak('明天');
    expect(synth.cancels).toBe(2);
    expect(synth.spoken.map((u) => u.text)).toEqual(['打算', '明天']);
    expect(synth.spoken[0]?.lang).toBe('zh-CN');
  });

  it('passes the rate through and trims', async () => {
    const synth = new FakeSynth();
    synth.voices = [voice('zh-CN')];
    await make(synth).speak('  你好 ', { rate: 0.9 });
    expect(synth.spoken[0]?.text).toBe('你好');
    expect(synth.spoken[0]?.rate).toBe(0.9);
  });

  it('does nothing, quietly, when there is no Chinese voice', async () => {
    const synth = new FakeSynth();
    synth.voices = [voice('en-US')];
    await expect(make(synth, 20).speak('打算')).resolves.toBeUndefined();
    expect(synth.spoken).toHaveLength(0);
    expect(synth.cancels).toBe(0);
  });

  it('ignores empty text', async () => {
    const synth = new FakeSynth();
    synth.voices = [voice('zh-CN')];
    await make(synth).speak('   ');
    expect(synth.spoken).toHaveLength(0);
  });
});
