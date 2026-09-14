/**
 * The widened `TTSProvider`, driven through a fake (docs/plans/core.md C2).
 *
 * C2's first criterion names two scenarios and they are the two that a
 * cancel-on-speak interface cannot express:
 *   - speak → stop → speak: the first is cancelled and the second is not;
 *   - two overlapping sequences: cancelling the older does not stop the newer.
 *
 * The fake here is not a mock of the Web Speech API — that is
 * `speech-synthesis.test.ts`'s job. It is a minimal `TTSProvider` whose
 * utterances are driven by hand, so the *interface's* contract is tested
 * independently of any engine.
 *
 * **This file is the contract, not a runnable conformance suite.** `ios.md` I4
 * and `android.md` A4 implement the same interface and the rules asserted here
 * are the rules their adapters must satisfy — but they cannot point their own
 * provider at this file, because every test drives the fake through methods
 * that are deliberately *not* part of `TTSProvider` (`start(id)`, `end(id)`,
 * `fail(id, message)`, `loadVoices()`). Turning this into
 * `describeProviderContract(factory, driver)` would mean specifying a driver
 * interface for "make this utterance start now", which is a real design
 * question about how a Capacitor adapter is testable at all, and not one C2
 * should answer on the mobile plans' behalf. Recorded in HANDOFF.md.
 */
import { describe, expect, it, vi } from 'vitest';

import { speakCharacters } from '@/lib/tts/sequence';

import { FakeProvider } from './fake-provider';

describe('the utterance handle', () => {
  it('is returned synchronously and carries the text it was given', () => {
    const provider = new FakeProvider();
    const utterance = provider.speak('打算');
    expect(utterance.text).toBe('打算');
    expect(typeof utterance.id).toBe('number');
  });

  it('gives every utterance a distinct id', () => {
    const provider = new FakeProvider();
    const ids = [provider.speak('a').id, provider.speak('b').id, provider.speak('c').id];
    expect(new Set(ids).size).toBe(3);
  });

  it('settles `unavailable` for empty text without touching the engine', async () => {
    const provider = new FakeProvider();
    const utterance = provider.speak('   ');
    await expect(utterance.done).resolves.toBe('unavailable');
    expect(provider.queued).toHaveLength(0);
  });

  it('reports start, boundary and end to subscribers, and unsubscribes cleanly', async () => {
    const provider = new FakeProvider();
    const utterance = provider.speak('打算');
    const seen: string[] = [];
    utterance.on('start', () => seen.push('start'));
    const off = utterance.on('boundary', (event) => seen.push(`boundary:${event.charIndex}`));
    utterance.on('end', () => seen.push('end'));

    provider.start(utterance.id);
    provider.boundary(utterance.id, 0);
    off();
    provider.boundary(utterance.id, 1);
    provider.end(utterance.id);

    await expect(utterance.done).resolves.toBe('ended');
    expect(seen).toEqual(['start', 'boundary:0', 'end']);
  });

  it('never rejects, even on an engine error', async () => {
    const provider = new FakeProvider();
    const utterance = provider.speak('打算');
    const errors: string[] = [];
    utterance.on('error', (event) => errors.push(event.message));
    provider.fail(utterance.id, 'synthesis-failed');
    await expect(utterance.done).resolves.toBe('error');
    expect(errors).toEqual(['synthesis-failed']);
  });
});

