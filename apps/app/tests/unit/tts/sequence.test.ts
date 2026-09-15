/**
 * One utterance per character (docs/plans/core.md C2's module, C6's phase).
 *
 * The module landed at C2 and **had no test of its own** until C6 mounted it;
 * the hold-to-slow criteria are all statements about this file, so they are
 * asserted here against the frozen `TTSProvider` contract rather than through
 * the component.
 *
 * Nothing here uses a fake clock. `FakeProvider` is hand-cranked — every
 * `start`, `end` and `error` is triggered by the test — so a sequence's
 * behaviour is asserted against the contract rather than against whatever a
 * fake timer happened to do.
 */
import { describe, expect, it } from 'vitest';

import { SLOW_RATE, speakCharacters, speakableCharacters } from '@/lib/tts/sequence';

import { FakeProvider } from './fake-provider';

/** Crank one character all the way through: start, then end. */
async function playOne(provider: FakeProvider): Promise<void> {
  const id = provider.last.id;
  provider.start(id);
  provider.end(id);
  await provider.settleMicrotasks();
}

describe('speakableCharacters', () => {
  it('is code points, not UTF-16 units', () => {
    // CJK Extension B is two code units wide; half a surrogate pair is not a
    // character anyone can speak.
    const found = speakableCharacters('\u{20BB7}林');
    expect(found.map((entry) => entry.char)).toEqual(['\u{20BB7}', '林']);
    expect(found.map((entry) => entry.index)).toEqual([0, 1]);
  });

  it('skips whitespace and punctuation, and keeps Latin', () => {
    const found = speakableCharacters('卡拉OK，好 吗？');
    expect(found.map((entry) => entry.char).join('')).toBe('卡拉OK好吗');
    // The index is into the ORIGINAL string's code points, so a caller can
    // light `chars[i]` without re-deriving anything.
    // 卡0 拉1 O2 K3 ，4 好5 ␠6 吗7 ？8 — the last speakable one is 吗.
    expect(found.at(-1)?.index).toBe(7);
  });
});

describe('speakCharacters', () => {
  it('speaks N utterances for an N-character block, at the configured rate', async () => {
    const provider = new FakeProvider();
    const seen: (number | null)[] = [];
    const sequence = speakCharacters(provider, '打算明', {
      rate: SLOW_RATE,
      onIndex: (index) => seen.push(index),
    });

    await provider.settleMicrotasks();
    expect(provider.spoken.map((u) => u.text)).toEqual(['打']);
    await playOne(provider);
    await playOne(provider);
    await playOne(provider);

    expect(await sequence.done).toBe('ended');
    expect(provider.spoken.map((u) => u.text)).toEqual(['打', '算', '明']);
    for (const spoken of provider.spoken) expect(spoken.options.rate).toBe(SLOW_RATE);
    // One index per character, then `null` — the clear a consumer needs so a
    // character is not left lit for ever.
    expect(seen).toEqual([0, 1, 2, null]);
  });

  it('advances on `start`, not on the loop position', async () => {
    // The queue can be a whole character behind on a slow engine, and the
    // highlight has to track what the engine is actually saying.
    const provider = new FakeProvider();
    const seen: (number | null)[] = [];
    speakCharacters(provider, '打算', { onIndex: (index) => seen.push(index) });
    await provider.settleMicrotasks();
    expect(seen).toEqual([]);
    provider.start(provider.last.id);
    expect(seen).toEqual([0]);
  });

  it('…and does the same with supportsBoundary TRUE, because it never reads boundaries', async () => {
    /**
     * STACK §2.1 adopts per-character utterances as **the rule, not the
     * fallback**, and C6 repeats it: "Do this even where boundary events
     * exist." A test that only exercised `supportsBoundary: false` would let a
     * later optimisation quietly branch on it.
     */
    const provider = new FakeProvider({ supportsBoundary: true });
    const seen: (number | null)[] = [];
    const sequence = speakCharacters(provider, '打算', { onIndex: (index) => seen.push(index) });
    await provider.settleMicrotasks();
    provider.boundary(provider.last.id, 0);
    await playOne(provider);
    await playOne(provider);
    expect(await sequence.done).toBe('ended');
    expect(provider.spoken.map((u) => u.text)).toEqual(['打', '算']);
    expect(seen).toEqual([0, 1, null]);
  });

  it('stopping mid-sequence cancels the rest and issues no further utterances', async () => {
    const provider = new FakeProvider();
    const seen: (number | null)[] = [];
    const sequence = speakCharacters(provider, '打算明天', {
      onIndex: (index) => seen.push(index),
    });
    await provider.settleMicrotasks();
    await playOne(provider);
    expect(provider.spoken).toHaveLength(2);

    sequence.stop();
    await provider.settleMicrotasks();

    expect(await sequence.done).toBe('stopped');
    // Two were queued; the third and fourth never were.
    expect(provider.spoken.map((u) => u.text)).toEqual(['打', '算']);
    expect(seen.at(-1)).toBeNull();
  });

  it('stopping cancels only ITS utterance, never the provider’s whole queue', async () => {
    // A second sequence started a moment ago is a different consumer's, and
    // stopping the older one must not silence the newer.
    const provider = new FakeProvider();
    const first = speakCharacters(provider, '打算');
    await provider.settleMicrotasks();
    const mine = provider.last;
    const other = provider.speak('別的');

    first.stop();
    await provider.settleMicrotasks();
    expect(mine.settled).toBe(true);
    expect(await Promise.race([other.done, Promise.resolve('pending')])).toBe('pending');
  });

  it('an engine error stops the sequence and is not reported as “ended”', async () => {
    /**
     * A failure on one character used to fall through the loop and the sequence
     * still reported `'ended'` at the far end, so a hold in which nothing was
     * audible was indistinguishable from one that worked.
     */
    const provider = new FakeProvider();
    const sequence = speakCharacters(provider, '打算明');
    await provider.settleMicrotasks();
    provider.fail(provider.last.id, 'synthesis-failed');
    expect(await sequence.done).toBe('error');
    expect(provider.spoken.map((u) => u.text)).toEqual(['打']);
  });

  it('a provider with no voice reports unavailable rather than pretending', async () => {
    const provider = new FakeProvider({ voiceless: true });
    const seen: (number | null)[] = [];
    const sequence = speakCharacters(provider, '打算', { onIndex: (index) => seen.push(index) });
    expect(await sequence.done).toBe('unavailable');
    expect(seen.at(-1)).toBeNull();
  });

  it('a block with nothing speakable in it ends at once', async () => {
    const provider = new FakeProvider();
    const sequence = speakCharacters(provider, '，。！');
    expect(await sequence.done).toBe('unavailable');
    expect(provider.spoken).toEqual([]);
  });

  it('works against an adapter that fires `start` from inside speak()', async () => {
    // The shape a Capacitor adapter produces: the plugin has no start event, so
    // one is synthesised at dispatch, before any consumer can subscribe. The
    // interface's replay rule is what makes the highlight advance at all.
    const provider = new FakeProvider({ startsEagerly: true });
    const seen: (number | null)[] = [];
    const sequence = speakCharacters(provider, '打算', { onIndex: (index) => seen.push(index) });
    await provider.settleMicrotasks();
    expect(seen).toEqual([0]);
    // No hand-cranked `start` here: this adapter already fired it at dispatch,
    // which is the whole point, so the test only has to end each utterance.
    provider.end(provider.last.id);
    await provider.settleMicrotasks();
    provider.end(provider.last.id);
    await provider.settleMicrotasks();
    expect(await sequence.done).toBe('ended');
    expect(seen).toEqual([0, 1, null]);
  });
});
