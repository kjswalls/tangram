/**
 * `/lists/:id` with the dictionary down (docs/plans/core.md C4a; `data.md` D4:
 * "the app runs without a dictionary").
 *
 * **Two calls on this page can reject, and the first fix guarded one of them.**
 * `readDetail` asks `ensureMembers` for the membership and then `source.entries`
 * for the glosses. The gloss call was wrapped; `ensureMembers` was not — and it
 * is the one that reaches the dictionary on a fresh install, because an HSK band
 * that has never been opened is materialised from `source.band()` on its first
 * visit. The rejection escaped the component, `data` stayed undefined, and the
 * card sat on "Loading words…" for ever under a raw `run pnpm data`, with no
 * retry. The custom-list case passed throughout, because its members are already
 * in IndexedDB and `materialise` returns before it can throw.
 *
 * There is no CI, so the rule is a test rather than a note (CLAUDE.md).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EntrySource } from '@/lib/lists/entry-source';

/** Every dictionary call refuses, exactly as a 503 `dict-data-missing` does. */
const down: EntrySource = {
  band: () => Promise.reject(new Error('run pnpm data')),
  entries: () => Promise.reject(new Error('run pnpm data')),
  search: () => Promise.reject(new Error('run pnpm data')),
};

vi.mock('@/lib/lists/entry-source', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/lists/entry-source')>()),
  getEntrySource: () => down,
}));

const { ListDetail } = await import('@/components/lists/list-detail');
const { closeDb, getDb, getRepository } = await import('@/lib/db/get-db');
const { ensureSystemLists, findHskList } = await import('@/lib/lists/system-lists');
const { render, screen, waitFor } = await import('../render');

afterEach(async () => {
  await getDb().delete();
  await closeDb();
});

describe('a list page with no dictionary', () => {
  it('an HSK band never opened before renders, and says the words are the dictionary’s', async () => {
    const repo = getRepository();
    const band3 = findHskList(await ensureSystemLists(repo), 3)!;
    // The precondition the bug needed: no membership yet, so `ensureMembers`
    // must go to `source.band()` — which refuses.
    expect(await repo.listMembers(band3.id)).toHaveLength(0);

    render(<ListDetail listId={band3.id} />);

    const empty = await screen.findByTestId('list-empty');
    expect(empty.getAttribute('data-unfilled')).toBe('true');
    expect(empty.textContent).toMatch(/dictionary/i);
    // Not stuck, and not showing the developer-facing hint as the page.
    expect(screen.queryByText(/Loading words…/)).toBeNull();
    expect(screen.queryByText('run pnpm data')).toBeNull();
    // The list itself is still there — its name, and a count, not an error page.
    expect(screen.getByTestId('member-total').textContent).toContain('0 words');
  });

  it('a list the learner owns still shows its words, by id', async () => {
    const repo = getRepository();
    const list = await repo.createList({ name: 'Offline list', kind: 'custom' });
    await repo.addListMembers(list.id, ['打算|打算[da3 suan4]']);

    render(<ListDetail listId={list.id} />);

    await waitFor(() => expect(screen.getAllByTestId('list-member')).toHaveLength(1));
    expect(screen.getByTestId('list-member').textContent).toContain('打算');
    // …and this empty state is never reached, so the two cannot be confused.
    expect(screen.queryByTestId('list-empty')).toBeNull();
  });

  it('an empty list the learner owns is their empty list, not the dictionary’s', async () => {
    const repo = getRepository();
    const list = await repo.createList({ name: 'Nothing here', kind: 'custom' });

    render(<ListDetail listId={list.id} />);

    const empty = await screen.findByTestId('list-empty');
    expect(empty.getAttribute('data-unfilled')).toBe('false');
    expect(empty.textContent).toMatch(/no words yet/i);
  });
});
