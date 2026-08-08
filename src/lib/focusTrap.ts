const FOCUSABLE_SELECTOR =
  'a[href], button, input, select, textarea, summary, [contenteditable]:not([contenteditable="false"]), [tabindex]';
const KEYBOARD_SHORTCUT_TARGET_SELECTOR = 'input, textarea, select, button, summary, a';

function isHiddenByClosedDetails(element: HTMLElement): boolean {
  let ancestor = element.parentElement;
  while (ancestor) {
    if (ancestor.matches('details:not([open])')) {
      const summary = Array.from(ancestor.children).find((child) =>
        child.matches('summary'),
      );
      if (!summary?.contains(element)) return true;
    }
    ancestor = ancestor.parentElement;
  }
  return false;
}

export function canRestoreFocus(element: HTMLElement): boolean {
  return (
    element.isConnected &&
    !element.matches(':disabled') &&
    !element.closest('[inert], [aria-hidden="true"], [hidden]') &&
    !isHiddenByClosedDetails(element)
  );
}

function focusableControls(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (control) =>
      control.tabIndex >= 0 &&
      !control.matches('input[type="hidden"]') &&
      canRestoreFocus(control),
  );
}

export function shouldAutoFocusFormControl(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return !window.matchMedia('(pointer: coarse)').matches;
}

export function isKeyboardShortcutTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.matches(KEYBOARD_SHORTCUT_TARGET_SELECTOR))
  );
}

export function focusFirstControl(root: HTMLElement) {
  (focusableControls(root)[0] ?? root).focus({ preventScroll: true });
}

type TabFocusEvent = Pick<KeyboardEvent, 'key' | 'shiftKey' | 'preventDefault'>;

export function trapTabFocusWithin(root: HTMLElement, event: TabFocusEvent) {
  if (event.key !== 'Tab') return;

  const controls = focusableControls(root);
  const firstControl = controls[0];
  const lastControl = controls.at(-1);
  if (!firstControl || !lastControl) {
    event.preventDefault();
    root.focus({ preventScroll: true });
    return;
  }

  const activeElement = document.activeElement;
  if (
    !root.contains(activeElement) ||
    (activeElement !== root && !controls.includes(activeElement as HTMLElement))
  ) {
    event.preventDefault();
    (event.shiftKey ? lastControl : firstControl).focus({ preventScroll: true });
  } else if (event.shiftKey && (activeElement === firstControl || activeElement === root)) {
    event.preventDefault();
    lastControl.focus({ preventScroll: true });
  } else if (!event.shiftKey && (activeElement === lastControl || activeElement === root)) {
    event.preventDefault();
    firstControl.focus({ preventScroll: true });
  }
}
