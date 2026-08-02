import { Component, lazy, Suspense, useState, type ReactNode } from 'react';
import { createClearCardLightingPreset } from '../clearCardLighting';
import type { ViewerStatus } from '../ClearCardThreeViewer';
import { DEFAULT_CLEAR_CARD_MODEL_URL } from '../lib/clearCardModels';

const ClearCardThreeViewer = lazy(() => import('../ClearCardThreeViewer'));

type ViewerErrorBoundaryProps = {
  children: ReactNode;
  onError: () => void;
};

class ViewerErrorBoundary extends Component<ViewerErrorBoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error('[mons] failed to load the clear-card drop viewer', error);
    this.props.onError();
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export default function ClearCardDropPreview({ fallbackImageSrc }: { fallbackImageSrc?: string }) {
  const [status, setStatus] = useState<ViewerStatus>('loading');
  const [lightingConfig] = useState(() => createClearCardLightingPreset());
  const ready = status === 'ready';

  return (
    <div className="clear-card-drop-preview-shell">
      <div
        className={`clear-card-drop-preview${ready ? ' clear-card-drop-preview--ready' : ''}`}
        aria-busy={status === 'loading'}
      >
        {status === 'error' && fallbackImageSrc ? (
          <img
            className="clear-card-drop-preview__fallback"
            src={fallbackImageSrc}
            alt="Clear Cards pack"
            draggable={false}
          />
        ) : null}
        <ViewerErrorBoundary onError={() => setStatus('error')}>
          <Suspense fallback={null}>
            <ClearCardThreeViewer
              ready={ready}
              cardModelUrl={DEFAULT_CLEAR_CARD_MODEL_URL}
              lightingConfig={lightingConfig}
              unrestrictedMovement={false}
              axisLockedOrbit={false}
              initiallyRevealed
              ariaLabel="Interactive 3D clear card"
              onStatusChange={setStatus}
            />
          </Suspense>
        </ViewerErrorBoundary>
        {status === 'error' ? (
          <div className="clear-card-drop-preview__status" role="alert">
            Unable to display 3D card.
          </div>
        ) : null}
      </div>
    </div>
  );
}
