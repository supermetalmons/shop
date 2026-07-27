import {
  type FormEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { shouldAutoFocusFormControl } from '../lib/focusTrap';
import { normalizeReceiptTransferDestination } from '../lib/receiptTransfer';

export type ReceiptTransferFormProps = {
  feePayer: string;
  onTransfer: (destination: string) => Promise<void>;
  onCancel: () => void;
};

function readableTransferError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return 'Unable to transfer receipt. Please try again.';
}

export function ReceiptTransferForm({
  feePayer,
  onTransfer,
  onCancel,
}: ReceiptTransferFormProps) {
  const mountedRef = useRef(false);
  const pendingRef = useRef(false);
  const destinationInputRef = useRef<HTMLInputElement | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const submitButtonRef = useRef<HTMLButtonElement | null>(null);
  const errorId = useId();
  const [destination, setDestination] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useLayoutEffect(() => {
    const initialFocus = shouldAutoFocusFormControl()
      ? destinationInputRef.current
      : cancelButtonRef.current;
    initialFocus?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (pending) submitButtonRef.current?.focus({ preventScroll: true });
  }, [pending]);

  const dismiss = () => {
    if (pendingRef.current) return;
    onCancel();
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pendingRef.current) return;

    const trimmedDestination = destination.trim();
    setDestination(trimmedDestination);

    let normalizedDestination: string;
    try {
      normalizedDestination = normalizeReceiptTransferDestination(trimmedDestination, feePayer);
    } catch (validationError) {
      setError(readableTransferError(validationError));
      destinationInputRef.current?.focus({ preventScroll: true });
      return;
    }

    setDestination(normalizedDestination);
    setError(null);
    pendingRef.current = true;
    setPending(true);

    try {
      await onTransfer(normalizedDestination);
    } catch (transferError) {
      if (mountedRef.current) {
        setError(readableTransferError(transferError));
      }
    } finally {
      pendingRef.current = false;
      if (mountedRef.current) setPending(false);
    }
  };

  return (
    <form
      className="modal-form compact-modal-form receipt-transfer-form"
      onSubmit={submit}
      noValidate
      aria-busy={pending}
    >
      <input
        ref={destinationInputRef}
        type="text"
        inputMode="text"
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        maxLength={64}
        value={destination}
        onChange={(event) => {
          setDestination(event.target.value);
          if (error) setError(null);
        }}
        placeholder="Destination address"
        aria-label="Destination address"
        required
        disabled={pending}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
      />
      {error ? (
        <div id={errorId} className="error" role="alert">
          {error}
        </div>
      ) : null}
      <div className="compact-modal-form__actions receipt-transfer-form__actions">
        <button ref={cancelButtonRef} type="button" onClick={dismiss} disabled={pending}>
          Cancel
        </button>
        <button ref={submitButtonRef} type="submit" aria-disabled={pending} aria-busy={pending}>
          OK
        </button>
      </div>
    </form>
  );
}
