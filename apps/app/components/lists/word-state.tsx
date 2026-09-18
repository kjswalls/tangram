import { Badge, type BadgeTone } from '@/components/ui/badge';
import type { WordState } from '@/lib/srs/states';

const TONE: Record<WordState, BadgeTone> = {
  known: 'neutral',
  learning: 'accent',
  new: 'warning',
};

/** The three states of §3.3, wearing the same colours everywhere they appear. */
export function WordStateBadge({ state }: { state: WordState }) {
  return (
    <Badge tone={TONE[state]} data-state={state}>
      {state}
    </Badge>
  );
}
