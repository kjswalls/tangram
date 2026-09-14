'use client';

/**
 * The block speaker (PLAN.md §3.6; product rule 3, rebuilt at core.md C2).
 *
 * **One speaker per hanzi BLOCK** — a headword, a phrase, an example sentence,
 * a card face — not one per character. C6 adds the hold: hold the speaker and
 * the block is read character by character at 0.6x with each character lit.
 * This phase builds the block half and the stop.
 *
 * **Tap plays; tap again stops.** Before C2 the provider cancelled whatever was
 * speaking on every `speak()`, so a double tap replayed the word and there was
 * no way to stop it at all. The cancel moved out of the provider (C6 needs a
 * queue, not a cancel-on-speak), so this is where it lives now: a tap on a
 * speaking button stops it, and a tap on an idle one stops whatever else was
 * speaking first. Both are asserted in tests/unit/tts/speak-button.test.tsx.
 *
 * The pending / ready / unavailable triad survives verbatim, and so does the
 * reason being **visible text** rather than only a `title`: a touch screen never
 * shows a `title`, so on a phone the tooltip-only version was a dead grey glyph
 * with no way to find out why. The `title` stays for pointer devices and the
 * `aria-label` for readers, and the tooltip lives on the wrapping span because a
 * disabled button has `pointer-events: none` and would never receive the hover
 * that shows one. Unavailable is not an edge case — headless Chromium has no
 * voices, so it is the only state this repository's e2e can observe.
 */

import { Volume2, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import type { TTSProvider, Utterance } from '@/lib/tts/provider';
import { getTTSProvider } from '@/lib/tts/speech-synthesis';

export const NO_VOICE_TOOLTIP = 'No Mandarin voice available in this browser';

/** The same thing, short enough to sit next to the glyph on a 390px card. */
export const NO_VOICE_LABEL = 'No voice';

/** Slower than natural, which is the point for a learner. Unchanged from P6. */
export const BLOCK_RATE = 0.9;

export interface SpeakButtonProps {
  /** The hanzi to read aloud. */
  text: string;
  /** Injected in unit tests; the Web Speech provider otherwise. */
  provider?: TTSProvider;
  className?: string;
  /** Extra words for screen readers, e.g. the headword being spoken. */
  label?: string;
}

type Status = 'pending' | 'ready' | 'unavailable';

/**
 * What the learner is told when an utterance that was supposed to play did
 * not. Short enough to sit next to the glyph on a 390px card, like
 * `NO_VOICE_LABEL`, and for the same reason: a touch screen never shows a
 * `title`, so a failure that lives only in a tooltip is a failure the learner
 * cannot see.
 */
export const SPEAK_FAILED_LABEL = 'Could not play';

export function SpeakButton({ text, provider, className, label }: SpeakButtonProps) {
  const [status, setStatus] = useState<Status>('pending');
  const [speaking, setSpeaking] = useState(false);
  const [failed, setFailed] = useState(false);
  const utterance = useRef<Utterance | null>(null);

  /**
   * `available()` has a different answer at different times, so it is asked
   * again whenever the provider says the voice list moved. Asked once, a
   * speaker mounted during Chrome's cold-start window said "No voice" for the
   * life of the mount while the next card's speaker worked — two identical
   * buttons on one screen disagreeing. `onVoicesChanged` is the C2 addition
   * that makes the re-ask possible through the seam rather than by reaching
   * for `window.speechSynthesis` from a component.
   */
  useEffect(() => {
    let alive = true;
    const tts = provider ?? getTTSProvider();
    const probe = () => {
      void tts
        .available()
        .then((ok) => {
          if (alive) setStatus(ok ? 'ready' : 'unavailable');
        })
        .catch(() => {
          if (alive) setStatus('unavailable');
        });
    };
    probe();
    const unsubscribe = tts.onVoicesChanged(probe);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [provider]);

  // Unmounting while speaking must stop the audio. A review card that is graded
  // mid-utterance unmounts, and without this the next card's speaker fights an
  // utterance nothing on screen owns any more.
  useEffect(
    () => () => {
      utterance.current?.cancel();
      utterance.current = null;
    },
    [],
  );

  const disabled = status !== 'ready';
  const tooltip =
    status === 'unavailable'
      ? NO_VOICE_TOOLTIP
      : speaking
        ? `Stop ${label ?? text}`
        : `Play ${label ?? text}`;

  const toggle = () => {
    if (disabled) return;
    const tts = provider ?? getTTSProvider();
    if (utterance.current) {
      utterance.current.cancel();
      utterance.current = null;
      setSpeaking(false);
      return;
    }
    // Stop whatever else was speaking — another card's speaker, a sequence —
    // before starting. This is the cancel that used to live inside `speak()`.
    tts.stop();
    setFailed(false);
    const handle = tts.speak(text, { rate: BLOCK_RATE });
    utterance.current = handle;
    setSpeaking(true);
    void handle.done.then((outcome) => {
      if (utterance.current !== handle) return;
      utterance.current = null;
      setSpeaking(false);
      /**
       * The outcome is READ, not discarded. The provider goes to the trouble
       * of distinguishing `'error'` and `'unavailable'` from `'ended'`, and a
       * consumer that throws that away returns to the Play glyph as if the
       * word had been spoken — silence with no explanation, on a surface whose
       * failure mode is already "nothing happens". `'cancelled'` is the
       * learner's own second tap and says nothing.
       */
      if (outcome === 'error' || outcome === 'unavailable') setFailed(true);
    });
  };

  const Glyph = speaking ? Square : Volume2;

  return (
    <span
      title={tooltip}
      data-testid="speak-button-wrap"
      className={cn(
        'inline-flex items-center gap-1',
        // Reserve the space while the answer is in flight; do not claim anything.
        status === 'pending' && 'invisible',
      )}
    >
      <Button
        data-testid="speak-button"
        data-tts-status={status}
        data-speaking={speaking ? 'true' : 'false'}
        variant="ghost"
        size="sm"
        className={cn('px-2', className)}
        disabled={disabled}
        title={tooltip}
        // The accessible NAME carries the state ("Play 打算" / "Stop 打算"),
        // so there is no `aria-pressed`: a reader would announce both — "Stop
        // 打算, toggle button, pressed" — which is the documented either/or.
        // The glyph swaps with the name, so the name is the half to keep.
        aria-label={tooltip}
        onClick={toggle}
      >
        <Glyph aria-hidden className="size-4" />
      </Button>
      {status === 'unavailable' ? (
        <span aria-hidden className="text-xs text-muted">
          {NO_VOICE_LABEL}
        </span>
      ) : failed ? (
        // Not `aria-hidden`: unlike the mount-time reason, which the disabled
        // button's own name already carries, this one appears after a press
        // and is the only announcement of it.
        <span data-testid="speak-failed" role="status" className="text-xs text-warning">
          {SPEAK_FAILED_LABEL}
        </span>
      ) : null}
    </span>
  );
}
