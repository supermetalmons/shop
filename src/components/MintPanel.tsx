import { FormEvent, useEffect, useState } from 'react';
import { MintStats } from '../types';
import { ProgressBar } from './ProgressBar';
import { FRONTEND_DEPLOYMENT } from '../config/deployment';

interface MintPanelProps {
  stats?: MintStats;
  onMint: (quantity: number) => Promise<void>;
  busy: boolean;
  onQuantityChange?: (quantity: number) => void;
}

export function MintPanel({ stats, onMint, busy, onQuantityChange }: MintPanelProps) {
  const minted = stats?.minted ?? 0;
  const total = stats?.total ?? FRONTEND_DEPLOYMENT.maxSupply;
  const remaining = stats?.remaining ?? Math.max(0, total - minted);
  const maxPerTx = stats?.maxPerTx ?? FRONTEND_DEPLOYMENT.maxPerTx;
  const [quantity, setQuantity] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const maxSelectable = Math.min(maxPerTx, remaining);

  useEffect(() => {
    onQuantityChange?.(quantity);
  }, [onQuantityChange, quantity]);

  useEffect(() => {
    if (maxSelectable < 1) return;
    if (quantity > maxSelectable) {
      setQuantity(maxSelectable);
    }
  }, [maxSelectable, quantity]);

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
      <div className="card__title">Mint Boxes</div>
      {stats ? (
        <ProgressBar minted={minted} total={total} remaining={remaining} />
      ) : null}
      {soldOut ? (
        <p className="muted">Sold out. Jump to secondary or standby for next drop.</p>
      ) : (
        <form className="mint" onSubmit={handleMint}>
          <label>
            <span className="muted">Quantity</span>
            <input
              type="range"
              min={1}
              max={maxSelectable}
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
