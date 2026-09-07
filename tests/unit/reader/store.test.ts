import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TextRow } from '@/lib/db/schema';
import {
  defaultTitle,
  nextExtendable,
  spanOf,
  useReaderStore,
  type ReaderState,
} from '@/lib/stores/reader';
import type { Token } from '@/lib/types';

/**
 * PLAN.md §3.5. The store is what makes the pasted text survive a navigation, so
 * the cases that matter are the ones where state could go stale: tokens that no
 * longer index the body, a selection left pointing at a token that is gone, and
 * a segmentation that lands after the learner has typed something else.
 */

const BODY = '我打算明天去北京。';

function word(text: string, start: number, entryIds: string[] = []): Token {
  return {
    text,
    start,
    end: start + text.length,
    kind: 'word',
    entryIds,
    via: entryIds.length > 0 ? 'entry' : 'fallback',
  };
}

function stop(text: string, start: number): Token {
  return { text, start, end: start + text.length, kind: 'text', entryIds: [], via: 'fallback' };
}

/** 我 / 打算 / 明天 / 去 / 北京 / 。 — P1's answer for the sentence above. */
const TOKENS: Token[] = [
  word('我', 0, ['我|我[wo3]']),
  word('打算', 1, ['打算|打算[da3 suan4]']),
  word('明天', 3, ['明天|明天[ming2 tian1]']),
  word('去', 5, ['去|去[qu4]']),
  word('北京', 6, ['北京|北京[Bei3 jing1]']),
  stop('。', 8),
];

const INITIAL: ReaderState = useReaderStore.getState();

