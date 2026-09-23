// @vitest-environment node
/**
 * `lib/ai/ask-client.ts` — the browser half of `backend.md` B2's contract flip,
 * and the file that now holds the grounding contract.
 *
 * **Where these assertions came from.** Most of this file is
 * `tests/unit/ai/route.test.ts` and `route-provider.test.ts`, moved rather than
 * written: before B2 the ask pipeline was one server route, so its retrieval,
 * its grounding and its empty-answer fallback were asserted against a handler.
 * They are asserted against this module now, because this module is where they
 * happen. The commit message names each one and where it went; the criterion
 * `backend.md` B2 sets is that **no assertion was dropped**.
 *
 * It runs in **node** against the real 124k-entry dictionary, through the same
 * `DictStore` the browser uses (`SqliteDictStore`). That is deliberate: the
 * grounding rules are claims about Chinese words, and a fixture dictionary is a
 * fixture that can agree with a bug.
 *
 * The two things that are faked are the two that are not the dictionary: the
 * transport (so no model is called and every failure mode is reachable) and the
 * repository (so the cache is a `Map` and Dexie stays out of a node suite).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ask,
  askInfo,
  citedIds,
  resetAskInfo,
  statusReason,
  unavailableReason,
  type ApiFetch,
} from '@/lib/ai/ask-client';
import {
  ASK_ANSWER_PATH,
  ASK_INFO_PATH,
  ASK_PROPOSE_PATH,
  RETRIEVED_CAP,
  type AskResponse,
  type RetrievedEntry,
} from '@tangram/ai/schemas';
import { ASK_PROMPT_VERSION, askCacheKey } from '@tangram/ai/cache-key';
import { closeServerDictStore, serverDictStore } from '@/lib/server/dict';
import type { AskCacheRow, SettingsRow } from '@/lib/db/schema';
import { DEFAULT_SETTINGS } from '@/lib/db/schema';
import type { Repository } from '@/lib/db/repository';
import type { DictStore } from '@/lib/dict/store';
import { requireDictData } from '../dict/data-required';
import { entryFor } from './helpers';

beforeAll(requireDictData);

let store: DictStore;
beforeAll(async () => {
  store = await serverDictStore();
});
afterAll(closeServerDictStore);

/**
 * A repository that is a `Map` and three constants.
 *
 * `ask()` reads exactly four members — `getSettings`, `allCards`,
 * `knownEntryIds` (through `getLearnerProfile`) and `askCache` — so everything
 * else is a getter that throws. A module that started reaching for a fifth
 * would say so rather than quietly get `undefined`.
 */
interface FakeRepo {
  repo: Repository;
  cache: Map<string, unknown>;
  writes: number;
}

function fakeRepository(): FakeRepo {
  const cache = new Map<string, unknown>();
  const state = { writes: 0 };
  const settings: SettingsRow = {
    ...DEFAULT_SETTINGS,
    createdAt: 0,
    updatedAt: 0,
  } as SettingsRow;
  const repo = {
    getSettings: async () => settings,
    allCards: async () => [],
    knownEntryIds: async () => [],
    askCache: {
      get: async (key: string) => {
        const response = cache.get(key);
        return response === undefined
          ? undefined
          : ({ id: key, response, createdAt: 0 } as AskCacheRow);
      },
      set: async (key: string, response: unknown) => {
        state.writes += 1;
        cache.set(key, response);
        return { id: key, response, createdAt: 0 } as AskCacheRow;
      },
    },
  } as unknown as Repository;
  return {
    repo,
    cache,
    get writes() {
      return state.writes;
    },
  };
}

interface Transport {
  fetchImpl: ApiFetch;
  calls: { info: number; propose: number; answer: number };
  posted: { propose?: Record<string, unknown>; answer?: Record<string, unknown> };
}

