import { FormEvent, useState } from 'react';

type ClaimFormResult = {
  itemsPerBox?: number;
  boxNamePrefix?: string;
  figureNamePrefix?: string;
};

interface ClaimFormProps {
  onClaim: (payload: { code: string }) => Promise<ClaimFormResult | void>;
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

export function ClaimForm({
  onClaim,
  mode = 'card',
  showTitle = true,
  itemsPerBox,
  boxNamePrefix,
  figureNamePrefix,
}: ClaimFormProps) {
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const figuresPerBox = Number.isFinite(itemsPerBox) && Number(itemsPerBox) > 0
    ? Math.floor(Number(itemsPerBox))
    : 1;
  const defaultBoxReceiptWord = resolveReceiptWord(boxNamePrefix, 'box');
  const defaultFigureReceiptWord = resolveReceiptWord(figureNamePrefix, 'figure');

  const buildSuccessMessage = (args: ClaimFormResult) => {
    const normalizedBoxReceiptWord = resolveReceiptWord(args.boxNamePrefix, defaultBoxReceiptWord);
    const normalizedFigureReceiptWord = resolveReceiptWord(args.figureNamePrefix, defaultFigureReceiptWord);
    const normalizedCount =
      Number.isFinite(args.itemsPerBox) && Number(args.itemsPerBox) > 0
        ? Math.floor(Number(args.itemsPerBox))
        : figuresPerBox;
    const boxReceiptLabel = receiptLabel(normalizedBoxReceiptWord, 1);
    const figureLabel = receiptLabel(normalizedFigureReceiptWord, normalizedCount);
    const figureVerb = normalizedCount === 1 ? 'is' : 'are';
    return `Claim submitted successfully! Your ${boxReceiptLabel} was transferred and your ${normalizedCount} ${figureLabel} ${figureVerb} being minted.`;
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await onClaim({ code: code.trim() });
      setSuccess(buildSuccessMessage(result || {}));
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
