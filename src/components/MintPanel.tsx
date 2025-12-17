import { FormEvent, useState } from 'react';
import { MintStats } from '../types';
import { ProgressBar } from './ProgressBar';

interface MintPanelProps {
  stats?: MintStats;
  onMint: (quantity: number) => Promise<void>;
  busy: boolean;
}

export function MintPanel({ stats, onMint, busy }: MintPanelProps) {
  const minted = stats?.minted ?? 0;
  const total = stats?.total ?? 333;
  const remaining = stats?.remaining ?? Math.max(0, total - minted);
  const maxPerTx = stats?.maxPerTx ?? 15;
  const [quantity, setQuantity] = useState(1);
  const [error, setError] = useState<string | null>(null);

  const handleMint = async (evt: FormEvent) => {
    evt.preventDefault();
    if (quantity < 1 || quantity > maxPerTx) return;
    setError(null);
    try {
      await onMint(quantity);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to mint');
    }
  };

  const soldOut = remaining <= 0;

  return (
    <section className="card">
      <div className="card__title">Mint blind boxes</div>
      {stats ? (
        <ProgressBar minted={minted} total={total} remaining={remaining} />
      ) : null}
      {soldOut ? (
        <p className="muted">Sold out. Jump to secondary or standby for next drop.</p>
      ) : (
        <form className="mint" onSubmit={handleMint}>
          <label>
            <span className="muted">Quantity (1-{maxPerTx} per tx)</span>
            <input
              type="range"
              min={1}
              max={Math.min(maxPerTx, remaining)}
              value={quantity}
              onChange={(evt) => setQuantity(parseInt(evt.target.value, 10))}
            />
          </label>
          <div className="mint__qty">
            <div>
              <div className="muted small">Selected</div>
              <div className="big">{quantity}</div>
            </div>
            <button type="submit" disabled={busy}>
              {busy ? 'Minting…' : 'Mint now'}
            </button>
          </div>
          {error ? <div className="error">{error}</div> : null}
        </form>
      )}
    </section>
  );
}