describe('stop() and per-utterance cancel()', () => {
  it('speak → stop → speak: the first is cancelled and the second is not', async () => {
    const provider = new FakeProvider();
    const first = provider.speak('打算');
    provider.start(first.id);

    provider.stop();
    await expect(first.done).resolves.toBe('cancelled');

    const second = provider.speak('明天');
    provider.start(second.id);
    provider.end(second.id);
    await expect(second.done).resolves.toBe('ended');
  });

  it('cancelling one utterance leaves a newer one alone', async () => {
    const provider = new FakeProvider();
    const older = provider.speak('打算');
    const newer = provider.speak('明天');

    older.cancel();
    await expect(older.done).resolves.toBe('cancelled');

    provider.start(newer.id);
    provider.end(newer.id);
    await expect(newer.done).resolves.toBe('ended');
  });

  it('cancelling twice, or after it ended, emits nothing and changes nothing', async () => {
    const provider = new FakeProvider();
    const utterance = provider.speak('打算');
    /**
     * Subscribed BEFORE the utterance ends, and counting.
     *
     * Re-asserting `done` after the cancels proves nothing at all: a settled
     * promise's value is immutable, so that assertion held whatever `cancel()`
     * did. The observable failure is a `cancel` **event** delivered after the
     * utterance already ended — which is exactly what the interface forbids
     * ("a no-op once it has finished, so a consumer that cancels an old
     * sequence cannot silence a newer one"), and what a sequence would read as
     * "the character I am on was interrupted".
     */
    let cancels = 0;
    utterance.on('cancel', () => {
      cancels += 1;
    });

    provider.start(utterance.id);
    provider.end(utterance.id);
    await expect(utterance.done).resolves.toBe('ended');

    utterance.cancel();
    utterance.cancel();
    expect(cancels).toBe(0);
    await expect(utterance.done).resolves.toBe('ended');
  });

  it('stop() with nothing speaking is a no-op', () => {
    const provider = new FakeProvider();
    expect(() => {
      provider.stop();
    }).not.toThrow();
  });
});

describe('two overlapping sequences', () => {
  it('cancelling the older does not stop the newer', async () => {
    const provider = new FakeProvider();

    const olderSeen: (number | null)[] = [];
    const older = speakCharacters(provider, '打算', { onIndex: (i) => olderSeen.push(i) });
    await provider.settleMicrotasks();
    provider.start(provider.last.id);

    const newerSeen: (number | null)[] = [];
    // A second consumer starts while the first is mid-flight. Its utterances
    // queue behind the first's in the fake, exactly as they do in the adapter.
    const newer = speakCharacters(provider, '明天', { onIndex: (i) => newerSeen.push(i) });
    await provider.settleMicrotasks();

    older.stop();
    await expect(older.done).resolves.toBe('stopped');

    // The newer sequence is untouched and runs to completion.
    for (let i = 0; i < 2; i += 1) {
      await provider.settleMicrotasks();
      provider.start(provider.last.id);
      provider.end(provider.last.id);
    }
    await expect(newer.done).resolves.toBe('ended');
    expect(newerSeen.filter((index) => index !== null)).toEqual([0, 1]);
    expect(newerSeen.at(-1)).toBeNull();
  });
});

