/**
 * Punctuation in the reader never starts or ends a line the wrong way
 * (the first-run audit's "Defects found, not fixed", item 2).
 *
 * Chinese typesetting forbids closing punctuation — ，。、；：？！」』）】》 and
 * the rest — at the start of a line, and opening punctuation — 「『（【《 — at
 * the end of one. The reader broke both rules, because every word is a
 * `<button>`, a button is an atomic inline, and Chromium allows a break before
 * and after any atomic inline whatever the character next to it is. The
 * line-breaking rule that would have glued "，" to the word before it never got
 * a say. `<HanziText>` now wraps a word with the punctuation that must travel
 * with it, and this file is what holds that.
 *
 * **Everything here is geometry, never a screenshot.** Each punctuation mark is
 * measured with a `Range` over the passage's own base text — the same walk
 * `use-span-select.ts` builds its map with, `<rt>` and `<rp>` excluded — and
 * compared with its neighbour's line.
 *
 * The drag cases are the other half: the wrapper sits between the word and the
 * passage, which is exactly where the span-select hit-test and the character
 * map live, so a drag across a glued boundary has to select what it selected
 * before the wrapper existed. They were run against the build without the
 * wrapper as well, and passed there unchanged (HANDOFF.md).
 */
import { expect, installDictionary, test, type Page } from '../dict';

import { readText, resetApp } from '../p5/helpers';
import { baseText } from '../hanzi';

/**
 * Real paragraphs, between them carrying every closing and opening mark the
 * reader is likely to meet — simplified, traditional, and mixed with Latin.
 * Each is its own paragraph in the pasted body (the passage is
 * `white-space: pre-wrap`), so every paragraph restarts the line and the marks
 * fall at different points of a line at each width.
 */
const CORPUS = [
  '我今天打算去图书馆看书。那里很安静，我可以学习汉语。你想跟我一起去吗？',
  '老师问：「你们读过《红楼梦》吗？」小明说：「读过一点儿，但是没读完。」老师笑了笑，说：「慢慢来；好书要多读几遍！」',
  '我们班上有三个同学（小王、小李和小张）已经读完了。他们说【第一回】最难懂……不过读下去就好了——真的！',
  '他在书上写着：『学而时习之，不亦说乎？』我问他：“这是谁说的？”他说：“孔子。”',
  '我昨天去圖書館借了兩本書：《論語》和《孟子》。圖書館的阿姨說：「這兩本書都很有名，你要好好讀。」我問她：「有沒有比較簡單的版本？」她想了想，回答說：「有的，在三樓（兒童區）。」',
  '我每天用iPhone学中文，有时候也用Pleco查词典。我的老师叫David，他是美国人（从加州来的）。他常常说：“学语言要有耐心！”我觉得他说得对；不过，考试还是很难……',
  '我最喜欢的作家是列夫·托尔斯泰。他的《战争与和平》很长，我读了一年多，才读完。',
  '周末的时候，我常常和朋友去公园散步、聊天、拍照。有时候我们也去博物馆看展览，或者去电影院看电影。你周末一般做什么？',
  '《西游记》是中国古典四大名著之一，讲的是唐僧师徒四人去西天取经的故事。书中的孙悟空（又叫“美猴王”）本领高强，会七十二变！',
  '「你明天有空嗎？」「有啊，怎麼了？」「我們一起去看電影，好不好？」「好啊！幾點見？」',
  '我今天打算去图书馆看书。那里很安静，我可以学习汉语。好吗？',
  '我们班上的同学都很喜欢看书，大家最近最喜欢的一本书是《小王子》。',
];

const BODY = CORPUS.join('\n\n');

/** May not start a line (CLREQ's 行首禁则, plus the ellipsis and dash, which may not be split). */
const CLOSING = '，。、；：？！」』）】》〉〕］｝〗〙”’…—·・～,.;:?!)';
/** May not end a line (CLREQ's 行尾禁则). */
const OPENING = '「『（【《〈〔［｛〖〘“‘(';

