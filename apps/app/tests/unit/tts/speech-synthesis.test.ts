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

import {
  SpeechSynthesisProvider,
  isCantoneseVoice,
  isChineseVoice,
  pickChineseVoice,
} from '@/lib/tts/speech-synthesis';

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
    // The engine fires `error: 'canceled'` on the utterance it was speaking.
    const live = this.#live;
    this.#live = null;
    live?.onerror?.({ error: 'canceled' } as SpeechSynthesisErrorEvent);
  }
  speak(u: FakeUtterance): void {
    this.spoken.push(u);
    this.#live = u;
    u.onstart?.(undefined as unknown as SpeechSynthesisEvent);
  }

  /** The one utterance the engine is holding, if any. */
  #live: FakeUtterance | null = null;

  /** What the engine does when an utterance finishes normally. */
  finish(): void {
    const live = this.#live;
    this.#live = null;
    live?.onend?.(undefined as unknown as SpeechSynthesisEvent);
  }
  /** What the engine does when it gives up on one. */
  fail(error: string): void {
    const live = this.#live;
    this.#live = null;
    live?.onerror?.({ error } as SpeechSynthesisErrorEvent);
  }
  /** A boundary event on the utterance currently being spoken. */
  boundary(charIndex: number): void {
    this.#live?.onboundary?.({ charIndex } as SpeechSynthesisEvent);
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
  onstart: ((event: SpeechSynthesisEvent) => void) | null = null;
  onend: ((event: SpeechSynthesisEvent) => void) | null = null;
  onerror: ((event: SpeechSynthesisErrorEvent) => void) | null = null;
  onboundary: ((event: SpeechSynthesisEvent) => void) | null = null;
  constructor(text: string) {
    this.text = text;
  }
}

