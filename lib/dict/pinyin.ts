/**
 * Pinyin conversion and query normalization (PLAN.md §3.1, §3.2).
 *
 * Two jobs, both mechanical and both dependency-free so they run identically in the
 * build script, on the server and in the browser:
 *
 *   1. `toMarked` turns CC-CEDICT's numbered pinyin (`da3 suan4`, `lu:4`) into the
 *      marked display form (`dǎsuàn`, `lǜ`). This is the only derivation Tangram
 *      makes from the dictionary text, and it is why data/ATTRIBUTION.md carries a
 *      modification notice.
 *   2. `normalizePinyin` folds anything a learner might type — marks, tone digits,
 *      `u:`, `v`, `ü`, apostrophes, spaces, mixed case — onto the same keys the
 *      dictionary indexes are built with, so `dasuan`, `da3suan4` and `dǎsuàn` all
 *      land on one entry.
 */

/** Tone 0 (= neutral) first, then tones 1–4. */
const TONE_ROWS: Record<string, string> = {
  a: 'aāáǎà',
  e: 'eēéěè',
  i: 'iīíǐì',
  o: 'oōóǒò',
  u: 'uūúǔù',
  ü: 'üǖǘǚǜ',
};

/** Accented vowel → [base letter, tone]. Built from TONE_ROWS, both cases. */
const ACCENTS = new Map<string, { base: string; tone: number }>();
for (const [base, row] of Object.entries(TONE_ROWS)) {
  for (let tone = 1; tone <= 4; tone += 1) {
    ACCENTS.set(row[tone], { base, tone });
    ACCENTS.set(row[tone].toUpperCase(), { base, tone });
  }
}

const VOWELS = 'aeiouü';

/**
 * Toneless pinyin syllables, ü folded to u (so `lu` covers both lu and lü).
 * Extracted from the CC-CEDICT snapshot itself, so every reading in the dictionary
 * parses; the handful of non-standard ones (biang, biu, ging, fiao, hm, hng) are
 * real CC-CEDICT readings and are kept on purpose.
 */
const SYLLABLES = new Set<string>(
  ('a ai an ang ao ba bai ban bang bao bei ben beng bi bia bian biang biao bie bin bing biu bo bu ' +
    'ca cai can cang cao ce cen ceng cha chai chan chang chao che chen cheng chi chong chou chu chua ' +
    'chuai chuan chuang chui chun chuo ci cong cou cu cuan cui cun cuo da dai dan dang dao de dei den ' +
    'deng di dia dian diao die ding diu dong dou du duan dui dun duo e ei en eng er fa fan fang fei fen ' +
    'feng fiao fo fou fu ga gai gan gang gao ge gei gen geng ging gong gou gu gua guai guan guang gui gun ' +
    'guo ha hai han hang hao he hei hen heng hm hng hong hou hu hua huai huan huang hui hun huo ji jia ' +
    'jian jiang jiao jie jin jing jiong jiu ju juan jue jun ka kai kan kang kao ke kei ken keng kong kou ' +
    'ku kua kuai kuan kuang kui kun kuo la lai lan lang lao le lei leng li lia lian liang liao lie lin ' +
    'ling liu lo long lou lu luan lue lun luo m ma mai man mang mao me mei men meng mi mian miao mie min ' +
    'ming miu mo mou mu na nai nan nang nao ne nei nen neng ni nian niang niao nie nin ning niu nong nou ' +
    'nu nuan nue nun nuo o ou pa pai pan pang pao pei pen peng pi pian piao pie pin ping po pou pu qi qia ' +
    'qian qiang qiao qie qin qing qiong qiu qu quan que qun r ran rang rao re ren reng ri rong rou ru rua ' +
    'ruan rui run ruo sa sai san sang sao se sei sen seng sha shai shan shang shao she shei shen sheng shi ' +
    'shou shu shua shuai shuan shuang shui shun shuo si song sou su suan sui sun suo ta tai tan tang tao te ' +
    'tei teng ti tian tiao tie ting tong tou tu tuan tui tun tuo wa wai wan wang wei wen weng wo wu xi xia ' +
    'xian xiang xiao xie xin xing xiong xiu xu xuan xue xun ya yan yang yao ye yi yin ying yo yong you yu ' +
    'yuan yue yun za zai zan zang zao ze zei zen zeng zha zhai zhan zhang zhao zhe zhei zhen zheng zhi ' +
    'zhong zhou zhu zhua zhuai zhuan zhuang zhui zhun zhuo zi zong zou zu zuan zui zun zuo').split(' '),
);

