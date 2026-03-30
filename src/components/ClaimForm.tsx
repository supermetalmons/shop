import { FormEvent, useState } from 'react';
import { FRONTEND_DEPLOYMENT } from '../config/deployment';

const ITEMS_PER_BOX = FRONTEND_DEPLOYMENT.itemsPerBox;

type ClaimFormResult = {
  itemsPerBox?: number;
};

interface ClaimFormProps {
  onClaim: (payload: { code: string }) => Promise<ClaimFormResult | void>;
  mode?: 'card' | 'modal';
  showTitle?: boolean;
  itemsPerBox?: number;
}

export function ClaimForm({ onClaim, mode = 'card', showTitle = true, itemsPerBox }: ClaimFormProps) {
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const figuresPerBox = Number.isFinite(itemsPerBox) && Number(itemsPerBox) > 0
    ? Math.floor(Number(itemsPerBox))
    : ITEMS_PER_BOX;

  const buildSuccessMessage = (resolvedItemsPerBox: number) => {
    const normalizedCount =
      Number.isFinite(resolvedItemsPerBox) && Number(resolvedItemsPerBox) > 0
        ? Math.floor(Number(resolvedItemsPerBox))
        : figuresPerBox;
    const figureLabel = normalizedCount === 1 ? 'figure receipt' : 'figure receipts';
    const figureVerb = normalizedCount === 1 ? 'is' : 'are';
    return `Claim submitted successfully! Your box receipt was transferred and your ${normalizedCount} ${figureLabel} ${figureVerb} being minted.`;
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await onClaim({ code: code.trim() });
      setSuccess(buildSuccessMessage(Number(result?.itemsPerBox)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to claim certificates');
    } finally {
      setLoading(false);
    }
  };

  return (
    <form className={mode === 'card' ? 'card' : 'modal-form'} onSubmit={submit}>
      {showTitle ? <div className="card__title">Secret Code</div> : null}
      <label>
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="10 digit code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{10}"
          maxLength={10}
          required
        />
      </label>
      {error ? <div className="error">{error}</div> : null}
      {success ? <div className="success">{success}</div> : null}
      <button type="submit" disabled={loading}>
        {loading ? 'Submitting…' : 'Claim receipts'}
      </button>
    </form>
  );
}
