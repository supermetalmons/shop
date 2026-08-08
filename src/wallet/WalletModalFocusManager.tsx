import { useEffect } from 'react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { focusFirstControl, trapTabFocusWithin } from '../lib/focusTrap';
import { useBackgroundBlur } from '../components/BackgroundBlurLayer';
import { prepareWalletModalDialog } from './walletModalFocus';

export function WalletModalFocusManager() {
  const { visible } = useWalletModal();
  useBackgroundBlur({ open: visible, active: visible, radius: 2 });

  useEffect(() => {
    if (!visible) return undefined;

    let dialog: HTMLElement | null = null;
    const focusPreferredControl = () => {
      if (!dialog?.isConnected) return;
      const preferredControl = prepareWalletModalDialog(dialog);
      if (preferredControl) {
        try {
          preferredControl.focus({ preventScroll: true });
        } catch {}
        if (dialog.contains(document.activeElement)) return;
      }
      focusFirstControl(dialog);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== 'Tab' || !dialog?.isConnected) return;
      trapTabFocusWithin(dialog, event);
    };
    const handleFocusIn = (event: FocusEvent) => {
      if (!dialog?.isConnected || dialog.contains(event.target as Node | null)) return;
      focusPreferredControl();
    };
    const frameId = window.requestAnimationFrame(() => {
      dialog = document.querySelector<HTMLElement>(
        '.wallet-adapter-modal[role="dialog"]',
      );
      if (!dialog) return;
      document.addEventListener('keydown', handleKeyDown);
      document.addEventListener('focusin', handleFocusIn);
      if (!dialog.contains(document.activeElement)) {
        focusPreferredControl();
      }
    });

    return () => {
      window.cancelAnimationFrame(frameId);
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('focusin', handleFocusIn);
    };
  }, [visible]);

  return null;
}
