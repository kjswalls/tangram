/**
 * The demo paragraph (`lib/dev/seed.ts`), copied rather than imported.
 *
 * Playwright transpiles a spec without resolving the app's runtime graph, and
 * `lib/dev/seed.ts` pulls in the repository, the entry source and Dexie behind
 * it — none of which a spec has any business loading in Node. This file holds
 * no Playwright import either, so the unit suite can read it back:
 * `tests/unit/reader/paragraph.test.ts` asserts the copy still matches the
 * seed, and fails there rather than letting the reader specs quietly test
 * yesterday's text.
 */

export const DEMO_PARAGRAPH =
  '我每天早上七点起床，先喝一杯水，然后去公园跑步。跑完步回家吃早饭，一般是鸡蛋和面包。' +
  '八点半我骑自行车去上班，路上大概要二十分钟。中午我和同事一起在公司附近的饭馆吃饭，' +
  '下午继续工作。晚上下班以后，我喜欢在家做饭，有时候也会跟朋友出去看电影。' +
  '周末我常常打扫房间、洗衣服，然后去超市买东西。';

/** The sentence 继续 sits in, which is what a card mined from it must carry. */
export const JIXU_SENTENCE = '中午我和同事一起在公司附近的饭馆吃饭，下午继续工作。';