describe('the interface rules a mobile adapter cannot infer', () => {
  it('replays `start` to a listener that subscribes after it fired', () => {
    // Rule 1. `@capacitor-community/text-to-speech` has no start event at all,
    // so a mobile adapter has to synthesise one — and the obvious place is
    // inside `speak()`, before any consumer can subscribe.
    const provider = new FakeProvider();
    const utterance = provider.speak('打算');
    provider.start(utterance.id);

    const seen: string[] = [];
    utterance.on('start', () => seen.push('start'));
    expect(seen).toEqual(['start']);
  });

  it('does not replay `boundary`, which is a stream', () => {
    const provider = new FakeProvider();
    const utterance = provider.speak('打算');
    provider.start(utterance.id);
    provider.boundary(utterance.id, 0);

    const seen: number[] = [];
    utterance.on('boundary', (event) => seen.push(event.charIndex));
    expect(seen).toEqual([]);
  });

  it('a sequence still lights every character when `start` fires inside speak()', async () => {
    // The end-to-end consequence of rule 1: this is the shape a Capacitor
    // adapter produces, and without the replay it yields zero highlights.
    const provider = new FakeProvider({ startsEagerly: true });
    const seen: (number | null)[] = [];
    const sequence = speakCharacters(provider, '打算', { onIndex: (i) => seen.push(i) });
    for (let i = 0; i < 2; i += 1) {
      await provider.settleMicrotasks();
      provider.end(provider.last.id);
    }
    await expect(sequence.done).resolves.toBe('ended');
    expect(seen).toEqual([0, 1, null]);
  });

  it('carries each utterance’s own options, not the previous call’s', async () => {
    // The queue is the point of C2's interface and this is the property that
    // makes it useful: C6 interleaves 0.6x per-character utterances with the
    // 0.9x block speaker on one provider.
    const provider = new FakeProvider();
    provider.speak('A', { rate: 0.6, voiceId: 'mei-jia' });
    provider.speak('B', { rate: 1.5, voiceId: 'ting-ting' });
    await provider.settleMicrotasks();
    expect(provider.spoken.map((u) => u.options.rate)).toEqual([0.6, 1.5]);
    expect(provider.spoken.map((u) => u.options.voiceId)).toEqual(['mei-jia', 'ting-ting']);
  });

  it('an engine error ends the sequence as `error`, never as `ended`', async () => {
    const provider = new FakeProvider();
    const seen: (number | null)[] = [];
    const sequence = speakCharacters(provider, '打算去', { onIndex: (i) => seen.push(i) });

    await provider.settleMicrotasks();
    provider.start(provider.last.id);
    provider.end(provider.last.id);
    await provider.settleMicrotasks();
    provider.fail(provider.last.id, 'synthesis-failed');

    // 'ended' means every character was spoken. One did not.
    await expect(sequence.done).resolves.toBe('error');
    expect(seen.at(-1)).toBeNull();
  });

  it('emits `cancel` exactly once per cancelled utterance', async () => {
    const provider = new FakeProvider();
    const utterance = provider.speak('打算');
    provider.start(utterance.id);
    let cancels = 0;
    utterance.on('cancel', () => {
      cancels += 1;
    });
    utterance.cancel();
    provider.stop();
    await expect(utterance.done).resolves.toBe('cancelled');
    expect(cancels).toBe(1);
  });
});

