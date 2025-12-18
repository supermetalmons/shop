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
  signedIn: boolean;
  signingIn: boolean;
  walletConnected: boolean;
  onSignIn: () => Promise<void>;
  onAddAddress: () => void;
}

export function DeliveryPanel({
  selectedCount,
  addresses,
  addressId,
  onSelectAddress,
  onRequestDelivery,
  loading,
  costLamports,
  signedIn,
  signingIn,
  walletConnected,
  onSignIn,
  onAddAddress,
}: DeliveryPanelProps) {
  const formatCountry = (addr: ProfileAddress) => {
    const code = addr.countryCode || normalizeCountryCode(addr.country);
    const option = findCountryByCode(code);
    if (option) return countryLabel(option);
    return addr.country || code || 'Unknown';
  };

  return (
    <section className="card">
      <div className="card__head">
        <div>
          <div className="card__title">Delivery</div>
          <p className="muted small">
            Select boxes or dudes to burn for delivery. We mint authenticity certificates in exchange once the delivery tx lands.
          </p>
        </div>
        <div className="card__actions">
          {!signedIn ? (
            <button type="button" className="ghost" onClick={onSignIn} disabled={!walletConnected || signingIn}>
              {signingIn ? 'Loading…' : 'Sign in to load addresses'}
            </button>
          ) : null}
          <button type="button" className="ghost" onClick={onAddAddress} disabled={!walletConnected || signingIn}>
            Add address
          </button>
        </div>
      </div>
      <div className="pill-row">
        <span className="pill">{selectedCount} selected</span>
        {typeof costLamports === 'number' ? (
          <span className="pill">Est. ship: {lamportsToSol(costLamports)} ◎</span>
        ) : null}
        {signedIn ? <span className="pill">{addresses.length} saved</span> : null}
      </div>
      {!walletConnected ? <div className="muted small">Connect a wallet to manage delivery addresses.</div> : null}
      {walletConnected && !signedIn && !signingIn ? (
        <div className="muted small">
          Sign in once to load saved addresses on this device. Afterwards you can reload and still see them.
        </div>
      ) : null}
      <label>
        <span className="muted">Send to</span>
        <select
          value={addressId || ''}
          onChange={(evt) => onSelectAddress(evt.target.value)}
          disabled={!addresses.length}
        >
          <option value="" disabled>
            {addresses.length ? 'Choose saved address' : signedIn ? 'No saved addresses yet' : 'Sign in to load addresses'}
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
