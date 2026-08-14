import { Buffer } from 'buffer';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom/client';
import ClearCardThreeViewer, {
  type ClearCardThreeViewerHandle,
  type ViewerStatus,
} from '../ClearCardThreeViewer';
import {
  createClearCardLightingPreset,
  DEFAULT_CLEAR_CARD_LIGHTING_PRESET_ID,
} from '../clearCardLighting';
import {
  CLEAR_CARD_MODEL_COUNT,
  DEFAULT_CLEAR_PACK_MODEL_URL,
  clearCardModelUrl,
} from '../lib/clearCardModels';
import { resolveSnapshotOutputSize } from '../lib/clearCardSnapshot';
import './clearCards.css';

if (!window.Buffer) window.Buffer = Buffer;

function positiveInteger(value: string | null, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function receiverEndpoint(baseUrl: string, path: string) {
  return new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
}

function ClearCardStaticRenderer() {
  const config = useMemo(() => {
    const search = new URLSearchParams(window.location.search);
    const firstCard = positiveInteger(search.get('from'), 1);
    const lastCard = positiveInteger(search.get('to'), CLEAR_CARD_MODEL_COUNT);
    const targetLongestEdge = positiveInteger(search.get('target'), 1400);
    const sourceLongestEdge = positiveInteger(search.get('source'), targetLongestEdge * 4);
    return {
      firstCard,
      lastCard,
      targetLongestEdge,
      sourceLongestEdge,
      mode: search.get('mode') === 'dark' ? 'dark' : 'light',
      receiverUrl: search.get('receiver') ?? 'http://127.0.0.1:5175',
    };
  }, []);
  const [cardId, setCardId] = useState(config.firstCard);
  const [viewerStatus, setViewerStatus] = useState<ViewerStatus>('loading');
  const [completed, setCompleted] = useState(0);
  const [error, setError] = useState<string>();
  const viewerRef = useRef<ClearCardThreeViewerHandle | null>(null);
  const capturingCardRef = useRef<number | undefined>(undefined);
  const errorReportedRef = useRef(false);
  const lightingConfig = useMemo(
    () => createClearCardLightingPreset(DEFAULT_CLEAR_CARD_LIGHTING_PRESET_ID, { darkMode: false }),
    [],
  );
  const cardModelUrl = clearCardModelUrl(cardId);

  const reportError = useCallback((cause: unknown) => {
    if (errorReportedRef.current) return;
    errorReportedRef.current = true;
    const message = cause instanceof Error ? cause.message : String(cause);
    setError(message);
    void fetch(receiverEndpoint(config.receiverUrl, 'error'), {
      method: 'POST',
      body: message,
    }).catch(() => undefined);
  }, [config.receiverUrl]);

  useEffect(() => {
    if (viewerStatus === 'error') {
      reportError(new Error(`3D viewer failed for card ${cardId}.`));
    }
  }, [cardId, reportError, viewerStatus]);

  useEffect(() => {
    if (viewerStatus !== 'ready' || !cardModelUrl || capturingCardRef.current === cardId) return;
    capturingCardRef.current = cardId;
    let cancelled = false;

    void (async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const snapshot = await viewerRef.current?.captureSnapshot({
        longestEdge: config.sourceLongestEdge,
      });
      if (!snapshot || cancelled) return;
      const outputSize = resolveSnapshotOutputSize(
        { x: 0, y: 0, width: snapshot.cropSize.width, height: snapshot.cropSize.height },
        config.targetLongestEdge,
      );
      const response = await fetch(
        `${receiverEndpoint(config.receiverUrl, 'upload')}?filename=${cardId}.png`,
        {
          method: 'POST',
          headers: {
            'X-Output-Height': String(outputSize.height),
            'X-Output-Width': String(outputSize.width),
          },
          body: snapshot.blob,
        },
      );
      if (!response.ok) throw new Error(`Receiver rejected card ${cardId}.`);
      if (cancelled) return;
      setCompleted((value) => value + 1);
      if (cardId >= config.lastCard) {
        await fetch(receiverEndpoint(config.receiverUrl, 'complete'), { method: 'POST' });
        return;
      }
      setViewerStatus('loading');
      setCardId((value) => value + 1);
    })().catch(reportError);

    return () => {
      cancelled = true;
    };
  }, [cardId, cardModelUrl, config, reportError, viewerStatus]);

  return (
    <main className="clear-card-static-renderer">
      <div
        className={`clear-card-static-renderer__status${
          error ? ' clear-card-static-renderer__status--error' : ''
        }`}
      >
        {error ?? `${config.mode} · card ${cardId} · ${completed} complete`}
      </div>
      <div className="clear-card-static-renderer__viewport">
        <ClearCardThreeViewer
          key={cardModelUrl}
          ref={viewerRef}
          ready={viewerStatus === 'ready'}
          cardModelUrl={cardModelUrl}
          packModelUrl={DEFAULT_CLEAR_PACK_MODEL_URL}
          lightingConfig={lightingConfig}
          unrestrictedMovement={false}
          axisLockedOrbit={false}
          interactionEnabled={false}
          initiallyRevealed
          ariaLabel={`Static renderer for clear card ${cardId}`}
          onStatusChange={setViewerStatus}
        />
      </div>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(<ClearCardStaticRenderer />);
