import { getDrifCardVisualAssetSources, type DrifCardConfig } from '../drifCards.ts';
import { loadMiNoteCardAssets, type MiNoteCardAssetResidency } from './miNoteCardAssets.ts';

type AssetState = {
  ready: boolean;
  error: Error | null;
};

type AssetEntry = {
  key: string;
  state: AssetState;
  controller: AbortController | null;
  residency: MiNoteCardAssetResidency | null;
  listeners: Set<() => void>;
};

const pendingState: AssetState = { ready: false, error: null };
const readyState: AssetState = { ready: true, error: null };
const idleEntryLimit = 3;

function assetKey(card: DrifCardConfig) {
  return JSON.stringify(getDrifCardVisualAssetSources(card));
}

export function createDrifCardVisualAssetsCache(loadAssets = loadMiNoteCardAssets) {
  const entries = new Map<string, AssetEntry>();

  const dispose = (entry: AssetEntry) => {
    entries.delete(entry.key);
    entry.controller?.abort();
    entry.residency?.release();
    entry.controller = null;
    entry.residency = null;
  };

  const trim = () => {
    const idle = [...entries.values()].filter((entry) => entry.listeners.size === 0);
    idle.slice(0, Math.max(0, idle.length - idleEntryLimit)).forEach(dispose);
  };

  const touch = (entry: AssetEntry) => {
    entries.delete(entry.key);
    entries.set(entry.key, entry);
  };

  const notify = (entry: AssetEntry) => {
    entry.listeners.forEach((listener) => listener());
  };

  const start = (entry: AssetEntry, card: DrifCardConfig) => {
    if (entry.state.ready || entry.controller) return;
    const controller = new AbortController();
    entry.controller = controller;
    entry.state = pendingState;
    notify(entry);
    const current = () => entries.get(entry.key) === entry && entry.controller === controller;
    const fail = (error: unknown) => {
      if (!current()) return;
      entry.controller = null;
      entry.state = { ready: false, error: error instanceof Error ? error : new Error('Unable to preload card assets.') };
      notify(entry);
    };
    try {
      void loadAssets([card], { signal: controller.signal }).then((residency) => {
        if (!current()) {
          residency.release();
          return;
        }
        entry.controller = null;
        entry.residency = residency;
        entry.state = readyState;
        notify(entry);
      }, fail);
    } catch (error) {
      fail(error);
    }
  };

  const getEntry = (card: DrifCardConfig) => {
    const key = assetKey(card);
    let entry = entries.get(key);
    if (!entry) {
      entry = { key, state: pendingState, controller: null, residency: null, listeners: new Set() };
    }
    touch(entry);
    return entry;
  };

  return {
    preload(card: DrifCardConfig) {
      const entry = getEntry(card);
      start(entry, card);
      trim();
    },
    getSnapshot(card: DrifCardConfig | undefined): AssetState {
      return card ? entries.get(assetKey(card))?.state ?? pendingState : pendingState;
    },
    subscribe(card: DrifCardConfig | undefined, listener: () => void) {
      if (!card) return () => {};
      const entry = getEntry(card);
      entry.listeners.add(listener);
      start(entry, card);
      trim();
      return () => {
        entry.listeners.delete(listener);
        if (entries.get(entry.key) !== entry) return;
        touch(entry);
        trim();
      };
    },
    clear() {
      const previous = [...entries.values()];
      previous.forEach(dispose);
      previous.forEach(notify);
    },
  };
}
