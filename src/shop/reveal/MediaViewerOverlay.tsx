import { useRef, type CSSProperties, type ReactNode, type TransitionEventHandler } from 'react';
import { useModalFocusScope } from '../../components/ModalFocusScope';
import { useViewerDismissInput } from '../../hooks/useViewerDismissInput';

type MediaViewerOverlayProps = {
  name: string;
  resetKey?: string;
  active: boolean;
  closing: boolean;
  suspended: boolean;
  style?: CSSProperties;
  className?: string;
  dismissIgnoreSelector?: string;
  onDismiss?: () => void;
  onTransitionEnd?: TransitionEventHandler<HTMLDivElement>;
  children: ReactNode;
  controls?: ReactNode;
};

export function MediaViewerOverlay({ name, resetKey, active, closing, suspended, style, className = '',
  dismissIgnoreSelector, onDismiss, onTransitionEnd, children, controls }: MediaViewerOverlayProps) {
  const dismissInput = useViewerDismissInput({ enabled: !closing && !suspended, onDismiss, resetKey, ignoreSelector: dismissIgnoreSelector });
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useModalFocusScope({ dialogRef, focusKey: closing ? 'closing' : active ? 'active' : 'opening', suspended });
  return <div {...dismissInput} ref={dialogRef}
    className={`reveal-overlay reveal-overlay--viewer ${className} reveal-overlay--revealed${active ? ' reveal-overlay--active' : ''}${closing ? ' reveal-overlay--closing' : ''}${suspended ? ' reveal-overlay--suspended' : ''}`}
    role="dialog" aria-modal={suspended ? undefined : 'true'} aria-hidden={suspended || undefined}
    aria-label={`${name} viewer`} inert={suspended || undefined} tabIndex={-1} style={style}
    onContextMenu={event => event.preventDefault()} onDragStart={event => event.preventDefault()}>
    <div className="reveal-overlay__backdrop" />
    <div className="reveal-overlay__frame" onTransitionEnd={onTransitionEnd}>{children}</div>
    {controls}
  </div>;
}
