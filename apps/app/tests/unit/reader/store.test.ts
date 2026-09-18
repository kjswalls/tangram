import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TextRow } from '@/lib/db/schema';
import {
  defaultTitle,
  nextExtendable,
  spanOf,
  tokenAt,
  useReaderStore,
  type ReaderState,
} from '@/lib/stores/reader';
import { resetDictStores, setDictStore } from '@/lib/dict/browser-store';
import type { DictStore } from '@/lib/dict/store';
import type { Token } from '@/lib/types';

/** The repository the store reaches for through `@/lib/db/get-db`. */
const saveText = vi.fn();
vi.mock('@/lib/db/get-db', () => ({
  getRepository: () => ({ saveText, texts: async () => [] }),
}));

/**
 * The dictionary `read()` segments through.
 *
 * It used to be a `fetch` stub, because the store behind `getDictStore()` was
 * `lib/dict/http-store.ts` and segmentation was a `POST`. `data.md` D6 deleted
 * that route: the browser's store is `sqlite-wasm` on OPFS, and a `fetch` stub
 * would have gone on passing while asserting nothing. Same cases, same expected
 * values; what is counted is the store call rather than the request.
 */
const segment = vi.fn<DictStore['segment']>();

function installStore(): void {
  const refuse = () => {
    throw new Error('the reader store should not reach this method');
  };
  setDictStore({
    status: { state: 'ready', version: 'test' },
    subscribe: () => () => {},
    open: async () => {},
    segment,
    entries: refuse,
    search: refuse,
    hskBand: refuse,
    readingCount: refuse,
    wordsContaining: refuse,
  });
}

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
  segment.mockReset();
  installStore();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await resetDictStores();
});

