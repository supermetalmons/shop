import { useEffect, useId, useRef } from 'react';

type Pre111kAccessGateProps = {
  open: boolean;
  input: string;
  setInput: (value: string) => void;
  verifying: boolean;
  error: string | null;
  submit: () => Promise<void>;
};

export function Pre111kAccessGate({ open, input, setInput, verifying, error, submit }: Pre111kAccessGateProps) {
  const feedbackId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreInputFocus = useRef(false);

  useEffect(() => {
    if (!open) restoreInputFocus.current = false;
    if (!open || !error || !restoreInputFocus.current) return;
    restoreInputFocus.current = false;
    if (document.activeElement === document.body) inputRef.current?.focus({ preventScroll: true });
  }, [open, error]);

  return (
    <div className={`relic-access${open ? ' relic-access--open' : ''}`}
      inert={!open || undefined} aria-hidden={!open || undefined}>
      <div className="relic-access__composition">
        <img className="relic-access__logo" src="https://cdn.lil.org/nft/111k/111k.webp" width={927} height={298} alt="111k" draggable={false} />
        <form className="relic-access__form" aria-label="Enter secret code" aria-busy={verifying}
          onSubmit={event => {
            event.preventDefault();
            if (verifying || !input.trim()) return;
            restoreInputFocus.current = document.activeElement === inputRef.current;
            inputRef.current?.blur();
            void submit();
          }}>
          <div className={`relic-access__field${error ? ' relic-access__field--error' : ''}`}>
            <input ref={inputRef} type="text" aria-label="Secret code" placeholder="SECRET CODE" value={input} maxLength={64}
              onChange={event => setInput(event.target.value.toUpperCase())} autoCapitalize="characters"
              autoComplete="off" autoCorrect="off" spellCheck={false} enterKeyHint="go"
              aria-invalid={Boolean(error)} aria-describedby={error || verifying ? feedbackId : undefined} />
            <button type="submit" aria-label="Continue" disabled={verifying || !input.trim()}>
              {verifying ? <svg className="relic-access__spinner" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.8" opacity=".2" />
                <path d="M12 4a8 8 0 0 1 8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg> : <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M5 12h14m-6-6 6 6-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>}
            </button>
          </div>
          <p id={feedbackId} className="relic-access__feedback" role={error ? 'alert' : 'status'}>{error ?? (verifying ? 'Checking code…' : '')}</p>
        </form>
      </div>
    </div>
  );
}
