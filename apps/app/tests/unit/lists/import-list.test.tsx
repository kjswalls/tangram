/**
 * The importer on screen (`components/lists/import-list.tsx`).
 *
 * The parsers and the plan have their own suites; what is pinned here is what
 * the *component* promises, which no other test can see:
 *
 *   - nothing is written until the preview has been read, and the picker is
 *     reachable before the write (criterion 4);
 *   - the write is one `addListMembers` call carrying the learner's picks;
 *   - re-importing the same paste adds nothing (criterion 5);
 *   - and the dictionary's absence is **not** announced here, because the page
 *     above already says it once with the button that fixes it (criterion 6,
 *     and `tests/e2e/d/dict-missing-surface.spec.ts`).
 *
 * The dictionary is injected, so this runs in jsdom with no artifact.
 */
import { fireEvent, render, screen, waitFor } from '../render';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ImportList } from '@/components/lists/import-list';
import { closeDb, getDb, getRepository } from '@/lib/db/get-db';
import { DictUnavailableError } from '@/lib/dict/unavailable';
import type { Resolver } from '@/lib/lists/import/resolve';
import type { ListRow } from '@/lib/db/schema';
import type { Entry } from '@/lib/types';

import { entry } from './helpers';

afterEach(async () => {
  await getDb().delete();
  await closeDb();
});

const LE = entry({
  id: '了|了[le5]',
  simp: '了',
  trad: '了',
  pinyinNum: 'le5',
  pinyinMarked: 'le',
  glosses: ['(modal particle)'],
});
const LIAO = entry({
  id: '了|了[liao3]',
  simp: '了',
  trad: '了',
  pinyinNum: 'liao3',
  pinyinMarked: 'liǎo',
  glosses: ['to finish'],
});
const NIHAO = entry({
  id: '你好|你好[ni3 hao3]',
  simp: '你好',
  trad: '你好',
  pinyinNum: 'ni3 hao3',
  pinyinMarked: 'nǐhǎo',
  glosses: ['hello'],
});

const DICT: Record<string, Entry[]> = { 了: [LE, LIAO], 你好: [NIHAO] };

const resolver: Resolver = async (words) => ({
  dictVersion: 'test-snapshot',
  results: words.map((word) => ({
    word,
    via: DICT[word] ? ('hanzi' as const) : ('none' as const),
    entries: DICT[word] ?? [],
  })),
});

async function customList(name = 'Pasted'): Promise<ListRow> {
  return getRepository().createList({
    name,
    owner: 'user',
    kind: 'custom',
    active: true,
    order: 0,
  });
}

/** Paste, preview, and wait for the rows. */
async function preview(text: string) {
  fireEvent.change(screen.getByLabelText('Words to import'), { target: { value: text } });
  fireEvent.click(screen.getByTestId('import-preview'));
  await waitFor(() => expect(screen.getAllByTestId('import-row').length).toBeGreaterThan(0));
}

