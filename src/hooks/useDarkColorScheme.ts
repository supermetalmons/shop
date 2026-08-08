import { useSyncExternalStore } from 'react';

const DARK_COLOR_SCHEME_QUERY = '(prefers-color-scheme: dark)';

type DarkColorSchemeStore = {
  getSnapshot: () => boolean;
  subscribe: (subscriber: () => void) => () => void;
};

function observeMediaQuery(media: MediaQueryList, onChange: () => void): () => void {
  if (
    typeof media.addEventListener === 'function' &&
    typeof media.removeEventListener === 'function'
  ) {
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }
  if (typeof media.addListener === 'function' && typeof media.removeListener === 'function') {
    media.addListener(onChange);
    return () => media.removeListener(onChange);
  }
  return () => undefined;
}

export function createDarkColorSchemeStore(
  resolveMedia: () => MediaQueryList | undefined,
): DarkColorSchemeStore {
  let media: MediaQueryList | undefined;
  let stopObserving: (() => void) | undefined;
  const subscribers = new Set<() => void>();
  const getMedia = () => {
    media ??= resolveMedia();
    return media;
  };
  const notifySubscribers = () => subscribers.forEach((subscriber) => subscriber());

  return {
    getSnapshot: () => getMedia()?.matches ?? false,
    subscribe: (subscriber) => {
      subscribers.add(subscriber);
      if (subscribers.size === 1) {
        const currentMedia = getMedia();
        if (currentMedia) stopObserving = observeMediaQuery(currentMedia, notifySubscribers);
      }
      return () => {
        if (!subscribers.delete(subscriber) || subscribers.size) return;
        stopObserving?.();
        stopObserving = undefined;
      };
    },
  };
}

const darkColorSchemeStore = createDarkColorSchemeStore(() => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
  return window.matchMedia(DARK_COLOR_SCHEME_QUERY);
});

function lightColorSchemeServerSnapshot(): boolean {
  return false;
}

export function useDarkColorScheme(): boolean {
  return useSyncExternalStore(
    darkColorSchemeStore.subscribe,
    darkColorSchemeStore.getSnapshot,
    lightColorSchemeServerSnapshot,
  );
}
