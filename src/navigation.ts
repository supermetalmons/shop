const NAVIGATION_EVENT = 'mons:navigate';

export const normalizePathname = (pathname: string): string => {
  const normalized = pathname.replace(/\/+$/, '');
  return normalized || '/';
};

const buildUrl = (pathname: string): string => {
  return normalizePathname(pathname.startsWith('/') ? pathname : `/${pathname}`);
};

const getNormalizedPathname = (pathname = window.location.pathname): string =>
  normalizePathname(pathname);

export function withoutNfcScan(state: History['state']) {
  if (!state || !Object.hasOwn(state, 'nfcScan')) return state;
  const { nfcScan: _entry, ...rest } = state;
  return rest;
}

export const navigate = (pathname: string, options?: { replace?: boolean }): void => {
  const targetPath = normalizePathname(pathname.startsWith('/') ? pathname : `/${pathname}`);
  if (getNormalizedPathname() === targetPath) return;

  const url = buildUrl(targetPath);
  const state = withoutNfcScan(window.history.state);
  if (options?.replace) {
    window.history.replaceState(state, '', url);
  } else {
    window.history.pushState(state, '', url);
  }

  window.dispatchEvent(new Event(NAVIGATION_EVENT));
};

export const subscribeToNavigation = (onChange: () => void): (() => void) => {
  window.addEventListener('popstate', onChange);
  window.addEventListener('pageshow', onChange);
  window.addEventListener(NAVIGATION_EVENT, onChange);

  return () => {
    window.removeEventListener('popstate', onChange);
    window.removeEventListener('pageshow', onChange);
    window.removeEventListener(NAVIGATION_EVENT, onChange);
  };
};
