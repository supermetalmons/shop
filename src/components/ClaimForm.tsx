import { FormEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { shouldAutoFocusFormControl } from '../lib/focusTrap';
import { isStripeReceiptClaimCode } from '../lib/stripeReceiptClaims';
import { useAsyncSubmit } from '../hooks/useAsyncSubmit';

type ClaimFormResult = {
  itemsPerBox?: number;
  boxNamePrefix?: string;
  figureNamePrefix?: string;
  deferred?: boolean;
};

interface ClaimFormProps {
  onClaim: (payload: { code: string; recipient?: string }) => Promise<ClaimFormResult | void>;
  onSuccess?: () => void;
  onLoadingChange?: (loading: boolean) => void;
  mode?: 'card' | 'modal';
  showTitle?: boolean;
  itemsPerBox?: number;
  boxNamePrefix?: string;
  figureNamePrefix?: string;
  initialCode?: string;
  defaultRecipient?: string;
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

export function ClaimForm({
  onClaim,
  onSuccess,
  onLoadingChange,
  mode = 'card',
  showTitle = true,
  itemsPerBox,
  boxNamePrefix,
  figureNamePrefix,
  initialCode = '',
  defaultRecipient = '',
}: ClaimFormProps) {
  const codeInputRef = useRef<HTMLInputElement | null>(null);
  const recipientInputRef = useRef<HTMLInputElement | null>(null);
  const recipientTouchedRef = useRef(false);
  const shouldAutoFocusCodeInput = shouldAutoFocusFormControl();
  const [code, setCode] = useState(initialCode);
  const [recipient, setRecipient] = useState('');
  const { pending: loading, error, setError, isPending, run } = useAsyncSubmit({
    formatError: (error) => error instanceof Error ? error.message : 'Unable to claim certificates',
    onPendingChange: onLoadingChange,
  });
  const [success, setSuccess] = useState<string | null>(null);
  const figuresPerBox = normalizeItemsPerBoxCount(itemsPerBox);
  const defaultBoxReceiptWord = resolveReceiptWord(boxNamePrefix, 'box');
  const defaultFigureReceiptWord = resolveReceiptWord(figureNamePrefix, 'figure');
  const isStripeCode = isStripeReceiptClaimCode(code);

  useEffect(() => {
    recipientTouchedRef.current = false;
    setCode(initialCode);
    setRecipient('');
    setError(null);
    setSuccess(null);
  }, [initialCode]);

  useEffect(() => {
    if (!isStripeCode || recipientTouchedRef.current || !defaultRecipient) return;
    setRecipient((current) => (current ? current : defaultRecipient));
  }, [defaultRecipient, isStripeCode]);

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
    if (isPending()) return;
    if (!shouldAutoFocusCodeInput) {
      codeInputRef.current?.blur();
      recipientInputRef.current?.blur();
    }
    setSuccess(null);
    await run(
      () => onClaim({
        code: code.trim(),
        ...(isStripeCode ? { recipient: recipient.trim() } : {}),
      }),
      (result) => {
        if (result && result.deferred) return;
        if (onSuccess) {
          onSuccess();
        } else {
          setSuccess(buildSuccessMessage(result || {}));
        }
      },
    );
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
          placeholder="Code"
          required
        />
      </label>
      {isStripeCode ? (
        <label>
          <input
            ref={recipientInputRef}
            value={recipient}
            onChange={(e) => {
              recipientTouchedRef.current = true;
              setRecipient(e.target.value);
            }}
            placeholder="Receiver Solana address"
            aria-label="Receiver Solana address"
            required
          />
        </label>
      ) : null}
      {error ? <div className="error">{error}</div> : null}
      {success ? <div className="success">{success}</div> : null}
      <button type="submit" disabled={loading}>
        {loading ? 'Sending…' : 'Claim'}
      </button>
    </form>
  );
}
