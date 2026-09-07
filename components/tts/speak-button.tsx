'use client';

/**
 * The speaker button (PLAN.md §3.6).
 *
 * It asks the provider once, on mount, whether this browser has a Mandarin
 * voice, and renders one of three states: pending (invisible but holding its
 * space, so the pinyin line does not jump when the answer lands), ready (a live
 * button), unavailable (disabled, with the reason **visible** beside it). The
 * third is not an edge case — headless Chromium has no voices, so it is the
 * only state this repository's e2e can actually observe, and it is the state
 * that has to look deliberate rather than broken.
 *
 * The reason is visible text and not only a `title`, because a touch screen
 * never shows a `title`: on a phone the tooltip-only version was a dead grey
 * glyph with no way to find out why. The `title` stays for pointer devices and
 * the `aria-label` for readers, and the tooltip lives on the wrapping span
 * because a disabled button has `pointer-events: none` and would never receive
 * the hover that shows one.
 */

import { Volume2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import type { TTSProvider } from '@/lib/tts/provider';
import { getTTSProvider } from '@/lib/tts/speech-synthesis';

export const NO_VOICE_TOOLTIP = 'No Mandarin voice available in this browser';

/** The same thing, short enough to sit next to the glyph on a 390px card. */
export const NO_VOICE_LABEL = 'No voice';

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

export function SpeakButton({ text, provider, className, label }: SpeakButtonProps) {
  const [status, setStatus] = useState<Status>('pending');

  useEffect(() => {
    let alive = true;
    const tts = provider ?? getTTSProvider();
    void tts
      .available()
      .then((ok) => {
        if (alive) setStatus(ok ? 'ready' : 'unavailable');
      })
      .catch(() => {
        if (alive) setStatus('unavailable');
      });
    return () => {
      alive = false;
    };
  }, [provider]);

  const disabled = status !== 'ready';
  const tooltip = status === 'unavailable' ? NO_VOICE_TOOLTIP : `Play ${label ?? text}`;

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
        variant="ghost"
        size="sm"
        className={cn('px-2', className)}
        disabled={disabled}
        title={tooltip}
        aria-label={status === 'unavailable' ? NO_VOICE_TOOLTIP : `Play ${label ?? text}`}
        onClick={() => {
          if (disabled) return;
          void (provider ?? getTTSProvider()).speak(text, { rate: 0.9 });
        }}
      >
        <Volume2 aria-hidden className="size-4" />
      </Button>
      {status === 'unavailable' ? (
        <span aria-hidden className="text-xs text-muted">
          {NO_VOICE_LABEL}
        </span>
      ) : null}
    </span>
  );
}
