import type { InputHTMLAttributes } from 'react';

import { cn } from '@/lib/cn';

/**
 * The text input (docs/plans/core.md C1). `Field` wraps it and owns the label,
 * the help text and the error wiring.
 *
 * `text-base` and `h-11` are deliberate: iOS Safari zooms the viewport when a
 * focused input's font is under 16px, and 44px is the platform touch target.
 * `aria-invalid` paints the border warning-coloured, so `Field`'s error state
 * is visible and not only announced.
 *
 * **No `focus:outline-none`.** It was here, inherited from the pre-C0 input,
 * and it suppressed the `:focus-visible` ring `globals.css` defines for every
 * control — on the app's most-used control. The border colour change is a
 * *second* cue, not a replacement for the ring. C1's keyboard-walk spec asserts
 * the ring on every focus stop, which is what caught it.
 */
export type InputProps = InputHTMLAttributes<HTMLInputElement>;

export function Input({ className, ...props }: InputProps) {
  return (
    <input
      className={cn(
        'h-11 w-full rounded-[var(--r-sm)] border border-border bg-surface px-3 text-base text-ink',
        'placeholder:text-muted focus:border-lookup',
        'aria-[invalid=true]:border-warning',
        className,
      )}
      {...props}
    />
  );
}