interface Mark {
  index: number;
  char: string;
  /** The neighbour it must share a line with: the one before a closing mark, after an opening one. */
  neighbour: string;
  sameLine: boolean;
  /** A line break falls on the far side of the mark — the rule was exercised here. */
  atEdge: boolean;
}

/**
 * Every punctuation mark in the passage, with whether it shares a line with
 * the character it must not be separated from.
 *
 * Two characters are on one line when their vertical centres are within half a
 * glyph of each other; ruby only ever moves a line by a whole line box, so the
 * tolerance never has to decide a close call.
 */
async function marks(page: Page): Promise<Mark[]> {
  return page.evaluate(
    ({ closing, opening }) => {
      const root = document.querySelector('[data-testid="reader-text"]');
      if (!root) return [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          for (let el = node.parentElement; el && el !== root; el = el.parentElement) {
            if (el.tagName === 'RT' || el.tagName === 'RP') return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      const chars: { char: string; rect: DOMRect | null }[] = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const value = node.nodeValue ?? '';
        for (let at = 0; at < value.length; at += 1) {
          const range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, at + 1);
          const rects = range.getClientRects();
          chars.push({
            char: value[at]!,
            rect: rects.length > 0 ? rects[0]! : null,
          });
        }
      }
      const centre = (rect: DOMRect) => rect.top + rect.height / 2;
      const same = (a: DOMRect, b: DOMRect) =>
        Math.abs(centre(a) - centre(b)) < Math.min(a.height, b.height) / 2;
      const visible = (at: number) => {
        const entry = chars[at];
        return entry && entry.rect && !/\s/.test(entry.char) ? entry : null;
      };
      const out: {
        index: number;
        char: string;
        neighbour: string;
        sameLine: boolean;
        atEdge: boolean;
      }[] = [];
      chars.forEach((entry, index) => {
        if (!entry.rect) return;
        const isClosing = closing.includes(entry.char);
        const isOpening = opening.includes(entry.char);
        if (!isClosing && !isOpening) return;
        // The neighbour that must share the line, and the one on the far side.
        const near = visible(isClosing ? index - 1 : index + 1);
        const far = visible(isClosing ? index + 1 : index - 1);
        if (!near) return; // start of a paragraph, or whitespace: nothing to glue to
        out.push({
          index,
          char: entry.char,
          neighbour: near.char,
          sameLine: same(entry.rect, near.rect!),
          atEdge: far ? !same(entry.rect, far.rect!) : false,
        });
      });
      return out;
    },
    { closing: CLOSING, opening: OPENING },
  );
}

async function openReader(page: Page, body: string): Promise<void> {
  await resetApp(page, { knownBand: 2, newPerDay: 0 });
  await readText(page, body);
  // The readings reflow the passage; the character map is rebuilt after them.
  await expect(page.locator('[data-span-index="0"]')).toBeAttached();
}

/**
 * The passage's geometry, read only once it has stopped moving: the readings
 * land and the web font swaps in a beat after the text, and each reflows every
 * line. Three equal readings in a row, as `core/routing.spec.ts` does.
 */
async function settled(page: Page): Promise<void> {
  let last = '';
  let same = 0;
  await expect
    .poll(
      async () => {
        const now = await page.evaluate(() => {
          const root = document.querySelector('[data-testid="reader-text"]');
          const rect = root?.getBoundingClientRect();
          return `${rect?.width}x${rect?.height}:${root?.querySelectorAll('rt').length}`;
        });
        same = now === last ? same + 1 : 0;
        last = now;
        return same;
      },
      { intervals: [100] },
    )
    .toBeGreaterThanOrEqual(2);
}

test.use({ dictionary: 'installed' });