/**
 * `speak()` returns synchronously and resolves its voice list in a microtask,
 * so a test that inspects the engine without yielding is looking at a state the
 * adapter has not reached yet.
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
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
    for (const lang of ['zh', 'zh-CN', 'zh-TW', 'ZH-HK', 'zh_CN', 'cmn-Hans-CN', 'yue-Hant-HK']) {
      expect(isChineseVoice({ lang }), lang).toBe(true);
    }
    for (const lang of ['en-US', 'ja-JP', '', 'zhu-XX']) {
      expect(isChineseVoice({ lang }), lang).toBe(false);
    }
  });

  it('knows which of those are Cantonese', () => {
    for (const lang of ['zh-HK', 'ZH-MO', 'yue', 'yue-Hant-HK', 'zh-yue']) {
      expect(isCantoneseVoice({ lang }), lang).toBe(true);
    }
    for (const lang of ['zh', 'zh-CN', 'zh-TW', 'cmn-Hans-CN', 'zh-SG']) {
      expect(isCantoneseVoice({ lang }), lang).toBe(false);
    }
  });

  it('prefers the voice the browser marks default, within its tier', () => {
    const picked = pickChineseVoice([voice('en-US'), voice('zh-CN'), voice('zh-CN', 'Ting', true)]);
    expect(picked?.name).toBe('Ting');
  });

  it('picks zh-CN over an earlier zh-HK (Sin-ji sorts first on macOS)', () => {
    const picked = pickChineseVoice([voice('zh-HK', 'Sinji'), voice('zh-CN', 'Tingting')]);
    expect(picked?.name).toBe('Tingting');
  });

  it('ranks Mandarin regions above a bare zh, and default does not jump a tier', () => {
    const picked = pickChineseVoice([
      voice('zh', 'Generic', true),
      voice('zh-TW', 'Meijia'),
      voice('zh-CN', 'Tingting'),
    ]);
    expect(picked?.name).toBe('Tingting');
    expect(pickChineseVoice([voice('zh', 'Generic', true), voice('zh-TW', 'Meijia')])?.name).toBe(
      'Meijia',
    );
  });

  it('refuses a Cantonese-only browser rather than reading pinyin in Cantonese', () => {
    expect(pickChineseVoice([voice('zh-HK', 'Sinji', true), voice('yue-Hant-HK')])).toBeNull();
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

  it('pays the timeout once, not once per caller (a SpeakButton per card)', async () => {
    const synth = new FakeSynth();
    const provider = make(synth, 60);
    const started = Date.now();
    await expect(provider.available()).resolves.toBe(false);
    const afterFirst = Date.now() - started;
    const second = Date.now();
    await expect(provider.available()).resolves.toBe(false);
    expect(Date.now() - second).toBeLessThan(afterFirst);
    expect(synth.listenerCount).toBe(0);
  });

  it('drops the memo as soon as the browser does have voices', async () => {
    const synth = new FakeSynth();
    const provider = make(synth, 20);
    await expect(provider.available()).resolves.toBe(false);
    synth.voices = [voice('zh-CN')];
    await expect(provider.available()).resolves.toBe(true);
  });
});

describe('speak()', () => {
  /**
   * **This block changed at C2 and every change is deliberate.** The old four
   * tests asserted the pre-C2 contract: `speak()` returned `Promise<void>`,
   * resolved once queued, and called `synth.cancel()` first so a second tap
   * replaced the first. C2 moved the cancel out of the provider — C6's
   * hold-to-slow mode is N utterances in order, which a cancel-on-speak
   * interface cannot express — so `speak()` now enqueues and returns a handle
   * synchronously. What replaced each old assertion:
   *
   * | Old | Now |
   * |---|---|
   * | "cancels the in-flight utterance before queueing the next one" | "hands the engine one utterance at a time, in order" plus, one layer up, `speak-button.test.tsx`'s "tap again stops, and does not play it a second time" |
   * | "passes the rate through and trims" | unchanged in substance; awaits the handle rather than the call |
   * | "does nothing, quietly, when there is no Chinese voice" | same, asserted through the handle's outcome |
   * | "ignores empty text" | same, and now also asserts the handle settles rather than hanging |
   */
  it('hands the engine one utterance at a time, in order, and cancels nothing', async () => {
    const synth = new FakeSynth();
    synth.voices = [voice('zh-CN')];
    const provider = make(synth);

    const first = provider.speak('打算');
    const second = provider.speak('明天');
    await flush();

    // One in the engine, not two — the browser's own queue is global and
    // `cancel()` empties all of it, so the adapter keeps its own.
    expect(synth.spoken.map((u) => u.text)).toEqual(['打算']);
    expect(synth.cancels).toBe(0);
    expect(synth.spoken[0]?.lang).toBe('zh-CN');

    synth.finish();
    await expect(first.done).resolves.toBe('ended');
    await flush();
    expect(synth.spoken.map((u) => u.text)).toEqual(['打算', '明天']);

    synth.finish();
    await expect(second.done).resolves.toBe('ended');
  });

  it('stop() cancels the speaking utterance and everything queued behind it', async () => {
    const synth = new FakeSynth();
    synth.voices = [voice('zh-CN')];
    const provider = make(synth);

    const first = provider.speak('打算');
    const second = provider.speak('明天');
    await flush();

    provider.stop();
    expect(synth.cancels).toBe(1);
    await expect(first.done).resolves.toBe('cancelled');
    await expect(second.done).resolves.toBe('cancelled');

    // …and the engine is not left holding the queued one.
    await flush();
    expect(synth.spoken.map((u) => u.text)).toEqual(['打算']);
  });

  it('cancelling a queued utterance drops it without touching the one speaking', async () => {
    const synth = new FakeSynth();
    synth.voices = [voice('zh-CN')];
    const provider = make(synth);

    const first = provider.speak('打算');
    const second = provider.speak('明天');
    await flush();

    second.cancel();
    expect(synth.cancels).toBe(0);
    await expect(second.done).resolves.toBe('cancelled');

    synth.finish();
    await expect(first.done).resolves.toBe('ended');
    await flush();
    expect(synth.spoken.map((u) => u.text)).toEqual(['打算']);
  });

  it('a cancel while the voice list is still resolving still lands', async () => {
    // The window a second tap actually arrives in: Chrome's first `getVoices()`
    // is empty, so the adapter is awaiting `voiceschanged` when the handle is
    // cancelled. A handle that only existed after the await could not be.
    const synth = new FakeSynth();
    const provider = make(synth, 20);
    const utterance = provider.speak('打算');
    utterance.cancel();
    synth.load([voice('zh-CN')]);
    await flush();

    await expect(utterance.done).resolves.toBe('cancelled');
    expect(synth.spoken).toHaveLength(0);
  });

  it('passes the rate through and trims', async () => {
    const synth = new FakeSynth();
    synth.voices = [voice('zh-CN')];
    const utterance = make(synth).speak('  你好 ', { rate: 0.9 });
    await flush();
    expect(utterance.text).toBe('你好');
    expect(synth.spoken[0]?.text).toBe('你好');
    expect(synth.spoken[0]?.rate).toBe(0.9);
  });

  it('speaks each queued utterance with ITS OWN rate, voice and lang', async () => {
    // The queue's whole point, and the bug the C2 review found: `#pump` used to
    // take its options from whichever call re-entered it, so a queued utterance
    // was spoken with the previous one's settings. C6 interleaves 0.6x
    // per-character utterances with the 0.9x block speaker on this provider.
    const synth = new FakeSynth();
    synth.voices = [voice('zh-CN', 'Ting-Ting'), voice('zh-TW', 'Mei-Jia')];
    const provider = make(synth);

    provider.speak('A', { rate: 0.6, voiceId: 'Mei-Jia', lang: 'zh-TW' });
    provider.speak('B', { rate: 1.5, voiceId: 'Ting-Ting', lang: 'zh-CN' });
    await flush();
    synth.finish();
    await flush();

    expect(synth.spoken.map((u) => u.rate)).toEqual([0.6, 1.5]);
    expect(synth.spoken.map((u) => u.voice?.name)).toEqual(['Mei-Jia', 'Ting-Ting']);
    expect(synth.spoken.map((u) => u.lang)).toEqual(['zh-TW', 'zh-CN']);
  });

  it('a cancel after a cancel-triggered engine error still fires `cancel` once', async () => {
    // `synth.cancel()` makes the engine answer with `error: 'canceled'` on the
    // live utterance, and `onerror` settles it — so the adapter must not emit
    // its own `cancel` on top.
    const synth = new FakeSynth();
    synth.voices = [voice('zh-CN')];
    const provider = make(synth);
    const utterance = provider.speak('打算');
    await flush();

    let cancels = 0;
    utterance.on('cancel', () => {
      cancels += 1;
    });
    utterance.cancel();
    await expect(utterance.done).resolves.toBe('cancelled');
    expect(cancels).toBe(1);
  });

  it('stop() fires `cancel` once on the speaking utterance too', async () => {
    const synth = new FakeSynth();
    synth.voices = [voice('zh-CN')];
    const provider = make(synth);
    const utterance = provider.speak('打算');
    await flush();

    let cancels = 0;
    utterance.on('cancel', () => {
      cancels += 1;
    });
    provider.stop();
    await expect(utterance.done).resolves.toBe('cancelled');
    expect(cancels).toBe(1);
  });

  it('replays `start` to a listener that subscribes after the engine started', async () => {
    const synth = new FakeSynth();
    synth.voices = [voice('zh-CN')];
    const provider = make(synth);
    const utterance = provider.speak('打算');
    // The FakeSynth fires `onstart` from inside `speak()`, as the engine does.
    await flush();

    const seen: string[] = [];
    utterance.on('start', () => seen.push('start'));
    expect(seen).toEqual(['start']);
  });

  it('honours a voice preference, and falls back rather than going silent', async () => {
    const synth = new FakeSynth();
    synth.voices = [voice('zh-CN', 'Ting-Ting'), voice('zh-TW', 'Mei-Jia')];
    const provider = make(synth);

    provider.speak('打算', { voiceId: 'Mei-Jia' });
    await flush();
    expect(synth.spoken[0]?.voice?.name).toBe('Mei-Jia');

    // A stored preference must not make the app silent after a system update
    // removes the voice it names. No `stop()` between the two: the options are
    // per handle now, so the queue is enough.
    provider.speak('明天', { voiceId: 'a-voice-that-was-uninstalled' });
    synth.finish();
    await flush();
    expect(synth.spoken[1]?.voice?.name).toBe('Ting-Ting');
  });

  it('refuses a Cantonese voice even when it is asked for by id', async () => {
    const synth = new FakeSynth();
    synth.voices = [voice('zh-CN', 'Ting-Ting'), voice('zh-HK', 'Sin-ji')];
    const provider = make(synth);
    provider.speak('打算', { voiceId: 'Sin-ji' });
    await flush();
    // The card shows Mandarin pinyin; a Cantonese reading of it is a wrong
    // answer the learner cannot detect (§1).
    expect(synth.spoken[0]?.voice?.name).toBe('Ting-Ting');
  });

  it('does nothing, quietly, when there is no Chinese voice', async () => {
    const synth = new FakeSynth();
    synth.voices = [voice('en-US')];
    const utterance = make(synth, 20).speak('打算');
    await expect(utterance.done).resolves.toBe('unavailable');
    expect(synth.spoken).toHaveLength(0);
    expect(synth.cancels).toBe(0);
  });

  it('ignores empty text, and settles rather than hanging', async () => {
    const synth = new FakeSynth();
    synth.voices = [voice('zh-CN')];
    const utterance = make(synth).speak('   ');
    await expect(utterance.done).resolves.toBe('unavailable');
    expect(synth.spoken).toHaveLength(0);
  });

  it('reports an engine error once, and advances the queue', async () => {
    const synth = new FakeSynth();
    synth.voices = [voice('zh-CN')];
    const provider = make(synth);
    const first = provider.speak('打算');
    const second = provider.speak('明天');
    await flush();

    const errors: string[] = [];
    first.on('error', (event) => errors.push(event.message));
    synth.fail('synthesis-failed');
    await expect(first.done).resolves.toBe('error');
    expect(errors).toEqual(['synthesis-failed']);

    await flush();
    expect(synth.spoken.map((u) => u.text)).toEqual(['打算', '明天']);
    synth.finish();
    await expect(second.done).resolves.toBe('ended');
  });

  it('treats the engine’s `interrupted` error as a cancel, not an error', async () => {
    const synth = new FakeSynth();
    synth.voices = [voice('zh-CN')];
    const provider = make(synth);
    const utterance = provider.speak('打算');
    await flush();
    // What `synth.cancel()` looks like from the engine's side on Chrome.
    synth.fail('interrupted');
    await expect(utterance.done).resolves.toBe('cancelled');
  });

  it('forwards boundary events, while still declaring it does not support them', async () => {
    const synth = new FakeSynth();
    synth.voices = [voice('zh-CN')];
    const provider = make(synth);
    expect(provider.supportsBoundary).toBe(false);

    const utterance = provider.speak('打算');
    await flush();
    const seen: number[] = [];
    utterance.on('boundary', (event) => seen.push(event.charIndex));
    synth.boundary(1);
    expect(seen).toEqual([1]);
  });
});