const MAX_SYLLABLE_LEN = 6;

/** CC-CEDICT writes `xx5` for a headword with no known Mandarin reading. */
export const UNKNOWN_SYLLABLE = 'xx5';

/** True when a reading is (partly) CC-CEDICT's "no known reading" placeholder. */
export function hasUnknownReading(pinyinNum: string): boolean {
  return pinyinNum.trim().split(/\s+/).includes(UNKNOWN_SYLLABLE);
}

/** `true` when `token` is a numbered pinyin syllable such as `da3`, `lu:4`, `r5`. */
function isNumberedSyllable(token: string): boolean {
  return /^[A-Za-züÜvV:]+[1-5]$/.test(token);
}

/** `u:` and `v` are both ways of writing ü. Only ever applied to real syllables — a
 * bare Latin run like `TV` must not lose its v. */
function unUmlaut(letters: string): string {
  return letters.replace(/u:/g, 'ü').replace(/U:/g, 'Ü').replace(/v/g, 'ü').replace(/V/g, 'Ü');
}

/**
 * Index of the vowel that carries the tone mark: `a` or `e` if present, else the `o`
 * of `ou`, else the last vowel. (The standard rule; `iu`/`ui` fall out of "last".)
 */
function toneVowelIndex(lower: string): number {
  const a = lower.indexOf('a');
  if (a !== -1) return a;
  const e = lower.indexOf('e');
  if (e !== -1) return e;
  const ou = lower.indexOf('ou');
  if (ou !== -1) return ou;
  for (let i = lower.length - 1; i >= 0; i -= 1) {
    if (VOWELS.includes(lower[i])) return i;
  }
  return -1;
}

/**
 * One numbered syllable → marked. Tone 5 (neutral, including erhua `r5`) gets no
 * mark. Anything that is not a numbered syllable (`C`, `OK`, `·`) passes through
 * with only `u:`/`v` folded to ü. Capitalization is preserved.
 */
export function markSyllable(token: string): string {
  // `xx5` is not a reading, it is CC-CEDICT saying it has none; rendering it as
  // "xx" would put a fake pinyin under a headword (々, ㍻, 込).
  if (token === UNKNOWN_SYLLABLE) return '';
  if (!isNumberedSyllable(token)) return token.replace(/u:/g, 'ü').replace(/U:/g, 'Ü');
  const letters = unUmlaut(token.slice(0, -1));
  const tone = Number(token[token.length - 1]);
  if (tone === 5) return letters;
  const lower = letters.toLowerCase();
  const i = toneVowelIndex(lower);
  if (i === -1) return letters;
  const row = TONE_ROWS[lower[i]];
  if (!row) return letters;
  const marked = letters[i] === lower[i] ? row[tone] : row[tone].toUpperCase();
  return letters.slice(0, i) + marked + letters.slice(i + 1);
}

/**
 * True when a marked syllable starts with a capital. CC-CEDICT capitalises every
 * word of a name, so a capital mid-reading is where one word ends and the next
 * begins (`Shao4 lin2 Si4` → `Shàolín Sì`).
 */
function startsCapitalized(marked: string): boolean {
  const first = marked[0];
  return first !== undefined && first !== first.toLowerCase();
}

/** Base vowel of a marked syllable's first letter — used for the apostrophe rule. */
function startsWithVowel(marked: string): boolean {
  const first = marked[0];
  if (!first) return false;
  const base = ACCENTS.get(first)?.base ?? first.toLowerCase();
  return base === 'a' || base === 'e' || base === 'o';
}

