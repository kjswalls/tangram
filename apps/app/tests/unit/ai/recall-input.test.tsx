/**
 * The recall box on its own (PLAN.md §4, Phase 6 item 2).
 *
 * `recall-session.test.tsx` walks the feature through the real store; this
 * covers the two things that are properties of the box itself and are awkward
 * to stage from up there: the flip happens exactly once and before anything is
 * asked, and a suggestion for a card that has left the screen reaches nobody —
 * neither the box (which is gone) nor the caller holding the grade bar, where
 * it would otherwise overwrite the suggestion belonging to the card that is
 * actually up.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RecallInput } from '@/components/review/recall-input';
import { closeDb, getDb, getRepository } from '@/lib/db/get-db';
import type { RecallSuggestion } from '@/lib/ai/recall';
import type { CardRow } from '@/lib/db/schema';
import { context, DASUAN, KANKAN } from '../db/fixtures';

afterEach(async () => {
  await getDb().delete();
  await closeDb();
});

const SUGGESTION: RecallSuggestion = { suggested: 4, why: 'That reads as recalled.' };

/** A request seam that is settled by hand. */
function deferredRequest() {
  let settle: ((suggestion: RecallSuggestion | null) => void) | undefined;
  const request = vi.fn(
    () =>
      new Promise<RecallSuggestion | null>((resolve) => {
        settle = resolve;
      }),
  );
  return { request, answer: (suggestion: RecallSuggestion | null) => settle?.(suggestion) };
}

async function cards(): Promise<[CardRow, CardRow]> {
  const repo = getRepository();
  return [
    await repo.addCardFromEntry(DASUAN, context({ source: 'lookup' })),
    await repo.addCardFromEntry(KANKAN, context({ source: 'reader' })),
  ];
}

function submit(answer: string) {
  fireEvent.change(screen.getByTestId('recall-answer'), { target: { value: answer } });
  fireEvent.keyDown(screen.getByTestId('recall-answer'), { key: 'Enter' });
}

describe('the recall box', () => {
  it('reveals once, before it asks, and cannot be submitted twice', async () => {
    const [card] = await cards();
    const onReveal = vi.fn();
    const { request, answer } = deferredRequest();
    render(
      <RecallInput card={card} revealed={false} onReveal={onReveal} request={request as never} />,
    );

    submit('to plan');
    expect(onReveal).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledOnce();

    // The box is out of the conversation the moment it is answered — no second
    // question, no second flip.
    fireEvent.click(screen.getByTestId('recall-answer'));
    expect(screen.queryByTestId('recall-submit')).toBeNull();
    answer(SUGGESTION);
    await screen.findByTestId('recall-suggestion');
    expect(onReveal).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledOnce();
  });

  it('tells nobody about a suggestion for a card that has been left behind', async () => {
    const [card] = await cards();
    const onSuggestion = vi.fn();
    const { request, answer } = deferredRequest();
    const view = render(
      <RecallInput
        card={card}
        revealed={false}
        onReveal={() => {}}
        onSuggestion={onSuggestion}
        request={request as never}
      />,
    );

    submit('to plan');
    view.unmount();
    answer(SUGGESTION);

    await Promise.resolve();
    expect(onSuggestion).not.toHaveBeenCalled();
  });

  it('abandons the previous card’s answer when the card changes under it', async () => {
    const [first, second] = await cards();
    const onSuggestion = vi.fn();
    const { request, answer } = deferredRequest();
    const props = {
      revealed: false,
      onReveal: () => {},
      onSuggestion,
      request: request as never,
    };
    const view = render(<RecallInput card={first} {...props} />);

    submit('to plan');
    // The caller normally keys this component on the card id, which remounts
    // it; a caller that does not must still not see the old answer land.
    view.rerender(<RecallInput card={second} {...props} />);
    answer(SUGGESTION);

    await waitFor(() => expect(screen.getByTestId('recall')).toHaveAttribute('data-phase', 'idle'));
    // Nothing of the old question survives on screen, and the suggestion that
    // did arrive is labelled with the card it was about — never the card now
    // in front of the learner, which is what the caller files it under.
    expect(screen.queryByTestId('recall-suggestion')).toBeNull();
    expect((screen.getByTestId('recall-answer') as HTMLInputElement).value).toBe('');
    for (const [cardId] of onSuggestion.mock.calls) expect(cardId).toBe(first.id);
    expect(onSuggestion).not.toHaveBeenCalledWith(second.id, expect.anything());
  });
});
