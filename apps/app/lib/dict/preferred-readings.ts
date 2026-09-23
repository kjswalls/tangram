/**
 * **The readings the app shows first, chosen by hand.**
 *
 * A headword with more than one reading shows its first one everywhere: the
 * reader's ruby, the character sheet, the "Add" button and the order of
 * readings in every list. `compareEntries` (`rank.ts`) picks that reading from
 * the data: jieba frequency, then variant and proper noun, then the HSK band,
 * then the id alphabetically. That is right for most words. For the ones below
 * the data cannot tell the readings apart, or HSK lists the rarer one, so the
 * app would teach the wrong reading. 奇 would be jī, 么 would be má.
 *
 * Every id here is put first among its headword's readings, before the HSK band
 * is consulted. That is all this list does. It changes no entry's content and
 * hides no reading. The other readings are still shown, just after this one.
 *
 * **To change it**
 *
 * - An id is `traditional|simplified[pinyin with tone numbers]`, exactly as
 *   CC-CEDICT writes it: `殼|壳[ke2]`, `麼|么[me5]`. Neutral tone is 5.
 *   If you get it wrong, the test below fails and lists the headword's real ids.
 * - Give one reason: the everyday word that makes this reading the one to learn
 *   first.
 * - Only add a reading every standard learner's dictionary gives first. If
 *   both readings are core (得 dé and de, 倒 dǎo and dào), leave the headword
 *   alone. HANDOFF.md lists the ones left out on purpose.
 * - Then run `pnpm data --force` (the order is baked into the dictionary file)
 *   and `pnpm test`. `tests/unit/dict/preferred-readings.test.ts` fails if an id
 *   does not exist, if two ids share a headword, or if an entry no longer changes
 *   anything.
 *
 * `data/ATTRIBUTION.md` says that this editorial choice exists. The list only
 * reorders CC-CEDICT's readings; it never changes their text.
 *
 * This file must stay free of imports. It runs in the build script, in Node, in
 * a browser worker and on the phone.
 */

export interface PreferredReading {
  /** The CC-CEDICT id of the reading to show first. */
  id: string;
  /** The everyday use that makes it the default. */
  reason: string;
}

export const PREFERRED_READINGS: readonly PreferredReading[] = [
  // HSK lists the rarer reading, so the band put it first.
  { id: '說道|说道[shuo1 dao4]', reason: 'shuōdào "said", as in 他说道 in any story; shuōdao "to discuss" is rarer' },
  { id: '殼|壳[ke2]', reason: 'ké, as in 鸡蛋壳 and 贝壳; qiào is bookish (地壳)' },
  { id: '勒|勒[le4]', reason: 'lè, as in 勒索, 勒令 and 希特勒; lēi is colloquial "to tie tight"' },
  { id: '唉|唉[ai1]', reason: 'āi, the ordinary sigh, as in 唉声叹气' },
  { id: '奔|奔[ben1]', reason: 'bēn, as in 奔跑 and 奔驰; bèn "to head for" is rarer' },
  { id: '釘|钉[ding1]', reason: 'dīng, as in 钉子 "nail"; dìng is the verb "to nail"' },
  { id: '哇|哇[wa1]', reason: 'wā, "wow!"; the particle wa only replaces 啊 after -u or -ao' },
  { id: '露|露[lu4]', reason: 'lù, as in 露水, 暴露 and 露天; lòu is colloquial (露面)' },

  // Neither reading has an HSK band, so the id decided alphabetically.
  { id: '麼|么[me5]', reason: 'me, as in 什么, 怎么 and 这么' },
  { id: '奇|奇[qi2]', reason: 'qí, as in 奇怪; jī only means "odd number" (奇数)' },
  { id: '似|似[si4]', reason: 'sì, as in 似乎 and 相似; shì only in 似的' },
  { id: '伯|伯[bo2]', reason: 'bó, as in 伯伯 and 伯父' },
  { id: '殷|殷[yin1]', reason: 'yīn, as in 殷勤' },
  { id: '屏|屏[ping2]', reason: 'píng, as in 屏幕 "screen"' },
  { id: '咖|咖[ka1]', reason: 'kā, as in 咖啡; gā only in 咖喱' },
  { id: '石|石[shi2]', reason: 'shí, as in 石头; dàn is an old measure of grain' },
  { id: '體|体[ti3]', reason: 'tǐ, as in 身体; tī only in 体己' },
  { id: '居|居[ju1]', reason: 'jū, as in 居住 and 邻居' },
  { id: '葉|叶[ye4]', reason: 'yè, as in 叶子 "leaf"' },
  { id: '華|华[hua2]', reason: 'huá, as in 中华 and 华丽' },
  { id: '漸|渐[jian4]', reason: 'jiàn, as in 渐渐 "gradually"' },
  { id: '遂|遂[sui4]', reason: 'suì, as in 未遂 and 遂心; suí only in 半身不遂' },
  { id: '聖|圣[sheng4]', reason: 'shèng, as in 圣诞节' },
  { id: '骨|骨[gu3]', reason: 'gǔ, as in 骨头; gū only in 骨碌 and 骨朵' },
  { id: '嶺|岭[ling3]', reason: 'lǐng, as in 山岭 "mountain ridge"' },
  { id: '校|校[xiao4]', reason: 'xiào, as in 学校; jiào is "to proofread" (校对)' },
  { id: '陸|陆[lu4]', reason: 'lù, as in 大陆 and 陆地; liù is 六 written on cheques' },
  { id: '濟|济[ji4]', reason: 'jì, as in 经济 and 救济' },
  { id: '頸|颈[jing3]', reason: 'jǐng, "neck", as in 颈部; gěng only in 脖颈' },
  { id: '摩|摩[mo2]', reason: 'mó, as in 摩擦 and 按摩; mā only in 摩挲' },
  { id: '禁|禁[jin4]', reason: 'jìn, as in 禁止; jīn "to endure" (禁不住) is rarer' },
  { id: '隆|隆[long2]', reason: 'lóng, as in 隆重' },
  { id: '囊|囊[nang2]', reason: 'náng, as in 胶囊 and 行囊' },
  { id: '舌|舌[she2]', reason: 'shé, as in 舌头 "tongue"' },
  { id: '姆|姆[mu3]', reason: 'mǔ, as in 保姆' },
  { id: '秘|秘[mi4]', reason: 'mì, as in 秘密; bì only in 秘鲁 "Peru"' },
  { id: '委|委[wei3]', reason: 'wěi, as in 委员 and 委托; wēi only in 委蛇' },
  { id: '不了|不了[bu4 liao3]', reason: 'bùliǎo, as in 受不了 and 少不了; bùle is "no thanks"' },
  { id: '小子|小子[xiao3 zi5]', reason: 'xiǎozi "boy; guy", as in 这小子; xiǎozǐ is literary' },
];
