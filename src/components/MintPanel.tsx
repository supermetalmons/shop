import { type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { FaCircleQuestion } from 'react-icons/fa6';
import { LuInfo } from 'react-icons/lu';
import type { PackStatusBreakdown, PackStatusDisplayLabels } from '../types';
import { resolveDropSizeGuide } from '../lib/dropSizeGuide';
import { resolveDropXProfile } from '../lib/dropSocialLinks';
import { secondaryMarketplaceLinksForDropId } from '../config/deployment';
import { useMintPanelForm, type MintPanelFormOptions } from '../shop/purchase/useMintPanelForm';
import { MintPanelActions } from './MintPanelActions';
import { MintPreview, type MintPanelBoxMedia } from './MintPreview';

export type { MintPanelBoxMedia } from './MintPreview';

type MintPanelTerminalButton = {
  key?: string;
  buttonText: string;
  href?: string;
  onClick?: () => void;
};

type MintPanelTerminalAction = {
  statusText: string;
  buttonText?: string;
  href?: string;
  onClick?: () => void;
  buttons?: MintPanelTerminalButton[];
};

interface MintPanelProps extends MintPanelFormOptions {
  title?: string;
  boxMedia?: MintPanelBoxMedia;
  dropId?: string;
  receiptPoolId?: string;
  terminalAction?: MintPanelTerminalAction;
  onNotifyNextDrops?: () => void;
  showPackStatusInfo?: boolean;
  packStatusBreakdown?: PackStatusBreakdown;
  packStatusDisplayLabels?: PackStatusDisplayLabels;
}

const MONS_SHOP_RECEIPTS_POOL_ID = 'mons_shop_receipts';
const PACK_STATUS_NUMBER_FORMATTER = new Intl.NumberFormat('en-US', { useGrouping: false });

function XProfileLogo() {
  return (
    <svg viewBox="26.8 48 460.2 416" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M389.2 48h70.6L305.6 224.2 487 464H345L233.7 318.6 106.5 464H35.8L200.7 275.5 26.8 48H172.4L272.9 180.9 389.2 48zM364.4 421.8h39.1L151.1 88h-42L364.4 421.8z"
      />
    </svg>
  );
}

function useDismissiblePopover<T extends HTMLElement>(
  open: boolean,
  rootRef: RefObject<T | null>,
  setOpen: (open: boolean) => void,
): void {
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (evt: MouseEvent) => {
      const root = rootRef.current;
      if (root && !root.contains(evt.target as Node)) setOpen(false);
    };
    const onKeyDown = (evt: KeyboardEvent) => {
      if (evt.key !== 'Escape' || evt.defaultPrevented) return;
      evt.preventDefault();
      setOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, rootRef, setOpen]);
}

function formatPackStatusAmount(amount: number): string {
  return PACK_STATUS_NUMBER_FORMATTER.format(Math.max(0, Math.floor(Number(amount) || 0)));
}

const DEFAULT_PACK_STATUS_DISPLAY_LABELS: PackStatusDisplayLabels = {
  itemColumnLabel: 'Cards',
  ariaLabel: 'Card status',
};