describe('nothing is written until the preview has been read', () => {
  it('shows every row, its status and the polyphone picker before any write', async () => {
    const list = await customList();
    const added = vi.spyOn(getRepository(), 'addListMembers');
    render(<ImportList target={list} resolver={resolver} />);

    await preview('你好\n了\nxyzzyq');

    const rows = screen.getAllByTestId('import-row');
    expect(rows.map((row) => row.getAttribute('data-status'))).toEqual([
      'add',
      'add',
      'unmatched',
    ]);
    // 了 is the ambiguous one and the learner can see it *and* change it before
    // anything is added — criterion 4, and the reason there is a preview at all.
    const picker = screen.getByLabelText('Reading for 了');
    expect((picker as HTMLSelectElement).value).toBe('了|le');
    expect(picker.querySelectorAll('option')).toHaveLength(2);
    expect(screen.queryByLabelText('Reading for xyzzyq')).toBeNull();
    expect(screen.getByTestId('import-summary').textContent).toContain('1 not in the dictionary');

    expect(added).not.toHaveBeenCalled();
  });

  it('writes the learner’s pick, not the default, in one call', async () => {
    const list = await customList();
    const repo = getRepository();
    const added = vi.spyOn(repo, 'addListMembers');
    render(<ImportList target={list} resolver={resolver} />);

    await preview('了');
    fireEvent.change(screen.getByLabelText('Reading for 了'), { target: { value: '了|liao3' } });
    fireEvent.click(screen.getByTestId('import-submit'));

    await waitFor(() => expect(screen.getByTestId('import-result')).toBeTruthy());
    expect(added).toHaveBeenCalledTimes(1);
    expect(added).toHaveBeenCalledWith(list.id, [LIAO.id]);
    expect((await repo.listMembers(list.id)).map((row) => row.entryId)).toEqual([LIAO.id]);
  });

  it('drops the preview when the paste changes, so a stale plan cannot be submitted', async () => {
    const list = await customList();
    render(<ImportList target={list} resolver={resolver} />);
    await preview('你好');
    fireEvent.change(screen.getByLabelText('Words to import'), { target: { value: '了' } });
    expect(screen.queryAllByTestId('import-row')).toHaveLength(0);
    expect(screen.queryByTestId('import-submit')).toBeNull();
  });

  /**
   * Two different nothings, and they need different answers. Blank text cannot
   * be previewed at all — the button stays disabled, which is the honest state
   * for a control with nothing to act on. Text that is *not* blank but holds no
   * words (an Anki header block with no notes under it, a Pleco export that is
   * all category lines) looks like a real paste and has to be told apart from
   * a dictionary that found nothing.
   */
  it('cannot preview blank text, and says so when a real paste holds no words', async () => {
    const list = await customList();
    render(<ImportList target={list} resolver={resolver} />);

    fireEvent.change(screen.getByLabelText('Words to import'), { target: { value: '\n\n \n' } });
    expect((screen.getByTestId('import-preview') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Words to import'), {
      target: { value: '#separator:tab\n#html:true\n' },
    });
    expect((screen.getByTestId('import-preview') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId('import-preview'));
    await waitFor(() =>
      expect(screen.getByTestId('import-error').textContent).toContain('Nothing to import'),
    );
    expect(screen.queryAllByTestId('import-row')).toHaveLength(0);
  });
});

describe('re-importing the same paste adds nothing', () => {
  it('marks what the list already has and writes only the rest', async () => {
    const list = await customList();
    const repo = getRepository();
    render(<ImportList target={list} resolver={resolver} />);

    await preview('你好');
    fireEvent.click(screen.getByTestId('import-submit'));
    await waitFor(() => expect(screen.getByTestId('import-result')).toBeTruthy());
    expect(await repo.listMembers(list.id)).toHaveLength(1);

    // The same paste again, plus one new word.
    await preview('你好\n了');
    const rows = screen.getAllByTestId('import-row');
    expect(rows[0].getAttribute('data-status')).toBe('present');
    expect(rows[1].getAttribute('data-status')).toBe('add');
    expect(screen.getByTestId('import-submit').textContent).toContain('Import 1 word');

    fireEvent.click(screen.getByTestId('import-submit'));
    await waitFor(() =>
      expect(screen.getByTestId('import-result').textContent).toContain('skipped 1 already there'),
    );
    const members = await repo.listMembers(list.id);
    expect(members.map((row) => row.entryId).sort()).toEqual([LE.id, NIHAO.id].sort());
  });

  it('collapses a repeat inside one paste to a single member', async () => {
    const list = await customList();
    render(<ImportList target={list} resolver={resolver} />);
    await preview('你好\n你好');
    expect(
      screen.getAllByTestId('import-row').map((row) => row.getAttribute('data-status')),
    ).toEqual(['add', 'duplicate']);
    fireEvent.click(screen.getByTestId('import-submit'));
    await waitFor(() => expect(screen.getByTestId('import-result')).toBeTruthy());
    expect(await getRepository().listMembers(list.id)).toHaveLength(1);
  });
});

describe('without a dictionary', () => {
  /**
   * The failure this test exists for is a *second* copy of "the dictionary is
   * not on this device yet" on a page that already says it — and, worse, the
   * raw lowercase `Error.message` saying it. Both surfaces that mount this
   * component carry the one `<DictNotice>`; this one stays quiet.
   */
  it('says nothing about it, and never prints the raw message', async () => {
    const list = await customList();
    const absent: Resolver = () => Promise.reject(new DictUnavailableError());
    const { container } = render(<ImportList target={list} resolver={absent} />);

    fireEvent.change(screen.getByLabelText('Words to import'), { target: { value: '你好' } });
    fireEvent.click(screen.getByTestId('import-preview'));

    await waitFor(() =>
      expect((screen.getByTestId('import-preview') as HTMLButtonElement).disabled).toBe(false),
    );
    expect(screen.queryByTestId('import-error')).toBeNull();
    expect(screen.queryByTestId('dict-status')).toBeNull();
    expect(container.textContent?.toLowerCase()).not.toContain('not on this device');
    // And the paste survives, so the learner can press Preview again once the
    // dictionary is there rather than retyping it.
    expect((screen.getByLabelText('Words to import') as HTMLTextAreaElement).value).toBe('你好');
  });

  it('still reports a failure that is NOT the missing dictionary', async () => {
    const list = await customList();
    const broken: Resolver = () => Promise.reject(new Error('the artifact is schema 0'));
    render(<ImportList target={list} resolver={broken} />);
    fireEvent.change(screen.getByLabelText('Words to import'), { target: { value: '你好' } });
    fireEvent.click(screen.getByTestId('import-preview'));
    await waitFor(() =>
      expect(screen.getByTestId('import-error').textContent).toContain('schema 0'),
    );
  });
});

describe('choosing where it goes', () => {
  it('creates a list when there is no fixed target', async () => {
    const repo = getRepository();
    render(<ImportList lists={[]} resolver={resolver} />);
    fireEvent.click(screen.getByTestId('import-open'));
    fireEvent.change(screen.getByLabelText('Imported list name'), { target: { value: 'Kitchen' } });
    await preview('你好');
    fireEvent.click(screen.getByTestId('import-submit'));

    await waitFor(() => expect(screen.getByTestId('import-result')).toBeTruthy());
    const made = (await repo.lists()).find((row) => row.name === 'Kitchen');
    expect(made).toMatchObject({ kind: 'custom', owner: 'user' });
    expect(await repo.listMembers(made!.id)).toHaveLength(1);
    // The result links to the list it made, at the path C7 gave it.
    expect(screen.getByRole('link', { name: 'Kitchen' }).getAttribute('href')).toBe(
      `/library/lists/${made!.id}`,
    );
  });

  it('names an unnamed list rather than refusing to write one', async () => {
    render(<ImportList lists={[]} resolver={resolver} />);
    fireEvent.click(screen.getByTestId('import-open'));
    await preview('你好');
    fireEvent.click(screen.getByTestId('import-submit'));
    await waitFor(() => expect(screen.getByTestId('import-result')).toBeTruthy());
    expect((await getRepository().lists()).some((row) => row.name === 'Imported list')).toBe(true);
  });

  it('is collapsed in Library and already open on a list’s own page', async () => {
    const { unmount } = render(<ImportList lists={[]} resolver={resolver} />);
    expect(screen.getByTestId('import-open')).toBeTruthy();
    expect(screen.queryByLabelText('Words to import')).toBeNull();
    unmount();

    render(<ImportList target={await customList()} resolver={resolver} />);
    expect(screen.queryByTestId('import-open')).toBeNull();
    expect(screen.getByLabelText('Words to import')).toBeTruthy();
  });
});
