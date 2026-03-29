const NAVIGATION_EVENT = 'mons:navigate';

const normalizePathname = (pathname: string): string => {
  const normalized = pathname.replace(/\/+$/, '');
  return normalized || '/';
};

const buildUrl = (pathname: string): string => {
  return normalizePathname(pathname.startsWith('/') ? pathname : `/${pathname}`);
};

export const getNormalizedPathname = (pathname = window.location.pathname): string => normalizePathname(pathname);

export const navigate = (pathname: string, options?: { replace?: boolean }): void => {
  const targetPath = normalizePathname(pathname.startsWith('/') ? pathname : `/${pathname}`);
  if (getNormalizedPathname() === targetPath) return;

  const url = buildUrl(targetPath);
  if (options?.replace) {
    window.history.replaceState(window.history.state, '', url);
  } else {
    window.history.pushState(window.history.state, '', url);
  }

  window.dispatchEvent(new Event(NAVIGATION_EVENT));
};

export const subscribeToNavigation = (onChange: () => void): (() => void) => {
  window.addEventListener('popstate', onChange);
  window.addEventListener(NAVIGATION_EVENT, onChange);

  return () => {
    window.removeEventListener('popstate', onChange);
    window.removeEventListener(NAVIGATION_EVENT, onChange);
  };
};
