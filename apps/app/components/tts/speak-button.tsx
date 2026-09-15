'use client';

/**
 * The block speaker (PLAN.md §3.6; product rule 3, rebuilt at core.md C2,
 * completed at C6).
 *
 * **This module is now the compatibility name.** C6's Files list puts the
 * control at `components/hanzi/speak-control.tsx`, next to `<HanziText>` — the
 * per-character DOM it lights and the character tap it answers both live there,
 * and a speaker that has to reach across `components/` to find them is a seam
 * in the wrong place. The four call sites that render a speaker today —
 * `lookup/entry-detail.tsx`, `hanzi/char-sheet.tsx`, `review/review-card.tsx`,
 * `review/production-card.tsx` — keep importing `SpeakButton` from here and get
 * hold-to-slow without an edit each, which is what C6's three-file Files list
 * assumes.
 *
 * Everything the C2 section of HANDOFF.md records about this component is still
 * true of it: the pending / ready / unavailable triad, the reason as **visible
 * text** rather than only a `title` (a touch screen never shows a `title`, so
 * the tooltip-only version was a dead grey glyph with no way to find out why),
 * tap-to-play / tap-to-stop, and the outcome being read rather than discarded.
 * C6 adds the hold, the per-character lighting and the keyboard-reachable
 * "Slow" button beside it.
 */

export {
  SpeakControl as SpeakButton,
  BLOCK_RATE,
  HOLD_MS,
  NO_VOICE_LABEL,
  NO_VOICE_TOOLTIP,
  SPEAK_FAILED_LABEL,
  type SpeakControlProps as SpeakButtonProps,
} from '@/components/hanzi/speak-control';
