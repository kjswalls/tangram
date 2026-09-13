/**
 * The per-list "also study production" flag (Phase 8, builder B).
 *
 * It is a stopgap store — `localStorage`, because `ListRow` is frozen — so what
 * matters most is that it cannot break the page it sits on. Every read is
 * total: a browser with storage blocked, a value another tab mangled, a quota
 * error on write. All of them mean "no lists are set", which is what a fresh
 * install says too.
 */
import { describe, expect, it } from 'vitest';

import {
  isProductionList,
  PRODUCTION_LISTS_KEY,
  readProductionLists,
  setProductionList,
} from '@/lib/srs/direction-prefs';

function memoryStore(initial?: string) {
  const map = new Map<string, string>();
  if (initial !== undefined) map.set(PRODUCTION_LISTS_KEY, initial);
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

describe('production list preferences', () => {
  it('remembers a list, and forgets it again', () => {
    const store = memoryStore();
    expect(readProductionLists(store).size).toBe(0);

    setProductionList('list-1', true, store);
    expect(isProductionList('list-1', store)).toBe(true);
    expect(isProductionList('list-2', store)).toBe(false);

    setProductionList('list-1', false, store);
    expect(isProductionList('list-1', store)).toBe(false);
  });

  it('keeps the other lists when one is turned off', () => {
    const store = memoryStore();
    setProductionList('a', true, store);
    setProductionList('b', true, store);
    setProductionList('a', false, store);
    expect([...readProductionLists(store)]).toEqual(['b']);
  });

  it('reads nothing out of a mangled value rather than throwing', () => {
    expect(readProductionLists(memoryStore('not json')).size).toBe(0);
    expect(readProductionLists(memoryStore('{"a":1}')).size).toBe(0);
    // A array with junk in it keeps the ids and drops the rest.
    expect([...readProductionLists(memoryStore('["a",1,null,"b",""]'))]).toEqual(['a', 'b']);
  });

  it('is a no-op when there is no storage at all', () => {
    expect(readProductionLists(null).size).toBe(0);
    expect(isProductionList('a', null)).toBe(false);
    expect([...setProductionList('a', true, null)]).toEqual(['a']);
  });

  it('survives a storage that refuses to write', () => {
    const store = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(() => setProductionList('a', true, store)).not.toThrow();
  });
});
