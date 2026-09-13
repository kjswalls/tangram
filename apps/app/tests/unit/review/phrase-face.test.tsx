/**
 * The front of a phrase card (HANDOFF.md, Phases 4–5 review fixes: "the review
 * card still renders `snapshot.simp` rather than per-token markup").
 *
 * The card is what the learner rehearses, so the flag has to be on the *front*,
 * before the flip. What is pinned here is the rule that decides the flag — a
 * token with no `entryId` is ungrounded whether or not the row says so, because
 * a card written before the unverified-Add rule carries no flag at all — and the
 * rule that decides what a front may show: no reading, ever, since the reading
 * is the answer.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { PhraseFace } from '@/components/review/phrase-face';
import type { CardRow, PhraseSnapshot, PhraseToken } from '@/lib/db/schema';

const WO: PhraseToken = { text: '我', entryId: '我|我[wo3]', pinyinMarked: 'wǒ' };
const SUIBIAN: PhraseToken = {
  text: '随便',
  entryId: '隨便|随便[sui2 bian4]',
  pinyinMarked: 'suíbiàn',
};
const KANKAN: PhraseToken = { text: '看看', entryId: '看看|看看[kan4 kan5]', pinyinMarked: 'kànkan' };

function phraseCard(tokens: PhraseToken[], overrides: Partial<PhraseSnapshot> = {}): CardRow {
  const snapshot: PhraseSnapshot = {
    tokens,
    simp: tokens.map((token) => token.text).join(''),
    pinyinMarked: tokens.map((token) => token.pinyinMarked ?? '?').join(' '),
    en: 'I am just looking, thanks.',
    dictVersion: '1.3.20251213',
    ...overrides,
  };
  return {
    id: 'card-1',
    wordId: null,
    entryId: null,
    kind: 'phrase',
    direction: 'recognition',
    snapshot,
    fsrs: {
      state: 0,
      due: 0,
      stability: 0,
      difficulty: 0,
      reps: 0,
      lapses: 0,
      scheduled_days: 0,
      learning_steps: 0,
    },
    due: 0,
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
  };
}

function tokens() {
  return screen.getAllByTestId('phrase-face-token');
}

describe('PhraseFace', () => {
  it('draws a fully cited phrase token by token, with nothing flagged', () => {
    render(<PhraseFace card={phraseCard([WO, SUIBIAN, KANKAN])} />);

    const face = screen.getByTestId('phrase-face');
    expect(face).toHaveTextContent('我随便看看');
    expect(face).toHaveAttribute('data-tokens', 'true');
    expect(face).toHaveAttribute('data-unverified', 'false');
    expect(face).toHaveAttribute('aria-label', '我随便看看');
    expect(tokens()).toHaveLength(3);
    for (const token of tokens()) {
      expect(token).toHaveAttribute('data-unverified', 'false');
      expect(token).toHaveAttribute('data-ai-generated', 'false');
    }
    expect(screen.queryByTestId('phrase-face-warning')).toBeNull();
  });

  it('never shows the reading — that is the answer, and this is the front', () => {
    render(<PhraseFace card={phraseCard([WO, SUIBIAN, KANKAN])} />);
    const front = screen.getByTestId('phrase-face').parentElement;
    expect(front?.textContent ?? '').not.toContain('suíbiàn');
    expect(front?.textContent ?? '').not.toContain('wǒ');
  });

  it('flags a token the model invented, and says so under the phrase', () => {
    render(
      <PhraseFace card={phraseCard([WO, { text: '随看随买', unverified: true }, KANKAN])} />,
    );

    const flagged = tokens()[1];
    expect(flagged).toHaveTextContent('随看随买');
    expect(flagged).toHaveAttribute('data-ai-generated', 'true');
    expect(flagged).toHaveAttribute('data-unverified', 'true');
    expect(flagged.getAttribute('title')).toContain('AI-generated');
    expect(screen.getByTestId('phrase-face')).toHaveAttribute('data-unverified', 'true');
    expect(screen.getByTestId('phrase-face-warning')).toHaveTextContent('not verified');
    // The other two are still ordinary cited tokens.
    expect(tokens()[0]).toHaveAttribute('data-unverified', 'false');
  });

  it('flags an uncited token written before the flag existed', () => {
    // This is the whole point of the fix: the Add-time refusal cannot reach a
    // row that was written before it, and such a row carries no `unverified`.
    render(<PhraseFace card={phraseCard([WO, { text: '绝绝子' }])} />);

    expect(tokens()[1]).toHaveAttribute('data-ai-generated', 'true');
    expect(tokens()[1]).toHaveAttribute('data-unverified', 'true');
    expect(screen.getByTestId('phrase-face-warning')).toBeVisible();
  });

  it('distinguishes a cited token the segmenter could not confirm', () => {
    render(
      <PhraseFace
        card={phraseCard([WO, { ...SUIBIAN, unverified: true }])}
      />,
    );

    const doubted = tokens()[1];
    expect(doubted).toHaveAttribute('data-unverified', 'true');
    expect(doubted).toHaveAttribute('data-ai-generated', 'false');
    expect(doubted.getAttribute('title')).toContain('Unverified');
    expect(doubted).toHaveAttribute('data-entry-id', SUIBIAN.entryId ?? '');
  });

  it('falls back to the joined text when the snapshot has no tokens', () => {
    const card = phraseCard([], { tokens: [], simp: '我随便看看', pinyinMarked: 'wǒ suíbiàn kànkan' });
    render(<PhraseFace card={card} />);

    const face = screen.getByTestId('phrase-face');
    expect(face).toHaveTextContent('我随便看看');
    expect(face).toHaveAttribute('data-tokens', 'false');
    expect(screen.queryAllByTestId('phrase-face-token')).toHaveLength(0);
    expect(screen.queryByTestId('phrase-face-warning')).toBeNull();
  });

  it('renders nothing for a word card, which has no tokens to draw', () => {
    const card = phraseCard([WO]);
    const word = {
      ...card,
      kind: 'word' as const,
      snapshot: {
        simp: '打算',
        trad: '打算',
        pinyinMarked: 'dǎsuàn',
        pinyinNum: 'da3 suan4',
        glosses: ['to plan'],
        classifiers: [],
        dictVersion: '1.3.20251213',
      },
    };
    const { container } = render(<PhraseFace card={word} />);
    expect(container).toBeEmptyDOMElement();
  });
});
