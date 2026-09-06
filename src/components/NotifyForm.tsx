import { FormEvent, useEffect, useId, useRef, useState } from 'react';
import { z } from 'zod';
import { useAsyncSubmit } from '../hooks/useAsyncSubmit';
import { subscribeToNotifications } from '../lib/notificationSubscriptions';

interface NotifyFormProps {
  onSuccess: () => void;
  onCancel: () => void;
}

const NOTIFICATION_EMAIL_SCHEMA = z.string().email().max(254);

function isValidEmail(email: string): boolean {
  return NOTIFICATION_EMAIL_SCHEMA.safeParse(email).success;
}

export function NotifyForm({ onSuccess, onCancel }: NotifyFormProps) {
  const submitButtonRef = useRef<HTMLButtonElement | null>(null);
  const errorId = useId();
  const [email, setEmail] = useState('');
  const { pending, error, setError, isPending, run } = useAsyncSubmit({
    formatError: () => 'Unable to subscribe. Please try again.',
  });

  useEffect(() => {
    if (pending) submitButtonRef.current?.focus({ preventScroll: true });
  }, [pending]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isPending()) return;

    const normalizedEmail = email.trim();
    setEmail(normalizedEmail);

    if (!isValidEmail(normalizedEmail)) {
      setError('Enter a valid email address.');
      return;
    }

    await run(async () => {
      const result = await subscribeToNotifications({ email: normalizedEmail });
      if (!result || result.subscribed !== true) {
        throw new Error('Unexpected subscription response.');
      }
    }, onSuccess);
  };

  return (
    <form
      className="modal-form compact-modal-form notify-form"
      onSubmit={submit}
      noValidate
      aria-busy={pending}
    >
      <input
        autoFocus
        type="email"
        inputMode="email"
        autoComplete="email"
        maxLength={254}
        value={email}
        onChange={(event) => {
          setEmail(event.target.value);
          if (error) setError(null);
        }}
        placeholder="Email"
        aria-label="Email"
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
      <div className="compact-modal-form__actions notify-form__actions">
        <button type="button" onClick={onCancel} disabled={pending}>
          Cancel
        </button>
        <button ref={submitButtonRef} type="submit" aria-disabled={pending} aria-busy={pending}>
          OK
        </button>
      </div>
    </form>
  );
}