/**
 * Whole numbered reading → the marked display form: `da3 suan4` → `dǎsuàn`.
 *
 * Syllables run together the way pinyin orthography writes a word, with an
 * apostrophe where the join would otherwise be ambiguous (`Xi1 an1` → `Xī'ān`, which
 * is what keeps it distinguishable from `xian1` → `xiān`). CC-CEDICT's `·` (name
 * separator) and `,` (clause separator in proverbs) are kept.
 */
export function toMarked(pinyinNum: string): string {
  const tokens = pinyinNum.trim().split(/\s+/).filter(Boolean);
  let out = '';
  let prevWasSyllable = false;
  let prevWasLatin = false;
  for (const token of tokens) {
    if (token === '·') {
      out += '·';
      prevWasSyllable = false;
      prevWasLatin = false;
      continue;
    }
    if (token === ',' || token === '，') {
      out += ', ';
      prevWasSyllable = false;
      prevWasLatin = false;
      continue;
    }
    if (isNumberedSyllable(token)) {
      const marked = markSyllable(token);
      if (prevWasSyllable && startsCapitalized(marked)) out += ' ';
      else if (prevWasSyllable && startsWithVowel(marked)) out += "'";
      else if (prevWasLatin) out += ' ';
      out += marked;
      prevWasSyllable = true;
      prevWasLatin = false;
      continue;
    }
    // Latin runs like `C` in `3C` or `OK`: keep them as separate words.
    out += (out && !out.endsWith(' ') ? ' ' : '') + markSyllable(token);
    prevWasSyllable = false;
    prevWasLatin = true;
  }
  return out.trim();
}

export interface PinyinSyllable {
  /** Toneless, lowercase, ASCII (ü folded to u). */
  base: string;
  /** 1–5, or null when the input carried no tone for this syllable. */
  tone: number | null;
}

export interface NormalizedPinyin {
  /** Lookup key with tones dropped: `dǎsuàn`, `da3suan4`, `dasuan` → `dasuan`. */
  toneless: string;
  /**
   * Lookup key with tones kept as digits: `dǎsuàn` → `da3suan4`.
   *
   * The neutral tone contributes no digit (`wo3 men5` → `wo3men`), because tone
   * marks cannot express it: a learner typing `wǒmen` must land on the same key
   * as the dictionary's `wo3 men5`, or every neutral-tone word — 我们, 什么,
   * 东西, 朋友 — falls out of the tone-exact tier it belongs in.
   */
  toned: string;
  syllables: PinyinSyllable[];
  /** The whole input parsed as pinyin syllables. False for English, hanzi, junk. */
  fullyParsed: boolean;
}

interface Chunk {
  letters: string;
  /** letter index → tone from a diacritic on that letter. */
  markTones: Map<number, number>;
  /** letter index (exclusive end of a syllable) → tone from a digit typed there. */
  digitTones: Map<number, number>;
}

