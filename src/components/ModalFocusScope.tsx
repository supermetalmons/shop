import {
  useEffect,
  useLayoutEffect,
  useRef,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  canRestoreFocus,
  focusFirstControl,
  trapTabFocusWithin,
} from '../lib/focusTrap';

type ModalFocusScopeProps = Omit<
  HTMLAttributes<HTMLDivElement>,
  'aria-hidden' | 'aria-label' | 'aria-modal' | 'inert' | 'role' | 'tabIndex'
> & {
  ariaLabel: string;
  children: ReactNode;
  enabled?: boolean;
  focusTarget?: 'first-control' | 'scope';
  focusKey?: string | number;
  onEscape?: () => void;
  suspended?: boolean;
};

export function shouldMoveFocusIntoModalScope({
  enabled,
  suspended,
  activeElementIsScope,
  activeElementIsInScope,
  activeElementIsTabbable,
}: {
  enabled: boolean;
  suspended: boolean;
  activeElementIsScope: boolean;
  activeElementIsInScope: boolean;
  activeElementIsTabbable: boolean;
}): boolean {
  return (
    enabled &&
    !suspended &&
    (activeElementIsScope || !activeElementIsInScope || !activeElementIsTabbable)
  );
}

function focusModalScope(
  dialog: HTMLDivElement,
  focusTarget: 'first-control' | 'scope',
) {
  if (focusTarget === 'scope') {
    dialog.focus({ preventScroll: true });
    return;
  }
  focusFirstControl(dialog);
}

export function useModalFocusScope({
  dialogRef,
  enabled = true,
  focusTarget = 'first-control',
  focusKey,
  onEscape,
  suspended = false,
}: {
  dialogRef: RefObject<HTMLDivElement | null>;
  enabled?: boolean;
  focusTarget?: 'first-control' | 'scope';
  focusKey?: string | number;
  onEscape?: () => void;
  suspended?: boolean;
}) {
  const interactionActiveRef = useRef(enabled && !suspended);
  interactionActiveRef.current = enabled && !suspended;

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    const activeElement = document.activeElement;
    const activeHtmlElement =
      activeElement instanceof HTMLElement ? activeElement : null;
    if (
      !dialog ||
      dialog.closest('[inert]') ||
      !shouldMoveFocusIntoModalScope({
        enabled,
        suspended,
        activeElementIsScope: activeElement === dialog,
        activeElementIsInScope: dialog.contains(activeElement),
        activeElementIsTabbable: Boolean(
          activeHtmlElement &&
            activeHtmlElement.tabIndex >= 0 &&
            canRestoreFocus(activeHtmlElement),
        ),
      })
    ) {
      return;
    }
    focusModalScope(dialog, focusTarget);
  }, [dialogRef, enabled, focusKey, focusTarget, suspended]);

  useEffect(() => {
    if (!enabled || suspended) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !interactionActiveRef.current) return;
      const dialog = dialogRef.current;
      if (!dialog || dialog.closest('[inert]')) return;
      if (event.key === 'Tab') {
        trapTabFocusWithin(dialog, event);
      } else if (event.key === 'Escape' && onEscape) {
        event.preventDefault();
        onEscape();
      }
    };
    const onFocusIn = (event: FocusEvent) => {
      if (!interactionActiveRef.current) return;
      const dialog = dialogRef.current;
      if (!dialog || dialog.closest('[inert]') || dialog.contains(event.target as Node | null)) {
        return;
      }
      focusModalScope(dialog, focusTarget);
    };

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [dialogRef, enabled, focusTarget, onEscape, suspended]);
}

export function ModalFocusScope({
  ariaLabel,
  children,
  enabled = true,
  focusTarget = 'first-control',
  focusKey,
  onEscape,
  suspended = false,
  ...props
}: ModalFocusScopeProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useModalFocusScope({
    dialogRef,
    enabled,
    focusTarget,
    focusKey,
    onEscape,
    suspended,
  });

  return (
    <div
      {...props}
      ref={dialogRef}
      role={enabled ? 'dialog' : undefined}
      aria-modal={enabled && !suspended ? 'true' : undefined}
      aria-hidden={enabled && suspended ? 'true' : undefined}
      aria-label={enabled ? ariaLabel : undefined}
      inert={enabled && suspended ? true : undefined}
      tabIndex={enabled ? -1 : undefined}
    >
      {children}
    </div>
  );
}
