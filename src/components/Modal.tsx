import { ReactNode, useEffect, useLayoutEffect, useRef } from 'react';

let activeModalScrollLocks = 0;
let previousBodyOverflow: string | undefined;

function acquireModalScrollLock() {
  if (activeModalScrollLocks === 0) {
    previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  activeModalScrollLocks += 1;
}

function releaseModalScrollLock() {
  if (activeModalScrollLocks === 0) return;
  activeModalScrollLocks -= 1;
  if (activeModalScrollLocks !== 0) return;
  document.body.style.overflow = previousBodyOverflow ?? '';
  previousBodyOverflow = undefined;
}

interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  className?: string;
  showCloseButton?: boolean;
  closeOnEscape?: boolean;
  focusDialogOnOpen?: boolean;
  children: ReactNode;
}

export function Modal({
  open,
  title,
  onClose,
  className,
  showCloseButton = true,
  closeOnEscape = true,
  focusDialogOnOpen = false,
  children,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (!open || !focusDialogOnOpen) return;
    const dialog = dialogRef.current;
    if (!dialog || dialog.contains(document.activeElement)) return;
    dialog.focus({ preventScroll: true });
  }, [focusDialogOnOpen, open]);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (evt: KeyboardEvent) => {
      if (evt.key === 'Escape' && closeOnEscape) {
        evt.preventDefault();
        onClose();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    acquireModalScrollLock();

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      releaseModalScrollLock();
    };
  }, [closeOnEscape, open, onClose]);

  if (!open) return null;

  return (
    <div
      className="modal-overlay"
      role="presentation"
      onClick={(evt) => {
        if (evt.target === evt.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className={`modal card${className ? ` ${className}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={focusDialogOnOpen ? -1 : undefined}
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
