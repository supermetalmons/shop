import { FormEvent, useState } from 'react';

interface DeliveryFormProps {
  onSave: (payload: { formatted: string; country: string; label: string }) => Promise<void>;
}

export function DeliveryForm({ onSave }: DeliveryFormProps) {
  const [fullName, setFullName] = useState('');
  const [line1, setLine1] = useState('');
  const [line2, setLine2] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [postalCode, setPostalCode] = useState('');
  const [country, setCountry] = useState('');
  const [label, setLabel] = useState('Home');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (evt: FormEvent) => {
    evt.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const formatted = [
        fullName,
        line1,
        line2,
        `${city}, ${state} ${postalCode}`.trim(),
        country,
      ]
        .filter(Boolean)
        .join('\n');
      await onSave({ formatted, country, label });
      setSaving(false);
    } catch (err) {
      setSaving(false);
      setError(err instanceof Error ? err.message : 'Failed to save');
    }
  };

  return (
    <form className="card" onSubmit={handleSubmit}>
      <div className="card__title">Save a delivery address</div>
      <div className="grid">
        <label>
          <span className="muted">Full name</span>
          <input required value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </label>
        <label>
          <span className="muted">Address line 1</span>
          <input required value={line1} onChange={(e) => setLine1(e.target.value)} />
        </label>
        <label>
          <span className="muted">Address line 2</span>
          <input value={line2} onChange={(e) => setLine2(e.target.value)} />
        </label>
        <label>
          <span className="muted">City</span>
          <input required value={city} onChange={(e) => setCity(e.target.value)} />
        </label>
        <label>
          <span className="muted">State / Region</span>
          <input required value={state} onChange={(e) => setState(e.target.value)} />
        </label>
        <label>
          <span className="muted">Postal code</span>
          <input required value={postalCode} onChange={(e) => setPostalCode(e.target.value)} />
        </label>
        <label>
          <span className="muted">Country</span>
          <input required value={country} onChange={(e) => setCountry(e.target.value)} />
        </label>
        <label>
          <span className="muted">Label</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Home / Studio" />
        </label>
      </div>
      {error ? <div className="error">{error}</div> : null}
      <button type="submit" disabled={saving}>
        {saving ? 'Saving…' : 'Save encrypted address'}
      </button>
    </form>
  );
}
