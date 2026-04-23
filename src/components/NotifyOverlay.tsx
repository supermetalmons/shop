import { useEffect, useRef } from 'react';

const EOMAIL_FORM_ID = '578237fe-8fb4-11f0-8bba-a35988c2be69';
const EOMAIL_SCRIPT_SRC = `https://eomail5.com/form/${EOMAIL_FORM_ID}.js`;
const EOMAIL_FORM_SELECTOR = `[data-form="${EOMAIL_FORM_ID}"]`;

interface NotifyOverlayProps {
  open: boolean;
  onClose: () => void;
}

function buildIframeSrcDoc(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="color-scheme" content="light dark" />
<style>
  :root {
    color-scheme: light dark;
    /* Light defaults */
    --notify-text: #1d1d1f;
    --notify-text-muted: rgba(29, 29, 31, 0.55);
    --notify-text-faint: rgba(29, 29, 31, 0.42);
    --notify-input-bg: rgba(0, 0, 0, 0.04);
    --notify-input-bg-focus: rgba(0, 0, 0, 0.06);
    --notify-input-border: rgba(0, 0, 0, 0.12);
    --notify-input-placeholder: rgba(29, 29, 31, 0.42);
    --notify-accent: #0b84ff;
    --notify-error: #d93025;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --notify-text: #ffffff;
      --notify-text-muted: rgba(255, 255, 255, 0.55);
      --notify-text-faint: rgba(255, 255, 255, 0.4);
      --notify-input-bg: rgba(255, 255, 255, 0.08);
      --notify-input-bg-focus: rgba(255, 255, 255, 0.12);
      --notify-input-border: rgba(255, 255, 255, 0.18);
      --notify-input-placeholder: rgba(255, 255, 255, 0.45);
      --notify-error: #ff6b6b;
    }
  }
  html, body {
    margin: 0;
    background: transparent;
    color: var(--notify-text);
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'SF Pro Display', 'Helvetica Neue', Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  body {
    padding: 22px 22px 16px;
    box-sizing: border-box;
  }
  /* Eomail5 form overrides — make it adapt to system color-scheme. */
  ${EOMAIL_FORM_SELECTOR}.inline-container {
    max-width: 100% !important;
    width: 100%;
  }
  ${EOMAIL_FORM_SELECTOR} .emailoctopus-form-wrapper {
    margin: 0 !important;
    padding: 0 !important;
    background: transparent !important;
  }
  ${EOMAIL_FORM_SELECTOR} .form-control {
    background-color: var(--notify-input-bg) !important;
    border: 1px solid var(--notify-input-border) !important;
    color: var(--notify-text) !important;
    border-radius: 12px !important;
    height: 44px !important;
    padding: 10px 14px !important;
    font-size: 16px !important;
    box-shadow: none !important;
    transition: border-color 0.15s ease, background-color 0.15s ease !important;
  }
  ${EOMAIL_FORM_SELECTOR} .form-control:focus {
    background-color: var(--notify-input-bg-focus) !important;
    border-color: rgba(11, 132, 255, 0.65) !important;
    box-shadow: 0 0 0 3px rgba(11, 132, 255, 0.25) !important;
    color: var(--notify-text) !important;
    outline: none !important;
  }
  ${EOMAIL_FORM_SELECTOR} .form-control::placeholder {
    color: var(--notify-input-placeholder) !important;
  }
  ${EOMAIL_FORM_SELECTOR} .btn,
  ${EOMAIL_FORM_SELECTOR} .btn-primary,
  ${EOMAIL_FORM_SELECTOR} input[type="submit"] {
    width: 100% !important;
    height: 44px !important;
    background-color: var(--notify-accent) !important;
    border: 0 !important;
    border-radius: 12px !important;
    color: #fff !important;
    font-size: 16px !important;
    font-weight: 600 !important;
    letter-spacing: 0.2px !important;
    box-shadow: none !important;
    cursor: pointer !important;
    transition: opacity 0.15s ease !important;
    margin-top: 10px !important;
  }
  ${EOMAIL_FORM_SELECTOR} .btn:hover,
  ${EOMAIL_FORM_SELECTOR} .btn-primary:hover,
  ${EOMAIL_FORM_SELECTOR} input[type="submit"]:hover {
    background-color: var(--notify-accent) !important;
    opacity: 0.92 !important;
  }
  ${EOMAIL_FORM_SELECTOR} .btn:active,
  ${EOMAIL_FORM_SELECTOR} .btn-primary:active,
  ${EOMAIL_FORM_SELECTOR} input[type="submit"]:active {
    opacity: 0.78 !important;
  }
  ${EOMAIL_FORM_SELECTOR} .form-group,
  ${EOMAIL_FORM_SELECTOR} .emailoctopus-form-row {
    margin-bottom: 0 !important;
  }
  ${EOMAIL_FORM_SELECTOR} .emailoctopus-success-message,
  ${EOMAIL_FORM_SELECTOR} .emailoctopus-error-message {
    color: var(--notify-text-muted) !important;
    text-align: center;
    margin: 0 !important;
    padding: 0 !important;
    font-size: 14px;
  }
  ${EOMAIL_FORM_SELECTOR} .emailoctopus-success-message:empty,
  ${EOMAIL_FORM_SELECTOR} .emailoctopus-error-message:empty {
    display: none !important;
  }
  ${EOMAIL_FORM_SELECTOR} .emailoctopus-success-message:not(:empty),
  ${EOMAIL_FORM_SELECTOR} .emailoctopus-error-message:not(:empty) {
    margin-bottom: 8px !important;
  }
  ${EOMAIL_FORM_SELECTOR} .emailoctopus-error-message {
    color: var(--notify-error) !important;
  }
  ${EOMAIL_FORM_SELECTOR} .mastfoot,
  ${EOMAIL_FORM_SELECTOR} .mastfoot * {
    color: var(--notify-text-faint) !important;
    font-size: 11px !important;
  }
  ${EOMAIL_FORM_SELECTOR} .mastfoot a {
    color: var(--notify-text-muted) !important;
    text-decoration: none !important;
  }
  ${EOMAIL_FORM_SELECTOR} .mastfoot {
    margin-top: 10px !important;
  }
</style>
</head>
<body>
<div id="signup"></div>
<script async src="${EOMAIL_SCRIPT_SRC}" data-form="${EOMAIL_FORM_ID}"></script>
</body>
</html>`;
}

export function NotifyOverlay({ open, onClose }: NotifyOverlayProps) {
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

  // The srcdoc is built once and the iframe stays mounted across open/close,
  // so the third-party script + fonts + styles are already loaded by the time
  // the user actually opens the overlay.
  const srcDocRef = useRef<string | null>(null);
  if (srcDocRef.current === null) srcDocRef.current = buildIframeSrcDoc();
  const srcDoc = srcDocRef.current;

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
        className="notify-overlay__frame-wrap"
        role="dialog"
        aria-modal="true"
        aria-label="Notify me"
        onClick={(evt) => evt.stopPropagation()}
      >
        <iframe
          className="notify-overlay__frame"
          title="Notify me"
          srcDoc={srcDoc}
          sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
          referrerPolicy="no-referrer"
          loading="eager"
          tabIndex={open ? 0 : -1}
          allowTransparency
        />
      </div>
    </div>
  );
}

export default NotifyOverlay;
