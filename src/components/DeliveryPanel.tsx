import { DeliveryForm } from './DeliveryForm';

interface DeliveryPanelProps {
  selectedCount: number;
  selectedLabel?: string;
  walletConnected: boolean;
  defaultEmail?: string;
  itemsPerBox?: number;
  boxNamePrefix?: string;
  figureNamePrefix?: string;
  onShip: (payload: { formatted: string; country: string; countryCode: string; email: string }) => Promise<void>;
  submitDisabled?: boolean;
}

export function DeliveryPanel({
  selectedCount,
  selectedLabel,
  walletConnected,
  defaultEmail,
  itemsPerBox,
  boxNamePrefix,
  figureNamePrefix,
  onShip,
  submitDisabled,
}: DeliveryPanelProps) {
  return (
    <section className="card">
      <div className="card__head">
        <div>
          <div className="card__title">Shipment</div>
        </div>
      </div>
      <div className="pill-row">
        <span className="pill">{selectedLabel || `${selectedCount} selected`}</span>
      </div>
      {!walletConnected ? <div className="muted small">Connect a wallet to ship items.</div> : null}
      <DeliveryForm
        mode="card"
        defaultEmail={defaultEmail}
        onSubmit={onShip}
        submitDisabled={submitDisabled}
        itemsPerBox={itemsPerBox}
        boxNamePrefix={boxNamePrefix}
        figureNamePrefix={figureNamePrefix}
      />
    </section>
  );
}
