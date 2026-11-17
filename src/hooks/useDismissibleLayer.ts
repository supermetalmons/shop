import { useEffect, type RefObject } from 'react';

export function useDismissibleLayer<T extends HTMLElement>({
  open,
  rootRef,
  setOpen,
  touchStart,
  escapeBehavior,
}: {
  open: boolean;
  rootRef: RefObject<T | null>;
  setOpen: (open: boolean) => void;
  touchStart: boolean;
  escapeBehavior: 'consume-unhandled' | 'always';
}): void {
  useEffect(() => {
    if (!open || typeof document === 'undefined') return;
    const onOutsideDown = (event: MouseEvent | TouchEvent) => {
      const root = rootRef.current;
      if (root && !root.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (escapeBehavior === 'consume-unhandled') {
        if (event.defaultPrevented) return;
        event.preventDefault();
      }
      setOpen(false);
    };
    document.addEventListener('mousedown', onOutsideDown);
    if (touchStart) document.addEventListener('touchstart', onOutsideDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onOutsideDown);
      if (touchStart) document.removeEventListener('touchstart', onOutsideDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, rootRef, setOpen, touchStart, escapeBehavior]);
}
