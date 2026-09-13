/**
 * The production card's front (Phase 8, builder B).
 *
 * One rule decides everything on this component: **the front may not contain
 * the answer.** That is more than "do not print the hanzi" — the glosses can
 * quote the headword, CC-CEDICT attaches its reading in brackets, and the
 * sentence the word was met in says the word by definition. Each of those is a
 * separate way to give the game away and each is checked here.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ProductionCard } from '@/components/review/production-card';
import type { CardRow, EntrySnapshot } from '@/lib/db/schema';

const SNAPSHOT: EntrySnapshot = {
  simp: '打算',
  trad: '打算',
  pinyinMarked: 'dǎsuàn',
  pinyinNum: 'da3 suan4',
  glosses: ['to plan', 'to intend'],
  classifiers: ['个'],
  hskBand: 2,
  dictVersion: 'test',
};

function card(overrides: Partial<CardRow> = {}): CardRow {
  return {
    id: 'card-1',
    wordId: 'word-1',
    entryId: '打算|打算[da3 suan4]',
    kind: 'word',
    direction: 'production',
    snapshot: SNAPSHOT,
    context: {
      sentence: '我打算明天去北京。',
      offset: 1,
      length: 2,
      source: 'reader',
      addedAt: 1,
    },
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
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    ...overrides,
  };
}

const noop = () => {};

describe('the production card front', () => {
  it('asks with the meaning and shows the sentence blanked', () => {
    render(<ProductionCard card={card()} script="simp" revealed={false} onReveal={noop} />);

    const front = screen.getByTestId('card-front');
    expect(front).toHaveTextContent('to plan');
    // Not the word, and not its reading: the reading is most of the answer.
    expect(front.textContent).not.toContain('打算');
    expect(front.textContent).not.toContain('dǎsuàn');

    const peek = screen.getByTestId('context-peek');
    expect(peek.textContent).toContain('明天去北京');
    expect(peek.textContent).not.toContain('打算');
    expect(screen.getByTestId('context-mask')).toBeInTheDocument();
  });

  it('leads with the sense the card is about, and masks the word out of the others', () => {
    const senses = card({
      senseIndex: 1,
      snapshot: { ...SNAPSHOT, glosses: ['to plan', 'to intend', 'variant of 打算[da3 suan4]'] },
    });
    render(<ProductionCard card={senses} script="simp" revealed={false} onReveal={noop} />);

    expect(screen.getByTestId('production-prompt')).toHaveTextContent('to intend');
    const front = screen.getByTestId('card-front');
    // The other senses are still offered — with the headword and the reading
    // it drags along blanked out of them.
    expect(front).toHaveTextContent('variant of');
    expect(front.textContent).not.toContain('打算');
    expect(front.textContent).not.toContain('da3 suan4');
  });

  it('shows no sentence at all rather than one that still says the word', () => {
    // The same word twice: masking the located one leaves the other standing.
    const repeated = card({
      context: {
        sentence: '我打算，你也打算。',
        offset: 1,
        length: 2,
        source: 'reader',
        addedAt: 1,
      },
    });
    render(<ProductionCard card={repeated} script="simp" revealed={false} onReveal={noop} />);
    expect(screen.queryByTestId('context-peek')).toBeNull();
    expect(screen.getByTestId('card-front').textContent).not.toContain('打算');
  });

  it('shows no sentence when the target cannot be located in it', () => {
    const unlocatable = card({
      context: { sentence: '我明天去北京。', source: 'reader', addedAt: 1 },
    });
    render(<ProductionCard card={unlocatable} script="simp" revealed={false} onReveal={noop} />);
    // `resolveContext` cannot split it, so there is nothing to blank — and an
    // unblanked line is not offered on this front.
    expect(screen.queryByTestId('context-peek')).toBeNull();
  });

  it('gives the answer on the back, with the reading and the sentence marked', () => {
    render(<ProductionCard card={card()} script="simp" revealed onReveal={noop} />);
    expect(screen.getByTestId('production-answer')).toHaveTextContent('打算');
    expect(screen.getByTestId('card-pinyin')).toHaveTextContent('dǎsuàn');
    expect(screen.getByTestId('card-glosses')).toHaveTextContent('to plan');
    expect(screen.getByTestId('context-target')).toHaveTextContent('打算');
  });

  it('answers in the script the learner reads, and shows the other alongside', () => {
    const xuexi = card({
      snapshot: { ...SNAPSHOT, simp: '学习', trad: '學習', glosses: ['to study'] },
      context: undefined,
    });
    render(<ProductionCard card={xuexi} script="trad" revealed onReveal={noop} />);
    expect(screen.getByTestId('production-answer')).toHaveTextContent('學習');
    expect(screen.getByTestId('card-back')).toHaveTextContent('学习');
  });

  it('carries the answer box, and stops a keystroke in it from flipping the card', () => {
    let flips = 0;
    render(
      <ProductionCard
        card={card()}
        script="simp"
        revealed={false}
        onReveal={() => {
          flips += 1;
        }}
        recall={<input data-testid="fake-recall" />}
      />,
    );
    const slot = screen.getByTestId('card-recall');
    expect(slot).toBeInTheDocument();
    slot.click();
    expect(flips).toBe(0);
  });
});
