/**
 * The sentences on the back of a card (PLAN.md §4, Phase 6 item 1) — the client
 * half: what is drawn, and when the network is spared.
 *
 * The cache cases are the ones that matter. A card back is opened again and
 * again, so a repeat must cost nothing; and the key carries the sense, because
 * a sentence for "to begin" is not a sentence for the other gloss. Both are
 * asserted by counting `POST`s, not by reading the key — a key that is right
 * for the wrong reason still has to spare the request.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExamplesRouteResponse } from '@/app/api/examples/route';
import { ExampleSentences, resetExamplesInfo } from '@/components/review/example-sentences';
import { closeDb, getDb, getRepository } from '@/lib/db/get-db';
import type { Entry } from '@/lib/types';

const WO: Entry = {
  id: '我|我[wo3]',
  simp: '我',
  trad: '我',
  pinyinNum: 'wo3',
  pinyinMarked: 'wǒ',
  glosses: ['I', 'me'],
  classifiers: [],
  properNoun: false,
  isVariant: false,
  surname: false,
  hskBand: 1,
  freqRank: 4,
};

const KAISHI: Entry = {
  id: '開始|开始[kai1 shi3]',
  simp: '开始',
  trad: '開始',
  pinyinNum: 'kai1 shi3',
  pinyinMarked: 'kāishǐ',
  glosses: ['to begin', 'to start'],
  classifiers: [],
  properNoun: false,
  isVariant: false,
  surname: false,
  hskBand: 2,
  freqRank: 300,
};

function answer(sentences: ExamplesRouteResponse['sentences']): ExamplesRouteResponse {
  return {
    provider: 'fake',
    promptVersion: 'v1',
    entryId: KAISHI.id,
    dictVersion: '2026-01-01',
    sentences,
    entries: [WO, KAISHI],
    support: 1,
    cacheable: sentences.length > 0,
  };
}

const ONE_SENTENCE: ExamplesRouteResponse['sentences'] = [
  {
    tokens: [{ entryId: WO.id }, { entryId: KAISHI.id }],
    en: 'I am starting.',
    register: '',
    unverified: false,
  },
];

interface Calls {
  info: number;
  post: number;
  entries: number;
}

let calls: Calls;
let body: ExamplesRouteResponse;

function json(value: unknown): Response {
  return { ok: true, status: 200, json: async () => value } as Response;
}

beforeEach(() => {
  resetExamplesInfo();
  calls = { info: 0, post: 0, entries: 0 };
  body = answer(ONE_SENTENCE);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/dict/entries')) {
        calls.entries += 1;
        return json({ meta: { version: '2026-01-01' }, entries: [WO, KAISHI] });
      }
      if (url === '/api/examples' && init?.method === 'POST') {
        calls.post += 1;
        return json(body);
      }
      if (url === '/api/examples') {
        calls.info += 1;
        return json({ provider: 'fake', promptVersion: 'v1' });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await getDb().delete();
  await closeDb();
});

describe('the example sentences on a card back', () => {
  it('draws the hanzi and the reading of every cited entry, and says it is offline', async () => {
    render(<ExampleSentences entryId={KAISHI.id} />);

    expect(screen.getByTestId('examples-status')).toBeInTheDocument();
    await screen.findByTestId('examples-list');

    const tokens = screen.getAllByTestId('example-token');
    expect(tokens).toHaveLength(2);
    // Rendered from the entries the route returned — never from the model.
    expect(tokens[0]).toHaveTextContent('我');
    expect(tokens[0]).toHaveTextContent('wǒ');
    expect(tokens[1]).toHaveTextContent('开始');
    expect(tokens[1]).toHaveTextContent('kāishǐ');
    expect(screen.getByTestId('example-en')).toHaveTextContent('I am starting.');
    expect(screen.getByTestId('examples-offline')).toBeInTheDocument();
    expect(calls.post).toBe(1);
  });

  it('serves a repeat from the cache, and re-resolves the text from the dictionary', async () => {
    const view = render(<ExampleSentences entryId={KAISHI.id} />);
    await screen.findByTestId('examples-list');
    expect(calls.post).toBe(1);
    await waitFor(async () => {
      expect(await getDb().table('ask_cache').count()).toBe(1);
    });

    view.unmount();
    render(<ExampleSentences entryId={KAISHI.id} />);
    const section = await screen.findByTestId('examples-list');
    expect(section).toBeInTheDocument();

    // No second ask, and the words came back from `/api/dict/entries`: the row
    // holds ids, so the dictionary text is fetched rather than stored.
    expect(calls.post).toBe(1);
    expect(calls.entries).toBe(1);
    expect(screen.getAllByTestId('example-token')[1]).toHaveTextContent('开始');
    expect(screen.getByTestId('example-sentences')).toHaveAttribute('data-cached', 'true');
  });

  it('asks again when the card is about a different sense', async () => {
    const view = render(<ExampleSentences entryId={KAISHI.id} senseIndex={0} />);
    await screen.findByTestId('examples-list');
    expect(calls.post).toBe(1);

    view.unmount();
    render(<ExampleSentences entryId={KAISHI.id} senseIndex={1} />);
    await waitFor(() => expect(calls.post).toBe(2));
  });

  it('says so quietly when nothing survived the filter, and does not cache it', async () => {
    body = answer([]);
    render(<ExampleSentences entryId={KAISHI.id} />);

    await screen.findByTestId('examples-empty');
    expect(screen.queryByTestId('examples-list')).toBeNull();
    expect(await getDb().table('ask_cache').count()).toBe(0);
  });

  it('keeps a provider failure to one quiet line', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === '/api/examples' && init?.method === 'POST') {
          return {
            ok: false,
            status: 502,
            json: async () => ({ error: 'provider-failed', hint: 'nope' }),
          } as Response;
        }
        return json({ provider: 'fake', promptVersion: 'v1' });
      }),
    );

    render(<ExampleSentences entryId={KAISHI.id} />);
    await waitFor(() =>
      expect(screen.getByTestId('examples-status')).toHaveTextContent('No example sentences'),
    );
    expect(screen.queryByTestId('examples-list')).toBeNull();
  });

  it('renders nothing at all for a phrase card, which has no entry behind it', () => {
    const { container } = render(<ExampleSentences entryId={null} />);
    expect(container).toBeEmptyDOMElement();
    expect(getRepository()).toBeDefined();
  });
});
