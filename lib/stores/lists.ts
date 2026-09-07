'use client';

/**
 * Lists store. Phase 3 owns the queue wiring; Phase 0 owns the shape.
 */

import { create } from 'zustand';

import type { ListRow, SettingsRow } from '@/lib/db/schema';

export interface ListsState {
  lists: ListRow[];
  settings?: SettingsRow;
  loading: boolean;
  error?: string;
  load: () => Promise<void>;
  setActive: (id: string, active: boolean) => Promise<void>;
  updateSettings: (patch: Partial<Omit<SettingsRow, 'id' | 'createdAt'>>) => Promise<void>;
}

export const useListsStore = create<ListsState>((set, get) => ({
  lists: [],
  settings: undefined,
  loading: false,
  error: undefined,
  load: async () => {
    set({ loading: true, error: undefined });
    try {
      const { getRepository } = await import('@/lib/db/get-db');
      const repo = getRepository();
      const [lists, settings] = await Promise.all([repo.lists(), repo.getSettings()]);
      set({ lists, settings, loading: false });
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  },
  setActive: async (id, active) => {
    const { getRepository } = await import('@/lib/db/get-db');
    await getRepository().setListActive(id, active);
    await get().load();
  },
  updateSettings: async (patch) => {
    const { getRepository } = await import('@/lib/db/get-db');
    const settings = await getRepository().setSettings(patch);
    set({ settings });
  },
}));
