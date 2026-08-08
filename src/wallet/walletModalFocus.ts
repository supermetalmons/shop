import { canRestoreFocus } from '../lib/focusTrap';

const WALLET_MODAL_TITLE_ID = 'wallet-adapter-modal-title';

function hasAccessibleLabel(element: HTMLElement): boolean {
  return (
    Boolean(element.getAttribute('aria-label')?.trim()) ||
    Boolean(element.getAttribute('aria-labelledby')?.trim()) ||
    Boolean(element.getAttribute('title')?.trim()) ||
    Boolean(element.textContent?.trim()) ||
    Boolean(element.querySelector<HTMLImageElement>('img[alt]')?.alt.trim())
  );
}

function isVisibleWalletChoice(element: HTMLElement): boolean {
  if (
    element.tabIndex < 0 ||
    element.matches('[aria-disabled="true"]') ||
    !canRestoreFocus(element)
  ) {
    return false;
  }

  const view = element.ownerDocument?.defaultView;
  if (!view) return true;

  const style = view.getComputedStyle(element);
  return (
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    element.getClientRects().length > 0
  );
}

export function prepareWalletModalDialog(dialog: HTMLElement): HTMLElement | null {
  const title = dialog.querySelector<HTMLElement>('.wallet-adapter-modal-title');
  const labelledBy = dialog.getAttribute('aria-labelledby')?.trim();
  if (title && !title.id) {
    title.id = labelledBy?.split(/\s+/)[0] || WALLET_MODAL_TITLE_ID;
  }
  if (title?.id && !labelledBy) {
    dialog.setAttribute('aria-labelledby', title.id);
  }

  const closeButton = dialog.querySelector<HTMLElement>(
    '.wallet-adapter-modal-button-close',
  );
  if (closeButton && !hasAccessibleLabel(closeButton)) {
    closeButton.setAttribute('aria-label', 'Close wallet selector');
  }

  return (
    Array.from(
      dialog.querySelectorAll<HTMLElement>(
        '.wallet-adapter-modal-list .wallet-adapter-button',
      ),
    ).find(isVisibleWalletChoice) ?? null
  );
}
