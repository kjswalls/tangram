/**
 * The sentences on the back of a card (PLAN.md §4, Phase 6 item 1) — the client
 * half: what is drawn, and when the network is spared.
 *
 * The cache cases are the ones that matter. A card back is opened again and
 * again, so a repeat must cost nothing; and the key carries the sense, because
 * a sentence for "to begin" is not a sentence for the other gloss. Both are
 * asserted by counting `POST`s, not by reading the key — a key that is right
 * for the wrong reason still has to spare the request.
 *
 * **What `backend.md` B2's contract flip changed here.** The route returned
 * grounded, filtered sentences plus the rows to draw them; it now returns the
 * model's own tokens, ungrounded and unfiltered, and this component grounds and
 * filters them against the dictionary on this device. So the fixture body below
 * is `{ provider, promptVersion, sentences }` and the i+1 promise is asserted
 * from this side — which is where `examples-route.test.ts`'s three
 * "a provider that breaks the rules" cases went.
 */
import { render, screen, waitFor } from '../render';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExamplesResponse, RawExampleSentence } from '@tangram/ai/schemas';
import { ExampleSentences, resetExamplesInfo } from '@/components/review/example-sentences';
import { closeDb, getDb, getRepository } from '@/lib/db/get-db';
import { resetDictStores, setDictStore } from '@/lib/dict/browser-store';
import type { Entry } from '@/lib/types';
import { memoryStore, type MemoryStore } from './memory-store';

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

/**
 * The body after the flip: the model's tokens, **ungrounded and unfiltered**.
 * No `entries`, no `dictVersion`, no `cacheable` — the client has the rows and
 * is the only party that can decide any of the three.
 */
function answer(sentences: RawExampleSentence[]): ExamplesResponse {
  return { provider: 'fake', promptVersion: 'v1', sentences };
}

const ONE_SENTENCE: RawExampleSentence[] = [
  { tokens: [{ entryId: WO.id }, { entryId: KAISHI.id }], en: 'I am starting.' },
];

interface Calls {
  info: number;
  post: number;
  entries: number;
}

let calls: Calls;
let body: ExamplesResponse;
/** What the dictionary still resolves. A rebuilt dictionary drops rows. */
let dictEntries: Entry[];
let store: MemoryStore;
/** The last body the card back POSTed, so the known set it sends can be read. */
let posted: Record<string, unknown> | undefined;

function json(value: unknown): Response {
  return { ok: true, status: 200, json: async () => value } as Response;
}

