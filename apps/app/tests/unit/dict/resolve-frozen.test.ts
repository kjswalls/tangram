// @vitest-environment node
/**
 * `DictStore.resolve` is declared and not implemented — `wave-zero.md` §8b.
 *
 * The list importer was written once already (`main`'s `abe6793`, 1,654 lines)
 * against the in-heap JSON index that `data.md` D1–D4 replaced with SQLite. The
 * *rule* it documents survives the port; the implementation does not, and
 * `resolve` is the seam the port needs. The declaration lands alone, first, so
 * the porting phase and anything that wants to call it start from the same
 * signature — the pattern `CLAUDE.md` calls "frozen by a types-only first
 * commit", the same one wave 0 §5 used for `Repository`.
 *
 * This file is why the stub cannot quietly pass for the feature. There is no CI
 * (`CLAUDE.md`), so the freeze is held by a test or it is held by nobody.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { nodeRunner } from '@/lib/dict/runners/node';
import { SqliteDictStore } from '@/lib/dict/sqlite-store';
import { RESOLVE_MAX_WORDS, RESOLVE_MAX_WORD_CHARS } from '@/lib/dict/resolve';
import { dictArtifactPath, requireDictData } from './data-required';

requireDictData();

let store: SqliteDictStore;

beforeAll(async () => {
  store = new SqliteDictStore({ connect: async () => nodeRunner(dictArtifactPath()) });
  await store.open();
});

afterAll(async () => {
  await store.close?.();
});

describe('DictStore.resolve, declared and not implemented', () => {
  /**
   * It must **reject**, not resolve empty.
   *
   * A stub returning `{ dictVersion, results: [] }` type-checks, passes any test
   * that only asserts a shape, and ships an importer that finds nothing in every
   * paste — which reads on screen as a broken dictionary rather than as missing
   * code. The five unimplemented `Repository` members throw for the same reason
   * and are guarded the same way (`tests/unit/db/repository.test.ts`).
   */
  it('rejects rather than answering with an empty result', async () => {
    await expect(store.resolve(['打算'])).rejects.toThrow(/not implemented/i);
  });

  it('rejects for an empty request too, so no caller can read a pass out of it', async () => {
    await expect(store.resolve([])).rejects.toThrow(/wave-zero/i);
  });

  /**
   * The caps are part of the declaration, not of the implementation: the
   * importer chunks a Pleco export to fit `RESOLVE_MAX_WORDS`, so a port that
   * picks its own number silently changes how a large paste is batched.
   */
  /**
   * And they are not in `store.ts`. That module is types-only and
   * `store-contract.test.ts` asserts it emits nothing at runtime — two
   * `export const`s put there broke it, which is how these ended up in their
   * own module rather than beside the declaration they belong to.
   */
  it('carries the caps the porting phase has to honour', () => {
    expect(RESOLVE_MAX_WORDS).toBe(1000);
    expect(RESOLVE_MAX_WORD_CHARS).toBe(200);
  });
});
