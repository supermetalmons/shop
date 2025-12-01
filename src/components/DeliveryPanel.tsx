import { ProfileAddress } from '../types';
import { lamportsToSol, normalizeCountryCode } from '../lib/solana';
import { countryLabel, findCountryByCode } from '../lib/countries';

interface DeliveryPanelProps {
  selectedCount: number;
  addresses: ProfileAddress[];
  addressId: string | null;
  onSelectAddress: (id: string) => void;
  onRequestDelivery: () => Promise<void>;
  loading: boolean;
  costLamports?: number;
}

export function DeliveryPanel({
  selectedCount,
  addresses,
  addressId,
  onSelectAddress,
  onRequestDelivery,
  loading,
  costLamports,
}: DeliveryPanelProps) {
  const formatCountry = (addr: ProfileAddress) => {
    const code = addr.countryCode || normalizeCountryCode(addr.country);
    const option = findCountryByCode(code);
    if (option) return countryLabel(option);
    return addr.country || code || 'Unknown';
  };

  return (
    <section className="card">
      <div className="card__title">Delivery</div>
      <p className="muted small">
        Select boxes or dudes to burn for delivery. We mint authenticity certificates in exchange once the delivery tx
        lands.
      </p>
      <div className="pill-row">
        <span className="pill">{selectedCount} selected</span>
        {typeof costLamports === 'number' ? (
          <span className="pill">Est. ship: {lamportsToSol(costLamports)} ◎</span>
        ) : null}
      </div>
      <label>
        <span className="muted">Send to</span>
        <select value={addressId || ''} onChange={(evt) => onSelectAddress(evt.target.value)}>
          <option value="" disabled>
            Choose saved address
          </option>
          {addresses.map((addr) => (
            <option key={addr.id} value={addr.id}>
              {addr.label} · {formatCountry(addr)} · {addr.hint}
            </option>
          ))}
        </select>
      </label>
      <button onClick={onRequestDelivery} disabled={!selectedCount || !addressId || loading}>
        {loading ? 'Preparing tx…' : 'Request delivery tx'}
      </button>
    </section>
  );
}