describe('the boundary fallback', () => {
  it.each([false, true])(
    'produces one highlight transition per character with supportsBoundary=%s',
    async (supportsBoundary) => {
      const provider = new FakeProvider({ supportsBoundary });
      const seen: (number | null)[] = [];
      const sequence = speakCharacters(provider, '打算去', { onIndex: (i) => seen.push(i) });

      for (let i = 0; i < 3; i += 1) {
        await provider.settleMicrotasks();
        expect(provider.queued).toHaveLength(1);
        const utterance = provider.last;
        expect(utterance.text).toBe('打算去'[i]);

        // **The assertion that makes this test mean what the criterion says.**
        // The utterance is queued and the loop has moved on, but the engine has
        // not started speaking — so the highlight must NOT have advanced. A
        // sequence that lit characters off its own loop position would fail
        // here and nowhere else, and that is precisely the substitution
        // sequence.ts's own comment says is wrong ("the queue can be a whole
        // character behind on a slow engine").
        expect(seen, `highlight ran ahead of the engine at ${i}`).toEqual(
          [...Array(i).keys()],
        );

        provider.start(utterance.id);
        expect(seen).toEqual([...Array(i + 1).keys()]);
        // A boundary event on a one-character utterance carries no information
        // and must change nothing — the sequence never reads them.
        provider.boundary(utterance.id, 0);
        provider.end(utterance.id);
      }

      await expect(sequence.done).resolves.toBe('ended');
      expect(seen).toEqual([0, 1, 2, null]);
    },
  );

  it('skips whitespace and keeps the index into the original string', async () => {
    const provider = new FakeProvider();
    const seen: (number | null)[] = [];
    const sequence = speakCharacters(provider, '打 算', { onIndex: (i) => seen.push(i) });

    for (let i = 0; i < 2; i += 1) {
      await provider.settleMicrotasks();
      provider.start(provider.last.id);
      provider.end(provider.last.id);
    }
    await expect(sequence.done).resolves.toBe('ended');
    // 0 and 2 — the space at 1 is not an utterance and not a highlight.
    expect(seen).toEqual([0, 2, null]);
  });

  it('skips punctuation, so no engine can kill a sentence at the comma', async () => {
    const provider = new FakeProvider();
    const seen: (number | null)[] = [];
    // 我，好 — three code points, two of them speakable.
    const sequence = speakCharacters(provider, '我，好', { onIndex: (i) => seen.push(i) });

    for (let i = 0; i < 2; i += 1) {
      await provider.settleMicrotasks();
      provider.start(provider.last.id);
      provider.end(provider.last.id);
    }
    await expect(sequence.done).resolves.toBe('ended');
    // The comma was never handed to the engine at all — which is what makes it
    // impossible for an engine that answers `，` with `synthesis-failed` to
    // stop the sequence at index 1. The indexes are still the original
    // string's, so a caller lights the right characters.
    expect(provider.spoken.map((u) => u.text)).toEqual(['我', '好']);
    expect(seen).toEqual([0, 2, null]);
  });

  it('a failure in the MIDDLE stops the sequence, and says so', async () => {
    // The policy is deliberate — `SpeakSequence.done` argues that engine
    // errors are almost never isolated — but only the *last* character was
    // ever failed, so "the rest is never spoken" was asserted nowhere.
    const provider = new FakeProvider();
    const seen: (number | null)[] = [];
    const sequence = speakCharacters(provider, '打算去', { onIndex: (i) => seen.push(i) });

    await provider.settleMicrotasks();
    provider.start(provider.last.id);
    provider.end(provider.last.id);

    await provider.settleMicrotasks();
    provider.start(provider.last.id);
    provider.fail(provider.last.id, 'synthesis-failed');

    await expect(sequence.done).resolves.toBe('error');
    // 去 was never reached.
    expect(provider.spoken.map((u) => u.text)).toEqual(['打', '算']);
    // And the highlight was cleared rather than left on 算.
    expect(seen.at(-1)).toBeNull();
  });

  it('counts astral characters as one, not as two surrogate halves', async () => {
    const provider = new FakeProvider();
    const seen: (number | null)[] = [];
    // U+20BB7 is a real CC-CEDICT headword character.
    const sequence = speakCharacters(provider, '\u{20BB7}好', { onIndex: (i) => seen.push(i) });
    for (let i = 0; i < 2; i += 1) {
      await provider.settleMicrotasks();
      expect([...provider.last.text].length).toBe(1);
      provider.start(provider.last.id);
      provider.end(provider.last.id);
    }
    await expect(sequence.done).resolves.toBe('ended');
    expect(seen).toEqual([0, 1, null]);
  });

  it('releasing mid-sequence cancels the remainder and issues no further utterances', async () => {
    const provider = new FakeProvider();
    const seen: (number | null)[] = [];
    const sequence = speakCharacters(provider, '打算去中国', { onIndex: (i) => seen.push(i) });

    await provider.settleMicrotasks();
    provider.start(provider.last.id);
    provider.end(provider.last.id);
    await provider.settleMicrotasks();
    provider.start(provider.last.id);

    const spokenSoFar = provider.spoken.length;
    sequence.stop();
    await expect(sequence.done).resolves.toBe('stopped');
    await provider.settleMicrotasks();

    expect(provider.spoken).toHaveLength(spokenSoFar);
    // The highlight is cleared, not left on the last character it lit.
    expect(seen.at(-1)).toBeNull();
  });

  it('a sequence over nothing speakable ends without touching the engine', async () => {
    const provider = new FakeProvider();
    const sequence = speakCharacters(provider, '   ');
    await expect(sequence.done).resolves.toBe('unavailable');
    expect(provider.spoken).toHaveLength(0);
  });

  it('a provider with no voice ends the sequence rather than hanging', async () => {
    const provider = new FakeProvider({ voiceless: true });
    const onIndex = vi.fn();
    const sequence = speakCharacters(provider, '打算', { onIndex });
    await expect(sequence.done).resolves.toBe('unavailable');
    expect(onIndex).toHaveBeenLastCalledWith(null);
  });
});
