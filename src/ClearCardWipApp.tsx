import { lazy, Suspense, useCallback, useState } from 'react';
import { navigate } from './navigation';
import './clearCardWip.css';

const ClearCardThreeViewer = lazy(() => import('./ClearCardThreeViewer'));

type ViewerStatus = 'loading' | 'ready' | 'error';

export default function ClearCardWipApp() {
  const [status, setStatus] = useState<ViewerStatus>('loading');
  const handleStatusChange = useCallback((nextStatus: ViewerStatus) => {
    setStatus(nextStatus);
  }, []);
  const handleClose = useCallback(() => {
    navigate('/');
  }, []);

  const ready = status === 'ready';
  const statusMessage = status === 'error' ? 'Unable to display 3D card.' : 'Loading…';

  return (
    <div
      className="clear-card-wip"
      role="dialog"
      aria-modal="true"
      aria-label="Clear card sample"
    >
      <div className="clear-card-wip__backdrop" aria-hidden="true" />
      <div className="clear-card-wip__stage">
        <div
          className={`clear-card-wip__viewport${ready ? ' clear-card-wip__viewport--ready' : ''}`}
          aria-busy={status === 'loading'}
        >
          <Suspense fallback={null}>
            <ClearCardThreeViewer ready={ready} onStatusChange={handleStatusChange} />
          </Suspense>
          {!ready ? (
            <div
              className={`clear-card-wip__status${
                status === 'error' ? ' clear-card-wip__status--error' : ''
              }`}
              role={status === 'error' ? 'alert' : 'status'}
              aria-live="polite"
            >
              {statusMessage}
            </div>
          ) : null}
        </div>
      </div>
      <button
        type="button"
        className="wip-close-btn"
        onClick={handleClose}
        aria-label="Close clear card viewer"
        autoFocus
      >
        Close
      </button>
    </div>
  );
}
