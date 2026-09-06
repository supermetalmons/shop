import type {
  FulfillmentShipStationRate,
  ShipStationMoney,
  ShipStationEditableAddressField,
} from '../types';
import { useOverlayScrollLock } from '../hooks/useOverlayScrollLock';
import { fulfillmentShipStationDeliveryText } from '../lib/fulfillmentShipStationRates';
import { isRedeemedForIrlFulfillmentOrder } from '../lib/fulfillmentOrderVisibility';
import { Modal } from '../components/Modal';
import { SHIPSTATION_PACKAGE_FIELDS } from './shipStationWorkflow';
import { useShipStationWorkflow, type ShipStationWorkflowOptions } from './useShipStationWorkflow';

const SHIPSTATION_AWAITING_SHIPMENT_URL = 'https://ship.shipstation.com/orders/awaiting-shipment';

const SHIPSTATION_ADDRESS_FIELDS: Record<
  ShipStationEditableAddressField,
  { label: string; autoComplete: string; optional?: boolean }
> = {
  name: { label: 'Recipient name', autoComplete: 'name' },
  address_line1: { label: 'Address line 1', autoComplete: 'address-line1' },
  address_line2: { label: 'Address line 2', autoComplete: 'address-line2', optional: true },
  address_line3: { label: 'Address line 3', autoComplete: 'address-line3', optional: true },
  city_locality: { label: 'City', autoComplete: 'address-level2' },
  state_province: { label: 'State / province', autoComplete: 'address-level1' },
  postal_code: { label: 'Postal code', autoComplete: 'postal-code' },
  country_code: { label: 'Country code', autoComplete: 'country' },
};

function formatShipStationMoney(money: ShipStationMoney | undefined): string {
  if (!money) return '—';
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: money.currency.toUpperCase(),
    }).format(money.amount);
  } catch {
    return `${money.amount.toFixed(2)} ${money.currency.toUpperCase()}`;
  }
}

function ShipStationRateOption({
  rate,
  detail,
  selected,
  disabled,
  onSelect,
}: {
  rate: FulfillmentShipStationRate;
  detail?: string;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <label className={`shipstation-rate-option${selected ? ' shipstation-rate-option--selected' : ''}`}>
      <input
        type="radio"
        name="shipstation-rate"
        value={rate.rateId}
        checked={selected}
        onChange={onSelect}
        disabled={disabled}
      />
      <span className="shipstation-rate-option__body">
        <span className="shipstation-rate-option__main">
          <span>
            <strong>{rate.carrierName}</strong>
            <span className="muted"> · {rate.serviceName}</span>
          </span>
          <strong>{formatShipStationMoney(rate.totalAmount)}</strong>
        </span>
        {detail ? <span className="muted small">{detail}</span> : null}
        <span className="muted small">
          {fulfillmentShipStationDeliveryText(rate)}
          {rate.guaranteedService ? ' · Guaranteed' : ''}
        </span>
        {rate.warningMessages.map((warning, warningIndex) => (
          <span key={`${rate.rateId}:${warningIndex}`} className="shipstation-rate-option__warning small">
            {warning}
          </span>
        ))}
      </span>
    </label>
  );
}

type FulfillmentShipStationModalProps = ShipStationWorkflowOptions & {
  suspended: boolean;
  api?: Parameters<typeof useShipStationWorkflow>[1];
};

