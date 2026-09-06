import { JSDOM } from 'jsdom';

export function setupFrontendDom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://mons.shop/',
    pretendToBeVisual: true,
  });
  for (const name of [
    'document', 'navigator', 'Element', 'HTMLElement', 'HTMLImageElement',
    'HTMLMediaElement', 'Node', 'MutationObserver', 'Image', 'getComputedStyle',
  ] as const) {
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true });
  for (const name of ['requestAnimationFrame', 'cancelAnimationFrame'] as const) {
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name].bind(dom.window) });
  }
  dom.window.scrollTo = () => undefined;

  const mediaQueries = new Map<string, { media: MediaQueryList; setMatches: (matches: boolean) => void }>();
  dom.window.matchMedia = (query: string) => {
    let entry = mediaQueries.get(query);
    if (!entry) {
      let matches = false;
      const events = new dom.window.EventTarget();
      const media = Object.assign(events, {
        media: query,
        get matches() { return matches; },
        onchange: null,
        addListener(listener: EventListener) { events.addEventListener('change', listener); },
        removeListener(listener: EventListener) { events.removeEventListener('change', listener); },
      }) as unknown as MediaQueryList;
      Object.defineProperty(media, 'matches', { get: () => matches });
      entry = {
        media,
        setMatches(next) {
          if (matches === next) return;
          matches = next;
          media.dispatchEvent(Object.assign(new dom.window.Event('change'), { matches, media: query }));
        },
      };
      mediaQueries.set(query, entry);
    }
    return entry.media;
  };

  return {
    dom,
    setMediaQueryMatches(query: string, matches: boolean) {
      dom.window.matchMedia(query);
      mediaQueries.get(query)!.setMatches(matches);
    },
  };
}
