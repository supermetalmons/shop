import { FormEvent, KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { z } from 'zod';
import { subscribeToNotifications } from '../lib/api';

interface NotifyFormProps {
  onSuccess: () => void;
  onCancel: () => void;
}

const NOTIFICATION_EMAIL_SCHEMA = z.string().email().max(254);

function isValidEmail(email: string): boolean {
  return NOTIFICATION_EMAIL_SCHEMA.safeParse(email).success;
}

function keepFocusInNotifyForm(event: KeyboardEvent<HTMLFormElement>) {
  if (event.key !== 'Tab') return;
  const controls = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled)'),
  );
  const firstControl = controls[0];
  const lastControl = controls.at(-1);
  if (!firstControl || !lastControl) return;

  if (event.shiftKey && document.activeElement === firstControl) {
    event.preventDefault();
    lastControl.focus({ preventScroll: true });
  } else if (!event.shiftKey && document.activeElement === lastControl) {
    event.preventDefault();
    firstControl.focus({ preventScroll: true });
  }
}

export function NotifyForm({ onSuccess, onCancel }: NotifyFormProps) {
  const mountedRef = useRef(false);
  const pendingRef = useRef(false);
  const errorId = useId();
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pendingRef.current) return;

    const normalizedEmail = email.trim();
    setEmail(normalizedEmail);

    if (!isValidEmail(normalizedEmail)) {
      setError('Enter a valid email address.');
      return;
    }

    pendingRef.current = true;
    setPending(true);
    setError(null);

    try {
      const result = await subscribeToNotifications({ email: normalizedEmail });
      if (!result || result.subscribed !== true) {
        throw new Error('Unexpected subscription response.');
      }
    } catch {
      if (mountedRef.current) setError('Unable to subscribe. Please try again.');
      return;
    } finally {
      pendingRef.current = false;
      if (mountedRef.current) setPending(false);
    }

    if (mountedRef.current) onSuccess();
  };

  return (
    <form
      className="modal-form notify-form"
      onSubmit={submit}
      onKeyDown={keepFocusInNotifyForm}
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
      <div className="notify-form__actions">
        <button type="button" onClick={onCancel} disabled={pending}>
          Cancel
        </button>
        <button type="submit" disabled={pending} aria-busy={pending}>
          OK
        </button>
      </div>
    </form>
  );
}
