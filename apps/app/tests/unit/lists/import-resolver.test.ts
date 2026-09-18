/**
 * `getImportResolver()` — the one line joining the importer to the real
 * dictionary (`lib/lists/import/resolver.ts`).
 *
 * Every other test in this feature injects a `Resolver`, which is deliberate:
 * it is what lets the parsers, the preview and the screen be tested without a
 * 43 MB file. The cost is that the wiring itself is covered by nothing but the
 * e2e spec, and the regression its own header warns about is invisible there —
 * both `getDictStore()` and `openDictStore()` produce a working importer on a
 * device that already has the dictionary. They differ only on a device that
 * does not, and the difference is a **14 MB download started by a button that
 * says "Preview"**.
 *
 * So this asserts the choice directly. It is the same rule `data.md` D6 and the
 * eager-open fix wrote for `lib/lists/entry-source.ts`: a surface that is not
 * behind `<DictGate>` has nowhere to draw a progress bar, so it opens what is
 * there and asks for nothing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const openDictStore = vi.fn();
const getDictStore = vi.fn(() => {
  throw new Error('getImportResolver must not reach for the app-wide store handle');
});
const getDictOpener = vi.fn(() => {
  throw new Error('getImportResolver must not reach for the opener — that downloads');
});

vi.mock('@/lib/dict/browser-store', () => ({ openDictStore, getDictStore, getDictOpener }));

afterEach(() => {
  vi.clearAllMocks();
});

describe('the browser’s resolver', () => {
  it('asks the store that is already open, and never the one that downloads', async () => {
    const resolve = vi.fn(async () => ({ dictVersion: 'v1', results: [] }));
    openDictStore.mockResolvedValue({ resolve });

    const { getImportResolver } = await import('@/lib/lists/import/resolver');
    const answer = await getImportResolver()(['你好', '了']);

    expect(openDictStore).toHaveBeenCalledTimes(1);
    // The two that would start a fetch. `getDictStore()` hands back the app's
    // store whose `open()` downloads; `getDictOpener().download()` is the
    // button on the card. Neither belongs behind "Preview".
    expect(getDictStore).not.toHaveBeenCalled();
    expect(getDictOpener).not.toHaveBeenCalled();

    expect(resolve).toHaveBeenCalledWith(['你好', '了']);
    expect(answer).toEqual({ dictVersion: 'v1', results: [] });
  });

  it('lets the store’s rejection through, so the screen can recognise it', async () => {
    // `openDictStore()` rejects with `DictUnavailableError` when there is no
    // dictionary on the device, and `import-list.tsx` recognises exactly that
    // to stay quiet. Swallowing it here would turn the page's one banner into
    // a preview that silently produced nothing.
    const cause = new Error('the dictionary is not on this device yet');
    openDictStore.mockRejectedValue(cause);

    const { getImportResolver } = await import('@/lib/lists/import/resolver');
    await expect(getImportResolver()(['你好'])).rejects.toBe(cause);
  });

  it('opens once per call rather than holding a store across calls', async () => {
    // `buildPreview` chunks a long paste, so this runs once per chunk.
    // `openDictStore()` is idempotent and memoised beneath us; caching a handle
    // here would be a second lifetime to keep in step with `close()`.
    const resolve = vi.fn(async () => ({ dictVersion: 'v1', results: [] }));
    openDictStore.mockResolvedValue({ resolve });

    const { getImportResolver } = await import('@/lib/lists/import/resolver');
    const resolver = getImportResolver();
    await resolver(['一']);
    await resolver(['二']);
    expect(openDictStore).toHaveBeenCalledTimes(2);
  });
});
