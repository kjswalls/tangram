/**
 * `decomp.json` on the web (docs/plans/data.md D4).
 *
 * Three properties, and all three are things a passing UI would hide: the file
 * must not be fetched until something asks for a decomposition (0.92 MB is not
 * first-load budget), it must be fetched once however many characters ask, and a
 * failed fetch must not latch — an offline first tap must not mean no
 * decomposition for the rest of the session.
 *
 * The laziness has an end-to-end counterpart in `tests/e2e/d/dict-wasm.spec.ts`,
 * which asserts it against the real network log. This is the half that can be
 * driven into its failure modes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { JsonDecompStore } from '@/lib/dict/decomp-json';

const FILE = {
  打: { char: '打', decomposition: '⿰扌丁', components: ['扌', '丁'] },
  算: { char: '算', decomposition: '⿱⿱𥫗目廾', components: ['𥫗', '目', '廾'] },
};

function stub(body: unknown, ok = true) {
  const fetcher = vi.fn(
    async () => new Response(JSON.stringify(body), { status: ok ? 200 : 500 }),
  );
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('JsonDecompStore', () => {
  it('fetches nothing until a decomposition is asked for', () => {
    const fetcher = stub(FILE);
    const store = new JsonDecompStore();
    expect(store.fetched).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('fetches once however many calls arrive, and dedupes the characters', async () => {
    const fetcher = stub(FILE);
    const store = new JsonDecompStore();
    const [first, second] = await Promise.all([
      store.decompose('打算打'),
      store.decompose('算'),
    ]);
    expect(first.map((one) => one.char)).toEqual(['打', '算']);
    expect(second.map((one) => one.char)).toEqual(['算']);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(store.fetched).toBe(true);
  });

  it('answers null for a character the file does not have', async () => {
    stub(FILE);
    const store = new JsonDecompStore();
    expect(await store.decompose('龘')).toEqual([{ char: '龘', entry: null }]);
  });

  it('does not latch a failure — the next call tries again', async () => {
    const failing = stub({}, false);
    const store = new JsonDecompStore();
    await expect(store.decompose('打')).rejects.toThrow(/500/);
    expect(store.fetched).toBe(false);
    const fetcher = stub(FILE);
    expect((await store.decompose('打'))[0].entry).not.toBeNull();
    expect(failing).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

/**
 * The URLs honour the deploy's base (`vite build --base=/sub/`).
 *
 * `vite.config.ts` and `src/main.tsx` both treat a subpath deploy as a real,
 * supported invocation — the router already derives its `basename` from it — so
 * a hard-coded `/decomp.json` would reach outside the deploy and, under an SPA
 * fallback, come back as HTML with a 200.
 */
describe('asset URLs', () => {
  it('prefixes the deploy base', async () => {
    const { assetUrl } = await import('@/lib/dict/asset-url');
    expect(assetUrl('decomp.json')).toBe(`${import.meta.env.BASE_URL}decomp.json`);
    expect(assetUrl('decomp.json').startsWith(import.meta.env.BASE_URL)).toBe(true);
  });

  it('is what the stores actually use', async () => {
    const { DEFAULT_DECOMP_URL } = await import('@/lib/dict/decomp-json');
    const { DEFAULT_MANIFEST_URL } = await import('@/lib/dict/runners/wasm');
    const { assetUrl } = await import('@/lib/dict/asset-url');
    expect(DEFAULT_DECOMP_URL).toBe(assetUrl('decomp.json'));
    expect(DEFAULT_MANIFEST_URL).toBe(assetUrl('dict-manifest.json'));
  });
});