/**
 * THE WATCHDOG — the guard that had no test at all.
 *
 * `#current` is cleared only by an engine event, so an engine that never fires
 * `end` or `error` wedges the queue forever. The watchdog was written for that
 * and reviewed into three bugs, each of which is one test below:
 *
 *  1. it gave up on the utterance without taking it off the **engine**, so the
 *     next `speak()` was handed to a synthesiser still speaking the abandoned
 *     one — two utterances in the browser's global, additive queue at once,
 *     which is the exact state this adapter exists to prevent;
 *  2. `stop()` only reached `synth.cancel()` when it was tracking something, so
 *     after a watchdog fire it was a complete no-op and nothing could silence
 *     the audio;
 *  3. the timeout scaled with the text and had no cap, so the *longer* the
 *     utterance the *later* the guard — backwards, because the failure it
 *     guards is Chrome dropping a long utterance.
 */
describe('the watchdog', () => {
  function armed() {
    const synth = new FakeSynth();
    synth.voices = [voice('zh-CN')];
    return { synth, provider: make(synth) };
  }

  it('takes the abandoned utterance off the ENGINE, not only off the queue', async () => {
    vi.useFakeTimers();
    try {
      const { synth, provider } = armed();
      const first = provider.speak('打算');
      await vi.advanceTimersByTimeAsync(0);
      await flush();
      expect(synth.spoken.map((u) => u.text)).toEqual(['打算']);

      // The engine says nothing, ever.
      await vi.advanceTimersByTimeAsync(31_000);
      await flush();
      expect(await first.done).toBe('error');
      // Cancelled once by the watchdog — without this the engine is still
      // holding 打算 when 明天 arrives.
      expect(synth.cancels).toBeGreaterThanOrEqual(1);

      const second = provider.speak('明天');
      await vi.advanceTimersByTimeAsync(0);
      await flush();
      expect(synth.spoken.map((u) => u.text)).toEqual(['打算', '明天']);
      synth.finish();
      expect(await second.done).toBe('ended');
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop() reaches the engine even when this adapter is tracking nothing', async () => {
    const { synth, provider } = armed();
    // Nothing ever queued: `#current` is null and `#queue` is empty. The
    // browser's queue is global, so "I am tracking nothing" is not "nothing is
    // speaking", and this used to return without touching the engine.
    provider.stop();
    expect(synth.cancels).toBe(1);
  });

  it('fires within the cap however long the text is', async () => {
    vi.useFakeTimers();
    try {
      const { synth, provider } = armed();
      // 40 characters at the block rate scaled to ~53s before the cap.
      const handle = provider.speak('打'.repeat(40), { rate: 0.9 });
      await vi.advanceTimersByTimeAsync(0);
      await flush();
      expect(synth.spoken).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(29_000);
      await flush();
      // Still generous — the guard has not fired early on a long block.
      expect(synth.cancels).toBe(0);

      await vi.advanceTimersByTimeAsync(2_000);
      await flush();
      expect(await handle.done).toBe('error');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not fire for an utterance the engine did answer', async () => {
    vi.useFakeTimers();
    try {
      const { synth, provider } = armed();
      const handle = provider.speak('打算');
      await vi.advanceTimersByTimeAsync(0);
      await flush();
      synth.finish();
      expect(await handle.done).toBe('ended');

      await vi.advanceTimersByTimeAsync(60_000);
      await flush();
      // No stray cancel, and no second settle: `finish` cleared the timer.
      expect(synth.cancels).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
