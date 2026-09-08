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

/** Band 4: past any band assumption, so only a declaration makes it known. */
const FUJIN: Entry = {
  id: '附近|附近[fu4 jin4]',
  simp: '附近',
  trad: '附近',
  pinyinNum: 'fu4 jin4',
  pinyinMarked: 'fùjìn',
  glosses: ['nearby', 'neighboring'],
  classifiers: [],
  properNoun: false,
  isVariant: false,
  surname: false,
  hskBand: 4,
  freqRank: 975,
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
/** What `/api/dict/entries` still resolves. A rebuilt dictionary drops rows. */
let dictEntries: Entry[];
/** The last body the card back POSTed, so the known set it sends can be read. */
let posted: Record<string, unknown> | undefined;

function json(value: unknown): Response {
  return { ok: true, status: 200, json: async () => value } as Response;
}

beforeEach(() => {
  resetExamplesInfo();
  calls = { info: 0, post: 0, entries: 0 };
  body = answer(ONE_SENTENCE);
  dictEntries = [WO, KAISHI, FUJIN];
  posted = undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/dict/entries')) {
        calls.entries += 1;
        // Repeated `ids=` params, the way `fetchEntriesResponse` sends them.
        const ids = new Set(new URL(url, 'http://localhost').searchParams.getAll('ids'));
        return json({
          meta: { version: '2026-01-01' },
          entries: dictEntries.filter((entry) => ids.has(entry.id)),
        });
      }
      if (url === '/api/examples' && init?.method === 'POST') {
        calls.post += 1;
        posted = JSON.parse(String(init.body)) as Record<string, unknown>;
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

  it('sends the known set as ids and a band, not as characters', async () => {
    const repo = getRepository();
    await repo.markKnown([FUJIN.id]);
    render(<ExampleSentences entryId={KAISHI.id} />);
    await screen.findByTestId('examples-list');

    // Three shapes of one answer: the headwords the prompt reads, the exact
    // entries the filter is built from, and the band assumption with its
    // exceptions. Without the ids the route can only guess which 看 is meant.
    expect(posted?.known).toEqual([FUJIN.simp]);
    expect(posted?.knownIds).toEqual([FUJIN.id]);
    expect(posted?.knownBand).toBe(2);
    expect(posted?.excludeIds).toEqual([]);
  });

  it('re-checks a cached row against today’s known set and replaces a stale one', async () => {
    // The everyday case: a sentence is cached while 附近 is known, and then the
    // learner presses Add on 附近 — which un-marks it and gives it a New card
    // (`addCardTracked`). The cache key holds no known set, so nothing else
    // would notice; the word the learner is being taught would go on sitting in
    // a sentence headed "Sentences from words you know".
    const repo = getRepository();
    await repo.markKnown([FUJIN.id]);
    body = {
      ...answer([
        {
          tokens: [{ entryId: FUJIN.id }, { entryId: KAISHI.id }],
          en: 'It starts nearby.',
          register: '',
          unverified: false,
        },
      ]),
      entries: [FUJIN, KAISHI],
    };

    const view = render(<ExampleSentences entryId={KAISHI.id} />);
    await screen.findByTestId('examples-list');
    expect(screen.getAllByTestId('example-token')[0]).toHaveTextContent('附近');
    await waitFor(async () => {
      expect(await getDb().table('ask_cache').count()).toBe(1);
    });
    view.unmount();

    await repo.addCardFromEntry(FUJIN);
    await repo.unmarkKnown([FUJIN.id]);
    body = answer(ONE_SENTENCE);

    render(<ExampleSentences entryId={KAISHI.id} />);
    await screen.findByTestId('examples-list');
    // The stale row was not drawn, and it was not left in place either.
    await waitFor(() => expect(calls.post).toBe(2));
    expect(screen.queryByText('附近')).toBeNull();
    expect(screen.getAllByTestId('example-token')[0]).toHaveTextContent('我');
  });

  it('never draws a hole where a cited entry stopped resolving', async () => {
    // A CC-CEDICT rebuild retires a content-derived id. `renderPhrase` reports
    // the token `missing`, and the old block printed it as `?` with `—` under
    // it — a sentence with a hole, under a heading that promises the opposite.
    const view = render(<ExampleSentences entryId={KAISHI.id} />);
    await screen.findByTestId('examples-list');
    await waitFor(async () => {
      expect(await getDb().table('ask_cache').count()).toBe(1);
    });
    view.unmount();

    dictEntries = [KAISHI];
    body = answer([]);
    render(<ExampleSentences entryId={KAISHI.id} />);

    await screen.findByTestId('examples-empty');
    expect(screen.queryByTestId('examples-list')).toBeNull();
    expect(document.body.textContent).not.toContain('?');
    expect(calls.post).toBe(2);
  });

  it('writes the sentences in the script the learner reads the card in', async () => {
    render(<ExampleSentences entryId={KAISHI.id} script="trad" />);
    await screen.findByTestId('examples-list');

    const tokens = screen.getAllByTestId('example-token');
    expect(tokens[1]).toHaveTextContent(KAISHI.trad);
    expect(tokens[1]).not.toHaveTextContent(KAISHI.simp);
    // The reading is a property of the entry, not of the script.
    expect(tokens[1]).toHaveTextContent('kāishǐ');
  });

  it('flags a polyphone the way the ask panel does', async () => {
    body = answer([
      {
        tokens: [{ entryId: WO.id, polyphone: true }, { entryId: KAISHI.id }],
        en: 'I am starting.',
        register: '',
        unverified: false,
      },
    ]);
    render(<ExampleSentences entryId={KAISHI.id} />);
    await screen.findByTestId('examples-list');

    const tokens = screen.getAllByTestId('example-token');
    expect(tokens[0]).toHaveAttribute('data-polyphone', 'true');
    expect(tokens[0]).toHaveTextContent('polyphone');
    expect(tokens[1]).not.toHaveAttribute('data-polyphone');
  });

  it('renders nothing at all for a phrase card, which has no entry behind it', () => {
    const { container } = render(<ExampleSentences entryId={null} />);
    expect(container).toBeEmptyDOMElement();
    expect(getRepository()).toBeDefined();
  });
});
