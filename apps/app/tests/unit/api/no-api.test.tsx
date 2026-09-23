/**
 * "There is no API" as a first-class state — how it is derived, and what each
 * AI surface does with it.
 *
 * Two situations, told apart on purpose (`lib/api/availability.ts`):
 *
 *  1. **not configured** — a production build with `VITE_API_BASE` empty.
 *     Build-time, permanent, known before anything is asked. No retry.
 *  2. **unreachable** — a base is set and nothing answered. Transient, so the
 *     surfaces that can show a control show a retry.
 *
 * The derivation is pure and tested directly. The surfaces are rendered with
 * `configured={false}` rather than from a second build — the prop exists for
 * exactly this — and every "no request" claim is a count of `fetch` calls, not
 * a reading of the code. `tests/e2e/d/no-api.spec.ts` is the same claim against
 * real builds.
 */
import { fireEvent, render, screen, waitFor } from '../render';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AskPanel } from '@/components/lookup/ask-panel';
import {
  ASK_NOT_CONFIGURED_BODY,
  ASK_NOT_CONFIGURED_CHIP,
  ASK_UNREACHABLE_BODY,
} from '@/components/lookup/ask-state';
import {
  EXAMPLES_NOT_CONFIGURED,
  EXAMPLES_UNREACHABLE,
  ExampleSentences,
  resetExamplesInfo,
} from '@/components/review/example-sentences';
import { RECALL_NOT_CONFIGURED, RecallInput } from '@/components/review/recall-input';
import { ask, resetAskInfo, unavailableReason } from '@/lib/ai/ask-client';
import { apiProblemOf, configuredProblem, responseProblem } from '@/lib/api/availability';
import { isUnreachable } from '@/components/lookup/ask-panel';
import { closeDb, getDb, getRepository } from '@/lib/db/get-db';
import { resetDictStores, setDictStore } from '@/lib/dict/browser-store';
import {
  ApiNotConfiguredError,
  apiConfigured,
  initAccess,
  verdictOf,
} from '@/src/access/client';
import { context, DASUAN } from '../db/fixtures';
import { memoryStore } from '../ai/memory-store';

const SECRET = 'a-perfectly-good-key-1234';

/** Every `fetch` the code under test made, by URL. */
let fetched: string[];

function refuseEverything(): void {
  fetched = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      fetched.push(String(input));
      // What a browser's `fetch` rejects with for a port nothing listens on.
      throw new TypeError('Failed to fetch');
    }),
  );
}

beforeEach(() => {
  resetAskInfo();
  resetExamplesInfo();
  refuseEverything();
  setDictStore(memoryStore([DASUAN]));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
  await resetDictStores();
  await getDb().delete();
  await closeDb();
});

