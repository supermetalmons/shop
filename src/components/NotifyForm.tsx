import { FormEvent, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { subscribeToNotifications } from '../lib/api';

interface NotifyFormProps {
  onSuccess: () => void;
}

const NOTIFICATION_EMAIL_SCHEMA = z.string().email().max(254);

function shouldAutoFocusEmailInput(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(pointer: fine)').matches;
}

function isValidEmail(email: string): boolean {
  return NOTIFICATION_EMAIL_SCHEMA.safeParse(email).success;
}

export function NotifyForm({ onSuccess }: NotifyFormProps) {
  const emailInputRef = useRef<HTMLInputElement | null>(null);
  const mountedRef = useRef(false);
  const pendingRef = useRef(false);
  const errorId = useId();
  const [shouldAutoFocus] = useState(shouldAutoFocusEmailInput);
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useLayoutEffect(() => {
    if (!shouldAutoFocus) return;
    emailInputRef.current?.focus({ preventScroll: true });
  }, [shouldAutoFocus]);

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
    <form className="modal-form notify-form" onSubmit={submit} noValidate aria-busy={pending}>
      <label>
        <span className="muted">Email</span>
        <input
          ref={emailInputRef}
          type="email"
          inputMode="email"
          autoComplete="email"
          maxLength={254}
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
            if (error) setError(null);
          }}
          placeholder="you@example.com"
          required
          disabled={pending}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : undefined}
        />
      </label>
      {error ? (
        <div id={errorId} className="error" role="alert">
          {error}
        </div>
      ) : null}
      <button type="submit" disabled={pending} aria-busy={pending}>
        {pending ? 'Adding…' : 'Notify Me'}
      </button>
    </form>
  );
}
