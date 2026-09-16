'use client';

/**
 * The speaker, completed (docs/plans/core.md C6; product-decisions §4 rule 3).
 *
 * **One speaker per hanzi block**, not one per character. A tap reads the block
 * as one utterance; **holding** it reads the block character by character at
 * 0.6×, with each character lit as it plays; and a tap on a character reads
 * that syllable alone. C2 built the block half and the stop; this is the rest.
 *
 * ## The mechanism is per-character utterances, deliberately
 *
 * `lib/tts/sequence.ts` enqueues one utterance per character and advances the
 * highlight on each utterance's `start`, and it does that **even where boundary
 * events exist**. The Android audit is explicit that range events are
 * engine-dependent, WebKit's are documented unreliable, and
 * `window.speechSynthesis` is reported undefined in the Android WebView (STACK
 * register #19). STACK §2.1 adopts per-character utterances as the rule, not
 * the fallback.
 *
 * ## The hold threshold, and where 500 ms comes from
 *
 * No audit measured one and product-decisions §4 rule 3 says only "Hold the
 * speaker → 0.6x". C6 says to start from the platform's own long-press
 * convention — the number a learner's hand already expects — tune it against a
 * real hold, and record it. Both platforms agree: iOS's
 * `UILongPressGestureRecognizer.minimumPressDuration` defaults to **0.5 s** and
 * Android's `ViewConfiguration.getLongPressTimeout()` is **500 ms**. So 500 ms,
 * recorded in HANDOFF.md, and `ios.md`/`android.md` re-check it on hardware
 * where a thumb is less precise than a synthetic pointer.
 *
 * ## A long press is not an accessible affordance, so it is not the only one
 *
 * C6 requires the slow mode to have a non-gesture trigger and says to name it
 * here: it is the **"Slow" button** beside the speaker. It is a real `<button>`
 * — reachable by Tab, by a screen reader's control rotor and by a switch — and
 * it *toggles* rather than holds, because there is no such thing as holding a
 * key on an assistive device. The hold gesture and the button drive exactly the
 * same `speakCharacters()` call; neither is a second code path.
 *
 * ## Which character is lit, and why it is a module store
 *
 * A block's speaker and the `<HanziText>` it speaks are **siblings**, not
 * parent and child — a card face, a headword row, a sheet header — so lighting
 * the character through props would mean threading state through every one of
 * them. Only one thing can be speaking at a time (the provider is cancelled
 * before every start), so "what is speaking, and where" is genuinely one piece
 * of app-wide state, and `<HanziText>` subscribes to it by the text it renders.
 * Nothing is published while nothing is speaking, so the cost is one
 * `useSyncExternalStore` subscription per rendered block.
 */

