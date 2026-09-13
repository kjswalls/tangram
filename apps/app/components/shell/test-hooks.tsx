'use client';

import { useEffect } from 'react';

import { closeDb, getDb, getRepository } from '@/lib/db/get-db';

/**
 * Exposes the repository on `window.__tangram` so end-to-end specs can seed
 * and inspect state through `page.evaluate`. Tangram is a single-user,
 * local-first app: the data on this window is already the user's own, so
 * there is nothing to protect by hiding it. Mounted once from the root layout.
 */
export function TestHooks() {
  useEffect(() => {
    const w = window as typeof window & { __tangram?: unknown };
    w.__tangram = { get repo() { return getRepository(); }, get db() { return getDb(); }, getRepository, getDb, closeDb };
  }, []);
  return null;
}
