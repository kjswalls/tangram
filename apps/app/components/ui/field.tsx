'use client';

import { useId, type ReactNode } from 'react';

import { cn } from '@/lib/cn';

/**
 * Label + control + help + error, wired together (docs/plans/core.md C1).
 *
 * The wiring is the whole point and it is the part hand-written forms get
 * wrong: the control needs an `id` the label points at, `aria-describedby`
 * naming *both* the help text and the error when both exist, and
 * `aria-invalid` when there is an error. `children` is a render prop rather
 * than a slot because the ids have to reach the control, and cloning an
 * arbitrary element to inject props is guesswork about which element is the
 * control.
 */
export interface FieldControlProps {
  id: string;
  'aria-describedby': string | undefined;
  'aria-invalid': true | undefined;
}

export interface FieldProps {
  label: ReactNode;
  help?: ReactNode;
  error?: ReactNode;
  /** Rendered next to the label — a unit, a count, an optional marker. */
  aside?: ReactNode;
  className?: string;
  children: (props: FieldControlProps) => ReactNode;
}

export function Field({ label, help, error, aside, className, children }: FieldProps) {
  const base = useId();
  const id = `${base}-control`;
  const helpId = help ? `${base}-help` : undefined;
  const errorId = error ? `${base}-error` : undefined;
  const describedBy = [helpId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <div className={cn('flex flex-col gap-1.5', className)} data-testid="field">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-sm font-medium text-ink">
          {label}
        </label>
        {aside}
      </div>
      {children({ id, 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined })}
      {help ? (
        <p id={helpId} className="text-xs text-muted">
          {help}
        </p>
      ) : null}
      {error ? (
        // `role="alert"` and not `aria-live="polite"`: a validation error is the
        // answer to something the learner just did, and a polite region is read
        // after whatever else is queued.
        <p id={errorId} role="alert" className="text-xs text-warning">
          {error}
        </p>
      ) : null}
    </div>
  );
}