interface TransportOptions {
  candidates?: string[];
  answer?: (retrieved: RetrievedEntry[]) => AskResponse;
  /** Override the whole reply for one path. */
  reply?: (path: string) => Response | Promise<Response> | undefined;
  provider?: 'fake' | 'anthropic';
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A transport with no model behind it: every route answers from the options. */
function transport(options: TransportOptions = {}): Transport {
  const calls = { info: 0, propose: 0, answer: 0 };
  const posted: Transport['posted'] = {};
  const provider = options.provider ?? 'fake';
  const fetchImpl: ApiFetch = async (path, init) => {
    const override = options.reply?.(path);
    if (override) return override;
    if (path === ASK_INFO_PATH) {
      calls.info += 1;
      return json({ provider, promptVersion: ASK_PROMPT_VERSION });
    }
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (path === ASK_PROPOSE_PATH) {
      calls.propose += 1;
      posted.propose = body;
      return json({
        provider,
        promptVersion: ASK_PROMPT_VERSION,
        candidates: options.candidates ?? [],
      });
    }
    if (path === ASK_ANSWER_PATH) {
      calls.answer += 1;
      posted.answer = body;
      const retrieved = body.retrieved as RetrievedEntry[];
      return json({
        provider,
        promptVersion: ASK_PROMPT_VERSION,
        response: options.answer?.(retrieved) ?? {
          interpretation: 'an answer',
          matches: retrieved[0]
            ? [{ entryId: retrieved[0].id, senseIndex: 0, whyThisOne: 'the first hit' }]
            : [],
          sayIt: [],
          notes: [],
        },
      });
    }
    throw new Error(`unexpected request to ${path}`);
  };
  return { fetchImpl, calls, posted };
}

beforeEach(() => {
  resetAskInfo();
});

afterEach(() => {
  resetAskInfo();
});

// ---------------------------------------------------------------------------
// The two round trips — new in B2, because retrieval moved to this side
// ---------------------------------------------------------------------------

describe('the two round trips', () => {
  it('skips propose for a headword the dictionary already answers', async () => {
    // `needsProposals` moved into `packages/ai/retrieve.ts` with the rest of
    // retrieval; this is the assertion that it is actually consulted, which is
    // the difference between one round trip and two on every hanzi lookup.
    const net = transport();
    const { repo } = fakeRepository();
    const outcome = await ask({ query: '打算' }, { store, repository: repo, fetchImpl: net.fetchImpl });
    expect(outcome.state).toBe('answered');
    expect(net.calls.propose).toBe(0);
    expect(net.calls.answer).toBe(1);
  });

  it('asks for proposals for an English question, and retrieves what comes back', async () => {
    const net = transport({ candidates: ['随便'] });
    const { repo } = fakeRepository();
    const outcome = await ask(
      { query: "how do I say I'm just browsing" },
      { store, repository: repo, fetchImpl: net.fetchImpl },
    );
    expect(outcome.state).toBe('answered');
    expect(net.calls.propose).toBe(1);
    // The proposed phrase was segmented against this device's dictionary and
    // its entries joined the retrieved set — the union that used to happen
    // inside the route (`tests/unit/ai/route.test.ts`, the demo query).
    const retrieved = (net.posted.answer?.retrieved ?? []) as RetrievedEntry[];
    expect(retrieved.some((entry) => entry.id === entryFor('随便').id)).toBe(true);
  });

  it('answers from the dictionary search alone when propose fails', async () => {
    // Moved from `route-provider.test.ts`: "gives up on proposePhrases and
    // answers from the dictionary search alone". The route used to swallow the
    // failure inside one request; the split has to keep doing it across two.
    const net = transport({
      candidates: ['随便'],
      reply: (path) => (path === ASK_PROPOSE_PATH ? json({ error: 'provider-failed' }, 502) : undefined),
    });
    const { repo } = fakeRepository();
    const outcome = await ask(
      { query: 'how do I ask for the bill' },
      { store, repository: repo, fetchImpl: net.fetchImpl },
    );
    expect(outcome.state).toBe('answered');
    expect(net.calls.answer).toBe(1);
    expect(((net.posted.answer?.retrieved ?? []) as RetrievedEntry[]).length).toBeGreaterThan(0);
  });
});

