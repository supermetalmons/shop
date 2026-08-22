export function canonicalProductionUrl(href: string): string | null {
  const url = new URL(href);
  if (url.hostname !== 'www.mons.shop') return null;
  url.hostname = 'mons.shop';
  return url.href;
}
