/**
 * The calibration panel's one-sentence explanation (docs/plans/core.md C8;
 * STACK §5.2).
 *
 * §5.2 did not say whether this panel ships. It set a test: *try to write the
 * panel's one-sentence explanation for a beginner; if it cannot be written, it
 * does not ship.* C8 is the phase that runs it, and the answer either way has to
 * be recorded — "either the panel carries a one-sentence beginner explanation
 * and a test asserts that sentence renders, or the panel is gone and no test
 * references it. A phase that ships neither has not run the test."
 *
 * This is that test. The sentence can be written, so the panel stays and this
 * file is what stops the sentence being quietly deleted while the chart
 * remains — which would put the decision back where C8 found it.
 */
import { describe, expect, it } from 'vitest';

import { render, screen } from '../render';

import { CALIBRATION_EXPLAINER, CalibrationChart } from '@/components/stats/calibration-chart';
import type { CalibrationSummary } from '@/lib/stats/calibration';

/** A log too small to draw a curve from: the explanation still has to be there. */
const THIN: CalibrationSummary = {
  buckets: Array.from({ length: 10 }, (_, index) => ({
    index,
    lower: index / 10,
    upper: (index + 1) / 10,
    count: 0,
    predictedMean: 0,
    observed: 0,
    enough: false,
  })),
  drawn: [],
  used: 3,
  unusable: 0,
  thin: 3,
  predictedMean: null,
  observedMean: null,
  bias: null,
  enough: false,
  needed: 50,
  minBucketReviews: 10,
};

describe('the calibration panel', () => {
  it('leads with a sentence a beginner can act on', () => {
    render(<CalibrationChart summary={THIN} parameters="FSRS defaults" />);
    expect(screen.getByTestId('stats-calibration-explainer')).toHaveTextContent(
      CALIBRATION_EXPLAINER,
    );
  });

  it('…and the sentence is one sentence, in plain words', () => {
    // One full stop, no jargon, and short enough to be read rather than
    // skipped. If a future edit cannot keep all three, STACK §5.2's answer is
    // to cut the panel rather than to loosen this test.
    expect(CALIBRATION_EXPLAINER.match(/\./g) ?? []).toHaveLength(1);
    expect(CALIBRATION_EXPLAINER.length).toBeLessThan(200);
    expect(CALIBRATION_EXPLAINER).not.toMatch(
      /calibrat|decile|probabilit|retention|FSRS|stability|interval/i,
    );
  });

  it('shows it even when there is not enough data to draw the chart', () => {
    // The commonest state for months: the explanation is what the panel is FOR
    // before there is a curve in it.
    render(<CalibrationChart summary={THIN} parameters="FSRS defaults" />);
    expect(screen.getByTestId('stats-calibration-explainer')).toBeInTheDocument();
    expect(screen.queryByTestId('stats-calibration-bias')).toBeNull();
  });
});