  it('drops proposals answered by a different provider than the answer will be', async () => {
    // **An adversarial reviewer's finding.** The answer's handshake is checked
    // before the cache write; the proposals — which shaped the retrieved set the
    // answer is built from — were not checked at all. Two replicas behind one
    // origin, one with a key and one without, is enough to mix them.
    const net = transport({ candidates: ['随便'] });
    const mixed: ApiFetch = async (path, init) => {
      const res = await net.fetchImpl(path, init);
      if (path !== ASK_PROPOSE_PATH) return res;
      const body = (await res.json()) as Record<string, unknown>;
      return json({ ...body, provider: 'anthropic' });
    };
    const { repo } = fakeRepository();
    await ask(
      { query: "how do I say I'm just browsing" },
      { store, repository: repo, fetchImpl: mixed },
    );
    const retrieved = (net.posted.answer?.retrieved ?? []) as RetrievedEntry[];
    // The dictionary search still stands; what is gone is the phrase the other
    // configuration proposed.
    expect(retrieved.length).toBeGreaterThan(0);
    expect(retrieved.some((entry) => entry.id === entryFor('随便').id)).toBe(false);
  });

  it('does not issue the answer call once the caller has given up', async () => {
    // Also a reviewer's. The panel aborts with a `TimeoutError`, which is not an
    // `AbortError`, so `propose` used to swallow it as "no candidates" and the
    // answer call went out on an already-aborted signal — a paid model call
    // after the deadline, for any transport that ignores `signal`.
    const controller = new AbortController();
    let answerCalls = 0;
    const impl: ApiFetch = async (path) => {
      if (path === ASK_INFO_PATH) return json({ provider: 'fake', promptVersion: ASK_PROMPT_VERSION });
      if (path === ASK_PROPOSE_PATH) {
        controller.abort(new DOMException('timeout', 'TimeoutError'));
        throw new DOMException('timeout', 'TimeoutError');
      }
      answerCalls += 1;
      return json({ provider: 'fake', promptVersion: ASK_PROMPT_VERSION, response: {} });
    };
    const { repo } = fakeRepository();
    const outcome = await ask(
      { query: 'how do I ask for the bill' },
      { store, repository: repo, fetchImpl: impl, signal: controller.signal },
    );
    expect(answerCalls).toBe(0);
    if (outcome.state !== 'unavailable') throw new Error('expected unavailable');
    expect(outcome.reason).toBe('timeout');
  });

