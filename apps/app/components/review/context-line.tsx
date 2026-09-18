import { maskFor, type ResolvedContext } from '@/lib/srs/context';
import { cn } from '@/lib/cn';

/**
 * The provenance line, in its two readings (PLAN.md §1, commitment 2):
 *
 * - `masked` sits on the *front*. The sentence is there to jog the memory, so
 *   the target is blanked — a peek that shows the answer is not a peek.
 * - `highlight` sits on the back, where the target is marked in the sentence
 *   the learner actually met it in.
 */
export function ContextLine({
  context,
  mode,
  className,
}: {
  context: ResolvedContext;
  mode: 'masked' | 'highlight';
  className?: string;
}) {
  const { parts, text } = context;
  const testId = mode === 'masked' ? 'context-peek' : 'context-back';

  return (
    // `lang` and not `<HanziText>`: a provenance sentence is a run the app has
    // no cited reading for — it is the learner's own pasted text, segmented but
    // not looked up — so there is nothing to annotate, and the grounding
    // contract says a reading with no citation does not get rendered. What it
    // does need is the language declaration (core.md C0 rule 2), because Han
    // unification renders Japanese glyph forms without it.
    <p
      data-testid={testId}
      lang="zh-Hans"
      className={cn('hanzi text-base leading-relaxed', className)}
    >
      {parts === null ? (
        text
      ) : mode === 'masked' ? (
        <>
          {parts.before}
          <span
            data-testid="context-mask"
            aria-label="hidden word"
            className="rounded bg-border px-0.5 text-transparent"
          >
            {maskFor(parts.target)}
          </span>
          {parts.after}
        </>
      ) : (
        <>
          {parts.before}
          <mark
            data-testid="context-target"
            className="rounded bg-accent-soft px-0.5 font-semibold text-accent"
          >
            {parts.target}
          </mark>
          {parts.after}
        </>
      )}
    </p>
  );
}
