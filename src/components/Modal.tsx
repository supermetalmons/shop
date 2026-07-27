import { type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef } from 'react';
import { acquireBodyScrollLock, releaseBodyScrollLock } from '../lib/bodyScrollLock';
import { canRestoreFocus, focusFirstControl, trapTabFocusWithin } from '../lib/focusTrap';

interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  className?: string;
  overlayClassName?: string;
  showCloseButton?: boolean;
  closeOnEscape?: boolean;
  suspended?: boolean;
  returnFocusRef?: RefObject<HTMLElement | null>;
  children: ReactNode;
}

export function Modal({
  open,
  title,
  onClose,
  className,
  overlayClassName,
  showCloseButton = true,
  closeOnEscape = true,
  suspended = false,
  returnFocusRef,
  children,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const lastFocusedOutsideRef = useRef<HTMLElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const openRef = useRef(open);
  const wasOpenRef = useRef(false);
  const lastOpenSuspendedRef = useRef(false);
  const activeRef = useRef(open && !suspended);
  openRef.current = open;
  activeRef.current = open && !suspended;

  useEffect(() => {
    const rememberFocusedElement = (event: FocusEvent) => {
      if (openRef.current || !(event.target instanceof HTMLElement) || event.target === document.body) {
        return;
      }
      lastFocusedOutsideRef.current = event.target;
    };

    if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) {
      lastFocusedOutsideRef.current = document.activeElement;
    }
    document.addEventListener('focusin', rememberFocusedElement);
    return () => document.removeEventListener('focusin', rememberFocusedElement);
  }, []);

  useLayoutEffect(() => {
    const wasOpen = wasOpenRef.current;

    if (open) {
      if (!wasOpen) {
        const dialog = dialogRef.current;
        const activeElement =
          document.activeElement instanceof HTMLElement && document.activeElement !== document.body
            ? document.activeElement
            : null;
        openerRef.current =
          returnFocusRef?.current ??
          (activeElement && !dialog?.contains(activeElement) ? activeElement : lastFocusedOutsideRef.current);
      }
      lastOpenSuspendedRef.current = suspended;
    } else if (wasOpen) {
      const target = returnFocusRef ? returnFocusRef.current : openerRef.current;
      if (!lastOpenSuspendedRef.current && target && canRestoreFocus(target)) {
        target.focus({ preventScroll: true });
      }
      openerRef.current = null;
    }

    wasOpenRef.current = open;
  }, [open, returnFocusRef, suspended]);

  useLayoutEffect(() => {
    if (!open || suspended) return;
    const dialog = dialogRef.current;
    if (!dialog || dialog.contains(document.activeElement)) return;
    focusFirstControl(dialog);
  }, [open, suspended]);

  useEffect(() => {
    if (!open) return;
    acquireBodyScrollLock();
    return () => releaseBodyScrollLock();
  }, [open]);

  useEffect(() => {
    if (!open || suspended) return;
    const onKeyDown = (evt: KeyboardEvent) => {
      if (!activeRef.current) return;
      const dialog = dialogRef.current;
      if (evt.key === 'Tab' && dialog) {
        trapTabFocusWithin(dialog, evt);
        return;
      }
      if (evt.key === 'Escape' && closeOnEscape) {
        evt.preventDefault();
        onClose();
      }
    };
    const onFocusIn = (evt: FocusEvent) => {
      if (!activeRef.current) return;
      const dialog = dialogRef.current;
      if (!dialog || dialog.contains(evt.target as Node | null)) return;
      focusFirstControl(dialog);
    };

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [closeOnEscape, onClose, open, suspended]);

  if (!open) return null;

  return (
    <div
      className={`modal-overlay${overlayClassName ? ` ${overlayClassName}` : ''}`}
      role="presentation"
      inert={suspended || undefined}
      onClick={(evt) => {
        if (!suspended && evt.target === evt.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className={`modal card${className ? ` ${className}` : ''}`}
        role="dialog"
        aria-modal={suspended ? undefined : 'true'}
        aria-hidden={suspended || undefined}
        inert={suspended || undefined}
        aria-label={title}
        data-overlay-scroll-allow=""
        tabIndex={-1}
      >
        <div className="modal__head">
          <div className="card__title">{title}</div>
          {showCloseButton ? (
            <button type="button" className="ghost" onClick={onClose}>
              Close
            </button>
          ) : null}
        </div>
        {children}
      </div>
    </div>
  );
}
