import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { cn } from '@/lib/cn';

/**
 * The button (docs/plans/core.md C1).
 *
 * Two axes, kept separate on purpose. **Variant** is which accent it wears;
 * **shape** is how much room it takes. `grade` is a shape rather than a variant
 * because a grade button can be primary (the "Got it" one) or secondary (the
 * other three), and the old bar built the two-line auto-height layout by hand
 * with `h-auto flex-col` at every call site.
 *
 * **`primary` is vermillion, and there is exactly one per screen** (§1). Jade is
 * `lookup` — the Look up verb and the "learning" family — so a screen that wants
 * a second filled button wants `lookup`, not a second primary. Nothing here
 * enforces the one-per-screen rule; C7's shells and C8's relabelling are where
 * it becomes visible, and the gallery is where it is looked at.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'lookup';
export type ButtonSize = 'sm' | 'md' | 'lg';
export type ButtonShape = 'default' | 'grade';

/**
 * Exported so `tests/unit/ui/primitives.test.tsx` can assert the MAP rather
 * than the rendered `className`. A rendered class string always carries the
 * base classes, so `VARIANTS[v] = ''` leaves a "className is non-empty"
 * assertion trivially true — which is exactly how a dropped variant ships
 * silently, and which C1's sixth criterion exists to prevent.
 */
export const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-practice text-on-accent hover:opacity-90',
  lookup: 'bg-lookup text-on-accent hover:opacity-90',
  secondary: 'border border-border bg-surface text-ink hover:border-practice',
  ghost: 'text-muted hover:text-ink hover:bg-lookup-soft',
};

export const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-sm',
  md: 'h-10 px-4 text-sm',
  lg: 'h-12 px-5 text-base',
};

/** The grade shape ignores the height half of `SIZES` — it sizes to its lines. */
export const GRADE_SIZES: Record<ButtonSize, string> = {
  sm: 'min-h-12 px-3 py-1.5 text-sm',
  md: 'min-h-14 px-4 py-2 text-sm',
  lg: 'min-h-16 px-5 py-2.5 text-base',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  shape?: ButtonShape;
  /** The grade shape's second line — the previewed interval, never a hardcoded one. */
  sub?: ReactNode;
}

export function Button({
  variant = 'primary',
  size = 'md',
  shape = 'default',
  sub,
  className,
  type = 'button',
  children,
  ...props
}: ButtonProps) {
  const grade = shape === 'grade';
  return (
    <button
      type={type}
      data-variant={variant}
      data-shape={shape}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-[var(--r-sm)] font-medium transition',
        'disabled:pointer-events-none disabled:opacity-50',
        grade && 'h-auto flex-col gap-0.5 text-center leading-tight',
        VARIANTS[variant],
        grade ? GRADE_SIZES[size] : SIZES[size],
        className,
      )}
      {...props}
    >
      {children}
      {grade && sub !== undefined && sub !== null ? (
        <span className="text-xs font-normal opacity-80">{sub}</span>
      ) : null}
    </button>
  );
}