beforeEach(async () => {
  resetExamplesInfo();
  calls = { info: 0, post: 0, entries: 0 };
  body = answer(ONE_SENTENCE);
  dictEntries = [WO, KAISHI, FUJIN];
  posted = undefined;
  // The card back resolves cited ids through `getDictStore()`. Before
  // `data.md` D6 that was a `fetch` of the entries route and this file stubbed
  // it; the browser's store is `sqlite-wasm` on OPFS now, so a jsdom test
  // installs a stand-in instead. Same rows, same counting.
  store = memoryStore(dictEntries, { onEntries: () => { calls.entries += 1; } });
  setDictStore(store);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
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
  // **`backend.md` B2 makes the known set part of every fixture.** Before the
  // flip the route filtered, so a test could return a sentence citing 我 and
  // draw it whether or not this learner knew 我. The filter runs here now, so a
  // learner who knows nothing gets the empty line — correctly — and a fixture
  // that wants a sentence on screen has to say who the learner is.
  await getRepository().markKnown([WO.id]);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await resetDictStores();
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
    // The cache key carries `estimatedBand`, which is derived from
    // `settings.knownBand` — so the band is part of this fixture, not a
    // default to inherit. core.md C8 moved the default to 0.
    await getRepository().setSettings({ knownBand: 2 });
    const view = render(<ExampleSentences entryId={KAISHI.id} />);
    await screen.findByTestId('examples-list');
    expect(calls.post).toBe(1);
    await waitFor(async () => {
      expect(await getDb().table('ask_cache').count()).toBe(1);
    });

    view.unmount();
    // Counted from here: the first render retrieves a support pool and grounds
    // an answer, which are several dictionary reads. What this case is about is
    // the second one.
    const before = calls.entries;
    render(<ExampleSentences entryId={KAISHI.id} />);
    const section = await screen.findByTestId('examples-list');
    expect(section).toBeInTheDocument();

    // No second ask, and the words came back from the dictionary store: the row
    // holds ids, so the dictionary text is resolved rather than stored. One
    // read, for the ids the row cites.
    expect(calls.post).toBe(1);
    expect(calls.entries - before).toBe(1);
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

  it('sends the target row and the support pool, resolved on this device', async () => {
    // `backend.md` B2: the known set no longer crosses the wire as three shapes
    // for the server to expand. It is expanded HERE — ids and bands into
    // dictionary rows, frequency-ordered and cut to SUPPORT_CAP — and what the
    // prompt gets is the rows. The band assumption is under test, stated rather
    // than inherited.
    const repo = getRepository();
    await repo.setSettings({ knownBand: 2 });
    await repo.markKnown([FUJIN.id]);
    render(<ExampleSentences entryId={KAISHI.id} />);
    await screen.findByTestId('examples-list');

    const entry = posted?.entry as Record<string, unknown>;
    expect(entry.id).toBe(KAISHI.id);
    // Six fields, and `hskBand` is one of them: `entryLine` renders it, so a
    // five-field projection would silently change the prompt.
    expect(Object.keys(entry).sort()).toEqual([
      'glosses',
      'hskBand',
      'id',
      'pinyinMarked',
      'simp',
      'trad',
    ]);
    expect(entry).not.toHaveProperty('pinyinNum');

    const support = posted?.support as { id: string }[];
    // 附近 is declared known by id; 我 is band 1 and reached through the band
    // assumption. The target itself is never in its own support pool.
    expect(support.map((row) => row.id)).toContain(FUJIN.id);
    expect(support.map((row) => row.id)).toContain(WO.id);
    expect(support.map((row) => row.id)).not.toContain(KAISHI.id);
    // Nothing that used to travel does any more.
    expect(posted).not.toHaveProperty('known');
    expect(posted).not.toHaveProperty('knownIds');
    expect(posted).not.toHaveProperty('entryId');
  });

  it('drops a sentence citing a word the learner does not know', async () => {
    // Moved from `examples-route.test.ts`, where the route ran the filter. The
    // server now returns this sentence intact; the promise on the card back —
    // *every word in this sentence is one you already know* — is kept here.
    const repo = getRepository();
    await repo.markKnown([WO.id]);
    body = answer([
      { tokens: [{ entryId: FUJIN.id }, { entryId: KAISHI.id }], en: 'It starts nearby.' },
    ]);

    render(<ExampleSentences entryId={KAISHI.id} />);
    await screen.findByTestId('examples-empty');
    expect(screen.queryByTestId('examples-list')).toBeNull();
    // …and an empty answer is never written into the cache, because the known
    // set it reflects is the one thing about this learner that will change.
    expect(await getDb().table('ask_cache').count()).toBe(0);
  });

  it('drops a sentence carrying characters the model wrote itself', async () => {
    // Also moved from `examples-route.test.ts`. A `{text}` token has no
    // dictionary row behind it, so its reading is unknowable — and the sentence
    // is dropped whole rather than trimmed.
    const repo = getRepository();
    await repo.markKnown([WO.id]);
    body = answer([
      {
        tokens: [{ entryId: WO.id }, { text: '绝绝子' }, { entryId: KAISHI.id }],
        en: 'Made up.',
      },
      { tokens: [{ entryId: WO.id }, { entryId: KAISHI.id }], en: 'A real one.' },
    ]);

    render(<ExampleSentences entryId={KAISHI.id} />);
    await screen.findByTestId('examples-list');
    expect(screen.getAllByTestId('example-sentence')).toHaveLength(1);
    expect(screen.getByTestId('example-en')).toHaveTextContent('A real one.');
    expect(document.body.textContent).not.toContain('绝绝子');
  });

  it('says so quietly when this device has no dictionary to ground with', async () => {
    // **A consequence of `backend.md` B2's contract flip, and a real one.**
    // Before it the route retrieved, grounded, filtered and returned the rows,
    // so this block worked on a device that had never downloaded the
    // dictionary. Every one of those is this component's now and each needs the
    // dictionary — there is no way to render a cited id as hanzi without the row
    // behind it. So a device with no dictionary gets the quiet failure line, and
    // **not** the "not enough known words yet" empty state, whose stated reason
    // would be false. The four grade buttons were live the whole time.
    await resetDictStores();
    render(<ExampleSentences entryId={KAISHI.id} />);
    await waitFor(() =>
      expect(screen.getByTestId('examples-status')).toHaveTextContent('No example sentences'),
    );
    expect(screen.queryByTestId('examples-list')).toBeNull();
    expect(screen.queryByTestId('examples-empty')).toBeNull();
  });

  it('drops a sentence citing an entry nobody offered', async () => {
    // The strongest form of the rule: an id the client never put in `support`
    // cannot be rendered at all, because `ground()` drops the citation and the
    // phrase with it. This is `PLAN.md` §3.4 on the card back.
    const repo = getRepository();
    await repo.markKnown([WO.id]);
    body = answer([
      { tokens: [{ entryId: 'never|never[n1]' }, { entryId: KAISHI.id }], en: 'Invented.' },
    ]);

    render(<ExampleSentences entryId={KAISHI.id} />);
    await screen.findByTestId('examples-empty');
    expect(screen.queryByTestId('examples-list')).toBeNull();
  });

  it('re-checks a cached row against today’s known set and replaces a stale one', async () => {
    // The everyday case: a sentence is cached while 附近 is known, and then the
    // learner presses Add on 附近 — which un-marks it and gives it a New card
    // (`addCardTracked`). The cache key holds no known set, so nothing else
    // would notice; the word the learner is being taught would go on sitting in
    // a sentence headed "Sentences from words you know".
    const repo = getRepository();
    await repo.markKnown([FUJIN.id]);
    body = answer([
      { tokens: [{ entryId: FUJIN.id }, { entryId: KAISHI.id }], en: 'It starts nearby.' },
    ]);

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

    store.setEntries([KAISHI]);
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
    // The flag is `ground()`'s, not the model's: a token is a polyphone when the
    // dictionary has more than one reading of its simplified headword. The
    // second 我 row below is what makes `readingCount('我')` answer 2.
    const repo = getRepository();
    await repo.markKnown([WO.id]);
    store.setEntries([...dictEntries, { ...WO, id: '我|我[wo2]', pinyinNum: 'wo2', pinyinMarked: 'wó' }]);
    body = answer(ONE_SENTENCE);
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