/** Split the raw query into letter runs, recording where tones were attached. */
function toChunks(query: string): { chunks: Chunk[]; clean: boolean } {
  const chunks: Chunk[] = [];
  let clean = true;
  let current: Chunk = { letters: '', markTones: new Map(), digitTones: new Map() };
  const flush = () => {
    if (current.letters) chunks.push(current);
    current = { letters: '', markTones: new Map(), digitTones: new Map() };
  };
  // `u:` and `v` are both ways of typing ü; the index folds ü to u, so do that here.
  const source = query.normalize('NFC').toLowerCase().replace(/u:/g, 'ü');
  for (const ch of source) {
    const accent = ACCENTS.get(ch);
    if (accent) {
      current.markTones.set(current.letters.length, accent.tone);
      current.letters += accent.base === 'ü' ? 'u' : accent.base;
      continue;
    }
    if (ch === 'ü' || ch === 'v') {
      current.letters += 'u';
      continue;
    }
    if (ch >= 'a' && ch <= 'z') {
      current.letters += ch;
      continue;
    }
    if (ch >= '1' && ch <= '5') {
      // A digit closes the syllable that ends here.
      if (current.letters) current.digitTones.set(current.letters.length, Number(ch));
      else clean = false;
      continue;
    }
    // An apostrophe, space or hyphen is a deliberate syllable break; anything else
    // (hanzi, punctuation, digits 0/6-9) means this is not a pinyin query.
    if (!/['’` \t\-·,]/.test(ch)) clean = false;
    flush();
  }
  flush();
  return { chunks, clean };
}

/**
 * Longest-match-first DP over one letter run. Returns null when it does not parse.
 *
 * "Longest first" alone mis-reads correctly written pinyin: `gunao` becomes
 * `gun ao` and `chana` becomes `chan a`. Orthography forbids both — a
 * vowel-initial syllable inside a word takes an apostrophe (`Xi'an`), so a
 * boundary in front of a/e/o without one cannot be where the writer meant. So a
 * split is tried in two passes: candidates whose boundary is orthographically
 * legal first, then, only if nothing parses, the rest.
 */
function parseChunk(chunk: Chunk): PinyinSyllable[] | null {
  const { letters, markTones, digitTones } = chunk;
  const memo = new Map<number, PinyinSyllable[] | null>();

  /** An apostrophe already split the chunk, so a digit is the only break left. */
  const legalBoundary = (end: number): boolean =>
    end === letters.length || digitTones.has(end) || !'aeo'.includes(letters[end]);

  const at = (start: number): PinyinSyllable[] | null => {
    if (start === letters.length) return [];
    const cached = memo.get(start);
    if (cached !== undefined) return cached;
    for (const orthographic of [true, false]) {
      for (let len = Math.min(MAX_SYLLABLE_LEN, letters.length - start); len >= 1; len -= 1) {
        const end = start + len;
        const candidate = letters.slice(start, end);
        if (!SYLLABLES.has(candidate)) continue;
        if (orthographic && !legalBoundary(end)) continue;
        // A typed tone digit forces a syllable boundary: no syllable may span it.
        let spansDigit = false;
        for (const boundary of digitTones.keys()) {
          if (boundary > start && boundary < end) spansDigit = true;
        }
        if (spansDigit) continue;
        const rest = at(end);
        if (!rest) continue;
        let tone = digitTones.get(end) ?? null;
        if (tone === null) {
          for (const [i, t] of markTones) {
            if (i >= start && i < end) tone = t;
          }
        }
        const result = [{ base: candidate, tone }, ...rest];
        memo.set(start, result);
        return result;
      }
    }
    memo.set(start, null);
    return null;
  };

  return at(0);
}

/**
 * Fold any pinyin-ish query onto the dictionary's lookup keys.
 *
 * `fullyParsed` is the signal the search router uses to decide whether a query is
 * pinyin at all; `toneless`/`toned` are still filled in on a failed parse so a
 * partial query can drive a prefix search.
 */
export function normalizePinyin(query: string): NormalizedPinyin {
  const { chunks, clean } = toChunks(query);
  const syllables: PinyinSyllable[] = [];
  let parsed = clean && chunks.length > 0;
  for (const chunk of chunks) {
    const got = parseChunk(chunk);
    if (got) syllables.push(...got);
    else parsed = false;
  }
  if (parsed && syllables.length > 0) {
    return {
      toneless: syllables.map((s) => s.base).join(''),
      toned: syllables.map((s) => s.base + (s.tone === null || s.tone === 5 ? '' : s.tone)).join(''),
      syllables,
      fullyParsed: true,
    };
  }
  // Not pinyin (or not yet): keep the letters in order so a partial query can still
  // drive a prefix search, and drop tones rather than guess where they attach.
  const letters = chunks.map((c) => c.letters).join('');
  return { toneless: letters, toned: letters, syllables: [], fullyParsed: false };
}
