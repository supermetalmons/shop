import { ETHEREUM_MINT_KINDS, type EthereumMintKind } from '../../shared/ethereum/protocol';
import { MintPanelFrame, MintPanelPurchaseFooter, MintPanelTitle, MintQuantityControl } from '../components/MintPanel';
import { MintPanelActions } from '../components/MintPanelActions';
import type { PrimaryMediaControls } from '../components/MediaWithFallback';
import { EthereumContainerPreview } from './EthereumContainerPreview';
import { EthereumContainerIcon } from './EthereumContainerIcon';
import { ETHEREUM_CONTAINER_MEDIA } from './containerMedia';

type EthereumMintPanelProps = {
  kind: EthereumMintKind;
  kindDisabled: boolean;
  quantity: number;
  maxQuantity: number;
  remaining?: number;
  total: number;
  price: string;
  discountPrice: string;
  useDiscountMint: boolean;
  statusText?: string;
  disabled: boolean;
  busy: boolean;
  onKindChange: (kind: EthereumMintKind) => void;
  onQuantityChange: (quantity: number) => void;
  onMint: () => void;
};

const containerPreviews = {
  crate: (controls: PrimaryMediaControls) => <EthereumContainerPreview kind="crate" className="mint-panel__box" {...controls} />,
  monument: (controls: PrimaryMediaControls) => <EthereumContainerPreview kind="monument" className="mint-panel__box" {...controls} />,
  warehouse: (controls: PrimaryMediaControls) => <EthereumContainerPreview kind="warehouse" className="mint-panel__box" {...controls} />,
};

export function EthereumMintPanel({
  kind, kindDisabled, quantity, maxQuantity, remaining, total, price, discountPrice, useDiscountMint, statusText, disabled, busy, onKindChange, onQuantityChange, onMint,
}: EthereumMintPanelProps) {
  const quantityLabel = `${quantity} ${quantity === 1 ? kind : ETHEREUM_CONTAINER_MEDIA[kind].pluralLabel.toLowerCase()}`;
  const showQuantitySlider = maxQuantity > 1;
  const formId = 'ethereum-mint-form';

  return <MintPanelFrame
    ariaLabel="111K testnet mint"
    quantity={quantity}
    quantityLabel={quantityLabel}
    boxMedia={{ aspectRatio: ETHEREUM_CONTAINER_MEDIA[kind].aspectRatio }}
    renderPreviewPrimary={containerPreviews[kind]}
    repeatPreviewPrimary
    previewPrimaryKey={`111k-${kind}`}
  >
    <MintPanelPurchaseFooter
      hasControls={showQuantitySlider}
      info={<>
        <div className="ethereum111k__mint-title">
          <MintPanelTitle title="111K" />
          <fieldset className="ethereum111k__mint-kind" aria-label="Container type" disabled={kindDisabled}>
            {ETHEREUM_MINT_KINDS.map(value => <label key={value} title={ETHEREUM_CONTAINER_MEDIA[value].label}>
              <input type="radio" name="ethereum-container" value={value} aria-label={ETHEREUM_CONTAINER_MEDIA[value].label}
                checked={kind === value} onChange={() => onKindChange(value)} />
              <span><EthereumContainerIcon kind={value} /></span>
            </label>)}
          </fieldset>
        </div>
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
          disabled={kindDisabled}
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
        useDiscountMint={useDiscountMint}
        showQuantitySlider={showQuantitySlider}
        quantityLabel={quantityLabel}
        stripePaymentDisplayPriceLabel={undefined}
        totalPriceLabel={price}
        totalDiscountPriceLabel={discountPrice}
        currencyLabel="ETH"
        onStripePayment={async () => {}}
      />}
    />
  </MintPanelFrame>;
}