beforeEach(() => {
  useReaderStore.setState(INITIAL, true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the reader store', () => {
  it('starts in the paste box with nothing in it', () => {
    const state = useReaderStore.getState();
    expect(state.view).toBe('compose');
    expect(state.body).toBe('');
    expect(state.tokens).toEqual([]);
  });

  it('editing the text drops the tokens: they index a string that no longer exists', () => {
    const store = useReaderStore.getState();
    store.setText(BODY);
    store.setTokens(TOKENS);
    store.select(1);
    expect(useReaderStore.getState().tokens).toHaveLength(6);

    useReaderStore.getState().setText('别的句子。');
    const after = useReaderStore.getState();
    expect(after.tokens).toEqual([]);
    expect(after.tokenizedBody).toBe('');
    expect(after.selected).toBeUndefined();
  });

  it('editing the text forgets the saved row, so the reopen list is not overwritten', () => {
    useReaderStore.setState({ textId: 'text-1' });
    useReaderStore.getState().setText('新的文章。');
    expect(useReaderStore.getState().textId).toBeUndefined();
  });

  it('only word tokens can be selected', () => {
    const store = useReaderStore.getState();
    store.setText(BODY);
    store.setTokens(TOKENS);

    store.select(1);
    expect(useReaderStore.getState().selected).toBe(1);
    expect(useReaderStore.getState().spanEnd).toBe(1);

    // The full stop is a `text` token — §3.5 renders it untappable.
    store.select(5);
    expect(useReaderStore.getState().selected).toBeUndefined();

    store.select(1);
    store.select(undefined);
    expect(useReaderStore.getState().selected).toBeUndefined();
  });

  it('a span is the selected token until Extend grows it over the next one', () => {
    const store = useReaderStore.getState();
    store.setText(BODY);
    store.setTokens(TOKENS);
    store.select(1);

    expect(spanOf(useReaderStore.getState())).toMatchObject({ text: '打算', start: 1, end: 3 });

    const extended = useReaderStore.getState().extend();
    expect(extended).toMatchObject({ text: '打算明天', start: 1, end: 5 });
    expect(useReaderStore.getState().spanEnd).toBe(2);
    expect(extended?.tokens).toHaveLength(2);

    // And again: the span keeps growing while there is an adjacent word.
    expect(useReaderStore.getState().extend()).toMatchObject({ text: '打算明天去' });
  });

  it('Extend stops at a text token — 北京。 is not a span', () => {
    const store = useReaderStore.getState();
    store.setText(BODY);
    store.setTokens(TOKENS);
    store.select(4);

    expect(nextExtendable(useReaderStore.getState())).toBeUndefined();
    expect(useReaderStore.getState().extend()).toBeUndefined();
    expect(useReaderStore.getState().spanEnd).toBe(4);
  });

  it('Extend refuses two words that are not adjacent in the body', () => {
    const gapped: Token[] = [word('北京', 0, ['a']), stop('，', 2), word('上海', 3, ['b'])];
    const store = useReaderStore.getState();
    store.setText('北京，上海');
    store.setTokens(gapped);
    store.select(0);
    expect(nextExtendable(useReaderStore.getState())).toBeUndefined();

    // With the comma gone they are adjacent, and the span is legal.
    store.setText('北京上海');
    store.setTokens([word('北京', 0, ['a']), word('上海', 2, ['b'])]);
    store.select(0);
    expect(nextExtendable(useReaderStore.getState())).toBe(1);
  });

  it('selecting again after an extension resets the span to one token', () => {
    const store = useReaderStore.getState();
    store.setText(BODY);
    store.setTokens(TOKENS);
    store.select(1);
    store.extend();
    store.select(3);
    expect(useReaderStore.getState().spanEnd).toBe(3);
    expect(spanOf(useReaderStore.getState())?.text).toBe('去');
  });

  it('read() posts once and keeps the tokens for the same body', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ text: BODY, script: 'simp', tokens: TOKENS }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    useReaderStore.getState().setText(BODY);
    await useReaderStore.getState().read();

    const state = useReaderStore.getState();
    expect(state.view).toBe('read');
    expect(state.tokens).toHaveLength(6);
    expect(state.tokenizedBody).toBe(BODY);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Coming back from another route must not re-post the paragraph.
    useReaderStore.getState().setView('compose');
    await useReaderStore.getState().read();
    expect(useReaderStore.getState().view).toBe('read');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('a segmentation that lands after the body changed is dropped', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      // The learner keeps typing while the request is out.
      useReaderStore.getState().setText('完全不同的句子。');
      return new Response(JSON.stringify({ text: BODY, script: 'simp', tokens: TOKENS }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    useReaderStore.getState().setText(BODY);
    await useReaderStore.getState().read();

    const state = useReaderStore.getState();
    expect(state.tokens).toEqual([]);
    expect(state.view).toBe('compose');
    expect(state.loading).toBe(false);
  });

  it('a failed segmentation leaves the text alone and reports why', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'dict-data-missing', hint: 'run pnpm data' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      }),
    );

    useReaderStore.getState().setText(BODY);
    await useReaderStore.getState().read();

    const state = useReaderStore.getState();
    expect(state.body).toBe(BODY);
    expect(state.view).toBe('compose');
    expect(state.loading).toBe(false);
    expect(state.error).toContain('pnpm data');
  });

  it('read() does nothing for an empty body', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    useReaderStore.getState().setText('   ');
    await useReaderStore.getState().read();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(useReaderStore.getState().view).toBe('compose');
  });

  it('opening a saved text replaces the current one and segments it', async () => {
    const row: TextRow = {
      id: 'text-9',
      title: '我的一天',
      body: BODY,
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ text: BODY, script: 'simp', tokens: TOKENS }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await useReaderStore.getState().open(row);

    const state = useReaderStore.getState();
    expect(state.textId).toBe('text-9');
    expect(state.title).toBe('我的一天');
    expect(state.body).toBe(BODY);
    expect(state.view).toBe('read');
    expect(state.tokens).toHaveLength(6);
  });

  it('clear() empties everything and goes back to the paste box', () => {
    const store = useReaderStore.getState();
    store.setText(BODY);
    store.setTokens(TOKENS);
    store.select(1);
    store.setView('read');

    useReaderStore.getState().clear();
    const state = useReaderStore.getState();
    expect(state).toMatchObject({ body: '', title: '', tokens: [], view: 'compose' });
    expect(state.selected).toBeUndefined();
    expect(state.textId).toBeUndefined();
  });
});

describe('defaultTitle', () => {
  it('is the first line', () => {
    expect(defaultTitle('我的一天\n第二行')).toBe('我的一天');
  });

  it('is cut with an ellipsis when the line runs long', () => {
    const title = defaultTitle('字'.repeat(80));
    expect(title).toHaveLength(41);
    expect(title.endsWith('…')).toBe(true);
  });

  it('never comes back empty', () => {
    expect(defaultTitle('   \n  ')).toBe('Untitled text');
  });
});
