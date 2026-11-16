import { useEffect, useState, type RefObject } from 'react';

export function useNearViewport(
  target: RefObject<Element | null>,
  { alwaysActive = false }: { alwaysActive?: boolean } = {},
): boolean {
  const [active, setActive] = useState(alwaysActive);

  useEffect(() => {
    const element = target.current;
    if (alwaysActive || !element || typeof IntersectionObserver === 'undefined') {
      setActive(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => setActive(Boolean(entry?.isIntersecting)),
      { rootMargin: '160px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [alwaysActive, target]);

  return active;
}
