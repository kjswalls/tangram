/**
 * The gallery's reading passage (docs/plans/core.md C3).
 *
 * C3's acceptance criteria are about a **passage** — 200 characters wrapping at
 * 390px with no `<rt>` clipped, and a 500-character layout time to record — and
 * nothing in the app renders one outside the reader, which C5b owns. So the
 * gallery grows one, and the ruby criteria are asserted against a surface this
 * plan is allowed to touch.
 *
 * The runs are **generated, not hand-written**: `lib/dict/segment.ts` over
 * `tests/e2e/p5/paragraph.ts`'s demo paragraph. Hand-pairing 95 runs would have
 * quietly encoded a wrong reading somewhere, and a wrong reading is the failure
 * this whole phase exists to prevent. They are committed rather than segmented
 * at render time because the gallery must not pull the dictionary index into
 * its bundle.
 *
 * **A polyphone gets NO reading.** The first cut took `entryIds[0]`, which is
 * the most frequent entry and not the contextually cited one, and printed jì
 * over 骑 in 骑自行车, páo over 跑 in 跑完步, yāo over 要 and kān over 看 —
 * four silently wrong readings on the one surface the adversarial review looks
 * at first. Frequency is not context, and nothing here has context: the
 * segmenter hands back every reading of the matched headword and it is the
 * panel a learner taps that decides between them. So a token whose entries
 * disagree on the reading (case-insensitively, so a proper-noun capitalisation
 * is not mistaken for a second reading) is rendered plain, which is also a fair
 * demonstration of what the app does with a polyphone.
 *
 * `tests/unit/hanzi/passage.test.ts` re-derives them and fails if the
 * segmenter, the dictionary or the paragraph moves under this file.
 */
import type { HanziRun } from '@/components/hanzi/hanzi-text';

/** One pass of the demo paragraph: 95 runs, 142 characters, 69 with a reading. */
export const PASSAGE_RUNS: readonly HanziRun[] = [
  { text: '我', pinyinNum: 'wo3' },
  { text: '每天', pinyinNum: 'mei3 tian1' },
  { text: '早上', pinyinNum: 'zao3 shang5' },
  { text: '七', pinyinNum: 'qi1' },
  { text: '点', pinyinNum: 'dian3' },
  { text: '起床', pinyinNum: 'qi3 chuang2' },
  { text: '，' },
  { text: '先', pinyinNum: 'xian1' },
  { text: '喝' },
  { text: '一', pinyinNum: 'yi1' },
  { text: '杯', pinyinNum: 'bei1' },
  { text: '水', pinyinNum: 'shui3' },
  { text: '，' },
  { text: '然后', pinyinNum: 'ran2 hou4' },
  { text: '去', pinyinNum: 'qu4' },
  { text: '公园', pinyinNum: 'gong1 yuan2' },
  { text: '跑步', pinyinNum: 'pao3 bu4' },
  { text: '。' },
  { text: '跑' },
  { text: '完', pinyinNum: 'wan2' },
  { text: '步', pinyinNum: 'bu4' },
  { text: '回家', pinyinNum: 'hui2 jia1' },
  { text: '吃', pinyinNum: 'chi1' },
  { text: '早饭', pinyinNum: 'zao3 fan4' },
  { text: '，' },
  { text: '一般', pinyinNum: 'yi1 ban1' },
  { text: '是', pinyinNum: 'shi4' },
  { text: '鸡蛋', pinyinNum: 'ji1 dan4' },
  { text: '和' },
  { text: '面包', pinyinNum: 'mian4 bao1' },
  { text: '。' },
  { text: '八', pinyinNum: 'ba1' },
  { text: '点', pinyinNum: 'dian3' },
  { text: '半', pinyinNum: 'ban4' },
  { text: '我', pinyinNum: 'wo3' },
  { text: '骑' },
  { text: '自行车', pinyinNum: 'zi4 xing2 che1' },
  { text: '去', pinyinNum: 'qu4' },
  { text: '上班', pinyinNum: 'shang4 ban1' },
  { text: '，' },
  { text: '路上', pinyinNum: 'lu4 shang5' },
  { text: '大概', pinyinNum: 'da4 gai4' },
  { text: '要' },
  { text: '二十', pinyinNum: 'er4 shi2' },
  { text: '分钟', pinyinNum: 'fen1 zhong1' },
  { text: '。' },
  { text: '中午', pinyinNum: 'zhong1 wu3' },
  { text: '我', pinyinNum: 'wo3' },
  { text: '和' },
  { text: '同事', pinyinNum: 'tong2 shi4' },
  { text: '一起', pinyinNum: 'yi1 qi3' },
  { text: '在', pinyinNum: 'zai4' },
  { text: '公司', pinyinNum: 'gong1 si1' },
  { text: '附近', pinyinNum: 'fu4 jin4' },
  { text: '的' },
  { text: '饭馆', pinyinNum: 'fan4 guan3' },
  { text: '吃饭', pinyinNum: 'chi1 fan4' },
  { text: '，' },
  { text: '下午', pinyinNum: 'xia4 wu3' },
  { text: '继续', pinyinNum: 'ji4 xu4' },
  { text: '工作', pinyinNum: 'gong1 zuo4' },
  { text: '。' },
  { text: '晚上', pinyinNum: 'wan3 shang5' },
  { text: '下班', pinyinNum: 'xia4 ban1' },
  { text: '以后', pinyinNum: 'yi3 hou4' },
  { text: '，' },
  { text: '我', pinyinNum: 'wo3' },
  { text: '喜欢', pinyinNum: 'xi3 huan5' },
  { text: '在家', pinyinNum: 'zai4 jia1' },
  { text: '做饭', pinyinNum: 'zuo4 fan4' },
  { text: '，' },
  { text: '有时候', pinyinNum: 'you3 shi2 hou5' },
  { text: '也', pinyinNum: 'ye3' },
  { text: '会' },
  { text: '跟', pinyinNum: 'gen1' },
  { text: '朋友', pinyinNum: 'peng2 you5' },
  { text: '出去', pinyinNum: 'chu1 qu4' },
  { text: '看' },
  { text: '电影', pinyinNum: 'dian4 ying3' },
  { text: '。' },
  { text: '周末', pinyinNum: 'zhou1 mo4' },
  { text: '我', pinyinNum: 'wo3' },
  { text: '常常', pinyinNum: 'chang2 chang2' },
  { text: '打扫', pinyinNum: 'da3 sao3' },
  { text: '房间', pinyinNum: 'fang2 jian1' },
  { text: '、' },
  { text: '洗' },
  { text: '衣服', pinyinNum: 'yi1 fu5' },
  { text: '，' },
  { text: '然后', pinyinNum: 'ran2 hou4' },
  { text: '去', pinyinNum: 'qu4' },
  { text: '超市', pinyinNum: 'chao1 shi4' },
  { text: '买', pinyinNum: 'mai3' },
  { text: '东西' },
  { text: '。' }
];

/**
 * At least `minChars` characters, by repeating the paragraph. Repetition is
 * honest here — the criteria measure **wrapping and layout cost**, which do not
 * care whether the text says something new, and a hand-written 500-character
 * passage would be 500 characters of unverified readings.
 */
export function passageRuns(minChars: number): HanziRun[] {
  const out: HanziRun[] = [];
  let chars = 0;
  while (chars < minChars) {
    for (const run of PASSAGE_RUNS) {
      out.push(run);
      chars += run.text.length;
    }
  }
  return out;
}
