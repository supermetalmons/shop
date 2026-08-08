import { Component, lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  createClearCardLightingPreset,
  type ClearCardLightingPresetId,
} from '../clearCardLighting';
import type { ViewerStatus } from '../ClearCardThreeViewer';
import { CLEAR_CARD_PREVIEW_MODEL_URL } from '../lib/clearCardModels';

const ClearCardThreeViewer = lazy(() => import('../ClearCardThreeViewer'));
const DARK_MODE_LIGHTING_PRESET_ID: ClearCardLightingPresetId = 'light-upcoming';
const LIGHT_MODE_LIGHTING_PRESET_ID: ClearCardLightingPresetId = 'dgpm-light-upcoming-white-bg';

export function clearCardDropPreviewLightingPresetId(
  darkMode: boolean,
): ClearCardLightingPresetId {
  return darkMode ? DARK_MODE_LIGHTING_PRESET_ID : LIGHT_MODE_LIGHTING_PRESET_ID;
}

function prefersDarkColorScheme() {
  return typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches;
}

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
  const [darkMode, setDarkMode] = useState(prefersDarkColorScheme);
  const lightingConfig = useMemo(
    () => createClearCardLightingPreset(clearCardDropPreviewLightingPresetId(darkMode)),
    [darkMode],
  );
  const ready = status === 'ready';

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const colorScheme = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = () => setDarkMode(colorScheme.matches);
    handleChange();
    colorScheme.addEventListener('change', handleChange);
    return () => colorScheme.removeEventListener('change', handleChange);
  }, []);

  return (
    <div className="clear-card-drop-preview-shell">
      <div
        className={`clear-card-drop-preview${ready ? ' clear-card-drop-preview--ready' : ''}`}
        aria-busy={status === 'loading'}
      >
        {fallbackImageSrc ? (
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
              cardModelUrl={CLEAR_CARD_PREVIEW_MODEL_URL}
              lightingConfig={lightingConfig}
              unrestrictedMovement
              axisLockedOrbit={false}
              snapBackOnRelease
              interactionFrameRateMode="adaptive"
              initiallyRevealed
              ariaLabel="Interactive 3D clear card; drag to rotate"
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
