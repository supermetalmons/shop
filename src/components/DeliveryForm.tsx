import { FormEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { type DropFamily } from '../config/deployment';
import { COUNTRIES, countryLabel, findCountryByCode } from '../lib/countries';
import { dropAssetLabel } from '../lib/dropLabels';
import { normalizeCountryCode } from '../../shared/countryNormalization.ts';
import {
  isDirectDeliveryItemsPerBox,
  resolveDeliveryPricing,
} from '../../shared/shipping.ts';

interface DeliveryFormProps {
  onSubmit: (payload: { formatted: string; country: string; countryCode: string; email: string }) => Promise<void>;
  defaultEmail?: string;
  itemsPerBox?: number;
  boxNamePrefix?: string;
  figureNamePrefix?: string;
  mode?: 'card' | 'modal';
  submitDisabled?: boolean;
  countryCode?: string;
  onCountryCodeChange?: (code: string) => void;
  submitLabel?: string;
  shipmentPending?: boolean;
  dropFamily?: DropFamily;
}

type DeliveryShippingContext = Pick<
  DeliveryFormProps,
  'itemsPerBox' | 'boxNamePrefix' | 'figureNamePrefix' | 'dropFamily'
>;

const useCommittedLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;
const LAMPORTS_PER_SOL = 1_000_000_000;

export function DeliveryForm({
  onSubmit,
  defaultEmail,
  itemsPerBox,
  boxNamePrefix,
  figureNamePrefix,
  mode = 'card',
  submitDisabled,
  countryCode,
  onCountryCodeChange,
  submitLabel,
  shipmentPending = false,
  dropFamily,
}: DeliveryFormProps) {
  const shippingContextRef = useRef<DeliveryShippingContext | null>(null);
  const liveShippingContext = {
    itemsPerBox,
    boxNamePrefix,
    figureNamePrefix,
    dropFamily,
  };
  const hasLiveShippingContext =
    itemsPerBox !== undefined ||
    boxNamePrefix !== undefined ||
    figureNamePrefix !== undefined ||
    dropFamily !== undefined;
  const shippingContext = hasLiveShippingContext
    ? liveShippingContext
    : shipmentPending
      ? shippingContextRef.current ?? liveShippingContext
      : liveShippingContext;
  useCommittedLayoutEffect(() => {
    if (hasLiveShippingContext) {
      shippingContextRef.current = { itemsPerBox, boxNamePrefix, figureNamePrefix, dropFamily };
    }
  }, [boxNamePrefix, dropFamily, figureNamePrefix, hasLiveShippingContext, itemsPerBox]);
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
  const directDelivery = isDirectDeliveryItemsPerBox(shippingContext.itemsPerBox);
  const pricing = resolveDeliveryPricing(selectedCountryCode, shippingContext.itemsPerBox, shippingContext.dropFamily);
  const countryOption = useMemo(
    () => findCountryByCode(selectedCountryCode) || findCountryByCode('INTL'),
    [selectedCountryCode],
  );
  const countryName = countryOption?.name || selectedCountryCode;
  const labelSource = {
    namePrefix: shippingContext.boxNamePrefix,
    figureNamePrefix: shippingContext.figureNamePrefix,
  };
  const deliveryUnitKind = directDelivery ? 'box' : 'figure';
  const deliveryRegion = normalizeCountryCode(selectedCountryCode) === 'US' ? 'US' : 'International';
  let shippingNote = `Free ${deliveryRegion === 'US' ? 'US' : 'international'} shipping`;
  if (pricing.kind === 'flat') {
    const flatLabel = shippingContext.dropFamily === 'poncho_drifella' ? ' flat' : '';
    shippingNote = `${deliveryRegion} delivery: ${pricing.baseLamports / LAMPORTS_PER_SOL} SOL${flatLabel}.`;
  } else if (pricing.kind === 'per-unit') {
    const deliveryUnitLabel = dropAssetLabel(labelSource, deliveryUnitKind, pricing.includedUnits);
    const singleDeliveryUnitLabel = dropAssetLabel(labelSource, deliveryUnitKind, 1);
    const baseUnitLabel = shippingContext.dropFamily === 'little_swag_hoodies' && pricing.includedUnits === 1
      ? `for the first ${singleDeliveryUnitLabel}`
      : `up to ${pricing.includedUnits} ${deliveryUnitLabel}`;
    shippingNote = `${deliveryRegion} delivery: ${pricing.baseLamports / LAMPORTS_PER_SOL} SOL ${baseUnitLabel}. ${pricing.extraUnitLamports / LAMPORTS_PER_SOL} SOL each additional ${singleDeliveryUnitLabel}.`;
  }

  useEffect(() => {
    if (!emailTouched && !email && defaultEmail) setEmail(defaultEmail);
  }, [defaultEmail, emailTouched, email]);

  const handleSubmit = async (evt: FormEvent<HTMLFormElement>) => {
    evt.preventDefault();
    if (submitDisabled || shipmentPending) return;
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
            className="country-picker"
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
        <button type="submit" disabled={saving || submitDisabled || shipmentPending}>
          {saving
            ? 'Sending…'
            : shipmentPending
              ? 'Shipment pending…'
              : submitLabel || 'Send'}
        </button>
      </div>
    </form>
  );
}
