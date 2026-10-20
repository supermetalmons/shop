import { useEffect } from 'react';
import { MintPanelFrame, MintPanelPurchaseFooter, MintPanelTitle, MintQuantityControl } from '../components/MintPanel';
import { MintPanelActions } from '../components/MintPanelActions';
import type { PrimaryMediaControls } from '../components/MediaWithFallback';
import { EthereumContainerPreview } from './EthereumContainerPreview';

type EthereumMintPanelProps = {
  quantity: number;
  maxQuantity: number;
  remaining?: number;
  total: number;
  price: string;
  statusText?: string;
  disabled: boolean;
  busy: boolean;
  onQuantityChange: (quantity: number) => void;
  onMint: () => void;
};

function CratePreview({ onReady }: PrimaryMediaControls) {
  useEffect(onReady, [onReady]);
  return <EthereumContainerPreview kind="crate" className="mint-panel__box mint-panel__box--media" />;
}

const renderCratePreview = (controls: PrimaryMediaControls) => <CratePreview {...controls} />;

export function EthereumMintPanel({
  quantity, maxQuantity, remaining, total, price, statusText, disabled, busy, onQuantityChange, onMint,
}: EthereumMintPanelProps) {
  const quantityLabel = `${quantity} crate${quantity === 1 ? '' : 's'}`;
  const showQuantitySlider = maxQuantity > 1;
  const formId = 'ethereum-mint-form';

  return <MintPanelFrame
    ariaLabel="111K testnet mint"
    quantity={quantity}
    quantityLabel={quantityLabel}
    boxMedia={{ aspectRatio: 1, mediaScale: 1.4 }}
    renderPreviewPrimary={renderCratePreview}
    previewPrimaryKey="111k-crate"
  >
    <MintPanelPurchaseFooter
      hasControls={showQuantitySlider}
      info={<>
        <MintPanelTitle title="111K" />
        <div className="mint-panel__remaining mint-panel__availability">
          {statusText ? <span role="status">{statusText}</span> : <>
            <span className="mint-panel__remaining-count" style={{ minWidth: `${String(total).length}ch` }}>
              {remaining !== undefined ? remaining : <span role="status" aria-label="Loading availability">
                {Array.from(String(total), (_, index) => <span key={index} className="mint-panel__digit-placeholder" aria-hidden="true" />)}
              </span>}
            </span>
            <span> / {total} left</span>
          </>}
        </div>
      </>}
      controls={<form
        id={formId}
        className={showQuantitySlider ? 'mint-panel__slider' : 'mint-panel__slider mint-panel__slider--hidden'}
        onSubmit={event => { event.preventDefault(); onMint(); }}
      >
        {showQuantitySlider ? <MintQuantityControl
          quantity={quantity}
          max={maxQuantity}
          quantityLabel={quantityLabel}
          disabled={disabled}
          onChange={onQuantityChange}
        /> : null}
      </form>}
      actions={<MintPanelActions
        formId={formId}
        showStripePaymentButton={false}
        showMintButton
        stripePaymentPending={false}
        submitBusy={busy}
        disabled={disabled}
        useDiscountMint={false}
        showQuantitySlider={showQuantitySlider}
        quantityLabel={quantityLabel}
        stripePaymentDisplayPriceLabel={undefined}
        totalPriceLabel={price}
        totalDiscountPriceLabel={price}
        currencyLabel="ETH"
        onStripePayment={async () => {}}
      />}
    />
  </MintPanelFrame>;
}