test.describe('punctuation keeps to its word across a line break', () => {
  for (const width of [390, 844, 1280] as const) {
    test(`at ${width}px, no line starts with closing punctuation or ends with opening`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await openReader(page, BODY);
      await settled(page);

      const found = await marks(page);
      // The corpus is what it says it is: every mark in both lists that the
      // paragraphs carry was measured, not skipped for want of a box.
      const measured = new Set(found.map((mark) => mark.char));
      for (const char of '，。、；：？！」』）】》”…—·「『（【《“') {
        expect(measured, `the corpus carries ${char}`).toContain(char);
      }

      const broken = found.filter((mark) => !mark.sameLine);
      expect(
        broken.map((mark) => `${mark.char} (char ${mark.index}) split from ${mark.neighbour}`),
      ).toEqual([]);

      // Not vacuous: at this width some marks really do sit against a line
      // break, which is where the old markup put them on the wrong side of it.
      expect(found.filter((mark) => mark.atEdge).length).toBeGreaterThan(0);
    });
  }

  /**
   * The wrapper that keeps a word and its comma together must not keep them
   * together at any cost. A word longer than the column has to wrap inside
   * itself, as it always did, and its comma then goes to the next line rather
   * than off the side of the screen.
   */
  test('a word longer than the column, plus its comma, does not overflow at 320px', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    // Fifteen characters, one dictionary word: at text-xl it is wider than
    // the 320px column by itself.
    const word = '积石山保安族东乡族撒拉族自治县';
    await openReader(page, `${word}，是一个自治县。「${word}」在甘肃。`);
    await settled(page);

    // It is one word, so this really is a run with no break opportunity
    // outside the word itself.
    await expect(page.locator(`[data-testid="reader-token"][data-token="${word}"]`)).toHaveCount(2);

    const overflow = await page.evaluate(() => {
      const root = document.querySelector<HTMLElement>('[data-testid="reader-text"]')!;
      const box = root.getBoundingClientRect();
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let widest = box.left;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const rect of range.getClientRects()) widest = Math.max(widest, rect.right);
      }
      return {
        page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        passage: root.scrollWidth - root.clientWidth,
        text: Math.round(widest - box.right),
      };
    });
    expect(overflow).toEqual({ page: 0, passage: 0, text: expect.any(Number) });
    expect(overflow.text).toBeLessThanOrEqual(0);
  });
});

/**
 * The first closing mark, between two Chinese characters, that sits against a
 * line break — either side of it, so that the same search finds the case in a
 * build where the mark had wrapped to the start of the next line.
 */
async function gluedBreak(page: Page): Promise<number> {
  const at = await page.evaluate(
    ({ closing }) => {
      const root = document.querySelector('[data-testid="reader-text"]')!;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          for (let el = node.parentElement; el && el !== root; el = el.parentElement) {
            if (el.tagName === 'RT' || el.tagName === 'RP') return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      const boxes: { char: string; rect: DOMRect }[] = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const value = node.nodeValue ?? '';
        for (let i = 0; i < value.length; i += 1) {
          const range = document.createRange();
          range.setStart(node, i);
          range.setEnd(node, i + 1);
          boxes.push({ char: value[i]!, rect: range.getBoundingClientRect() });
        }
      }
      const line = (rect: DOMRect) => Math.round(rect.top + rect.height / 2);
      const cjk = /[一-鿿]/;
      for (let i = 3; i < boxes.length - 3; i += 1) {
        if (!closing.includes(boxes[i]!.char)) continue;
        if (!cjk.test(boxes[i - 1]!.char) || !cjk.test(boxes[i + 1]!.char)) continue;
        const before = line(boxes[i - 1]!.rect) !== line(boxes[i + 1]!.rect);
        if (before) return i;
      }
      return -1;
    },
    { closing: '，。、；' },
  );
  expect(at, 'a pause or stop mark against a line break').toBeGreaterThan(0);
  return at;
}

