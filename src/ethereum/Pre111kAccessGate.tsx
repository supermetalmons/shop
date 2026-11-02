import { useEffect, useId, useState, type CSSProperties } from 'react';

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
  const [viewport, setViewport] = useState<{ height: number; top: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const visualViewport = window.visualViewport;
    const update = () => setViewport({ height: visualViewport?.height ?? window.innerHeight, top: visualViewport?.offsetTop ?? 0 });
    update();
    visualViewport?.addEventListener('resize', update);
    visualViewport?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    return () => {
      visualViewport?.removeEventListener('resize', update);
      visualViewport?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [open]);

  const style = viewport ? {
    '--relic-gate-viewport-height': `${viewport.height}px`,
    '--relic-gate-viewport-top': `${viewport.top}px`,
  } as CSSProperties : undefined;
  const compact = viewport !== null && viewport.height < 540;

  return (
    <div className={`relic-access${open ? ' relic-access--open' : ''}${compact ? ' relic-access--compact' : ''}`}
      style={style} inert={!open || undefined} aria-hidden={!open || undefined}>
      <div className="relic-access__composition">
        <img className="relic-access__logo" src="https://wip.lil.org/111k/111k.webp" width={927} height={298} alt="111k" draggable={false} />
        <form className="relic-access__form" aria-label="Enter secret code" aria-busy={verifying}
          onSubmit={event => { event.preventDefault(); if (!verifying && input.trim()) void submit(); }}>
          <div className={`relic-access__field${error ? ' relic-access__field--error' : ''}`}>
            <input type="text" aria-label="Secret code" placeholder="SECRET CODE" value={input} maxLength={64}
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
