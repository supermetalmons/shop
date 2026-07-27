const FOCUSABLE_SELECTOR =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

export function canRestoreFocus(element: HTMLElement): boolean {
  return (
    element.isConnected &&
    !element.matches(':disabled') &&
    !element.closest('[inert], [aria-hidden="true"]')
  );
}

export function shouldAutoFocusFormControl(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return !window.matchMedia('(pointer: coarse)').matches;
}

export function focusFirstControl(root: HTMLElement) {
  (root.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ?? root).focus({ preventScroll: true });
}

type TabFocusEvent = Pick<KeyboardEvent, 'key' | 'shiftKey' | 'preventDefault'>;

export function trapTabFocusWithin(root: HTMLElement, event: TabFocusEvent) {
  if (event.key !== 'Tab') return;

  const controls = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
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