/** The base-text walk every helper here shares: `<rt>` and `<rp>` excluded. */
async function boxOf(
  page: Page,
  index: number,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.evaluate((at) => {
    const root = document.querySelector('[data-testid="reader-text"]');
    if (!root) return null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        for (let el = node.parentElement; el && el !== root; el = el.parentElement) {
          if (el.tagName === 'RT' || el.tagName === 'RP') return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let seen = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const length = node.nodeValue?.length ?? 0;
      if (at < seen + length) {
        const range = document.createRange();
        range.setStart(node, at - seen);
        range.setEnd(node, at - seen + 1);
        const rect = range.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }
      seen += length;
    }
    return null;
  }, index);
  if (!box) throw new Error(`character ${index} has no box`);
  return box;
}

/**
 * Scroll character `index` to a quarter of the way down the viewport: below
 * the pinned header, and above the word sheet, which covers the bottom of a
 * phone once the first drag has opened it. A drag aimed at a point off the
 * screen, or under the sheet, hits nothing, which is a broken test and not a
 * broken reader.
 */
async function bringIntoView(page: Page, index: number): Promise<void> {
  const box = await boxOf(page, index);
  await page.evaluate((top) => window.scrollBy(0, top - window.innerHeight / 4), box.y);
}

/**
 * The centre of character `index` in the viewport, and proof that a pointer
 * there lands on the passage.
 */