describe('whether a build has an API', () => {
  it('is "not configured" only for a production build with an empty base', () => {
    expect(apiConfigured({ PROD: true, VITE_API_BASE: '' })).toBe(false);
    expect(apiConfigured({ PROD: true })).toBe(false);
    // Whitespace is what a copied-and-pasted empty variable looks like.
    expect(apiConfigured({ PROD: true, VITE_API_BASE: '   ' })).toBe(false);
    expect(apiConfigured({ PROD: true, VITE_API_BASE: 'https://api.example' })).toBe(true);
    // Outside a production build an empty base is the test runner's, not a
    // deployment's, and the suite stubs `fetch` against relative paths.
    expect(apiConfigured({ PROD: false, VITE_API_BASE: '' })).toBe(true);
    expect(apiConfigured(undefined)).toBe(true);
  });

  it('names the build-time problem, and only that one, from the flag', () => {
    expect(configuredProblem(false)).toBe('not-configured');
    expect(configuredProblem(true)).toBeUndefined();
  });

  it('reads a failed request as unreachable only when nothing answered', () => {
    expect(apiProblemOf(new ApiNotConfiguredError())).toBe('not-configured');
    expect(apiProblemOf(new TypeError('Failed to fetch'))).toBe('unreachable');
    expect(apiProblemOf(new DOMException('timeout', 'TimeoutError'))).toBe('unreachable');
    // The learner moving on is not a problem to report.
    expect(apiProblemOf(new DOMException('aborted', 'AbortError'))).toBeUndefined();
    expect(apiProblemOf(new Error('a 502 with a reason'))).toBeUndefined();
    expect(apiProblemOf(undefined)).toBeUndefined();
  });

  it('reads a 404 or a proxy 5xx as unreachable, unless the API itself said so', () => {
    // A static host's page, a platform proxy's gateway error: not the API.
    expect(responseProblem(404, null)).toBe('unreachable');
    expect(responseProblem(502, '<html>Bad gateway</html>')).toBe('unreachable');
    expect(responseProblem(503, {})).toBe('unreachable');
    expect(responseProblem(504, null)).toBe('unreachable');
    // The API's own refusals carry its error shape and are server answers.
    expect(responseProblem(502, { error: 'provider-failed', hint: 'x' })).toBeUndefined();
    expect(responseProblem(503, { error: 'dict-data-missing' })).toBeUndefined();
    expect(responseProblem(500, null)).toBeUndefined();
    expect(responseProblem(429, null)).toBeUndefined();
    expect(responseProblem(401, null)).toBeUndefined();
  });

  it('gives a retry to the reasons that mean the API did not answer, and only those', () => {
    expect(isUnreachable('offline')).toBe(true);
    expect(isUnreachable('timeout')).toBe(true);
    expect(isUnreachable('unreachable')).toBe(true);
    for (const reason of ['server', 'rate-limited', 'no-key', 'not-configured'] as const) {
      expect(isUnreachable(reason), reason).toBe(false);
    }
  });

  it('refuses in `apiFetch` without touching the network when there is no base', async () => {
    vi.stubEnv('PROD', true);
    vi.stubEnv('VITE_API_BASE', '');
    vi.resetModules();
    const client = await import('@/src/access/client');
    expect(client.API_CONFIGURED).toBe(false);
    await expect(client.apiFetch('/api/ask')).rejects.toBeInstanceOf(client.ApiNotConfiguredError);
    expect(fetched).toEqual([]);
  });

  it('calls the network as before when a base is set', async () => {
    vi.stubEnv('PROD', true);
    vi.stubEnv('VITE_API_BASE', 'http://127.0.0.1:9/');
    vi.resetModules();
    const client = await import('@/src/access/client');
    expect(client.API_CONFIGURED).toBe(true);
    await expect(client.apiFetch('/api/ask')).rejects.toBeInstanceOf(TypeError);
    expect(fetched).toEqual(['http://127.0.0.1:9/api/ask']);
  });
});

describe('the key exchange, when there is no server to ask', () => {
  function location(href: string): Location {
    return { href } as Location;
  }

  it('does not ask, says `no-api`, and KEEPS the key', async () => {
    const replace = vi.spyOn(globalThis.history, 'replaceState');
    const check = vi.fn(() => Promise.resolve('granted' as const));
    await expect(
      initAccess(location(`https://app.example/?key=${SECRET}`), check, false),
    ).resolves.toBe('no-api');
    expect(check).not.toHaveBeenCalled();
    expect(globalThis.localStorage.getItem('tangram.access.secret')).toBe(SECRET);
    const last = replace.mock.calls.at(-1)?.[2];
    expect(String(last)).toBe('/?access=no-api');
    expect(String(last)).not.toContain(SECRET);
  });

  it('reads the probe status as a verdict about the key only when the API answered', () => {
    expect(verdictOf(200)).toBe('granted');
    expect(verdictOf(401)).toBe('denied');
    // Whatever answered is not the API, so the key was never looked at.
    expect(verdictOf(404)).toBe('unreachable');
    // An API that answered and could not say.
    expect(verdictOf(500)).toBe('unverified');
    expect(verdictOf(429)).toBe('unverified');
  });

  it('keeps the key when the server is unreachable, and says so rather than "unverified"', async () => {
    await expect(
      initAccess(location(`https://app.example/?key=${SECRET}`), () =>
        Promise.resolve('unreachable' as const),
      ),
    ).resolves.toBe('unreachable');
    expect(globalThis.localStorage.getItem('tangram.access.secret')).toBe(SECRET);
  });
});

