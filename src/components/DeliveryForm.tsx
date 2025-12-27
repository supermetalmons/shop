import { FormEvent, useEffect, useMemo, useState } from 'react';
import { COUNTRIES, countryLabel, findCountryByCode } from '../lib/countries';

interface DeliveryFormProps {
  onSubmit: (payload: { formatted: string; country: string; countryCode: string; email: string }) => Promise<void>;
  defaultEmail?: string;
  mode?: 'card' | 'modal';
  onCancel?: () => void;
  submitDisabled?: boolean;
  countryCode?: string;
  onCountryCodeChange?: (code: string) => void;
  submitLabel?: string;
}

export function DeliveryForm({
  onSubmit,
  defaultEmail,
  mode = 'card',
  onCancel,
  submitDisabled,
  countryCode,
  onCountryCodeChange,
  submitLabel,
}: DeliveryFormProps) {
  const [email, setEmail] = useState(defaultEmail || '');
  const [emailTouched, setEmailTouched] = useState(false);
  const [fullName, setFullName] = useState('');
  const [line1, setLine1] = useState('');
  const [line2, setLine2] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [postalCode, setPostalCode] = useState('');
  const [localCountryCode, setLocalCountryCode] = useState(countryCode || 'US');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedCountryCode = countryCode ?? localCountryCode;
  const countryOption = useMemo(
    () => findCountryByCode(selectedCountryCode) || findCountryByCode('INTL'),
    [selectedCountryCode],
  );
  const countryName = countryOption?.name || selectedCountryCode;
  const shippingNote =
    selectedCountryCode === 'US'
      ? 'Free US shipping'
      : 'International delivery: 0.19 SOL up to 3 figures. 0.04 SOL each additional figure.';

  useEffect(() => {
    if (!emailTouched && !email && defaultEmail) setEmail(defaultEmail);
  }, [defaultEmail, emailTouched, email]);

  const handleSubmit = async (evt: FormEvent<HTMLFormElement>) => {
    evt.preventDefault();
    if (submitDisabled) return;
    if (!evt.currentTarget.checkValidity()) {
      setError('Please complete the required fields.');
      return;
    }
    const normalizedEmail = email.trim();
    if (!normalizedEmail) {
      setError('Please add an email for shipping updates.');
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
      await onSubmit({ formatted, country: countryName, countryCode: selectedCountryCode, email: normalizedEmail });
      setSaving(false);
    } catch (err) {
      setSaving(false);
      setError(err instanceof Error ? err.message : 'Failed to ship');
    }
  };

  return (
    <form className={mode === 'card' ? 'card' : 'modal-form'} onSubmit={handleSubmit} noValidate>
      {mode === 'card' ? (
        <>
          <div className="card__title">Shipping address</div>
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
          <select
            required
            value={selectedCountryCode}
            onChange={(e) => {
              const next = e.target.value;
              onCountryCodeChange?.(next);
              if (countryCode == null) setLocalCountryCode(next);
            }}
          >
            {COUNTRIES.map((option) => (
              <option key={option.code} value={option.code}>
                {countryLabel(option)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="muted small">{shippingNote}</div>
      {error ? <div className="error">{error}</div> : null}
      <div className={`row${mode === 'modal' ? ' row--end' : ''}`}>
        {onCancel ? (
          <button type="button" className="ghost" onClick={onCancel} disabled={saving}>
            Cancel
          </button>
        ) : null}
        <button type="submit" disabled={saving || submitDisabled}>
          {saving ? 'Sending…' : submitLabel || 'Send'}
        </button>
      </div>
    </form>
  );
}
