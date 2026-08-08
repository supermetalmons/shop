import { type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef } from 'react';
import { acquireBodyScrollLock, releaseBodyScrollLock } from '../lib/bodyScrollLock';
import { DEFAULT_BACKGROUND_BLUR_RADIUS } from '../lib/backgroundBlur';
import { canRestoreFocus } from '../lib/focusTrap';
import { BodyPortal, useBackgroundBlur } from './BackgroundBlurLayer';
import { useModalFocusScope } from './ModalFocusScope';

interface ModalProps {
  open: boolean;
  title: string;
  ariaLabel?: string;
  titleAbove?: ReactNode;
  onClose: () => void;
  className?: string;
  overlayClassName?: string;
  showCloseButton?: boolean;
  closeOnEscape?: boolean;
  blurBackground?: boolean;
  blurRadius?: number;
  suspended?: boolean;
  returnFocusRef?: RefObject<HTMLElement | null>;
  children: ReactNode;
}

export function Modal({
  open,
  title,
  ariaLabel,
  titleAbove,
  onClose,
  className,
  overlayClassName,
  showCloseButton = true,
  closeOnEscape = true,
  blurBackground = false,
  blurRadius = DEFAULT_BACKGROUND_BLUR_RADIUS,
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
  openRef.current = open;
  useBackgroundBlur({
    open: blurBackground && open && !suspended,
    active: blurBackground && open && !suspended,
    radius: blurRadius,
  });

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

  useEffect(() => {
    if (!open) return;
    acquireBodyScrollLock();
    return () => releaseBodyScrollLock();
  }, [open]);

  useModalFocusScope({
    dialogRef,
    enabled: open,
    onEscape: closeOnEscape ? onClose : undefined,
    suspended,
  });

  if (!open) return null;

  return (
    <BodyPortal>
      <div
        className={`modal-overlay${overlayClassName ? ` ${overlayClassName}` : ''}${
          suspended ? ' modal-overlay--suspended' : ''
        }`}
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
          aria-label={ariaLabel || title}
          data-overlay-scroll-allow=""
          tabIndex={-1}
        >
          <div className="modal__head">
            <div className="modal__title">
              {titleAbove ? (
                <div className="modal__title-above" aria-hidden="true">
                  {titleAbove}
                </div>
              ) : null}
              <div className="card__title">{title}</div>
            </div>
            {showCloseButton ? (
              <button type="button" className="ghost" onClick={onClose}>
                Close
              </button>
            ) : null}
          </div>
          {children}
        </div>
      </div>
    </BodyPortal>
  );
}
