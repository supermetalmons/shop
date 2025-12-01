import { FormEvent, useState } from 'react';

interface ClaimFormProps {
  onClaim: (payload: { code: string }) => Promise<void>;
}

export function ClaimForm({ onClaim }: ClaimFormProps) {
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
      setSuccess('Claim submitted successfully! Your dude certificates are being minted.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to claim certificates');
    } finally {
      setLoading(false);
    }
  };

  return (
    <form className="card" onSubmit={submit}>
      <div className="card__title">Claim IRL dudes certificates</div>
      <p className="muted small">
        Use the secret code inside the physical blind box. We will locate the matching blind box certificate in your
        wallet before minting the dudes certificates.
      </p>
      <label>
        <span className="muted">Secret code</span>
        <input value={code} onChange={(e) => setCode(e.target.value)} required />
      </label>
      {error ? <div className="error">{error}</div> : null}
      {success ? <div className="success">{success}</div> : null}
      <button type="submit" disabled={loading}>
        {loading ? 'Submitting…' : 'Claim certificates'}
      </button>
    </form>
  );
}
