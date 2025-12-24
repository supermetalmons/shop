import { FormEvent, useEffect, useMemo, useState } from 'react';
import { COUNTRIES, countryLabel, findCountryByCode } from '../lib/countries';

interface DeliveryFormProps {
  onSave: (payload: { formatted: string; country: string; countryCode: string; label: string; email: string }) => Promise<void>;
  defaultEmail?: string;
  mode?: 'card' | 'modal';
  onCancel?: () => void;
}

export function DeliveryForm({ onSave, defaultEmail, mode = 'card', onCancel }: DeliveryFormProps) {
  const [email, setEmail] = useState(defaultEmail || '');
  const [emailTouched, setEmailTouched] = useState(false);
  const [fullName, setFullName] = useState('');
  const [line1, setLine1] = useState('');
  const [line2, setLine2] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [postalCode, setPostalCode] = useState('');
  const [countryCode, setCountryCode] = useState('INTL');
  const [label, setLabel] = useState('Home');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const countryOption = useMemo(() => findCountryByCode(countryCode) || findCountryByCode('INTL'), [countryCode]);
  const countryName = countryOption?.name || countryCode;

  useEffect(() => {
    if (!emailTouched && !email && defaultEmail) setEmail(defaultEmail);
  }, [defaultEmail, emailTouched, email]);

  const handleSubmit = async (evt: FormEvent) => {
    evt.preventDefault();
    const normalizedEmail = email.trim();
    if (!normalizedEmail) {
      setError('Email is required for shipping updates.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const formatted = [
        fullName,
        line1,
        line2,
        `${city}, ${state} ${postalCode}`.trim(),
        countryName,
      ]
        .filter(Boolean)
        .join('\n');
      await onSave({ formatted, country: countryName, countryCode, label, email: normalizedEmail });
      setSaving(false);
    } catch (err) {
      setSaving(false);
      setError(err instanceof Error ? err.message : 'Failed to save');
    }
  };

  return (
    <form className={mode === 'card' ? 'card' : 'modal-form'} onSubmit={handleSubmit}>
      {mode === 'card' ? (
        <>
          <div className="card__title">Save a shipping address</div>
          <p className="muted small">We use your email for shipping updates.</p>
        </>
      ) : null}
      <div className="grid">
        <label>
          <span className="muted">Email</span>
          <input
            required
            type="email"
            value={email}
            onChange={(e) => {
              setEmailTouched(true);
              setEmail(e.target.value);
            }}
            placeholder="you@example.com"
          />
        </label>
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
          <select required value={countryCode} onChange={(e) => setCountryCode(e.target.value)}>
            {COUNTRIES.map((option) => (
              <option key={option.code} value={option.code}>
                {countryLabel(option)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="muted">Label</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Home / Studio" />
        </label>
      </div>
      {error ? <div className="error">{error}</div> : null}
      <div className="row">
        {onCancel ? (
          <button type="button" className="ghost" onClick={onCancel} disabled={saving}>
            Cancel
          </button>
        ) : null}
        <button type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save encrypted address'}
        </button>
      </div>
    </form>
  );
}
