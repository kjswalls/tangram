/**
 * One utterance per character, with the highlight advancing on `start`
 * (docs/plans/core.md C2; C6 is the phase that mounts it).
 *
 * **Why per-character rather than one utterance plus boundary events.** The
 * Android audit is explicit that range events are engine-dependent, WebKit's
 * are documented unreliable, and `window.speechSynthesis` is reported undefined
 * in the Android WebView (STACK register #19). STACK §2.1 adopts per-character
 * utterances as **the rule, not the fallback**, and C6 repeats it: "Do this
 * even where boundary events exist." So this module never reads `boundary` and
 * behaves identically whether the provider declares `supportsBoundary` true or
 * false — which is what its unit test asserts, rather than only exercising the
 * `false` branch.
 *
 * It costs one thing and it is worth stating: N utterances do not sound like
 * one sentence. That is the point here — hold-to-slow is 0.6x, character by
 * character, for a learner working out which syllable is which. The block
 * speaker (`SpeakButton`) is one utterance and stays one utterance.
 *
 * **What counts as a character.** Code points, not UTF-16 units: CJK Extension
 * B lives above the BMP and a surrogate half is not a character anyone can
 * speak. Whitespace **and punctuation** are skipped; everything else — hanzi,
 * Latin, digits — is spoken, so 卡拉OK keeps its OK, which is what *filtering*
 * to "CJK only" would have dropped.
 *
 * Punctuation was originally spoken, on the reasoning that "an engine handed 。
 * says nothing and returns, which is a free no-op". That is an assertion about
 * every engine this app will ever run on, nothing verifies it, and the cost of
 * it being wrong is not free: an engine that answers a `，`-only utterance with
 * `synthesis-failed` kills the **whole** sequence at the comma, because the
 * first `'error'` stops it. Skipping punctuation costs nothing a learner wants
 * — nobody holds the speaker to hear a comma — and removes an unverifiable
 * claim from the hot path.
 *
 * The index reported to `onIndex` is the index into the **code points of the
 * original string**, so a caller can light `chars[i]` without re-deriving
 * anything. `null` means the sequence is over.
 */
import type { SpeakOptions, TTSProvider, Utterance } from '@/lib/tts/provider';

export interface SequenceOptions extends SpeakOptions {
  /**
   * The index of the character now being spoken, or `null` when the sequence
   * has ended for any reason — finished, stopped, or refused for want of a
   * voice. A consumer that only clears on "finished" leaves a character lit
   * forever when the learner releases the hold.
   */
  onIndex?: (index: number | null) => void;
}

export type SequenceOutcome = 'ended' | 'stopped' | 'unavailable' | 'error';

export interface SpeakSequence {
  /**
   * Resolves when the sequence ends, however it ends. Never rejects.
   *
   * `'ended'` means **every** character was spoken, and that is why `'error'`
   * is in the union: an engine failure on one character used to fall through
   * the loop and the sequence still reported `'ended'` at the far end, so a
   * hold-to-slow pass in which nothing was audible was indistinguishable from
   * one that worked. The engine errors that produce it are the common ones —
   * Chrome's `not-allowed` (speech attempted outside a user gesture) and
   * `synthesis-failed` — and they are almost never isolated to one character,
   * so the first one stops the sequence.
   */
  readonly done: Promise<SequenceOutcome>;
  /** Stop here. Idempotent, and a no-op once the sequence has ended. */
  stop(): void;
}

/** C6's default. 0.6x is product-decisions §4 rule 3's number. */
export const SLOW_RATE = 0.6;

/**
 * Code points, with their index into the ORIGINAL string's code points, minus
 * whitespace and punctuation. See the header for why punctuation is out.
 *
 * `\p{P}` covers CJK punctuation (。，、！？；：《》「」…—) as well as ASCII;
 * `\p{S}` covers symbols such as ～ and currency marks. `\p{C}` is the
 * unassigned and control ranges, which nothing should hand an engine.
 */
const UNSPEAKABLE = /[\p{White_Space}\p{P}\p{S}\p{C}]/u;

export function speakableCharacters(text: string): { char: string; index: number }[] {
  const out: { char: string; index: number }[] = [];
  let index = 0;
  for (const char of text) {
    if (!UNSPEAKABLE.test(char)) out.push({ char, index });
    index += 1;
  }
  return out;
}

export function speakCharacters(
  provider: TTSProvider,
  text: string,
  options: SequenceOptions = {},
): SpeakSequence {
  const { onIndex, ...speakOptions } = options;
  const characters = speakableCharacters(text);

  let stopped = false;
  let current: Utterance | null = null;
  let settle!: (outcome: SequenceOutcome) => void;
  const done = new Promise<SequenceOutcome>((resolve) => {
    settle = resolve;
  });

  const finish = (outcome: SequenceOutcome) => {
    if (stopped && outcome !== 'stopped') return;
    stopped = true;
    current = null;
    onIndex?.(null);
    settle(outcome);
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    const utterance = current;
    current = null;
    // Cancel only OUR utterance, never the provider's whole queue: a second
    // sequence started a moment ago is a different consumer's, and stopping
    // the older one must not silence the newer.
    utterance?.cancel();
    onIndex?.(null);
    settle('stopped');
  };

  void (async () => {
    if (characters.length === 0) {
      finish('unavailable');
      return;
    }
    for (const { char, index } of characters) {
      if (stopped) return;
      const utterance = provider.speak(char, speakOptions);
      current = utterance;
      // `start`, not the loop position: the highlight has to track what the
      // engine is actually saying, and the queue can be a whole character
      // behind on a slow engine.
      const off = utterance.on('start', () => {
        if (!stopped) onIndex?.(index);
      });
      const outcome = await utterance.done;
      off();
      if (stopped) return;
      if (outcome === 'cancelled') {
        finish('stopped');
        return;
      }
      if (outcome === 'unavailable') {
        finish('unavailable');
        return;
      }
      if (outcome === 'error') {
        // Not swallowed and not reported as 'ended': see `SpeakSequence.done`.
        finish('error');
        return;
      }
    }
    finish('ended');
  })();

  return { done, stop };
}
