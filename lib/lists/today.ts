/**
 * Today (PLAN.md §3.3, §4 P3): the counts on `/`, and the one place the queue's
 * decisions are turned into rows.
 *
 * Opening Today *introduces* the day's new words — it creates their cards and
 * charges `settings.introduced[dayKey]` — so the count on the page and the cards
 * `/review` will offer are the same thing and cannot drift. Reloading is free:
 * the cards already exist, the counter already reflects them, and the draw asks
 * for `cap − already introduced` more, which is zero.
 */

import type { CardRow, ListRow, SettingsRow } from '@/lib/db/schema';
import type { Repository } from '@/lib/db/repository';
import { collectDrawCandidates } from '@/lib/lists/draw';
import { getEntrySource, type EntrySource } from '@/lib/lists/entry-source';
import { introduceCards } from '@/lib/lists/introduce';
import { buildQueue, type Queue } from '@/lib/lists/queue';
import { ensureSystemLists } from '@/lib/lists/system-lists';

export interface TodayInput {
  repo: Repository;
  now?: number;
  source?: EntrySource;
  /** Set false to report the counts without creating anything (tests, previews). */
  introduce?: boolean;
}

export interface TodaySummary {
  now: number;
  settings: SettingsRow;
  lists: ListRow[];
  queue: Queue;
  due: CardRow[];
  newCards: CardRow[];
  /** Cards this call brought into being. */
  created: CardRow[];
  dueCount: number;
  newCount: number;
  introducedToday: number;
  newPerDay: number;
  /**
   * The dictionary was unreachable, so no new words could be drawn. Everything
   * else on the page is still true: a data outage must not empty the queue.
   */
  drawError?: string;
}

/**
 * One run at a time per repository: React can mount Today twice (StrictMode, a
 * fast re-navigation) and two concurrent draws would each see an empty card
 * table and charge the counter for the same ten words.
 */
const inFlight = new WeakMap<Repository, Promise<TodaySummary>>();

async function run(input: TodayInput): Promise<TodaySummary> {
  const now = input.now ?? Date.now();
  const source = input.source ?? getEntrySource();
  const repo = input.repo;

  const lists = await ensureSystemLists(repo);
  const settings = await repo.getSettings();
  const cards = await repo.allCards();

  const first = buildQueue({ now, cards, settings });

  let created: CardRow[] = [];
  let after = settings;
  let drawError: string | undefined;
  let drew = false;
  if (input.introduce !== false && first.drawLimit > 0) {
    drew = true;
    try {
      const candidates = await collectDrawCandidates({
        repo,
        settings,
        lists,
        limit: first.drawLimit,
        cards,
        source,
      });
      if (candidates.length > 0) {
        // Read after the draw, not before: the source only knows the snapshot
        // once it has fetched something from it.
        const dictVersion = source.dictVersion?.();
        const outcome = await introduceCards(repo, candidates, {
          now,
          source,
          settings,
          // The draw has just read the dictionary, so the source knows which
          // snapshot these rows came from; without it the card records
          // 'unknown' and can never be re-checked against a rebuilt dictionary.
          ...(dictVersion === undefined ? {} : { dictVersion }),
        });
        created = outcome.created;
        after = outcome.settings;
      }
    } catch (error) {
      // `data/` is missing or the route is down. The due cards are local and
      // still valid, so the page renders with a note instead of an error.
      drawError = error instanceof Error ? error.message : String(error);
    }
  }

  // The card table is re-read whenever a draw ran, rather than assumed to be
  // what was read plus what this call created. A second tab introducing the
  // same words a moment earlier leaves `created` empty here — its cards are
  // today's all the same, and a page reporting "0 new" over four rows in the
  // database would send the learner to a review it says is empty.
  const settled = drew ? await repo.allCards() : cards;
  const queue = buildQueue({ now, cards: settled, settings: after });

  return {
    now,
    settings: after,
    lists,
    queue,
    due: queue.due,
    newCards: queue.newCards,
    created,
    dueCount: queue.due.length,
    newCount: queue.newCards.length,
    introducedToday: queue.introducedToday,
    newPerDay: queue.newPerDay,
    ...(drawError === undefined ? {} : { drawError }),
  };
}

export function loadToday(input: TodayInput): Promise<TodaySummary> {
  const pending = inFlight.get(input.repo);
  if (pending) return pending;
  const started = run(input).finally(() => {
    inFlight.delete(input.repo);
  });
  inFlight.set(input.repo, started);
  return started;
}