import { Gauge, Square, Volume2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import type { TTSProvider, Utterance } from '@/lib/tts/provider';
import { speakCharacters, SLOW_RATE, type SpeakSequence } from '@/lib/tts/sequence';
import { getTTSProvider } from '@/lib/tts/speech-synthesis';

export const NO_VOICE_TOOLTIP = 'No Mandarin voice available in this browser';

/** The same thing, short enough to sit next to the glyph on a 390px card. */
export const NO_VOICE_LABEL = 'No voice';

/** Slower than natural, which is the point for a learner. Unchanged from P6. */
export const BLOCK_RATE = 0.9;

/**
 * How long a press has to last to become a hold. See the header: this is both
 * platforms' own long-press default, not a number someone liked.
 */
export const HOLD_MS = 500;

/**
 * What the learner is told when an utterance that was supposed to play did
 * not. Short enough to sit next to the glyph on a 390px card, like
 * `NO_VOICE_LABEL`, and for the same reason: a touch screen never shows a
 * `title`, so a failure that lives only in a tooltip is a failure the learner
 * cannot see.
 */
export const SPEAK_FAILED_LABEL = 'Could not play';

// --- "what is speaking, and where" ------------------------------------------

interface SpeakingAt {
  /** The block's base characters, exactly as `<HanziText>` renders `data-hanzi`. */
  text: string;
  /** Offset of the character being spoken, in **UTF-16 code units**. */
  offset: number;
}

let speaking: SpeakingAt | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

/** Publish the character now being spoken, or `null` when nothing is. */
export function setSpeakingAt(next: SpeakingAt | null): void {
  if (next === null && speaking === null) return;
  speaking = next;
  emit();
}

function subscribeSpeaking(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function speakingSnapshot(): SpeakingAt | null {
  return speaking;
}

/**
 * The code-unit offset of the character being spoken inside `text`, or `null`.
 *
 * Matched on the text rather than on an id, because the speaker and the block
 * are siblings and there is nothing else they both know. Two identical blocks
 * on one screen — the same headword twice — light together; that is a cosmetic
 * cost of the match and it is the honest one, since both really are the word
 * being read.
 */
export function useSpeakingOffset(text: string): number | null {
  const at = useSyncExternalStore(subscribeSpeaking, speakingSnapshot, () => null);
  return at && at.text === text ? at.offset : null;
}

/**
 * `lib/tts/sequence.ts` counts in **code points**; the DOM counts in code
 * units. CJK Extension B lives above the BMP, so on a passage with a rare name
 * in it the two disagree from the first astral character onward and every
 * character after it would light one position early.
 */
export function codeUnitOffset(text: string, codePointIndex: number): number {
  let units = 0;
  let points = 0;
  for (const char of text) {
    if (points === codePointIndex) return units;
    units += char.length;
    points += 1;
  }
  return units;
}

// --- the control -------------------------------------------------------------

export interface SpeakControlProps {
  /** The hanzi to read aloud. */
  text: string;
  /** Injected in unit tests; the Web Speech provider otherwise. */
  provider?: TTSProvider;
  className?: string;
  /** Extra words for screen readers, e.g. the headword being spoken. */
  label?: string;
}

type Status = 'pending' | 'ready' | 'unavailable';

export function SpeakControl({ text, provider, className, label }: SpeakControlProps) {
  const [status, setStatus] = useState<Status>('pending');
  const [speakingBlock, setSpeakingBlock] = useState(false);
  const [slow, setSlow] = useState(false);
  const [failed, setFailed] = useState(false);
  const utterance = useRef<Utterance | null>(null);
  const sequence = useRef<SpeakSequence | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** A hold has fired: the sequence is running and a release must stop it. */
  const held = useRef(false);
  /**
   * The **next** `click` is the tail of a hold and must be swallowed.
   *
   * Separate from `held` because the two are not the same question, and the
   * first version conflated them. A release *on* the button fires `pointerup`
   * and then `click`; a release after dragging off fires `pointerleave` and
   * **no click at all**. Reusing one flag therefore left it set for ever on the
   * drag-off path, and Chromium focuses a button on mousedown — so the next
   * Enter on the still-focused speaker was eaten by the suppression and the
   * learner got silence, on the one path C6's fifth criterion is about. Only a
   * release that will actually produce a click sets this.
   */
  const swallowClick = useRef(false);

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

  const stopSequence = useCallback(() => {
    sequence.current?.stop();
    sequence.current = null;
    setSlow(false);
    setSpeakingAt(null);
  }, []);

  // Unmounting while speaking must stop the audio. A review card that is graded
  // mid-utterance unmounts, and without this the next card's speaker fights an
  // utterance nothing on screen owns any more. The lit character goes with it:
  // a published offset outliving its block would light a different one.
  useEffect(
    () => () => {
      utterance.current?.cancel();
      utterance.current = null;
      sequence.current?.stop();
      sequence.current = null;
      if (holdTimer.current !== null) clearTimeout(holdTimer.current);
      setSpeakingAt(null);
    },
    [],
  );

  const disabled = status !== 'ready';

  const stopEverything = useCallback(() => {
    utterance.current?.cancel();
    utterance.current = null;
    setSpeakingBlock(false);
    stopSequence();
  }, [stopSequence]);

  /** The block, as ONE utterance. C2's behaviour, unchanged. */
  const speakBlock = useCallback(() => {
    const tts = provider ?? getTTSProvider();
    if (utterance.current) {
      stopEverything();
      return;
    }
    // Stop whatever else was speaking — another card's speaker, a sequence —
    // before starting. This is the cancel that used to live inside `speak()`.
    stopSequence();
    tts.stop();
    setFailed(false);
    const handle = tts.speak(text, { rate: BLOCK_RATE });
    utterance.current = handle;
    setSpeakingBlock(true);
    void handle.done.then((outcome) => {
      if (utterance.current !== handle) return;
      utterance.current = null;
      setSpeakingBlock(false);
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
  }, [provider, stopEverything, stopSequence, text]);

  /** Character by character at 0.6×, with each character lit as it plays. */
  const startSlow = useCallback(() => {
    const tts = provider ?? getTTSProvider();
    utterance.current?.cancel();
    utterance.current = null;
    setSpeakingBlock(false);
    sequence.current?.stop();
    tts.stop();
    setFailed(false);
    setSlow(true);
    const running = speakCharacters(tts, text, {
      rate: SLOW_RATE,
      onIndex: (index) => {
        // `null` means the sequence is over, however it ended — including a
        // release mid-word, which is the common case. A consumer that only
        // cleared on "finished" would leave a character lit for ever.
        setSpeakingAt(index === null ? null : { text, offset: codeUnitOffset(text, index) });
      },
    });
    sequence.current = running;
    void running.done.then((outcome) => {
      if (sequence.current !== running) return;
      sequence.current = null;
      setSlow(false);
      setSpeakingAt(null);
      if (outcome === 'error' || outcome === 'unavailable') setFailed(true);
    });
  }, [provider, text]);

  const onPointerDown = () => {
    if (disabled) return;
    held.current = false;
    swallowClick.current = false;
    if (holdTimer.current !== null) clearTimeout(holdTimer.current);
    holdTimer.current = setTimeout(() => {
      holdTimer.current = null;
      held.current = true;
      startSlow();
    }, HOLD_MS);
  };

  /**
   * The gesture is over. `clicks` says whether a `click` will follow — true for
   * a release on the button, false for a drag-off or a cancel, where the
   * browser sends none. See `swallowClick`.
   */
  const endHold = (clicks: boolean) => {
    if (holdTimer.current !== null) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
    // Releasing stops the sequence. C6: "Releasing stops the sequence."
    if (held.current) {
      stopSequence();
      swallowClick.current = clicks;
    }
    held.current = false;
  };

  const onClick = () => {
    if (disabled) return;
    /**
     * The `click` that follows a hold is not a tap.
     *
     * A press-and-hold that ends **on** the button fires `pointerdown`,
     * `pointerup` and `click`, so without this the release would start a block
     * utterance on top of the sequence it just stopped — the slow reading
     * followed instantly by the fast one, every time. A hold that ends off the
     * button sends no click, which is why the flag is set at release rather
     * than when the hold fires.
     */
    if (swallowClick.current) {
      swallowClick.current = false;
      return;
    }
    speakBlock();
  };

  const tooltip =
    status === 'unavailable'
      ? NO_VOICE_TOOLTIP
      : speakingBlock
        ? `Stop ${label ?? text}`
        : `Play ${label ?? text}`;

  const Glyph = speakingBlock ? Square : Volume2;

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
        data-speaking={speakingBlock ? 'true' : 'false'}
        variant="ghost"
        size="sm"
        className={cn('speak-hold px-2', className)}
        disabled={disabled}
        title={tooltip}
        // The accessible NAME carries the state ("Play 打算" / "Stop 打算"),
        // so there is no `aria-pressed`: a reader would announce both — "Stop
        // 打算, toggle button, pressed" — which is the documented either/or.
        // The glyph swaps with the name, so the name is the half to keep.
        aria-label={tooltip}
        /**
         * **`touch-action: none`, and it is load-bearing.**
         *
         * The hold keeps a finger down for 500 ms plus the whole sequence —
         * three seconds or more for a four-character word — on a 40×32 target.
         * At the UA default a thumb that drifts past the browser's touch slop
         * (~8px) hands the touch to the scroller, which dispatches
         * `pointercancel`; the reading then stops mid-word and the page slides
         * out from under the finger. Measured with real touch input in
         * Chromium. `page.mouse` never produces a pan, which is why the gate
         * was green. The class carries the iOS callout suppression with it, for
         * the same reason `.hanzi-span-host` does: a long press on a button is
         * exactly what summons it.
         */
        onPointerDown={onPointerDown}
        onPointerUp={() => endHold(true)}
        onPointerLeave={() => endHold(false)}
        onPointerCancel={() => endHold(false)}
        onClick={onClick}
      >
        <Glyph aria-hidden className="size-4" />
      </Button>

      {/*
        The non-gesture trigger for slow mode (C6). A long press is not an
        accessible affordance on its own, so the same sequence has a real
        button: Tab reaches it, a screen reader lists it, a switch can press it,
        and it toggles rather than holds because nothing can "hold" a key.
      */}
      {status === 'ready' ? (
        <Button
          data-testid="speak-slow"
          data-slow={slow ? 'true' : 'false'}
          variant="ghost"
          size="sm"
          className="px-2"
          aria-pressed={slow}
          title={slow ? 'Stop reading slowly' : `Read ${label ?? text} slowly, character by character`}
          aria-label={
            slow ? 'Stop reading slowly' : `Read ${label ?? text} slowly, character by character`
          }
          onClick={() => (slow ? stopSequence() : startSlow())}
        >
          <Gauge aria-hidden className="size-4" />
        </Button>
      ) : null}

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

/**
 * Read one character aloud — rule 3's third clause, "tap a character → hear
 * that syllable alone".
 *
 * Exported rather than inlined into `<HanziText>` so the rate and the
 * stop-first rule live beside the block speaker's, which is the only way the
 * two cannot drift. A tap on a character while a sequence is running stops the
 * sequence: the learner has asked for a different thing.
 */
export function speakOneCharacter(char: string, provider?: TTSProvider): void {
  const tts = provider ?? getTTSProvider();
  tts.stop();
  setSpeakingAt(null);
  /**
   * Synchronous, and **not** behind an `available()` await.
   *
   * `speak()` returns a handle synchronously and a provider with no voice
   * settles it `'unavailable'` quietly, so there is nothing to gain from
   * asking first — and there is something to lose: Chrome refuses speech
   * attempted outside a user gesture with `not-allowed`, and an `await`
   * between the tap and the `speak()` is exactly how a handler leaves that
   * gesture's turn.
   */
  tts.speak(char, { rate: SLOW_RATE });
}