function MintPanelPackStatusPopover({
  breakdown,
  displayLabels = DEFAULT_PACK_STATUS_DISPLAY_LABELS,
}: {
  breakdown?: PackStatusBreakdown;
  displayLabels?: PackStatusDisplayLabels;
}) {
  return (
    <div className="mint-panel__pack-status-popover" role="dialog" aria-label={displayLabels.ariaLabel} aria-busy={!breakdown}>
      {breakdown ? (
        <table className="mint-panel__pack-status-table">
          <thead>
            <tr>
              <th scope="col" aria-label="Status" />
              <th scope="col">{displayLabels.itemColumnLabel}</th>
            </tr>
          </thead>
          <tbody>
            {breakdown.items.map((item) => (
              <tr key={item.key} className={item.key === 'total' ? 'mint-panel__pack-status-row--total' : undefined}>
                <th scope="row">{item.label}</th>
                <td>{formatPackStatusAmount(item.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="mint-panel__pack-status-loading">LOADING</div>
      )}
    </div>
  );
}

export function MintPanel({
  title, boxMedia, dropId, receiptPoolId, terminalAction, onNotifyNextDrops,
  showPackStatusInfo, packStatusBreakdown,
  packStatusDisplayLabels = DEFAULT_PACK_STATUS_DISPLAY_LABELS,
  ...formOptions
}: MintPanelProps) {
  const form = useMintPanelForm(formOptions);
  const {
    total, remaining, remainingReady, soldOut, quantity, setQuantity, quantityLabel,
    maxSelectable, sizeOptions, sizeAvailability, selectedSize, toggleSize,
    sizeBlinkToken, isBlinking, showSizeSelector, showQuantitySlider, showFormControls,
    controlsBusy,
  } = form;
  const formId = 'mint-form';
  const sizeGuide = showSizeSelector ? resolveDropSizeGuide(dropId) : null;
  const showPackStatusControl = Boolean(showPackStatusInfo || packStatusBreakdown);
  const [sizeInfoOpen, setSizeInfoOpen] = useState(false);
  const [packStatusInfoOpen, setPackStatusInfoOpen] = useState(false);
  const sizeInfoRef = useRef<HTMLDivElement | null>(null);
  const packStatusInfoRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!showSizeSelector && sizeInfoOpen) setSizeInfoOpen(false);
  }, [showSizeSelector, sizeInfoOpen]);

  useEffect(() => {
    if (!showPackStatusControl && packStatusInfoOpen) setPackStatusInfoOpen(false);
  }, [showPackStatusControl, packStatusInfoOpen]);

  useDismissiblePopover(sizeInfoOpen, sizeInfoRef, setSizeInfoOpen);
  useDismissiblePopover(packStatusInfoOpen, packStatusInfoRef, setPackStatusInfoOpen);

  const mintTitle = title || 'Little Swag Boxes';
  const dropXProfile = resolveDropXProfile(dropId);
  const dropXProfileLink = dropXProfile ? (
    <a
      className="mint-panel__social-link"
      href={dropXProfile.href}
      target="_blank"
      rel="noreferrer"
      aria-label={`Open ${dropXProfile.handle} on X`}
    >
      <XProfileLogo />
    </a>
  ) : null;
  const dropTitle = (
    <div className="mint-panel__price">
      <span className="mint-panel__drop-name">{mintTitle}</span>
      {dropXProfileLink}
    </div>
  );
  const soldOutButtons = useMemo<MintPanelTerminalButton[]>(() => {
    return secondaryMarketplaceLinksForDropId(dropId || '').map((link) => ({
      key: link.key,
      buttonText: link.label,
      href: link.href,
    }));
  }, [dropId]);
  const isSharedReceiptPoolSoldOut = soldOut && receiptPoolId === MONS_SHOP_RECEIPTS_POOL_ID;
  const isDefaultSoldOutState = soldOut && !terminalAction && !isSharedReceiptPoolSoldOut;
  const terminalState =
    terminalAction ||
    (soldOut
      ? isSharedReceiptPoolSoldOut
        ? {
            statusText: 'Sold Out',
            buttonText: 'Notify me',
            onClick: onNotifyNextDrops,
          }
        : {
            statusText: 'Minted Out',
            buttons: soldOutButtons,
          }
      : null);
  const terminalButtons = (
    terminalState
      ? terminalState.buttons ||
        (terminalState.buttonText && (terminalState.href || terminalState.onClick)
          ? [
              {
                key: 'primary',
                buttonText: terminalState.buttonText,
                href: terminalState.href,
                onClick: terminalState.onClick,
              },
            ]
          : [])
      : []
  ).filter((button) => button.href || button.onClick);
  const terminalFooterClassName = isDefaultSoldOutState
    ? 'mint-panel__footer mint-panel__footer--soldout mint-panel__footer--marketplaces'
    : 'mint-panel__footer mint-panel__footer--soldout';
  const splitTerminalButtons = terminalButtons.length > 1;
  const terminalButtonsClassName = splitTerminalButtons
    ? terminalButtons.length > 2
      ? 'mint-panel__terminal-buttons mint-panel__terminal-buttons--split mint-panel__terminal-buttons--triple'
      : 'mint-panel__terminal-buttons mint-panel__terminal-buttons--split'
    : 'mint-panel__terminal-buttons';

  return (
    <section className="mint-panel">
      <MintPreview boxMedia={boxMedia} dropId={dropId} quantity={quantity} quantityLabel={quantityLabel} />
      {terminalState ? (
        <div className={terminalFooterClassName}>
          <div className="mint-panel__info">
            {dropTitle}
            <div className="mint-panel__remaining mint-panel__remaining--with-info">
              <span>{terminalState.statusText}</span>
              {showPackStatusControl ? (
                <span className="mint-panel__pack-status-info-wrap" ref={packStatusInfoRef}>
                  <button
                    type="button"
                    className="mint-panel__pack-status-info"
                    aria-label={packStatusDisplayLabels.ariaLabel}
                    aria-expanded={packStatusInfoOpen}
                    aria-haspopup="dialog"
                    onClick={() => setPackStatusInfoOpen((prev) => !prev)}
                  >
                    <LuInfo aria-hidden="true" focusable="false" size={16} strokeWidth={2} />
                  </button>
                  {packStatusInfoOpen ? (
                    <MintPanelPackStatusPopover breakdown={packStatusBreakdown} displayLabels={packStatusDisplayLabels} />
                  ) : null}
                </span>
              ) : null}
            </div>
          </div>
          {terminalButtons.length ? (
            <div className="mint-panel__cta">
              <div
                className={terminalButtonsClassName}
              >
                {terminalButtons.map((button, index) => {
                  const key = button.key || `${button.buttonText}-${index}`;
                  if (button.href) {
                    return (
                      <a key={key} className="mint-panel__secondary" href={button.href} target="_blank" rel="noreferrer">
                        <span className="mint-panel__secondary-text">{button.buttonText}</span>
                      </a>
                    );
                  }
                  if (!button.onClick) return null;
                  return (
                    <button key={key} type="button" className="mint-panel__secondary" onClick={button.onClick}>
                      <span className="mint-panel__secondary-text">{button.buttonText}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        <div className={showFormControls ? 'mint-panel__footer' : 'mint-panel__footer mint-panel__footer--no-slider'}>
          <div className="mint-panel__info">
            {dropTitle}
            <div
              className={remainingReady ? 'mint-panel__remaining' : 'mint-panel__remaining mint-panel__remaining--hidden'}
              aria-hidden={!remainingReady}
            >
              <span>{remaining} / {total} left</span>
            </div>
          </div>
          <form
            id={formId}
            className={showFormControls ? 'mint-panel__slider' : 'mint-panel__slider mint-panel__slider--hidden'}
            onSubmit={(event) => {
              event.preventDefault();
              void form.handleMint();
            }}
          >
            {showSizeSelector ? (
              <div className="mint-panel__sizes-row">
                <div
                  key={sizeBlinkToken}
                  className={
                    isBlinking
                      ? 'mint-panel__sizes mint-panel__sizes--blink'
                      : 'mint-panel__sizes'
                  }
                  role="radiogroup"
                  aria-label={sizeGuide?.selectionAriaLabel ?? 'Size'}
                >
                  {sizeOptions.map((size) => {
                    const selected = selectedSize === size.key;
                    const unavailable = (sizeAvailability[size.key] ?? 0) <= 0;
                    const classes = ['mint-panel__size'];
                    if (selected) classes.push('mint-panel__size--selected');
                    if (unavailable) classes.push('mint-panel__size--unavailable');
                    return (
                      <button
                        key={size.key}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        aria-disabled={unavailable || undefined}
                        title={unavailable ? 'Currently unavailable' : `${sizeAvailability[size.key] ?? 0} left`}
                        className={classes.join(' ')}
                        onClick={() => toggleSize(size.key)}
                        disabled={controlsBusy || unavailable}
                      >
                        {size.label}
                      </button>
                    );
                  })}
                </div>
                {sizeGuide ? (
                  <div className="mint-panel__size-info-wrap" ref={sizeInfoRef}>
                    <button
                      type="button"
                      className="mint-panel__size-info"
                      aria-label="Size info"
                      aria-expanded={sizeInfoOpen}
                      aria-haspopup="dialog"
                      onClick={() => setSizeInfoOpen((prev) => !prev)}
                    >
                      <FaCircleQuestion aria-hidden="true" focusable="false" size={16} />
                    </button>
                    {sizeInfoOpen ? (
                      <div
                        className="mint-panel__size-popover"
                        role="dialog"
                        aria-label={sizeGuide.dialogAriaLabel}
                      >
                        <table className="mint-panel__size-table">
                          <thead>
                            <tr>
                              <th scope="col" aria-label="Size" />
                              <th scope="col">Body Length</th>
                              <th scope="col">Chest Width</th>
                              <th scope="col">Sleeve Length</th>
                            </tr>
                          </thead>
                          <tbody>
                            {sizeGuide.rows.map((row) => (
                              <tr key={row.size}>
                                <th scope="row">{row.size}</th>
                                <td>{row.bodyLength}</td>
                                <td>{row.chestWidth}</td>
                                <td>{row.sleeveLength}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        <p className="mint-panel__size-quote">
                          No returns; please choose your size carefully.
                        </p>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : showQuantitySlider ? (
              <label className="mint-panel__label">
                <span className="mint-panel__label-text muted small">{quantityLabel}</span>
                <input
                  type="range"
                  aria-label="Mint quantity"
                  min={1}
                  max={maxSelectable}
                  value={quantity}
                  onChange={(evt) => setQuantity(parseInt(evt.target.value, 10))}
                  disabled={controlsBusy}
                />
              </label>
            ) : null}
          </form>
          <MintPanelActions
            formId={formId}
            showStripePaymentButton={form.showStripePaymentButton}
            showSolanaMintButton={form.showSolanaMintButton}
            stripePaymentPending={form.stripePaymentPending}
            submitBusy={form.submitBusy}
            disabled={form.actionsDisabled}
            useDiscountMint={form.useDiscountMint}
            showQuantitySlider={showQuantitySlider}
            quantityLabel={quantityLabel}
            stripePaymentDisplayPriceLabel={form.stripePaymentDisplayPriceLabel}
            totalPriceLabel={form.totalPriceLabel}
            totalDiscountPriceLabel={form.totalDiscountPriceLabel}
            onStripePayment={form.handleStripePaymentClick}
          />
        </div>
      )}
    </section>
  );
}
