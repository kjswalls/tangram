/**
 * The in-context gloss line (docs/plans/core.md C4; product-decisions §5).
 *
 * One rule decides everything here and it is the product's core promise, not a
 * detail: **the line never renders a sense the cited entry does not have.** The
 * model returns an id and an index; the words on screen come from the entry.
 * Every case below is a way that could fail — a match citing a different entry,
 * an index past the end, a negative or fractional index, and prose carrying
 * hanzi the model invented.
 */
import { describe, expect, it } from 'vitest';

import { ContextGloss, citedSense } from '@/components/hanzi/context-gloss';
import type { GroundedMatch } from '@tangram/ai/ground';
import type { Entry } from '@/lib/types';

import { render, screen } from '../render';

const JIXU: Entry = {
  id: '繼續|继续[ji4 xu4]',
  trad: '繼續',
  simp: '继续',
  pinyinNum: 'ji4 xu4',
  pinyinMarked: 'jìxù',
  glosses: ['to continue', 'to proceed with', 'to go on with'],
  classifiers: [],
  properNoun: false,
  isVariant: false,
  surname: false,
  hskBand: 3,
};

function match(overrides: Partial<GroundedMatch> = {}): GroundedMatch {
  return { entryId: JIXU.id, senseIndex: 0, whyThisOne: 'the sentence is about carrying on', ...overrides };
}

describe('citedSense', () => {
  it('names the entry’s own sense', () => {
    expect(citedSense(JIXU, match({ senseIndex: 2 }))?.gloss).toBe('to go on with');
  });

  it('drops a match that cites a different entry', () => {
    expect(citedSense(JIXU, match({ entryId: '打算|打算[da3 suan4]' }))).toBeUndefined();
  });

  it('drops an index past the end and a negative one', () => {
    for (const senseIndex of [3, 99, -1]) {
      expect(citedSense(JIXU, match({ senseIndex })), String(senseIndex)).toBeUndefined();
    }
  });

  it('drops a NON-INTEGER index even when something answers to it', () => {
    /**
     * The `Number.isInteger` guard, exercised rather than assumed.
     *
     * `glosses[0.5]` and `glosses[NaN]` are already `undefined` on an ordinary
     * array, so passing those indexes proves nothing: the lookup would fail
     * with the guard deleted. What the guard is for is a value that *does*
     * resolve — a cached row written by an older format, a model answer coerced
     * through JSON — so the entry here carries a `'0.5'` property that would
     * otherwise be rendered as a sense.
     */
    const glosses = Object.assign(['to continue'], { '0.5': 'a sense nobody wrote' });
    const odd: Entry = { ...JIXU, glosses: glosses as unknown as string[] };
    expect(odd.glosses[0.5 as unknown as number]).toBe('a sense nobody wrote');
    expect(citedSense(odd, match({ senseIndex: 0.5 }))).toBeUndefined();
  });

  it('drops everything when there is no entry or no match', () => {
    expect(citedSense(undefined, match())).toBeUndefined();
    expect(citedSense(JIXU, undefined)).toBeUndefined();
  });
});

describe('the rendered line', () => {
  it('renders the sense the match names, from the entry', () => {
    render(<ContextGloss entry={JIXU} match={match({ senseIndex: 1 })} />);
    expect(screen.getByTestId('context-gloss-sense').textContent).toBe('to proceed with');
    expect(screen.getByTestId('context-gloss').getAttribute('data-sense-index')).toBe('1');
  });

  it('is ABSENT, not empty, when the module has no answer', () => {
    render(<ContextGloss entry={JIXU} />);
    expect(screen.queryByTestId('context-gloss')).toBeNull();
  });

  it('is absent when the match does not survive the checks', () => {
    render(<ContextGloss entry={JIXU} match={match({ senseIndex: 9 })} />);
    expect(screen.queryByTestId('context-gloss')).toBeNull();
  });

  it('strips hanzi and readings out of the model’s prose', () => {
    // The one place a fabricated character could sit directly under a real
    // headword. The route scrubs it; this scrubs it again rather than trusting.
    render(
      <ContextGloss
        entry={JIXU}
        match={match({ whyThisOne: 'it means 繼續 here, read jìxù' })}
      />,
    );
    const line = screen.getByTestId('context-gloss').textContent ?? '';
    expect(line).not.toContain('繼續');
    expect(line).not.toContain('jìxù');
    expect(line).toContain('to continue');
  });
});
