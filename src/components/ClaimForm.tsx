import { FormEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';

type ClaimFormResult = {
  itemsPerBox?: number;
  boxNamePrefix?: string;
  figureNamePrefix?: string;
};

interface ClaimFormProps {
  onClaim: (payload: { code: string }) => Promise<ClaimFormResult | void>;
  onSuccess?: () => void;
  onDismiss?: () => void;
  mode?: 'card' | 'modal';
  showTitle?: boolean;
  itemsPerBox?: number;
  boxNamePrefix?: string;
  figureNamePrefix?: string;
}

function resolveReceiptWord(value: string | undefined, fallback: string): string {
  if (value === undefined) return String(fallback ?? '').trim();
  return String(value).trim();
}

function receiptLabel(word: string, count: number): string {
  if (!word) return count === 1 ? 'receipt' : 'receipts';
  return count === 1 ? `${word} receipt` : `${word} receipts`;
}

function normalizeItemsPerBoxCount(value: number | undefined, fallback = 1): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(Number(value))) : fallback;
}

function shouldAutoFocusClaimCodeInput(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return !window.matchMedia('(pointer: coarse)').matches;
}

export function ClaimForm({
  onClaim,
  onSuccess,
  onDismiss,
  mode = 'card',
  showTitle = true,
  itemsPerBox,
  boxNamePrefix,
  figureNamePrefix,
}: ClaimFormProps) {
  const codeInputRef = useRef<HTMLInputElement | null>(null);
  const shouldAutoFocusCodeInput = shouldAutoFocusClaimCodeInput();
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const figuresPerBox = normalizeItemsPerBoxCount(itemsPerBox);
  const defaultBoxReceiptWord = resolveReceiptWord(boxNamePrefix, 'box');
  const defaultFigureReceiptWord = resolveReceiptWord(figureNamePrefix, 'figure');

  useEffect(() => {
    if (!onDismiss) return;

    const onKeyDown = (evt: KeyboardEvent) => {
      if (evt.key === 'Escape' && !loading) {
        evt.preventDefault();
        onDismiss();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [loading, onDismiss]);

  useLayoutEffect(() => {
    if (!shouldAutoFocusCodeInput) return;
    codeInputRef.current?.focus({ preventScroll: true });
  }, [shouldAutoFocusCodeInput]);

  const buildSuccessMessage = (args: ClaimFormResult) => {
    const normalizedBoxReceiptWord = resolveReceiptWord(args.boxNamePrefix, defaultBoxReceiptWord);
    const normalizedFigureReceiptWord = resolveReceiptWord(args.figureNamePrefix, defaultFigureReceiptWord);
    const normalizedCount = normalizeItemsPerBoxCount(args.itemsPerBox, figuresPerBox);
    if (normalizedCount === 0) {
      return `Claim submitted successfully! Your ${receiptLabel(normalizedBoxReceiptWord, 1)} was transferred.`;
    }
    const boxReceiptLabel = receiptLabel(normalizedBoxReceiptWord, 1);
    const figureLabel = receiptLabel(normalizedFigureReceiptWord, normalizedCount);
    const figureVerb = normalizedCount === 1 ? 'is' : 'are';
    return `Claim submitted successfully! Your ${boxReceiptLabel} was transferred and your ${normalizedCount} ${figureLabel} ${figureVerb} being minted.`;
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!shouldAutoFocusCodeInput) {
      codeInputRef.current?.blur();
    }
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await onClaim({ code: code.trim() });
      if (onSuccess) {
        onSuccess();
      } else {
        setSuccess(buildSuccessMessage(result || {}));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to claim certificates');
    } finally {
      setLoading(false);
    }
  };

  return (
    <form className={`${mode === 'card' ? 'card' : 'modal-form'} claim-form`} onSubmit={submit}>
      {showTitle ? <div className="card__title">Secret Code</div> : null}
      <label>
        <input
          ref={codeInputRef}
          autoFocus={shouldAutoFocusCodeInput}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="10 digits"
          inputMode="numeric"
          pattern="[0-9]{10}"
          maxLength={10}
          required
        />
      </label>
      {error ? <div className="error">{error}</div> : null}
      {success ? <div className="success">{success}</div> : null}
      <button type="submit" disabled={loading}>
        {loading ? 'Sending…' : 'Claim'}
      </button>
    </form>
  );
}