async function centreOf(page: Page, index: number): Promise<{ x: number; y: number }> {
  const box = await boxOf(page, index);
  // Low in the glyph: a hit-test near the top of an annotated run lands in the `<rt>`.
  const point = { x: box.x + box.width / 2, y: box.y + box.height * 0.75 };
  const onPassage = await page.evaluate(
    ({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest('[data-testid="reader-text"]')),
    point,
  );
  expect(onPassage, `character ${index} is on screen and uncovered`).toBe(true);
  return point;
}

async function mouseDrag(page: Page, from: number, to: number): Promise<void> {
  await bringIntoView(page, Math.min(from, to));
  const a = await centreOf(page, from);
  const b = await centreOf(page, to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (let step = 1; step <= 8; step += 1) {
    await page.mouse.move(a.x + ((b.x - a.x) * step) / 8, a.y + ((b.y - a.y) * step) / 8);
  }
  await page.mouse.up();
}

/** The touch drag `core/reader-span.spec.ts` drives, with synthetic touch pointers. */
async function touchDrag(page: Page, from: number, to: number): Promise<void> {
  await bringIntoView(page, Math.min(from, to));
  const a = await centreOf(page, from);
  const b = await centreOf(page, to);
  await page.evaluate(
    ({ a: start, b: end }) => {
      const passage = document.querySelector('[data-testid="reader-text"]')!;
      const fire = (type: string, x: number, y: number) =>
        passage.dispatchEvent(
          new PointerEvent(type, {
            pointerId: 1,
            pointerType: 'touch',
            isPrimary: true,
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY: y,
          }),
        );
      fire('pointerdown', start.x, start.y);
      for (let step = 1; step <= 8; step += 1) {
        fire(
          'pointermove',
          start.x + ((end.x - start.x) * step) / 8,
          start.y + ((end.y - start.y) * step) / 8,
        );
      }
      fire('pointerup', end.x, end.y);
    },
    { a, b },
  );
}

function sheetQuery(page: Page): Promise<string> {
  return baseText(page.getByTestId('reader-panel').getByTestId('lookup-panel').locator('h2'));
}

async function sheetShows(page: Page, expected: string): Promise<void> {
  await expect.poll(() => sheetQuery(page)).toBe(expected);
}

function ringed(page: Page): Promise<string[]> {
  return page.$$eval('[data-testid="reader-token"][data-in-span="true"]', (nodes) =>
    nodes.map((node) => node.getAttribute('data-token') ?? ''),
  );
}

/**
 * The drag cases, once for a mouse and once for touch. Every expected span is
 * derived from the passage's own characters by the rule C5b ships — across
 * punctuation keeps it, an endpoint on punctuation snaps inward — so none of
 * them depends on where a line happens to break.
 */
const DRAGGERS = [
  { name: 'a mouse', touch: false, drag: mouseDrag },
  { name: 'touch', touch: true, drag: touchDrag },
] as const;

for (const { name, touch, drag } of DRAGGERS) {
  test.describe(`dragging across a glued boundary, with ${name}`, () => {
    test('selects what it selected before the punctuation was glued', async ({ browser }) => {
      const context = await browser.newContext({
        hasTouch: touch,
        viewport: { width: 390, height: 844 },
      });
      const page = await context.newPage();
      try {
        // Its own context is its own origin: a fresh install.
        await installDictionary(page);
        await openReader(page, BODY);
        await settled(page);
        const text = await page
          .getByTestId('reader-text')
          .evaluate((el) => el.getAttribute('data-hanzi') ?? '');
        const chars = [...text];
        const slice = (from: number, to: number) => chars.slice(from, to + 1).join('');

        const p = await gluedBreak(page);

        // Across the mark, from the line it ends to the line after: the span
        // carries the mark, and the lookup fires with exactly that string.
        await drag(page, p - 2, p + 1);
        await sheetShows(page, slice(p - 2, p + 1));
        const across = await ringed(page);
        expect(across.join('')).toContain(chars[p - 1]);
        expect(across.join('')).toContain(chars[p + 1]);

        // …and backwards, to the same span.
        await drag(page, p + 1, p - 2);
        await sheetShows(page, slice(p - 2, p + 1));

        // Ending on the mark snaps back to the word it is glued to.
        await drag(page, p - 2, p);
        await sheetShows(page, slice(p - 2, p - 1));

        // Starting on it snaps forward, onto the next line.
        await drag(page, p, p + 1);
        await sheetShows(page, slice(p + 1, p + 1));
      } finally {
        await context.close();
      }
    });
  });
}

/**
 * A drag that overshoots the end of a line (review A, finding 1).
 *
 * A line that ends a clause now ends in a `.hanzi-glue` inline-block, and a
 * caret hit past it names the ELEMENT, with an offset that counts its
 * children. `indexOfNode` used to drop that offset and answer the element's
 * first character, so a thumb that ran off the end of "你周末一般做什么？"
 * selected "你周末一般做什". Every line that ends in a closing mark is tried.
 */
test('a drag past the end of a line keeps the whole of its last word', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openReader(page, BODY);
  await settled(page);
  const text = await page
    .getByTestId('reader-text')
    .evaluate((el) => el.getAttribute('data-hanzi') ?? '');
  const chars = [...text];

  // Each line that ends in a closing mark after a Chinese character: the
  // index of its first Chinese character and of its last one.
  const lines = await page.evaluate(
    ({ closing }) => {
      const root = document.querySelector('[data-testid="reader-text"]')!;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          for (let el = node.parentElement; el && el !== root; el = el.parentElement) {
            if (el.tagName === 'RT' || el.tagName === 'RP') return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      const boxes: { char: string; line: number }[] = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const value = node.nodeValue ?? '';
        for (let i = 0; i < value.length; i += 1) {
          const range = document.createRange();
          range.setStart(node, i);
          range.setEnd(node, i + 1);
          const rect = range.getBoundingClientRect();
          boxes.push({ char: value[i]!, line: Math.round(rect.top + rect.height / 2) });
        }
      }
      const cjk = /[\u4e00-\u9fff]/;
      const out: { first: number; last: number }[] = [];
      for (let i = 1; i < boxes.length; i += 1) {
        const next = boxes[i + 1];
        const endsLine = !next || /\s/.test(next.char) || next.line !== boxes[i]!.line;
        if (!closing.includes(boxes[i]!.char) || !endsLine) continue;
        let last = i - 1;
        while (last > 0 && !cjk.test(boxes[last]!.char)) last -= 1;
        if (boxes[last]!.line !== boxes[i]!.line) continue;
        let first = last;
        while (first > 0 && boxes[first - 1]!.line === boxes[i]!.line) first -= 1;
        while (!cjk.test(boxes[first]!.char)) first += 1;
        if (last - first >= 3) out.push({ first, last });
      }
      return out;
    },
    { closing: CLOSING },
  );
  expect(lines.length).toBeGreaterThan(3);

  const right = await page
    .getByTestId('reader-text')
    .evaluate((el) => el.getBoundingClientRect().right);
  for (const { first, last } of lines.slice(0, 6)) {
    await bringIntoView(page, first);
    const a = await centreOf(page, first);
    const end = await centreOf(page, last);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    for (let step = 1; step <= 8; step += 1) {
      await page.mouse.move(a.x + ((right - 2 - a.x) * step) / 8, end.y);
    }
    await page.mouse.up();
    await sheetShows(page, chars.slice(first, last + 1).join(''));
  }
});

/**
 * Adjacent full-width marks are still compressed (review A, finding 2).
 *
 * Chromium trims the space in a pair like "：「" when the two marks share one
 * inline formatting context. Splitting such a run between two wrappers printed
 * both at full width, 17 pairs 10px wider each over this corpus at 1280px, and
 * that added a line. A bridging run is now kept whole inside one wrapper.
 */
test('a pair like "：「" between two words is set as tightly as before', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openReader(page, BODY);
  await settled(page);
  const widths = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="reader-text"]')!;
    const size = parseFloat(getComputedStyle(root).fontSize);
    const out: { pair: string; ratio: number }[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const value = node.nodeValue ?? '';
      for (let i = 0; i + 1 < value.length; i += 1) {
        if (!'：」。'.includes(value[i]!) || !'「“'.includes(value[i + 1]!)) continue;
        const range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + 2);
        out.push({
          pair: value.slice(i, i + 2),
          ratio: range.getBoundingClientRect().width / size,
        });
      }
    }
    return out;
  });
  // Every such pair in the corpus is in ONE text node, which is what lets the
  // engine trim it at all…
  expect(widths.length).toBeGreaterThan(10);
  // …and it does: two full-width marks set at full width are 2em.
  for (const { pair, ratio } of widths) expect(ratio, pair).toBeLessThan(1.75);
});

