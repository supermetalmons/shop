const DEFAULT_MONS_API_ORIGIN = 'https://api.mons.shop';

export function normalizeMonsApiOrigin(configured: unknown): string {
  const configuredOrigin = String(configured || '').trim();
  const candidate = (configuredOrigin || DEFAULT_MONS_API_ORIGIN).replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error('VITE_MONS_API_ORIGIN must be an HTTP(S) origin');
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.origin !== candidate ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('VITE_MONS_API_ORIGIN must be an HTTP(S) origin');
  }
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error('VITE_MONS_API_ORIGIN must use HTTPS outside local development');
  }
  return url.origin;
}

export function monsApiOrigin(): string {
  return normalizeMonsApiOrigin(import.meta.env?.VITE_MONS_API_ORIGIN);
}
