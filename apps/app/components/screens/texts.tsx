'use client';

/**
 * The pasted-texts view, inside the **Look up** tab (docs/plans/core.md C7).
 *
 * `/read` used to be one of seven routes; it is a sub-path of Look up now, so
 * the tab stays marked while a text is open. It keeps a path of its own because
 * a text is a place a learner comes back to and a browser needs something to
 * bookmark — a fourth tab is what it does not get.
 *
 * Which of the two views is showing lives in the reader store rather than in
 * local state, so a trip to Practice and back returns to the text where it was
 * (PLAN.md §3.5).
 */
import { DictGate } from '@/components/dict/dict-gate';
import { ReaderView } from '@/components/reader/reader-view';
import { PageHeader } from '@/components/ui/page-header';

export function TextsScreen() {
  return (
    <div data-testid="screen-texts" className="flex flex-col gap-4">
      <PageHeader title="Your own texts">
        Paste anything; tap a word to look it up in its sentence, or drag across several.
      </PageHeader>
      <DictGate>
        <ReaderView />
      </DictGate>
    </div>
  );
}