test.describe('the wrapper is layout, and only layout', () => {
  test('focus order is the words in reading order, with no stop that is not a word', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openReader(page, CORPUS[1]!);

    // Every focusable element inside the passage is a word, and every word is one.
    const focusable = await page.getByTestId('reader-text').evaluate((root) =>
      [
        ...root.querySelectorAll<HTMLElement>(
          'a[href], button, input, select, textarea, [tabindex], [contenteditable]',
        ),
      ].map((el) => ({
        token: el.getAttribute('data-testid') === 'reader-token',
        tabIndex: el.tabIndex,
        text: el.getAttribute('data-token'),
      })),
    );
    expect(focusable.every((el) => el.token && el.tabIndex === 0)).toBe(true);
    const tokens = await page
      .getByTestId('reader-token')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-token')));
    expect(focusable.map((el) => el.text)).toEqual(tokens);

    // …and Tab walks them in that order: the first dozen, from the first word.
    await page.getByTestId('reader-token').first().focus();
    const walked: (string | null)[] = [];
    for (let step = 0; step < 12; step += 1) {
      walked.push(
        await page.evaluate(() => document.activeElement?.getAttribute('data-token') ?? null),
      );
      await page.keyboard.press('Tab');
    }
    expect(walked).toEqual(tokens.slice(0, 12));
  });

  test('the accessibility tree carries the words and the punctuation, and nothing else', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openReader(page, CORPUS[0]!);
    const snapshot = await page.getByTestId('reader-text').ariaSnapshot();
    // One line per word button, and the punctuation as text between them. No
    // wrapper shows up as a group, a generic or a label of its own.
    const lines = snapshot.split('\n').map((line) => line.trim());
    expect(lines.filter((line) => /^- (group|generic|region|list)/.test(line))).toEqual([]);
    const buttons = lines.filter((line) => line.startsWith('- button'));
    expect(buttons.length).toBe(await page.getByTestId('reader-token').count());
    for (const mark of '，。？') expect(snapshot).toContain(mark);
  });
});