describe('the ask module with no API', () => {
  it('answers not-configured without a request or a cache read', async () => {
    const fetchImpl = vi.fn();
    const repository = getRepository();
    const cacheRead = vi.spyOn(repository.askCache, 'get');
    const outcome = await ask(
      { query: '打算' },
      { configured: false, fetchImpl, repository },
    );
    expect(outcome).toMatchObject({ state: 'unavailable', reason: 'not-configured' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(cacheRead).not.toHaveBeenCalled();
  });

  it('reads a gateway error from something that is not the API as unreachable', async () => {
    const repository = getRepository();
    const status = (code: number, body: unknown) =>
      vi.fn(async () => ({ ok: false, status: code, json: async () => body }) as Response);
    await expect(
      ask({ query: '打算' }, { fetchImpl: status(503, null), repository }),
    ).resolves.toMatchObject({ state: 'unavailable', reason: 'unreachable' });
    resetAskInfo();
    // The API's own 502 is a provider failure, with its hint, and no retry.
    await expect(
      ask(
        { query: '打算' },
        { fetchImpl: status(502, { error: 'provider-failed', hint: 'The model failed.' }), repository },
      ),
    ).resolves.toMatchObject({ state: 'unavailable', reason: 'server', message: 'The model failed.' });
  });

  it('names apiFetch\'s refusal as not-configured, not as offline', () => {
    expect(unavailableReason(new ApiNotConfiguredError())).toBe('not-configured');
    expect(unavailableReason(new TypeError('Failed to fetch'))).toBe('offline');
  });
});

describe('the ask panel', () => {
  it('not configured: says so on first paint, with no spinner, no retry and no request', async () => {
    render(<AskPanel query="打算" configured={false} />);
    const panel = screen.getByTestId('ask-panel');
    expect(panel).toHaveAttribute('data-api', 'not-configured');
    expect(panel).toHaveAttribute('data-ask-state', 'unavailable');
    expect(screen.getByTestId('ask-not-configured-chip')).toHaveTextContent(ASK_NOT_CONFIGURED_CHIP);
    expect(screen.getByTestId('ask-status')).toHaveTextContent(ASK_NOT_CONFIGURED_BODY);
    expect(screen.queryByTestId('ask-retry')).toBeNull();
    expect(screen.queryByTestId('ask-offline-badge')).toBeNull();

    // Past the debounce: still nothing asked, still no "Thinking…".
    await new Promise((done) => setTimeout(done, 700));
    expect(screen.queryByText(/Thinking about/)).toBeNull();
    expect(fetched).toEqual([]);
  });

  it('unreachable: a distinct state with a retry that asks again', async () => {
    render(<AskPanel query="打算" />);
    const panel = screen.getByTestId('ask-panel');
    await waitFor(() => expect(panel).toHaveAttribute('data-api', 'unreachable'), {
      timeout: 5_000,
    });
    expect(screen.getByTestId('ask-status')).toHaveTextContent(ASK_UNREACHABLE_BODY);
    // A failed handshake is not a provider: no "set ANTHROPIC_API_KEY" badge
    // over a server that was simply down.
    expect(panel).toHaveAttribute('data-provider', 'unknown');
    expect(screen.queryByTestId('ask-offline-badge')).toBeNull();

    const before = fetched.length;
    fireEvent.click(screen.getByTestId('ask-retry'));
    await waitFor(() => expect(fetched.length).toBeGreaterThan(before), { timeout: 5_000 });
    await waitFor(() => expect(panel).toHaveAttribute('data-api', 'unreachable'), {
      timeout: 5_000,
    });
  });
});

describe('the example sentences on a card back', () => {
  it('not configured: one line, no loading line, no retry, no request', async () => {
    render(<ExampleSentences entryId={DASUAN.id} configured={false} />);
    const section = screen.getByTestId('example-sentences');
    expect(section).toHaveAttribute('data-api', 'not-configured');
    expect(screen.getByTestId('examples-status')).toHaveTextContent(EXAMPLES_NOT_CONFIGURED);
    expect(screen.queryByTestId('examples-retry')).toBeNull();
    await new Promise((done) => setTimeout(done, 100));
    expect(fetched).toEqual([]);
  });

  it('a malformed answer is the quiet line, not "could not reach" — a retry cannot fix it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        fetched.push(String(input));
        if (init?.method === 'POST') {
          // A 200 that is not the contract: grounding it throws a TypeError.
          return { ok: true, status: 200, json: async () => ({ provider: 'fake' }) } as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ provider: 'fake', promptVersion: 'v1' }),
        } as Response;
      }),
    );
    render(<ExampleSentences entryId={DASUAN.id} />);
    const section = screen.getByTestId('example-sentences');
    await waitFor(() => expect(section).toHaveAttribute('data-status', 'error'));
    expect(section).toHaveAttribute('data-api', 'ok');
    expect(screen.queryByTestId('examples-retry')).toBeNull();
    expect(screen.getByTestId('examples-status')).not.toHaveTextContent(EXAMPLES_UNREACHABLE);
  });

  it('a proxy 503 is unreachable, with a retry', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        fetched.push(String(input));
        return { ok: false, status: 503, json: async () => null } as unknown as Response;
      }),
    );
    render(<ExampleSentences entryId={DASUAN.id} />);
    const section = screen.getByTestId('example-sentences');
    await waitFor(() => expect(section).toHaveAttribute('data-api', 'unreachable'));
    expect(screen.getByTestId('examples-retry')).toBeInTheDocument();
  });

  it('unreachable: says the server did not answer, and retries on request', async () => {
    render(<ExampleSentences entryId={DASUAN.id} />);
    const section = screen.getByTestId('example-sentences');
    await waitFor(() => expect(section).toHaveAttribute('data-api', 'unreachable'));
    expect(screen.getByTestId('examples-status')).toHaveTextContent(EXAMPLES_UNREACHABLE);

    const before = fetched.length;
    fireEvent.click(screen.getByTestId('examples-retry'));
    await waitFor(() => expect(fetched.length).toBeGreaterThan(before));
    await waitFor(() => expect(section).toHaveAttribute('data-api', 'unreachable'));
  });
});