  it('calls a malformed 200 a server problem, not an offline one', async () => {
    // A reviewer's third: the client validated cache rows and not the wire, so a
    // 200 whose `whyThisOne` is a number threw a `TypeError` inside `scrubProse`
    // and `unavailableReason` painted C7's "Dictionary only — offline" chip over
    // a server that had answered. A captive portal or a stale proxy is the
    // realistic source.
    const net = transport({
      reply: (path) =>
        path === ASK_ANSWER_PATH
          ? json({
              provider: 'fake',
              promptVersion: ASK_PROMPT_VERSION,
              response: {
                interpretation: 'fine',
                matches: [{ entryId: 'a|a[a]', senseIndex: 0, whyThisOne: 42 }],
                sayIt: [],
                notes: [],
              },
            })
          : undefined,
    });
    const { repo, cache } = fakeRepository();
    const outcome = await ask({ query: '打算' }, { store, repository: repo, fetchImpl: net.fetchImpl });
    if (outcome.state !== 'unavailable') throw new Error('expected unavailable');
    expect(outcome.reason).toBe('server');
    expect(cache.size).toBe(0);
  });

/**
 * **`offline` is a claim about the network, so only the network may make it.**
 * The catch in `ask()` used to hand every error to `unavailableReason`, whose
 * `TypeError` → `offline` rule is right about what `fetch` rejects with and
 * wrong about a `TypeError` from this app's own code — which then reached the
 * learner as "Dictionary only — offline" with a retry that could never work.
 */
describe('what the caught failure is called', () => {
  /**
   * The same store, with one method throwing — from the moment `when()` says
   * so, so a case can put the throw *after* a response has arrived.
   */
  function breaking(
    method: 'entries' | 'search',
    error: Error,
    when: () => boolean = () => true,
  ): DictStore {
    // A proxy that binds every method to the real store, which keeps its
    // private fields — `Object.create(store)` would not, and would fail on its
    // own `TypeError` before the case under test was reached.
    const real = store;
    return new Proxy(real, {
      get(target, key) {
        const value = Reflect.get(target, key, target) as unknown;
        if (typeof value !== 'function') return value;
        const bound = (value as (...args: unknown[]) => unknown).bind(target);
        if (key !== method) return bound;
        return (...args: unknown[]) => (when() ? Promise.reject(error) : bound(...args));
      },
    });
  }

  it('calls a TypeError from our own code a server problem, not offline', async () => {
    const net = transport();
    const { repo } = fakeRepository();
    const bug = new TypeError("Cannot read properties of undefined (reading 'map')");
    const outcome = await ask(
      { query: '打算' },
      {
        // Throws only once the answer is in: a response arrived, then our code failed.
        store: breaking('entries', bug, () => net.calls.answer > 0),
        repository: repo,
        fetchImpl: net.fetchImpl,
      },
    );
    if (outcome.state !== 'unavailable') throw new Error('expected unavailable');
    expect(outcome.reason).toBe('server');
    // It really got past the network: the answer was fetched, then our code threw.
    expect(net.calls.answer).toBe(1);
  });

  it('does not borrow the browser\'s offline flag for an error the network did not raise', async () => {
    // This file runs in Node, whose `navigator` has no `onLine` at all; a
    // browser's reads `false` here while the device has no connection.
    vi.stubGlobal('navigator', { onLine: false });
    try {
      const net = transport();
      const { repo } = fakeRepository();
      const outcome = await ask(
        { query: '打算' },
        { store: breaking('search', new TypeError('a bug')), repository: repo, fetchImpl: net.fetchImpl },
      );
      if (outcome.state !== 'unavailable') throw new Error('expected unavailable');
      expect(outcome.reason).toBe('server');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('still calls a fetch that never reached a server offline', async () => {
    const net = transport({
      reply: (path) =>
        path === ASK_ANSWER_PATH ? Promise.reject(new TypeError('Failed to fetch')) : undefined,
    });
    const { repo } = fakeRepository();
    const outcome = await ask({ query: '打算' }, { store, repository: repo, fetchImpl: net.fetchImpl });
    if (outcome.state !== 'unavailable') throw new Error('expected unavailable');
    expect(outcome.reason).toBe('offline');
  });

  it('calls a body the connection dropped offline, and a body that is not JSON a server problem', async () => {
    const dropped = {
      ok: true,
      status: 200,
      json: () => Promise.reject(new TypeError('network error')),
    } as unknown as Response;
    const garbled = new Response('<html>captive portal</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
    for (const [reply, reason] of [
      [dropped, 'offline'],
      [garbled, 'server'],
    ] as const) {
      const net = transport({ reply: (path) => (path === ASK_ANSWER_PATH ? reply : undefined) });
      const { repo } = fakeRepository();
      const outcome = await ask({ query: '打算' }, { store, repository: repo, fetchImpl: net.fetchImpl });
      if (outcome.state !== 'unavailable') throw new Error('expected unavailable');
      expect(outcome.reason).toBe(reason);
    }
  });
});

// ---------------------------------------------------------------------------
// What goes on the wire
// ---------------------------------------------------------------------------

describe('the payload', () => {
  it('sends the six fields of RetrievedEntry and no more', async () => {
    // `toRetrieved` is what makes the projection true at runtime: `Entry` is
    // *assignable* to `RetrievedEntry`, which is a compile-time fact that
    // `JSON.stringify` does not honour.
    const net = transport();
    const { repo } = fakeRepository();
    await ask({ query: '打算' }, { store, repository: repo, fetchImpl: net.fetchImpl });
    const retrieved = (net.posted.answer?.retrieved ?? []) as Record<string, unknown>[];
    expect(retrieved.length).toBeGreaterThan(0);
    for (const entry of retrieved) {
      expect(Object.keys(entry).sort()).toEqual(
        expect.arrayContaining(['glosses', 'id', 'pinyinMarked', 'simp', 'trad']),
      );
      for (const dropped of ['pinyinNum', 'classifiers', 'properNoun', 'freqRank', 'freq', 'pos']) {
        expect(entry).not.toHaveProperty(dropped);
      }
    }
  });

  it('keeps hskBand, because the prompt renders it', async () => {
    // `backend.md` B2: dropping it "would silently change every prompt
    // containing a banded entry — a model-behaviour change smuggled in as a
    // transport decision". 打算 is HSK 3.
    const net = transport();
    const { repo } = fakeRepository();
    await ask({ query: '打算' }, { store, repository: repo, fetchImpl: net.fetchImpl });
    const retrieved = (net.posted.answer?.retrieved ?? []) as RetrievedEntry[];
    const dasuan = retrieved.find((entry) => entry.id === entryFor('打算').id);
    expect(dasuan?.hskBand).toBe(entryFor('打算').hskBand);
  });

  it('never sends more than the cap the edge enforces', async () => {
    const net = transport();
    const { repo } = fakeRepository();
    // A one-character query with many readings and many compounds.
    await ask({ query: '看' }, { store, repository: repo, fetchImpl: net.fetchImpl });
    const retrieved = (net.posted.answer?.retrieved ?? []) as RetrievedEntry[];
    expect(retrieved.length).toBeLessThanOrEqual(RETRIEVED_CAP);
  });
});

// ---------------------------------------------------------------------------
// Grounding — moved here with the dictionary
// ---------------------------------------------------------------------------

describe('grounding, which is now this side of the wire', () => {
  it('drops a citation the client never retrieved', async () => {
    // The single most important case in this file. The server returns
    // `response` schema-validated and NOT grounded, so an id the model invented
    // arrives intact and is dropped here, against the set this module built.
    const net = transport({
      answer: () => ({
        interpretation: 'a plausible sentence',
        matches: [{ entryId: 'bogus|bogus[bo1 gus4]', senseIndex: 0, whyThisOne: 'invented' }],
        sayIt: [],
        notes: [],
      }),
    });
    const { repo } = fakeRepository();
    const outcome = await ask({ query: '打算' }, { store, repository: repo, fetchImpl: net.fetchImpl });
    expect(outcome.state).toBe('answered');
    if (outcome.state !== 'answered') return;
    expect(outcome.response.matches).toEqual([]);
    expect(citedIds(outcome.response)).toEqual([]);
  });

  it('drops a sense index past the end of the cited entry', async () => {
    const dasuan = entryFor('打算');
    const net = transport({
      answer: () => ({
        interpretation: 'a plausible sentence',
        matches: [{ entryId: dasuan.id, senseIndex: 999, whyThisOne: 'out of range' }],
        sayIt: [],
        notes: [],
      }),
    });
    const { repo } = fakeRepository();
    const outcome = await ask({ query: '打算' }, { store, repository: repo, fetchImpl: net.fetchImpl });
    if (outcome.state !== 'answered') throw new Error('expected an answer');
    expect(outcome.response.matches).toEqual([]);
  });

  it('strips CJK the model wrote into prose', async () => {
    // Moved from `route.test.ts`: "body.response.interpretation does not match
    // CJK". The model is not allowed to write a headword anywhere the
    // dictionary did not.
    const dasuan = entryFor('打算');
    const net = transport({
      answer: () => ({
        interpretation: 'The everyday verb 打算 for planning.',
        matches: [{ entryId: dasuan.id, senseIndex: 0, whyThisOne: 'the 计划 sense' }],
        sayIt: [],
        notes: [],
      }),
    });
    const { repo } = fakeRepository();
    const outcome = await ask({ query: '打算' }, { store, repository: repo, fetchImpl: net.fetchImpl });
    if (outcome.state !== 'answered') throw new Error('expected an answer');
    expect(outcome.response.interpretation).not.toMatch(/[一-鿿]/);
    expect(outcome.response.matches[0]?.whyThisOne).not.toMatch(/[一-鿿]/);
  });

  it('returns the cited entries, so hanzi and pinyin are rendered from rows', async () => {
    // Moved from `route.test.ts`: "every entry needed to draw the answer travels
    // with it" and "body.dictVersion is truthy". The rows come off this device
    // now rather than out of a response body, which is the flip in one line.
    const dasuan = entryFor('打算');
    const net = transport({
      answer: () => ({
        interpretation: 'the verb',
        matches: [{ entryId: dasuan.id, senseIndex: 0, whyThisOne: 'the verb sense' }],
        sayIt: [],
        notes: [],
      }),
    });
    const { repo } = fakeRepository();
    const outcome = await ask({ query: '打算' }, { store, repository: repo, fetchImpl: net.fetchImpl });
    if (outcome.state !== 'answered') throw new Error('expected an answer');
    expect(outcome.entries.map((entry) => entry.id)).toEqual([dasuan.id]);
    expect(outcome.entries[0]?.pinyinMarked).toBe(dasuan.pinyinMarked);
    expect(outcome.dictVersion).toMatch(/\d/);
  });

  it('answers a hanzi query differently depending on the sentence it came from', async () => {
    // Moved from `route.test.ts`. The context reaches the prompt and the cache
    // key alike, so the two asks are two questions.
    const net = transport();
    const { repo } = fakeRepository();
    await ask(
      { query: '看', context: { sentence: '我看了一下', source: 'ask', addedAt: 0 } },
      { store, repository: repo, fetchImpl: net.fetchImpl },
    );
    const first = net.posted.answer?.context;
    await ask(
      { query: '看', context: { sentence: '你看着孩子', source: 'ask', addedAt: 0 } },
      { store, repository: repo, fetchImpl: net.fetchImpl },
    );
    expect(net.posted.answer?.context).not.toEqual(first);
    // Two distinct cache keys: a different context is a different question.
    expect(net.calls.answer).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// The fallback, and the cache rule that travels with it
// ---------------------------------------------------------------------------

describe('an answer that grounds to nothing', () => {
  const nothing = (): AskResponse => ({
    // The commonest thing a live model does wrong: write the Chinese into the
    // prose and cite an id it was never given.
    interpretation: '我随便看看',
    matches: [{ entryId: 'bogus', senseIndex: 0, whyThisOne: '随便' }],
    sayIt: [{ tokens: [{ entryId: 'bogus' }], en: '看看', register: '口語' }],
    notes: ['看看'],
  });

  it('falls back to the dictionary rather than rendering an empty panel', async () => {
    // Moved from `route-provider.test.ts`. §3.4's "no query ever renders an
    // empty panel" is a promise about what is on screen, and the screen is here.
    const net = transport({ answer: nothing, provider: 'anthropic' });
    const { repo, cache } = fakeRepository();
    const outcome = await ask({ query: '随便' }, { store, repository: repo, fetchImpl: net.fetchImpl });
    if (outcome.state !== 'answered') throw new Error('expected an answer');
    expect(outcome.response.interpretation.length).toBeGreaterThan(0);
    expect(outcome.response.matches.length).toBeGreaterThan(0);
    expect(outcome.fallback).toBe(true);
    // …and it must not be remembered: the next ask should reach the provider.
    // This is `cacheable: false` after the flip — the server cannot compute it
    // any more, so the rule lives here.
    expect(cache.size).toBe(0);
  });

  it('says so even for the empty-but-valid answer', async () => {
    const net = transport({
      answer: () => ({ interpretation: '', matches: [], sayIt: [], notes: [] }),
      provider: 'anthropic',
    });
    const { repo, cache } = fakeRepository();
    const outcome = await ask({ query: '打算' }, { store, repository: repo, fetchImpl: net.fetchImpl });
    if (outcome.state !== 'answered') throw new Error('expected an answer');
    expect(outcome.response.interpretation.length).toBeGreaterThan(0);
    expect(outcome.fallback).toBe(true);
    expect(cache.size).toBe(0);
  });

  it('caches a real answer, and serves the repeat from the cache', async () => {
    // Moved from `route-provider.test.ts` ("keeps a real answer cacheable") and
    // extended: the cache *read* was the ask panel's before B2 and is this
    // module's now, so the round trip is asserted end to end.
    const dasuan = entryFor('打算');
    const net = transport({
      provider: 'anthropic',
      answer: () => ({
        interpretation: 'The everyday verb for planning to do something.',
        matches: [{ entryId: dasuan.id, senseIndex: 0, whyThisOne: 'the verb sense' }],
        sayIt: [],
        notes: [],
      }),
    });
    const { repo, cache } = fakeRepository();
    const first = await ask({ query: '打算' }, { store, repository: repo, fetchImpl: net.fetchImpl });
    if (first.state !== 'answered') throw new Error('expected an answer');
    expect(first.fallback).toBe(false);
    expect(first.cached).toBe(false);
    expect(cache.size).toBe(1);

    const again = await ask({ query: '打算' }, { store, repository: repo, fetchImpl: net.fetchImpl });
    if (again.state !== 'answered') throw new Error('expected an answer');
    expect(again.cached).toBe(true);
    expect(net.calls.answer).toBe(1);
    // The row holds ids and indexes; the text was resolved from the dictionary.
    expect(again.entries.map((entry) => entry.id)).toEqual([dasuan.id]);
    expect(again.entries[0]?.pinyinMarked).toBe(dasuan.pinyinMarked);
  });

  it('resolves a warm row written by the OLD shape, unchanged by the flip', async () => {
    /**
     * **`backend.md` B2's last acceptance criterion**, and it is a promise about
     * rows that already exist rather than about a shape this phase designed.
     *
     * The cached value is `GroundedAskResponse` and the flip did not touch it —
     * the server used to ground and write it through the panel, and the client
     * grounds and writes it now, but it is the same four fields of ids and
     * indexes. The row below is copied from `lib/dev/seed.ts`'s two pre-warmed
     * ones, flags and all: **no `unverified` on the phrase, no `aiGenerated` on
     * the tokens**, because neither existed when that shape was written. If
     * `groundedAskResponseSchema` had stopped defaulting them, a demo learner's
     * warm rows would parse to nothing and every ask would go back to the
     * provider with no sign that anything was wrong.
     */
    const oldShape = {
      interpretation:
        'In a shop, the natural reply to an assistant is that you are only looking.',
      matches: [
        {
          entryId: '隨便|随便[sui2 bian4]',
          senseIndex: 0,
          whyThisOne: 'Carries the "no particular aim" sense the English sentence is doing.',
        },
      ],
      sayIt: [
        {
          tokens: [
            { entryId: '我|我[wo3]' },
            { entryId: '隨便|随便[sui2 bian4]' },
            { entryId: '看看|看看[kan4 kan5]' },
          ],
          en: 'I am just looking, thanks.',
          register: 'neutral, spoken',
        },
      ],
      notes: ['Doubling the verb is what makes it casual rather than curt.'],
    };

    const query = "how do I say I'm just browsing";
    const net = transport();
    const { repo, cache } = fakeRepository();
    // Written under the key the client itself derives, through the same
    // function the seed uses — a row keyed by a copy of the formula would prove
    // nothing about whether an ask ever looks for it.
    const key = await askCacheKey({
      query,
      estimatedBand: 1,
      provider: 'fake',
      promptVersion: ASK_PROMPT_VERSION,
    });
    cache.set(key, oldShape);

    const outcome = await ask({ query }, { store, repository: repo, fetchImpl: net.fetchImpl });
    if (outcome.state !== 'answered') throw new Error('expected an answer');
    expect(outcome.cached).toBe(true);
    // Nothing reached the provider: a warm row written before the flip still
    // spares the round trip.
    expect(net.calls.answer).toBe(0);
    expect(net.calls.propose).toBe(0);

    // And it renders: the ids resolve against today's dictionary, and the
    // defaults the schema supplies make the phrase drawable.
    expect(outcome.response.matches[0]?.entryId).toBe('隨便|随便[sui2 bian4]');
    expect(outcome.response.sayIt[0]?.unverified).toBe(false);
    expect(outcome.entries.map((entry) => entry.id)).toContain('看看|看看[kan4 kan5]');
    const kankan = outcome.entries.find((entry) => entry.id === '看看|看看[kan4 kan5]');
    expect(kankan?.pinyinMarked).toBeTruthy();
  });

  it('never writes a row against a guessed handshake', async () => {
    // A failed `GET /api/ask` falls back to `{fake, v1}`, which would key every
    // later row under the wrong provider. The identity check is what stops it.
    const net = transport({
      provider: 'anthropic',
      reply: (path) => (path === ASK_INFO_PATH ? json({ error: 'nope' }, 500) : undefined),
    });
    const { repo, cache } = fakeRepository();
    const outcome = await ask({ query: '打算' }, { store, repository: repo, fetchImpl: net.fetchImpl });
    expect(outcome.state).toBe('answered');
    expect(cache.size).toBe(0);
  });

  it('does not write the cache when the caller says not to', async () => {
    // `useContextGloss` (core.md C4) reads the cache and never writes it.
    const dasuan = entryFor('打算');
    const net = transport({
      provider: 'anthropic',
      answer: () => ({
        interpretation: 'the verb',
        matches: [{ entryId: dasuan.id, senseIndex: 0, whyThisOne: 'the verb sense' }],
        sayIt: [],
        notes: [],
      }),
    });
    const { repo, cache } = fakeRepository();
    await ask(
      { query: '打算' },
      { store, repository: repo, fetchImpl: net.fetchImpl, cache: false },
    );
    expect(cache.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Failure is a state, not an exception
// ---------------------------------------------------------------------------

describe('when the API cannot be reached', () => {
  it('reports unavailable rather than throwing', async () => {
    const { repo } = fakeRepository();
    const outcome = await ask(
      { query: '打算' },
      {
        store,
        repository: repo,
        fetchImpl: async () => {
          throw new TypeError('Failed to fetch');
        },
      },
    );
    expect(outcome.state).toBe('unavailable');
    if (outcome.state !== 'unavailable') return;
    expect(outcome.reason).toBe('offline');
  });

  it('carries the server’s own hint for a 502, because the panel shows it', async () => {
    const net = transport({
      reply: (path) =>
        path === ASK_ANSWER_PATH
          ? json({ error: 'provider-failed', hint: 'the model is overloaded' }, 502)
          : undefined,
    });
    const { repo } = fakeRepository();
    const outcome = await ask({ query: '打算' }, { store, repository: repo, fetchImpl: net.fetchImpl });
    if (outcome.state !== 'unavailable') throw new Error('expected unavailable');
    expect(outcome.message).toBe('the model is overloaded');
    expect(outcome.reason).toBe('server');
  });

  it('names the reason a 401 and a 429 give', () => {
    expect(statusReason(401)).toBe('no-key');
    expect(statusReason(429)).toBe('rate-limited');
    expect(unavailableReason(new DOMException('timeout', 'TimeoutError'))).toBe('timeout');
  });

  it('rethrows the caller’s own abort, because a new keystroke is not a state', async () => {
    const { repo } = fakeRepository();
    const controller = new AbortController();
    controller.abort();
    await expect(
      ask(
        { query: '打算' },
        {
          store,
          repository: repo,
          signal: controller.signal,
          fetchImpl: async () => {
            throw new DOMException('aborted', 'AbortError');
          },
        },
      ),
    ).rejects.toThrow(DOMException);
  });

  it('does not memoise a failed handshake', async () => {
    let failing = true;
    const impl: ApiFetch = async (path) => {
      if (path !== ASK_INFO_PATH) throw new Error('unexpected');
      if (failing) return json({ error: 'nope' }, 500);
      return json({ provider: 'anthropic', promptVersion: ASK_PROMPT_VERSION });
    };
    expect((await askInfo(impl)).provider).toBe('fake');
    failing = false;
    expect((await askInfo(impl)).provider).toBe('anthropic');
  });
});

describe('a query with nothing in it', () => {
  it('asks nobody', async () => {
    const net = transport();
    const { repo } = fakeRepository();
    const outcome = await ask({ query: '   ' }, { store, repository: repo, fetchImpl: net.fetchImpl });
    expect(outcome.state).toBe('unavailable');
    expect(net.calls.answer).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The panel is never empty — the property, over several shapes of query
// ---------------------------------------------------------------------------

describe('no query ever renders an empty panel', () => {
  it('holds for hanzi, pinyin, nonsense and an English question', async () => {
    // Moved verbatim in intent from `route.test.ts`. The offline provider used
    // to run inside the route; here the transport plays the same part by
    // returning what the fake returns — an answer that grounds to nothing —
    // so the fallback is what has to fill the panel.
    for (const query of ['dasuan', 'zzzqqq', 'how do I ask for the bill', '开始']) {
      const net = transport({
        answer: () => ({ interpretation: '', matches: [], sayIt: [], notes: [] }),
      });
      const { repo } = fakeRepository();
      const outcome = await ask({ query }, { store, repository: repo, fetchImpl: net.fetchImpl });
      if (outcome.state !== 'answered') throw new Error(`${query} was unavailable`);
      expect(outcome.response.interpretation.length, query).toBeGreaterThan(0);
      const something =
        outcome.response.matches.length > 0 ||
        outcome.response.sayIt.length > 0 ||
        outcome.response.notes.length > 0;
      expect(something, query).toBe(true);
    }
  });
});