export function FulfillmentShipStationModal({ suspended, api, ...props }: FulfillmentShipStationModalProps) {
  const { order } = props;
  useOverlayScrollLock({ active: order !== null && !suspended });
  const {
    activeShipstationAddressCorrectionValid,
    activeShipstationBusy,
    activeShipstationCanAdd,
    activeShipstationCanGetRates,
    activeShipstationHasLabel,
    activeShipstationLabel,
    activeShipstationMultiPackage,
    activeShipstationOrder,
    activeShipstationPackageDraft,
    activeShipstationPackageKnown,
    activeShipstationPreparedRates,
    activeShipstationPurchaseUnknown,
    activeShipstationRateGroups,
    activeShipstationSelectedOtherRate,
    activeShipstationSelectedRate,
    activeShipstationSelectedRateDetail,
    shipstationAddressCorrection,
    shipstationError,
    shipstationLabelLoading,
    shipstationPurchasing,
    shipstationRates,
    shipstationRatesExpanded,
    shipstationRatesLoading,
    shipstationRatesRequested,
    shipstationReviewingPurchase,
    shipstationReviewingVoid,
    shipstationSaving,
    shipstationSelectedRateId,
    shipstationVoiding,
    visibleShipstationInvalidRates,
    handleCloseShipstationModal,
    handleAddToShipStation,
    handleGetShipstationRates,
    handleSelectShipstationRate,
    handleReviewShipstationPurchase,
    handleConfirmShipstationPurchase,
    handleConfirmShipstationVoid,
    refreshShipstationLabel,
    editPackage,
    toggleRatesExpanded,
    editAddress,
    reviewVoid,
    cancelVoidReview,
    cancelPurchaseReview,
    downloadLabel,
  } = useShipStationWorkflow(props, api);

  return (
    <Modal
      open={order !== null}
      title={activeShipstationOrder ? `Print label · Order ${activeShipstationOrder.deliveryId}` : 'Print label'}
      onClose={handleCloseShipstationModal}
      showCloseButton={false}
      closeOnEscape={!activeShipstationBusy}
      suspended={suspended}
    >
      <div className="modal-form">
        {activeShipstationOrder && !isRedeemedForIrlFulfillmentOrder(activeShipstationOrder) ? (
          <div className="fulfillment-shipstation">
            {activeShipstationOrder.shipstationShipmentId ? (
              <div className="shipstation-header-actions">
                <a
                  className="link small no-focus-style"
                  href={SHIPSTATION_AWAITING_SHIPMENT_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  View on ShipStation
                </a>
              </div>
            ) : null}

            {shipstationReviewingVoid && activeShipstationLabel?.status === 'completed' ? (
              <div className="shipstation-review shipstation-review--void" role="alert">
                <div className="shipstation-review__title">Void this label?</div>
                <div className="small">
                  This cannot be undone. ShipStation will request a carrier refund when applicable, but approval and timing depend on the carrier.
                </div>
                {activeShipstationLabel.trackingNumber ? (
                  <div className="muted small">Tracking {activeShipstationLabel.trackingNumber}</div>
                ) : null}
              </div>
            ) : activeShipstationLabel ? (
              <div className="shipstation-label-summary" aria-live="polite">
                <div className="shipstation-label-summary__heading">
                  {activeShipstationLabel.status === 'processing'
                    ? 'Label purchase is processing'
                    : activeShipstationLabel.status === 'completed'
                      ? 'Label purchased'
                      : activeShipstationLabel.status === 'voided'
                        ? 'Previous label was voided'
                        : 'Previous label could not be created'}
                </div>
                {activeShipstationHasLabel ? (
                  <div className="shipstation-label-summary__details">
                    <span>
                      {[activeShipstationLabel.carrierName || activeShipstationLabel.carrierCode,
                        activeShipstationLabel.serviceName || activeShipstationLabel.serviceCode]
                        .filter(Boolean)
                        .join(' · ') || 'Carrier details pending'}
                    </span>
                    {activeShipstationLabel.totalCost ? (
                      <span>{formatShipStationMoney(activeShipstationLabel.totalCost)}</span>
                    ) : null}
                    {activeShipstationLabel.trackingNumber ? (
                      <span>Tracking {activeShipstationLabel.trackingNumber}</span>
                    ) : null}
                  </div>
                ) : (
                  <div className="muted small">Get fresh rates to purchase another label.</div>
                )}
              </div>
            ) : null}

            {activeShipstationPurchaseUnknown ? (
              <div className="shipstation-notice" role="status">
                ShipStation may already have charged for this label. Check its status before taking any other action.
              </div>
            ) : null}

            {activeShipstationMultiPackage && !activeShipstationHasLabel ? (
              <div className="shipstation-notice">
                {activeShipstationOrder.shipstationPackageCount
                  ? `This shipment has ${activeShipstationOrder.shipstationPackageCount} packages.`
                  : 'This shipment does not have a single package.'}{' '}
                Buy its label in ShipStation; the in-app flow supports one package only.
              </div>
            ) : null}

            {!activeShipstationHasLabel && !activeShipstationMultiPackage && !activeShipstationPurchaseUnknown ? (
              activeShipstationPackageKnown ? (
                <div className="shipstation-package">
                  {SHIPSTATION_PACKAGE_FIELDS.map((field) => (
                    <label key={field.key} className="shipstation-package-field">
                      <span className="muted small">{field.label}</span>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={activeShipstationPackageDraft[field.key]}
                        onChange={(evt) => editPackage(field.key, evt.target.value)}
                        disabled={activeShipstationBusy || shipstationReviewingPurchase}
                        aria-label={field.ariaLabel}
                        autoComplete="off"
                      />
                    </label>
                  ))}
                </div>
              ) : (
                <div className="muted small">
                  Package details will be loaded from ShipStation when you get rates.
                </div>
              )
            ) : null}

            {shipstationReviewingPurchase && activeShipstationSelectedRate ? (
              <div className="shipstation-review">
                <div className="shipstation-review__title">Review label purchase</div>
                <div className="shipstation-review__row">
                  <span>Carrier</span>
                  <strong>{activeShipstationSelectedRate.carrierName}</strong>
                </div>
                <div className="shipstation-review__row">
                  <span>Service</span>
                  <strong>{activeShipstationSelectedRate.serviceName}</strong>
                </div>
                <div className="shipstation-review__row shipstation-review__row--total">
                  <span>Total charge</span>
                  <strong>{formatShipStationMoney(activeShipstationSelectedRate.totalAmount)}</strong>
                </div>
                {activeShipstationSelectedRateDetail ? (
                  <div className="muted small">{activeShipstationSelectedRateDetail}</div>
                ) : null}
                <div className="muted small">The charge is made through your ShipStation account.</div>
              </div>
            ) : activeShipstationPreparedRates.rates.length ? (
              <div className="shipstation-rate-picker">
                <div className="shipstation-rate-picker__head">
                  <div id="shipstation-lowest-prices-label" className="shipstation-rate-section__label">
                    Lowest prices
                  </div>
                  {activeShipstationRateGroups.otherRates.length ? (
                    <button
                      type="button"
                      className="link small shipstation-rate-toggle"
                      aria-expanded={shipstationRatesExpanded}
                      aria-controls="shipstation-rate-options"
                      onClick={toggleRatesExpanded}
                      disabled={activeShipstationBusy}
                    >
                      {shipstationRatesExpanded
                        ? 'Show fewer'
                        : `Show all ${activeShipstationPreparedRates.rates.length} rates`}
                    </button>
                  ) : null}
                </div>
                <div
                  id="shipstation-rate-options"
                  className="shipstation-rate-groups"
                  role="radiogroup"
                  aria-label="Shipping rates"
                >
                  <div
                    className="shipstation-rate-section"
                    role="group"
                    aria-labelledby="shipstation-lowest-prices-label"
                  >
                    <div className="shipstation-rate-list">
                      {activeShipstationRateGroups.recommendedRates.map((rate) => (
                        <ShipStationRateOption
                          key={rate.rateId}
                          rate={rate}
                          detail={activeShipstationPreparedRates.detailByRateId.get(rate.rateId)}
                          selected={rate.rateId === shipstationSelectedRateId}
                          disabled={activeShipstationBusy}
                          onSelect={() => handleSelectShipstationRate(rate.rateId)}
                        />
                      ))}
                    </div>
                  </div>
                  {shipstationRatesExpanded ? (
                    <div
                      className="shipstation-rate-section"
                      role="group"
                      aria-labelledby="shipstation-other-rates-label"
                    >
                      <div id="shipstation-other-rates-label" className="shipstation-rate-section__label">
                        Other rates
                      </div>
                      <div className="shipstation-rate-list">
                        {activeShipstationRateGroups.otherRates.map((rate) => (
                          <ShipStationRateOption
                            key={rate.rateId}
                            rate={rate}
                            detail={activeShipstationPreparedRates.detailByRateId.get(rate.rateId)}
                            selected={rate.rateId === shipstationSelectedRateId}
                            disabled={activeShipstationBusy}
                            onSelect={() => handleSelectShipstationRate(rate.rateId)}
                          />
                        ))}
                      </div>
                    </div>
                  ) : activeShipstationSelectedOtherRate ? (
                    <div
                      className="shipstation-rate-section"
                      role="group"
                      aria-labelledby="shipstation-selected-rate-label"
                    >
                      <div id="shipstation-selected-rate-label" className="shipstation-rate-section__label">
                        Selected rate
                      </div>
                      <div className="shipstation-rate-list">
                        <ShipStationRateOption
                          rate={activeShipstationSelectedOtherRate}
                          detail={activeShipstationPreparedRates.detailByRateId.get(
                            activeShipstationSelectedOtherRate.rateId,
                          )}
                          selected
                          disabled={activeShipstationBusy}
                          onSelect={() => handleSelectShipstationRate(activeShipstationSelectedOtherRate.rateId)}
                        />
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}
            {visibleShipstationInvalidRates.length ? (
              <div className="error shipstation-invalid-rates" role="status">
                <strong>
                  {shipstationRates.length
                    ? 'Some ShipStation rates couldn’t be processed'
                    : 'ShipStation couldn’t quote these services'}
                </strong>
                {visibleShipstationInvalidRates.map((rate, rateIndex) => (
                  <div
                    key={`${rate.carrierId}:${rate.serviceCode}:${rateIndex}`}
                    className="shipstation-invalid-rate"
                  >
                    <span>
                      {[rate.carrierName, rate.serviceName].filter(Boolean).join(' · ')}
                    </span>
                    {rate.errorMessages.map((message, messageIndex) => (
                      <span key={`${rateIndex}:${messageIndex}`}>{message}</span>
                    ))}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        {shipstationError ? <div className="error">{shipstationError}</div> : null}
        {shipstationAddressCorrection?.visibleFields.length ? (
          <div className="shipstation-address-correction" role="group" aria-label="Temporary ShipStation address corrections">
            <div className="shipstation-address-correction__heading">Correct the ShipStation address</div>
            <div className="muted small">
              {shipstationAddressCorrection.baseline
                ? 'These changes apply only to the ShipStation shipment and do not update the saved fulfillment address.'
                : 'The saved address is hidden for this account. Enter the requested values; they apply only to the ShipStation shipment.'}
            </div>
            <div className="shipstation-address-correction__fields">
              {shipstationAddressCorrection.visibleFields.map((field) => {
                const config = SHIPSTATION_ADDRESS_FIELDS[field];
                return (
                  <label key={field} className="shipstation-address-correction__field">
                    <span className="muted small">
                      {config.label}{config.optional ? ' (optional)' : ''}
                    </span>
                    <input
                      type="text"
                      value={shipstationAddressCorrection.draft[field]}
                      onChange={(evt) => editAddress(field, evt.target.value)}
                      maxLength={field === 'country_code' ? 2 : 50}
                      required={!config.optional}
                      disabled={activeShipstationBusy}
                      autoComplete={config.autoComplete}
                      aria-label={config.label}
                    />
                  </label>
                );
              })}
            </div>
          </div>
        ) : null}
        <div className="row row--end">
          <button
            type="button"
            className="secondary-light"
            onClick={handleCloseShipstationModal}
            disabled={activeShipstationBusy}
          >
            Cancel
          </button>
          {activeShipstationCanAdd ? (
            <button
              type="button"
              onClick={() => void handleAddToShipStation()}
              disabled={activeShipstationBusy || (
                Boolean(shipstationAddressCorrection?.visibleFields.length) &&
                  !activeShipstationAddressCorrectionValid
              )}
            >
              {shipstationSaving ? 'Adding…' : 'Add to ShipStation'}
            </button>
          ) : shipstationReviewingVoid && activeShipstationLabel?.status === 'completed' ? (
            <>
              <button
                type="button"
                className="secondary-light"
                onClick={cancelVoidReview}
                disabled={activeShipstationBusy}
              >
                Back
              </button>
              <button
                type="button"
                className="shipstation-void-confirm"
                onClick={() => void handleConfirmShipstationVoid()}
                disabled={activeShipstationBusy}
              >
                {shipstationVoiding ? 'Voiding…' : 'Confirm void'}
              </button>
            </>
          ) : activeShipstationPurchaseUnknown || activeShipstationLabel?.status === 'processing' ? (
            <button type="button" onClick={() => void refreshShipstationLabel(false)} disabled={activeShipstationBusy}>
              {shipstationLabelLoading ? 'Checking…' : 'Check purchase status'}
            </button>
          ) : activeShipstationLabel?.status === 'completed' ? (
            <>
              <button
                type="button"
                className="secondary-light shipstation-void-button"
                onClick={reviewVoid}
                disabled={activeShipstationBusy}
              >
                Void label
              </button>
              <button
                type="button"
                onClick={downloadLabel}
                disabled={activeShipstationBusy}
              >
                {shipstationLabelLoading ? 'Preparing PDF…' : 'Download PDF'}
              </button>
            </>
          ) : shipstationReviewingPurchase && activeShipstationSelectedRate ? (
            <>
              <button
                type="button"
                className="secondary-light"
                onClick={cancelPurchaseReview}
                disabled={activeShipstationBusy}
              >
                Back
              </button>
              <button
                type="button"
                onClick={() => void handleConfirmShipstationPurchase()}
                disabled={activeShipstationBusy}
              >
                {shipstationPurchasing
                  ? 'Purchasing…'
                  : `Confirm purchase · ${formatShipStationMoney(activeShipstationSelectedRate.totalAmount)}`}
              </button>
            </>
          ) : shipstationRates.length ? (
            <button
              type="button"
              onClick={handleReviewShipstationPurchase}
              disabled={activeShipstationBusy || !activeShipstationSelectedRate}
            >
              Review purchase
            </button>
          ) : activeShipstationCanGetRates ? (
            <button type="button" onClick={() => void handleGetShipstationRates()} disabled={activeShipstationBusy}>
              {shipstationRatesLoading ? 'Getting rates…' : shipstationRatesRequested ? 'Refresh rates' : 'Get rates'}
            </button>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
