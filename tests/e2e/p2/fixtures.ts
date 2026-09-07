import type { Page } from '@playwright/test';

import type { CardRow, Repository, ReviewRow, StoredRating, TangramDb } from '@/lib/db';
import type { CardContext, Entry } from '@/lib/types';

/**
 * The test hook the shell mounts on every page (`components/shell/test-hooks.tsx`).
 * Specs seed and inspect through it rather than through a fake API: a
 * local-first app's state *is* the database.
 */
type TangramWindow = Window & {
  __tangram?: { repo: Repository; db: TangramDb };
};

export const DAY_MS = 86_400_000;

export const DASUAN: Entry = {
  id: '打算|打算[da3 suan4]',
  simp: '打算',
  trad: '打算',
  pinyinNum: 'da3 suan4',
  pinyinMarked: 'dǎsuàn',
  glosses: ['to plan', 'to intend', 'to calculate'],
  classifiers: ['个'],
  properNoun: false,
  isVariant: false,
  surname: false,
  hskBand: 2,
  freqRank: 1200,
};

export const KANKAN: Entry = {
  id: '看看|看看[kan4 kan5]',
  simp: '看看',
  trad: '看看',
  pinyinNum: 'kan4 kan5',
  pinyinMarked: 'kànkan',
  glosses: ['to take a look at', 'to examine'],
  classifiers: [],
  properNoun: false,
  isVariant: false,
  surname: false,
  hskBand: 1,
  freqRank: 800,
};

/** 我打算明天去北京。 with 打算 located at offset 1, as the reader records it. */
export const SENTENCE = '我打算明天去北京。';

export function readerContext(overrides: Partial<CardContext> = {}): CardContext {
  return {
    sentence: SENTENCE,
    offset: 1,
    length: 2,
    source: 'reader',
    addedAt: Date.now(),
    ...overrides,
  };
}

export interface SeedCard {
  entry: Entry;
  context?: CardContext;
  senseIndex?: number;
  /** Grade the card this many days ago, so it is genuinely due now. */
  gradedDaysAgo?: number;
  rating?: StoredRating;
}

/** Open /review with an empty database and the test hook ready. */
export async function openReview(page: Page): Promise<void> {
  await page.goto('/review');
  await page.waitForFunction(() => Boolean((window as TangramWindow).__tangram));
  await page.evaluate(() => (window as TangramWindow).__tangram!.repo.resetAll());
}

/**
 * Seed cards and reload, so the session loads them. Returns the card ids in the
 * order they were created.
 */
export async function seed(page: Page, cards: SeedCard[]): Promise<string[]> {
  const ids = await page.evaluate(async (input: SeedCard[]) => {
    const repo = (window as TangramWindow).__tangram!.repo;
    const created: string[] = [];
    for (const item of input) {
      const card = await repo.addCardFromEntry(item.entry, item.context, item.senseIndex, 'test');
      if (item.gradedDaysAgo !== undefined) {
        await repo.grade(
          card.id,
          item.rating ?? 3,
          Date.now() - item.gradedDaysAgo * 86_400_000,
        );
      }
      created.push(card.id);
    }
    return created;
  }, cards);
  await page.reload();
  await page.waitForFunction(() => Boolean((window as TangramWindow).__tangram));
  return ids;
}

/**
 * Every review row, oldest first. The repository seam deliberately has no
 * review reader — nothing in the app needs one — so this reads the table
 * through the `db` handle the same test hook publishes.
 */
export function reviewRows(page: Page): Promise<ReviewRow[]> {
  return page.evaluate(() =>
    (window as TangramWindow).__tangram!.db.reviews.orderBy('reviewedAt').toArray(),
  );
}

/** The stored card, for asserting that a grade actually rescheduled it. */
export function storedCard(page: Page, id: string): Promise<CardRow | undefined> {
  return page.evaluate(async (cardId: string) => {
    const repo = (window as TangramWindow).__tangram!.repo;
    return (await repo.allCards()).find((card) => card.id === cardId);
  }, id);
}
