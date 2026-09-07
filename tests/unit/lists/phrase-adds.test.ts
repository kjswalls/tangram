/**
 * The two Add seams the Phases 4–5 review found leaking (HANDOFF.md).
 *
 * A phrase card had no idempotency at all — the frozen repository has no
 * `phraseCardFor` to ask — so the same question asked twice made two identical
 * cards and the review session offered both. And "known" and "has a card due
 * today" were reachable at once, which made the reader paint a word known while
 * the queue served it.
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { Repository } from '@/lib/db/repository';
import {
  addCardTracked,
  addPhraseCardChecked,
  phraseCardFor,
  phraseKey,
} from '@/lib/lists/looked-up';
import { entry, freshRepository } from './helpers';

let close: (() => void) | undefined;

afterEach(() => {
  close?.();
  close = undefined;
});

function setup(): Repository {
  const { db, repo } = freshRepository();
  close = () => db.close();
  return repo;
}

const TOKENS = [
  { text: '我', entryId: '我|我[wo3]', pinyinMarked: 'wǒ' },
  { text: '随便', entryId: '隨便|随便[sui2 bian4]', pinyinMarked: 'suíbiàn' },
  { text: '看看', entryId: '看看|看看[kan4 kan5]', pinyinMarked: 'kànkan' },
];

const CONTEXT = { question: 'how do I say I am just browsing', source: 'ask' as const, addedAt: 1 };

describe('addPhraseCardChecked', () => {
  it('makes one card however many times the same phrase is added', async () => {
    const repo = setup();
    const first = await addPhraseCardChecked(repo, TOKENS, 'I am just looking.', CONTEXT);
    const second = await addPhraseCardChecked(repo, TOKENS, 'I am just looking.', CONTEXT);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.card.id).toBe(first.card.id);
    expect((await repo.allCards()).filter((card) => card.kind === 'phrase')).toHaveLength(1);
  });

  it('can be asked before the button is pressed, so it can say so', async () => {
    const repo = setup();
    expect(await phraseCardFor(repo, TOKENS)).toBeUndefined();
    await addPhraseCardChecked(repo, TOKENS, 'I am just looking.', CONTEXT);
    expect(await phraseCardFor(repo, TOKENS)).toBeDefined();
    expect(phraseKey(TOKENS)).toBe('我随便看看');
  });

  it('still tells two different phrases apart', async () => {
    const repo = setup();
    await addPhraseCardChecked(repo, TOKENS, 'I am just looking.', CONTEXT);
    const other = await addPhraseCardChecked(
      repo,
      [TOKENS[0], { text: '只是', entryId: '只是|只是[zhi3 shi4]' }, TOKENS[2]],
      'I am only looking.',
      CONTEXT,
    );
    expect(other.created).toBe(true);
    expect((await repo.allCards()).filter((card) => card.kind === 'phrase')).toHaveLength(2);
  });

  it('writes a placeholder rather than dropping a syllable with no reading', async () => {
    const repo = setup();
    const { card } = await addPhraseCardChecked(
      repo,
      [TOKENS[0], { text: '隨便', unverified: true }],
      'made up',
      CONTEXT,
    );
    // Two tokens on the front, two groups on the back: a card whose pinyin is
    // shorter than its hanzi teaches a reading that is not the word.
    expect(card.snapshot).toMatchObject({ simp: '我隨便', pinyinMarked: 'wǒ ?' });
  });
});

describe('an explicit Add and “Mark known” are exclusive', () => {
  it('un-knows a word when a card for it is added', async () => {
    const repo = setup();
    const meitian = entry({ simp: '每天', id: '每天|每天[mei3 tian1]' });
    await repo.markKnown([meitian.id]);
    expect(await repo.knownEntryIds()).toEqual([meitian.id]);

    await addCardTracked(repo, meitian, { sentence: '我每天跑步', source: 'reader', addedAt: 1 });
    expect(await repo.knownEntryIds()).toEqual([]);
  });

  it('leaves the known set alone for a card the spine drew', async () => {
    const repo = setup();
    const word = entry();
    await repo.markKnown([word.id]);
    await addCardTracked(repo, word, { source: 'list', addedAt: 1 });
    expect(await repo.knownEntryIds()).toEqual([word.id]);
  });
});
