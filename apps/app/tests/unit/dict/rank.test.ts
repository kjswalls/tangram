/**
 * `lib/dict/rank.ts`'s pure helpers (docs/plans/data.md D6).
 *
 * `parseIdList` was tested in `tests/unit/dict/routes.test.ts`, because
 * the deleted `?ids=` entries route was the only thing that called it. D6 takes
 * that route and its suite; the function outlived both — `lib/dict/rank.ts` is
 * shared by the artifact builder and by `lib/dict/sqlite-store.ts`, and the
 * comma rule below is a property of CC-CEDICT's ids rather than of a query
 * string. So the cases move here rather than going with the route, which is
 * exactly what D6's disposition table asks for.
 */
import { describe, expect, it } from 'vitest';

import { parseIdList } from '@/lib/dict/rank';

const DASUAN = '打算|打算[da3 suan4]';
const GREEN = '綠|绿[lu:4]';

describe('parseIdList', () => {
  it('splits on commas outside the pinyin brackets only', () => {
    expect(parseIdList(`${DASUAN},${GREEN}`)).toEqual([DASUAN, GREEN]);
    // A proverb's pinyin contains a comma; splitting inside the brackets would
    // silently turn one id into two that match nothing.
    const proverb = '一不做，二不休|一不做，二不休[yi1 bu4 zuo4 , er4 bu4 xiu1]';
    expect(parseIdList(proverb)).toEqual([proverb]);
    expect(parseIdList(` ${DASUAN} , , `)).toEqual([DASUAN]);
  });
});
