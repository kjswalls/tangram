/**
 * The two render slots on the review card (PLAN.md §4, Phase 6 items 1 and 2),
 * and the phrase front that now goes through `PhraseFace`.
 *
 * The card owns *where* these go and nothing else: both props default to null,
 * so a caller that knows nothing about them renders exactly the card that
 * shipped in Phase 2. What is pinned here is the placement — recall on the
 * front, under the hanzi, where it is answered before the flip; examples on the
 * back, under the glosses, after the meaning has been seen — and the one thing
 * placement alone would get wrong: typing into the recall box must not flip the
 * card it is about.
 */
import { fireEvent, render, screen } from '../render';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ReviewCard } from '@/components/review/review-card';
import { closeDb, getDb, getRepository } from '@/lib/db/get-db';
import type { CardRow } from '@/lib/db/schema';
import { context, DASUAN } from '../db/fixtures';

afterEach(async () => {
  await getDb().delete();
  await closeDb();
});

const noop = () => {};

function card(props: Partial<React.ComponentProps<typeof ReviewCard>> & { card: CardRow }) {
  return (
    <ReviewCard
      script="simp"
      revealed={false}
      peeked={false}
      onPeek={noop}
      onReveal={noop}
      {...props}
    />
  );
}

describe('the card slots', () => {
  it('renders the card unchanged when nothing is injected', async () => {
    const row = await getRepository().addCardFromEntry(DASUAN, context({ source: 'lookup' }));
    render(card({ card: row }));

    // `<ruby>` interleaves the readings into `textContent` (`打dǎ算suàn`), so the
    // base characters come from `data-hanzi` — the hook `<HanziText>` provides
    // for exactly this (core.md C3).
    expect(
      screen.getByTestId('card-front').querySelector('[data-hanzi]'),
    ).toHaveAttribute('data-hanzi', '打算');
    expect(screen.queryByTestId('card-recall')).toBeNull();
    expect(screen.queryByTestId('card-examples')).toBeNull();
  });

  it('puts recall on the front and examples on the back', async () => {
    const row = await getRepository().addCardFromEntry(DASUAN, context({ source: 'lookup' }));
    const slots = { recall: <input data-testid="recall-box" />, examples: <p>a sentence</p> };

    const view = render(card({ card: row, ...slots }));
    // Front: the recall box is there before the answer is; the examples are not.
    expect(screen.getByTestId('card-front')).toContainElement(screen.getByTestId('card-recall'));
    expect(screen.queryByTestId('card-examples')).toBeNull();

    view.rerender(card({ card: row, revealed: true, ...slots }));
    // Back: the examples sit under the glosses, and the recall box survives the
    // flip — the suggested grade has to be readable beside what was typed.
    expect(screen.getByTestId('card-back')).toContainElement(screen.getByTestId('card-examples'));
    expect(screen.getByTestId('card-recall')).toBeVisible();
  });

  it('does not flip the card when the learner types their answer into it', async () => {
    const row = await getRepository().addCardFromEntry(DASUAN, context({ source: 'lookup' }));
    const onReveal = vi.fn();
    render(card({ card: row, onReveal, recall: <input data-testid="recall-box" /> }));

    const box = screen.getByTestId('recall-box');
    fireEvent.click(box);
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.keyDown(box, { key: ' ' });
    expect(onReveal).not.toHaveBeenCalled();

    // The rest of the front still flips.
    fireEvent.click(screen.getByTestId('card-front'));
    expect(onReveal).toHaveBeenCalledTimes(1);
  });
});

/**
 * **A practice card's QUESTION side never carries the reading**, whatever
 * `pinyinDisplay` says (core.md C3, as amended — see HANDOFF.md).
 *
 * This is the guard the phrase card had and the word card did not. C3 gave the
 * front an unforced `<HanziWord>`, and since `DEFAULT_SETTINGS.pinyinDisplay`
 * is `'always'`, a fresh install printed 打(dǎ)算(suàn) above the headword and
 * then revealed `dǎsuàn` as the answer — the card answering itself for every
 * learner who never opens a setting C8 has not built yet. No test saw it,
 * because the assertion next door reads `data-hanzi`, which strips the
 * readings by construction.
 */
describe('the question side', () => {
  it('shows no reading on the front, and the whole reading on the back', async () => {
    const row = await getRepository().addCardFromEntry(DASUAN, context({ source: 'lookup' }));

    const view = render(card({ card: row }));
    expect(screen.getByTestId('card-front').querySelector('rt')).toBeNull();
    view.unmount();

    /**
     * Not vacuous: the same card, flipped, annotates every character.
     *
     * The annotation appears on the FRONT element, because that is where the
     * headword is rendered — the back is appended below it and never repeats
     * the characters. So "the question side is silent" and "the answer shows
     * the reading over each character" are two states of one element, which is
     * why `revealed` is what switches it.
     */
    render(card({ card: row, revealed: true }));
    const readings = [...screen.getByTestId('card-front').querySelectorAll('rt')].map(
      (node) => node.textContent,
    );
    expect(readings).toEqual(['dǎ', 'suàn']);
  });

  it('keeps the other script silent too', async () => {
    const row = await getRepository().addCardFromEntry(DASUAN, context({ source: 'lookup' }));
    // 打算's traditional and simplified forms are the same, so the secondary
    // face needs a card whose scripts differ to be rendered at all.
    const xuexi: CardRow = {
      ...row,
      snapshot: { ...row.snapshot, simp: '学习', trad: '學習', pinyinNum: 'xue2 xi2' },
    };
    render(card({ card: xuexi, script: 'trad' }));
    expect(screen.getByTestId('card-front').querySelectorAll('rt')).toHaveLength(0);
    // Both scripts are on the front — this is the face, not an empty render.
    const hanzi = [...screen.getByTestId('card-front').querySelectorAll('[data-hanzi]')].map(
      (node) => node.getAttribute('data-hanzi'),
    );
    expect(hanzi).toEqual(['學習', '学习']);
  });
});

describe('a phrase card front', () => {
  it('is rendered by PhraseFace, still showing the phrase', async () => {
    const row = await getRepository().addPhraseCard(
      [
        { text: '我', entryId: '我|我[wo3]', pinyinMarked: 'wǒ' },
        { text: '随便', entryId: '隨便|随便[sui2 bian4]', pinyinMarked: 'suíbiàn' },
        { text: '看看', entryId: '看看|看看[kan4 kan5]', pinyinMarked: 'kànkan' },
      ],
      'I am just looking, thanks.',
      context({ source: 'ask' }),
    );

    render(card({ card: row }));
    expect(screen.getByTestId('phrase-face')).toHaveTextContent('我随便看看');
    expect(screen.getByTestId('card-front')).toContainElement(screen.getByTestId('phrase-face'));
  });
});
