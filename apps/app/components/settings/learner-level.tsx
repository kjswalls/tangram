'use client';

/**
 * "Your level" (docs/plans/core.md C8).
 *
 * The HSK band model is unchanged: this is `settings.spineStartBand` and
 * `settings.knownBand`, the same two fields the scheduler and the reader
 * already read. What changes is that a learner meets them as a sentence about
 * themselves rather than as two dropdowns labelled "Spine starts at HSK" and
 * "Assume known through HSK" — which are accurate, and which describe the
 * app's internals rather than the person using it.
 *
 * **It says what it will do, not what it is set to.** "New words come from
 * HSK 1, easiest first" is a prediction the learner can check tomorrow; "band
 * 1" is a number they have to look up.
 *
 * The Change button is a link into the controls that already exist further up
 * Library, not a second way to write the field: two writers for one setting is
 * how the two disagree.
 */
import { Button } from '@/components/ui/button';
import type { SettingsRow } from '@/lib/db/schema';
import { DEFAULT_SETTINGS } from '@/lib/db/schema';
import type { HskBand } from '@/lib/types';
import { hskBandLabel } from '@/lib/types';

/**
 * What to call where a learner is starting.
 *
 * Deliberately four names over seven bands: the distinctions a beginner can
 * act on are "I am starting", "I have some", "I have a lot" and "I am well
 * past the textbooks", and inventing seven adjectives would be inventing
 * precision the band number does not carry either.
 */
export function levelName(spineStartBand: HskBand): string {
  if (spineStartBand <= 1) return 'Just starting';
  if (spineStartBand <= 3) return 'Getting going';
  if (spineStartBand <= 5) return 'Well along';
  return 'Advanced';
}

/** The whole line, so a test can assert the sentence rather than its pieces. */
export function levelSentence(settings: Pick<SettingsRow, 'spineStartBand' | 'knownBand'>): string {
  const band = (settings.spineStartBand ?? DEFAULT_SETTINGS.spineStartBand) as HskBand;
  const known = settings.knownBand ?? DEFAULT_SETTINGS.knownBand;
  const from = `new words come from HSK ${hskBandLabel(band)}, easiest first`;
  // `knownBand: 0` means "assume nothing", which has no second clause to say.
  const already =
    known > 0
      ? `, and HSK ${hskBandLabel(known as HskBand)} and below are treated as words you already know`
      : '';
  return `${levelName(band)} — ${from}${already}.`;
}

export function LearnerLevel({
  settings,
  onChange,
}: {
  settings: Pick<SettingsRow, 'spineStartBand' | 'knownBand'>;
  /** Take the learner to the controls above. */
  onChange: () => void;
}) {
  return (
    <div
      data-testid="learner-level"
      data-band={String(settings.spineStartBand ?? DEFAULT_SETTINGS.spineStartBand)}
      className="flex flex-wrap items-baseline justify-between gap-3"
    >
      <p className="text-sm">
        <span className="text-muted">Your level: </span>
        <span data-testid="learner-level-sentence">{levelSentence(settings)}</span>
      </p>
      <Button size="sm" variant="secondary" data-testid="learner-level-change" onClick={onChange}>
        Change
      </Button>
    </div>
  );
}
