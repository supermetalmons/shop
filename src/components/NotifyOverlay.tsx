import { useEffect, useLayoutEffect, useRef } from 'react';

const EOMAIL_FORM_ID = '578237fe-8fb4-11f0-8bba-a35988c2be69';
const EOMAIL_SCRIPT_SRC = `https://eomail5.com/form/${EOMAIL_FORM_ID}.js`;

interface NotifyOverlayProps {
  open: boolean;
  onClose: () => void;
}

export function NotifyOverlay({ open, onClose }: NotifyOverlayProps) {
  const signupRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (evt: KeyboardEvent) => {
      if (evt.key === 'Escape') onClose();
    };
    const previousOverflow = document.body.style.overflow;
    document.addEventListener('keydown', onKeyDown);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose]);

  // Inject the eomail5 form once when the component mounts so it's already
  // loaded by the time the user opens the overlay. The script inserts the
  // form HTML right after itself (i.e. as a child of the signup container).
  useLayoutEffect(() => {
    const container = signupRef.current;
    if (!container) return;
    const script = document.createElement('script');
    script.async = true;
    script.src = EOMAIL_SCRIPT_SRC;
    script.dataset.form = EOMAIL_FORM_ID;
    container.appendChild(script);
    return () => {
      while (container.firstChild) container.removeChild(container.firstChild);
    };
  }, []);

  return (
    <div
      className={`notify-overlay${open ? ' notify-overlay--open' : ''}`}
      role="presentation"
      aria-hidden={!open}
      onClick={(evt) => {
        if (!open) return;
        if (evt.target === evt.currentTarget) onClose();
      }}
    >
      <div
        className="notify-overlay__card"
        role="dialog"
        aria-modal="true"
        aria-label="Notify me"
        onClick={(evt) => evt.stopPropagation()}
      >
        <div ref={signupRef} className="notify-overlay__signup" />
      </div>
    </div>
  );
}

export default NotifyOverlay;
