export function subscribeBrowserRefreshEvents(
  listener: () => void,
  { online = false }: { online?: boolean } = {},
): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};
  window.addEventListener('focus', listener);
  if (online) window.addEventListener('online', listener);
  document.addEventListener('visibilitychange', listener);
  return () => {
    window.removeEventListener('focus', listener);
    if (online) window.removeEventListener('online', listener);
    document.removeEventListener('visibilitychange', listener);
  };
}
