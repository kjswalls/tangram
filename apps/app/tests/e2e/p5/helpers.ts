import { expect, type Locator, type Page } from '@playwright/test';

import type { CardContext } from '@/lib/types';

import { ready, resetApp } from '../p3/helpers';
import { DEMO_PARAGRAPH, JIXU_SENTENCE } from './paragraph';

export { ready, resetApp, DEMO_PARAGRAPH, JIXU_SENTENCE };

/** Paste a text into `/read` and open the reading view. */
export async function readText(page: Page, body: string): Promise<void> {
  await page.goto('/read');
  await ready(page);
  await page.getByTestId('reader-input').fill(body);
  await page.getByTestId('read-text').click();
  await expect(page.getByTestId('reader-text')).toBeVisible();
  // The colouring pass lands a beat after the tokens; nothing below should read
  // a state of "unknown".
  await expect(page.getByTestId('reader-token').first()).not.toHaveAttribute(
    'data-state',
    'unknown',
  );
}

/** The first token whose text is exactly `text`. */
export function token(page: Page, text: string): Locator {
  return page.locator(`[data-testid="reader-token"][data-token="${text}"]`).first();
}

/** Every token's state, in reading order. */
export function tokenStates(page: Page): Promise<string[]> {
  return page.$$eval('[data-testid="reader-token"]', (nodes) =>
    nodes.map((node) => node.getAttribute('data-state') ?? ''),
  );
}

/** The single card in the database, for asserting what an Add actually wrote. */
export async function onlyCard(page: Page) {
  return page.evaluate(async () => {
    const cards = await window.__tangram.repo.allCards();
    return cards.map((card) => ({
      entryId: card.entryId,
      context: card.context,
      simp: (card.snapshot as { simp?: string }).simp,
    }));
  });
}

/**
 * What a card back will highlight, given the context the reader wrote: the
 * `offset`/`length` span resolved against the sentence (`lib/srs/context.ts`).
 * `''` when the context carries no locatable span, which is itself a failure.
 */
export function highlighted(context: CardContext | undefined): string {
  if (!context?.sentence || context.offset === undefined || context.length === undefined) return '';
  return context.sentence.slice(context.offset, context.offset + context.length);
}
