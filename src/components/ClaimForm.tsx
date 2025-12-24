import { FormEvent, useState } from 'react';

interface ClaimFormProps {
  onClaim: (payload: { code: string }) => Promise<void>;
  mode?: 'card' | 'modal';
  showTitle?: boolean;
}

export function ClaimForm({ onClaim, mode = 'card', showTitle = true }: ClaimFormProps) {
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      await onClaim({ code: code.trim() });
      setSuccess('Claim submitted successfully! Your box receipt was transferred and your 3 figure receipts are being minted.');
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