describe('the reader store', () => {
  it('starts in the paste box with nothing in it', () => {
    const state = useReaderStore.getState();
    expect(state.view).toBe('compose');
    expect(state.body).toBe('');
    expect(state.tokens).toEqual([]);
  });

  it('the tokens tile the body exactly, which is what makes a DOM index a body offset', () => {
    // C5b's whole index model rests on this: `<HanziText>` renders one run per
    // token in order, so the concatenated base text of the rendered passage IS
    // the body — and character 7 in the DOM is character 7 in `body`. Asserted
    // rather than assumed, because every span offset downstream is wrong by the
    // size of the first gap if it ever stops holding.
    expect(TOKENS.map((token) => token.text).join('')).toBe(BODY);
    let at = 0;
    for (const token of TOKENS) {
      expect(token.start).toBe(at);
      at = token.end;
    }
    expect(at).toBe(BODY.length);
  });

  it('editing the text drops the tokens: they index a string that no longer exists', () => {
    const store = useReaderStore.getState();
    store.setText(BODY);
    store.setTokens(TOKENS);
    store.selectToken(1);
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

  it('a tap selects a word token as a CHARACTER span (C5b)', () => {
    const store = useReaderStore.getState();
    store.setText(BODY);
    store.setTokens(TOKENS);

    // 打算 is token 1 and characters 1–2. Both numbers are now the span.
    store.selectToken(1);
    expect(useReaderStore.getState().selected).toBe(1);
    expect(useReaderStore.getState().spanEnd).toBe(2);

    // The full stop is a `text` token — §3.5 renders it untappable.
    store.selectToken(5);
    expect(useReaderStore.getState().selected).toBeUndefined();

    store.selectToken(1);
    store.selectToken(undefined);
    expect(useReaderStore.getState().selected).toBeUndefined();
  });

  it('a dragged span is characters, and it may cross a token boundary', () => {
    const store = useReaderStore.getState();
    store.setText(BODY);
    store.setTokens(TOKENS);

    // 算明 — the second half of 打算 and the first of 明天. Token-granular
    // selection could not express this at all, which is the point of C5b.
    store.selectSpan(2, 3);
    const span = spanOf(useReaderStore.getState());
    expect(span).toMatchObject({ text: '算明', start: 2, end: 4 });
    // Overlap, not containment: both words are part of what was selected.
    expect(span?.tokens.map((token) => token.text)).toEqual(['打算', '明天']);
  });

  it('a span that crosses punctuation contains it', () => {
    const store = useReaderStore.getState();
    store.setText(BODY);
    store.setTokens(TOKENS);
    // 北京。 would be refused by Extend; a drag across it is legal and keeps
    // the full stop, because `spanOf` slices the body.
    store.selectSpan(6, 8);
    expect(spanOf(useReaderStore.getState())?.text).toBe('北京。');
  });

  it('a backwards drag is the same span as a forwards one', () => {
    const store = useReaderStore.getState();
    store.setText(BODY);
    store.setTokens(TOKENS);
    store.selectSpan(5, 1);
    expect(useReaderStore.getState().selected).toBe(1);
    expect(useReaderStore.getState().spanEnd).toBe(5);
  });

  it('a span is clamped to the body, so a stale index cannot slice past the end', () => {
    const store = useReaderStore.getState();
    store.setText(BODY);
    store.setTokens(TOKENS);
    store.selectSpan(-4, 500);
    expect(spanOf(useReaderStore.getState())?.text).toBe(BODY);
  });

  it('a span is the selected token until Extend grows it over the next one', () => {
    const store = useReaderStore.getState();
    store.setText(BODY);
    store.setTokens(TOKENS);
    store.selectToken(1);

    expect(spanOf(useReaderStore.getState())).toMatchObject({ text: '打算', start: 1, end: 3 });

    const extended = useReaderStore.getState().extend();
    expect(extended).toMatchObject({ text: '打算明天', start: 1, end: 5 });
    // Character 4 is the last of 明天, not token 2.
    expect(useReaderStore.getState().spanEnd).toBe(4);
    expect(extended?.tokens).toHaveLength(2);

    // And again: the span keeps growing while there is an adjacent word.
    expect(useReaderStore.getState().extend()).toMatchObject({ text: '打算明天去' });
  });

  it('Extend stops at a text token — 北京。 is not a span', () => {
    const store = useReaderStore.getState();
    store.setText(BODY);
    store.setTokens(TOKENS);
    store.selectToken(4);

    expect(nextExtendable(useReaderStore.getState())).toBeUndefined();
    expect(useReaderStore.getState().extend()).toBeUndefined();
    expect(useReaderStore.getState().spanEnd).toBe(7);
  });

  it('Extend refuses two words that are not adjacent in the body', () => {
    const gapped: Token[] = [word('北京', 0, ['a']), stop('，', 2), word('上海', 3, ['b'])];
    const store = useReaderStore.getState();
    store.setText('北京，上海');
    store.setTokens(gapped);
    store.selectToken(0);
    expect(nextExtendable(useReaderStore.getState())).toBeUndefined();

    // With the comma gone they are adjacent, and the span is legal.
    store.setText('北京上海');
    store.setTokens([word('北京', 0, ['a']), word('上海', 2, ['b'])]);
    store.selectToken(0);
    expect(nextExtendable(useReaderStore.getState())).toBe(1);
  });

  it('selecting again after an extension resets the span to one token', () => {
    const store = useReaderStore.getState();
    store.setText(BODY);
    store.setTokens(TOKENS);
    store.selectToken(1);
    store.extend();
    store.selectToken(3);
    expect(useReaderStore.getState().selected).toBe(5);
    expect(useReaderStore.getState().spanEnd).toBe(5);
    expect(spanOf(useReaderStore.getState())?.text).toBe('去');
  });

  it('tokenAt answers for every character, punctuation included', () => {
    // A span interior has to be locatable even where a tap is not allowed.
    expect(tokenAt(TOKENS, 0)).toBe(0);
    expect(tokenAt(TOKENS, 2)).toBe(1);
    expect(tokenAt(TOKENS, 8)).toBe(5);
    expect(tokenAt(TOKENS, 9)).toBeUndefined();
  });

  it('read() segments once and keeps the tokens for the same body', async () => {
    segment.mockResolvedValue({ text: BODY, script: 'simp', tokens: TOKENS });

    useReaderStore.getState().setText(BODY);
    await useReaderStore.getState().read();

    const state = useReaderStore.getState();
    expect(state.view).toBe('read');
    expect(state.tokens).toHaveLength(6);
    expect(state.tokenizedBody).toBe(BODY);
    expect(segment).toHaveBeenCalledTimes(1);

    // Coming back from another route must not re-post the paragraph.
    useReaderStore.getState().setView('compose');
    await useReaderStore.getState().read();
    expect(useReaderStore.getState().view).toBe('read');
    expect(segment).toHaveBeenCalledTimes(1);
  });

  it('a segmentation that lands after the body changed is dropped', async () => {
    segment.mockImplementation(async () => {
      // The learner keeps typing while the segmentation is out.
      useReaderStore.getState().setText('完全不同的句子。');
      return { text: BODY, script: 'simp', tokens: TOKENS };
    });

    useReaderStore.getState().setText(BODY);
    await useReaderStore.getState().read();

    const state = useReaderStore.getState();
    expect(state.tokens).toEqual([]);
    expect(state.view).toBe('compose');
    expect(state.loading).toBe(false);
  });

  it('a failed segmentation leaves the text alone and reports why', async () => {
    // What "the dictionary cannot answer" is since D6: a rejected promise from a
    // store that is absent, still importing, or evicted mid-session. The message
    // the learner reads is the store's, and it still has to reach the screen.
    segment.mockRejectedValue(new Error('the dictionary is not ready — run pnpm data'));

    useReaderStore.getState().setText(BODY);
    await useReaderStore.getState().read();

    const state = useReaderStore.getState();
    expect(state.body).toBe(BODY);
    expect(state.view).toBe('compose');
    expect(state.loading).toBe(false);
    expect(state.error).toContain('pnpm data');
  });

  it('read() does nothing for an empty body', async () => {
    useReaderStore.getState().setText('   ');
    await useReaderStore.getState().read();
    expect(segment).not.toHaveBeenCalled();
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
    segment.mockResolvedValue({ text: BODY, script: 'simp', tokens: TOKENS });

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
    store.selectToken(1);
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

describe('save', () => {
  it('reports the failure instead of letting the read swallow it', async () => {
    // "Save and read" runs both; `read()` clears `error` and unmounts the only
    // box that shows it, so a save that failed looked exactly like one that
    // worked until the refresh that lost the paragraph.
    saveText.mockRejectedValueOnce(new Error('QuotaExceededError'));
    useReaderStore.setState({ body: BODY, title: 'x' });

    expect(await useReaderStore.getState().save()).toBe(false);
    expect(useReaderStore.getState().error).toBe('QuotaExceededError');
    expect(useReaderStore.getState().textId).toBeUndefined();
  });

  it('reports success, and remembers the row', async () => {
    const row: TextRow = {
      id: 'text-1',
      title: 'x',
      body: BODY,
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
    };
    saveText.mockResolvedValueOnce(row);
    useReaderStore.setState({ body: BODY, title: 'x' });

    expect(await useReaderStore.getState().save()).toBe(true);
    expect(useReaderStore.getState().textId).toBe('text-1');
    expect(useReaderStore.getState().error).toBeUndefined();
  });
});
