import { useEffect, useId, useRef } from 'react';
import { FaWallet } from 'react-icons/fa6';
import { canRestoreFocus } from '../../lib/focusTrap';
import type { HeaderWallet } from '../account/useHeaderWallet';

type ShopWalletControlProps = {
  interactive: boolean;
  model: HeaderWallet;
};

const BALANCE_FORMAT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 });
const FOCUSABLE_TARGET = 'a[href], button, input, select, textarea, label, [tabindex], [contenteditable="true"]';

function formatBalance(lamports: number): string {
  const sol = lamports / 1_000_000_000;
  return `${sol > 0 && sol < 0.0001 ? '<0.0001' : BALANCE_FORMAT.format(sol)} SOL`;
}

export function ShopWalletControl({ interactive, model }: ShopWalletControlProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const restoreAfterDisconnect = useRef(false);
  const popupId = useId();
  const open = interactive && model.open;
  const close = model.close;

  useEffect(() => {
    if (!interactive) return;
    const onFocusIn = (event: FocusEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        restoreAfterDisconnect.current = false;
      }
    };
    document.addEventListener('focusin', onFocusIn);
    return () => document.removeEventListener('focusin', onFocusIn);
  }, [interactive]);

  useEffect(() => {
    if (!restoreAfterDisconnect.current) return;
    if (!interactive || (!open && model.address)) {
      restoreAfterDisconnect.current = false;
      return;
    }
    if (model.disconnecting || (open ? !model.disconnectError : model.buttonDisabled)) return;
    restoreAfterDisconnect.current = false;
    const target = open ? popupRef.current : buttonRef.current;
    if (document.activeElement === document.body && target && canRestoreFocus(target)) {
      target.focus({ preventScroll: true });
    }
  }, [interactive, model.address, model.buttonDisabled, model.disconnectError, model.disconnecting, open]);

  useEffect(() => {
    if (!open) return;
    popupRef.current?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !rootRef.current?.contains(document.activeElement)) return;
      event.preventDefault();
      event.stopPropagation();
      restoreAfterDisconnect.current = false;
      close();
      buttonRef.current?.focus({ preventScroll: true });
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || rootRef.current?.contains(target)) return;
      restoreAfterDisconnect.current = false;
      const popup = popupRef.current;
      const hadFocus = popup?.contains(document.activeElement);
      const claimsFocus = target instanceof Element && target.closest(FOCUSABLE_TARGET);
      close();
      if (hadFocus && !claimsFocus) {
        window.requestAnimationFrame(() => {
          if (document.activeElement === document.body || popup?.contains(document.activeElement)) {
            buttonRef.current?.focus({ preventScroll: true });
          }
        });
      }
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [close, open]);

  return (
    <div className="top__wallet-control" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className={`top__settings top__wallet-button${open ? ' top__settings--active' : ''}`}
        onClick={interactive ? () => { void model.activate(); } : undefined}
        disabled={!interactive || model.buttonDisabled}
        tabIndex={interactive ? undefined : -1}
        aria-label={interactive ? 'Wallet' : undefined}
        aria-haspopup={interactive ? 'dialog' : undefined}
        aria-controls={open ? popupId : undefined}
        aria-expanded={interactive ? open : undefined}
        data-background-blur-focus-fallback={interactive ? '' : undefined}
      >
        <FaWallet
          size={16}
          fill="none"
          stroke="currentColor"
          strokeWidth={48}
          strokeLinejoin="round"
          viewBox="-24 8 560 496"
          aria-hidden
        />
      </button>
      {open ? (
        <div ref={popupRef} id={popupId} className="top__wallet-popup" role="dialog" aria-label="Wallet" tabIndex={-1}>
          {model.address ? (
            <div className="top__wallet-address" title={model.address} aria-label={`Solana wallet ${model.address}`}>
              {model.address.slice(0, 6)}…{model.address.slice(-4)}
            </div>
          ) : null}
          <div className="top__wallet-balance" aria-busy={model.balanceLoading}>
            <div className="top__wallet-caption">Mainnet balance</div>
            <div className="top__wallet-balance-value" aria-live="polite">
              {model.balanceError ? (
                <>
                  <span className="top__wallet-caption">Balance unavailable</span>
                  <button type="button" className="top__wallet-retry" onClick={model.retryBalance} aria-label="Retry balance">Retry</button>
                </>
              ) : model.balanceLamports !== undefined ? formatBalance(model.balanceLamports) : model.balanceLoading ? 'Loading balance…' : '—'}
            </div>
          </div>
          {model.disconnectError ? <div className="top__wallet-error" role="alert">{model.disconnectError}</div> : null}
          <button
            type="button"
            className="top__wallet-disconnect"
            disabled={model.disconnectDisabled || model.disconnecting}
            onClick={() => {
              restoreAfterDisconnect.current = Boolean(popupRef.current?.contains(document.activeElement));
              void model.disconnect();
            }}
          >
            {model.disconnecting ? 'Disconnecting…' : model.disconnectError ? 'Retry disconnect' : 'Disconnect'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
