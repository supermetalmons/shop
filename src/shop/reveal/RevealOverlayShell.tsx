import type { CSSProperties, ReactNode, TransitionEventHandler } from 'react';
import { MediaWithFallback } from '../../components/MediaWithFallback';
import { ModalFocusScope } from '../../components/ModalFocusScope';

type RevealOverlayShellProps = {
  name: string;
  imageSrc?: string;
  stage: string;
  active: boolean;
  closing: boolean;
  suspended: boolean;
  style?: CSSProperties;
  className?: string;
  busy: boolean;
  disabled: boolean;
  showOutcome: boolean;
  onDismiss: () => void;
  onReveal: () => void;
  onTransitionEnd: TransitionEventHandler<HTMLDivElement>;
  children?: ReactNode;
};

export function RevealOverlayShell({ name, imageSrc, stage, active, closing, suspended, style, className = '',
  busy, disabled, showOutcome, onDismiss, onReveal, onTransitionEnd, children }: RevealOverlayShellProps) {
  return <ModalFocusScope
    ariaLabel={`${name} unboxing`}
    suspended={closing || suspended}
    className={`reveal-overlay reveal-overlay--${stage}${active ? ' reveal-overlay--active' : ''}${closing ? ' reveal-overlay--closing' : ''}${suspended ? ' reveal-overlay--suspended' : ''}${className ? ` ${className}` : ''}`}
    style={style}
    onClick={() => { if (!closing && !suspended) onDismiss(); }}
    onContextMenu={event => event.preventDefault()}
    onDragStart={event => event.preventDefault()}
  >
    <div className="reveal-overlay__backdrop" />
    <div className="reveal-overlay__frame" onTransitionEnd={onTransitionEnd}>
      <div className={`reveal-overlay__shine${showOutcome ? ' reveal-overlay__shine--visible' : ''}`} aria-hidden="true" />
      {children}
      <button type="button" className="reveal-overlay__box" aria-label={`Reveal ${name}`}
        aria-busy={busy} aria-disabled={disabled}
        onClick={event => { event.stopPropagation(); if (!disabled && !suspended) onReveal(); }}>
        <MediaWithFallback imageSources={imageSrc ? [imageSrc] : []}
          imageProps={{ alt: name, className: 'reveal-overlay__image', draggable: false }}
          renderPlaceholder={hidden => <div className="reveal-overlay__image reveal-overlay__image--placeholder" hidden={hidden} aria-hidden="true" />} />
      </button>
    </div>
  </ModalFocusScope>;
}