describe('free recall', () => {
  function submit(answer: string) {
    fireEvent.change(screen.getByTestId('recall-answer'), { target: { value: answer } });
    fireEvent.keyDown(screen.getByTestId('recall-answer'), { key: 'Enter' });
  }

  it('not configured: flips, asks nobody, and says why there is no suggestion', async () => {
    const card = await getRepository().addCardFromEntry(DASUAN, context({ source: 'lookup' }));
    const onReveal = vi.fn();
    render(<RecallInput card={card} revealed={false} onReveal={onReveal} configured={false} />);
    submit('to plan');
    expect(onReveal).toHaveBeenCalledTimes(1);
    const line = await screen.findByTestId('recall-no-suggestion');
    expect(line).toHaveAttribute('data-api', 'not-configured');
    expect(line).toHaveTextContent(RECALL_NOT_CONFIGURED);
    expect(fetched).toEqual([]);
  });

  it('unreachable: stays quiet mid-review — the same "this time" line, and no retry', async () => {
    const card = await getRepository().addCardFromEntry(DASUAN, context({ source: 'lookup' }));
    render(<RecallInput card={card} revealed={false} onReveal={() => {}} />);
    submit('to plan');
    const line = await screen.findByTestId('recall-no-suggestion');
    expect(line).toHaveAttribute('data-api', 'ok');
    expect(line).toHaveTextContent('No suggestion this time');
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
    expect(fetched.length).toBeGreaterThan(0);
  });

  it('an injected grader needs no API and is used either way', async () => {
    const card = await getRepository().addCardFromEntry(DASUAN, context({ source: 'lookup' }));
    const request = vi.fn(async () => ({ suggested: 3 as const, why: 'local' }));
    render(
      <RecallInput
        card={card}
        revealed={false}
        onReveal={() => {}}
        request={request}
        configured={false}
      />,
    );
    submit('打算');
    await screen.findByTestId('recall-suggestion');
    expect(request).toHaveBeenCalledTimes(1);
    expect(fetched).toEqual([]);
  });
});
