import { createDexieRepository, TangramDb } from '@/lib/db/dexie';
import type { Repository } from '@/lib/db/repository';
import type { CardContext, Entry } from '@/lib/types';

let counter = 0;

/** A private database per test, so nothing leaks between them. */
export function freshRepository(): { db: TangramDb; repo: Repository } {
  const db = new TangramDb(`tangram-test-${Date.now()}-${counter++}`);
  return { db, repo: createDexieRepository(db) };
}

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

export function context(overrides: Partial<CardContext> = {}): CardContext {
  return {
    sentence: '我打算明天去北京。',
    offset: 1,
    length: 2,
    source: 'reader',
    addedAt: Date.now(),
    ...overrides,
  };
}
