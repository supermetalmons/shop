import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

export function useHomePageScrollRestoration(currentPath: string): () => void {
  const previousPathRef = useRef(currentPath);
  const homeScrollYRef = useRef(
    currentPath === '/' && typeof window !== 'undefined' ? window.scrollY : 0,
  );
  const homeScrollCaptureActiveRef = useRef(currentPath === '/');
  const restoreHomeOnNextNavigationRef = useRef(false);
  const restoreHomeOnNextNavigation = useCallback(() => {
    restoreHomeOnNextNavigationRef.current = true;
  }, []);

  useEffect(() => {
    if (currentPath !== '/') return;

    const captureHomeScroll = () => {
      if (!homeScrollCaptureActiveRef.current) return;
      homeScrollYRef.current = window.scrollY;
    };

    captureHomeScroll();
    window.addEventListener('scroll', captureHomeScroll, { passive: true });
    return () => window.removeEventListener('scroll', captureHomeScroll);
  }, [currentPath]);

  useLayoutEffect(() => {
    homeScrollCaptureActiveRef.current = currentPath === '/';
    const previousPath = previousPathRef.current;
    if (previousPath === currentPath) return;

    previousPathRef.current = currentPath;

    if (previousPath === '/' && currentPath !== '/') {
      window.scrollTo({ top: 0, left: 0 });
      return;
    }

    if (previousPath !== '/' && currentPath === '/') {
      if (!restoreHomeOnNextNavigationRef.current) return;
      restoreHomeOnNextNavigationRef.current = false;
      const homeScrollY = homeScrollYRef.current;
      const restoreHomeScroll = () => {
        window.scrollTo({ top: homeScrollY, left: 0 });
      };

      restoreHomeScroll();
      const frameId = window.requestAnimationFrame(restoreHomeScroll);
      const timeoutId = window.setTimeout(restoreHomeScroll, 0);
      return () => {
        window.cancelAnimationFrame(frameId);
        window.clearTimeout(timeoutId);
      };
    }
  }, [currentPath]);

  return restoreHomeOnNextNavigation;
}
