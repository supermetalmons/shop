import { Component, lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { BodyPortal, useBackgroundBlur } from '../../components/BackgroundBlurLayer';
import { ModalFocusScope } from '../../components/ModalFocusScope';
import { useStaticToModelHandoff } from '../../hooks/useStaticToModelHandoff';
import { createMiNoteCardInput, type PackPointerEvent } from '../../lib/miNoteCardInput';
import { ETHEREUM_CONTAINER_MEDIA } from '../containerMedia';
import { ethereumRevealTiles } from '../revealLayout';
import type { EthereumInventoryPresentation } from '../useEthereumInventoryPresentation';
import { loadCratePreviewAssets, type CratePreview, type CratePreviewAssets } from './crateAssets';
import { createCrateFlow, hitCrateFlow, pauseCrateFlow, readyCrateFlow } from './crateFlow';
import { playCrateHitSound, playCrateOpenSound, preloadCrateSounds } from './crateSounds';

const CrateScene = lazy(() => import('./CrateScene'));

class SceneBoundary extends Component<{ children: ReactNode; onError: (error: Error) => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error) { this.props.onError(error); }
  render() { return this.state.failed ? null : this.props.children; }
}

function PreparedPreview({ preview, style }: { preview: CratePreview; style: CSSProperties }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const target = canvas.current;
    if (!target) return;
    target.width = preview.image.width;
    target.height = preview.image.height;
    target.getContext('2d')?.drawImage(preview.image, 0, 0);
  }, [preview]);
  return <canvas ref={canvas} role="img" aria-label={preview.name}
    data-reveal-item={preview.id} className="crate-reveal__preview" style={style} />;
}

export function CrateRevealOverlay({ presentation, suspended = false }: {
  presentation: EthereumInventoryPresentation;
  suspended?: boolean;
}) {
  const overlay = presentation.overlay!;
  const crate = overlay.items[0];
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [flow, setFlow] = useState(() => createCrateFlow({ reducedMotion }));
  const [hit, setHit] = useState<{ id: number; x: number; y: number } | null>(null);
  const [press, setPress] = useState<{ id: number; x: number; y: number } | null>(null);
  const [assets, setAssets] = useState<CratePreviewAssets | null>(null);
  const [assetError, setAssetError] = useState(false);
  const [assetAttempt, setAssetAttempt] = useState(0);
  const [fallback, setFallback] = useState(() => typeof window.WebGLRenderingContext === 'undefined');
  const [sceneReady, setSceneReady] = useState(false);
  const [assetsReady, setAssetsReady] = useState(false);
  const [entered, setEntered] = useState(false);
  const [pageHidden, setPageHidden] = useState(() => document.hidden);
  const mounted = useRef(true);
  const hitSequence = useRef(0);
  const pressSequence = useRef(0);
  const soundOpened = useRef(false);
  const previousAttempt = useRef(overlay.attempted);
  const current = useRef({ overlay, suspended, presentation });
  current.current = { overlay, suspended, presentation };
  const active = overlay.active && !overlay.closing && !suspended;
  const opening = flow.stage === 'opening' || flow.stage === 'revealed';
  const assetKey = overlay.results.map(item => `${item.id}:${item.image}`).join('|');
  const tiles = useMemo(() => ethereumRevealTiles(overlay.results.length, overlay.viewport), [overlay.results.length, overlay.viewport]);
  const handoff = useStaticToModelHandoff(entered && sceneReady && !fallback, overlay.session);

  useBackgroundBlur({ open: !suspended, active });
  useEffect(() => {
    mounted.current = true;
    const update = () => setPageHidden(document.hidden);
    document.addEventListener('visibilitychange', update);
    return () => { mounted.current = false; document.removeEventListener('visibilitychange', update); };
  }, []);
  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => { setReducedMotion(preference.matches); setFlow(value => ({ ...value, reducedMotion: preference.matches })); };
    preference.addEventListener('change', update);
    return () => preference.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (!overlay.active || suspended || entered) return;
    const timer = window.setTimeout(() => setEntered(true), reducedMotion ? 0 : 520);
    return () => window.clearTimeout(timer);
  }, [overlay.active, suspended, entered, reducedMotion]);
  useEffect(() => {
    if (!overlay.attempted && previousAttempt.current && !overlay.results.length) {
      setFlow(createCrateFlow({ reducedMotion }));
      setHit(null);
      setPress(null);
    }
    previousAttempt.current = overlay.attempted;
  }, [overlay.attempted, overlay.results.length, reducedMotion]);
  useEffect(() => {
    if (!assetKey || overlay.closing) return;
    const controller = new AbortController();
    let resident: CratePreviewAssets | null = null;
    setAssetError(false);
    setAssets(null);
    setAssetsReady(false);
    void loadCratePreviewAssets(current.current.overlay.results, { signal: controller.signal }).then(value => {
      if (controller.signal.aborted) { value.release(); return; }
      resident = value;
      setAssets(value);
    }).catch(() => { if (!controller.signal.aborted) setAssetError(true); });
    return () => { controller.abort(); resident?.release(); };
  }, [assetKey, assetAttempt, overlay.closing]);
  useEffect(() => {
    setFlow(value => pauseCrateFlow(value, suspended || pageHidden || overlay.closing, performance.now()));
  }, [suspended, pageHidden, overlay.closing]);
  useEffect(() => {
    setFlow(value => readyCrateFlow(value, Boolean(entered && assets && (fallback || sceneReady && assetsReady)), performance.now()));
  }, [assets, fallback, sceneReady, assetsReady, entered]);
  const isActive = useCallback(() => {
    const state = current.current;
    return mounted.current && !state.suspended && !state.overlay.closing && !document.hidden;
  }, []);
  useEffect(() => {
    if (!opening || !active || soundOpened.current) return;
    soundOpened.current = true;
    void playCrateOpenSound(isActive).catch(() => {});
  }, [opening, active, isActive]);
  const complete = useCallback(() => {
    const state = current.current;
    if (!isActive() || !state.overlay.results.length) return;
    setFlow(value => ({ ...value, stage: 'revealed' }));
    state.presentation.completeCrateReveal(state.overlay.session);
  }, [isActive]);
  useEffect(() => {
    if (!fallback || !assets || !opening || overlay.resultsVisible || !active || pageHidden) return;
    let frame = 0;
    let timer = 0;
    const duration = reducedMotion ? 160 : 360 + Math.min(Math.max(0, assets.items.length - 1) * 24, 480);
    frame = window.requestAnimationFrame(() => {
      frame = window.requestAnimationFrame(() => { timer = window.setTimeout(complete, duration); });
    });
    return () => { window.cancelAnimationFrame(frame); window.clearTimeout(timer); };
  }, [fallback, assets, opening, overlay.resultsVisible, active, pageHidden, reducedMotion, complete]);
  const activate = useRef<(event?: PackPointerEvent) => void>(() => {});
  activate.current = event => {
    if (!isActive() || opening || overlay.resultsVisible) return;
    if (!overlay.attempted && !overlay.results.length) void presentation.requestUnpack();
    const rect = overlay.targetRect;
    const x = event ? Math.max(-1, Math.min(1, (event.clientX - rect.left) / rect.width * 2 - 1)) : 0;
    const y = event ? Math.max(-1, Math.min(1, (event.clientY - rect.top) / rect.height * 2 - 1)) : 0;
    setHit({ id: ++hitSequence.current, x, y });
    setFlow(value => hitCrateFlow(value, performance.now()));
    void playCrateHitSound(Math.min(3, flow.hitCount + 1), isActive).catch(() => {});
    void preloadCrateSounds().catch(() => {});
  };
  const input = useMemo(() => createMiNoteCardInput(event => activate.current(event), {
    onStart: event => {
      if (!isActive()) return false;
      event.preventDefault();
      const rect = current.current.overlay.targetRect;
      setPress({ id: ++pressSequence.current,
        x: Math.max(-1, Math.min(1, (event.clientX - rect.left) / rect.width * 2 - 1)),
        y: Math.max(-1, Math.min(1, (event.clientY - rect.top) / rect.height * 2 - 1)),
      });
    },
  }), [isActive]);
  useEffect(() => { if (suspended || overlay.closing) input.cancel(); }, [input, suspended, overlay.closing]);
  useEffect(() => () => input.cancel(), [input]);
  const sceneFailed = useCallback(() => { if (mounted.current && !current.current.overlay.closing) setFallback(true); }, []);
  const sceneBecameReady = useCallback(() => { if (mounted.current) setSceneReady(true); }, []);
  const previewsBecameReady = useCallback(() => { if (mounted.current) setAssetsReady(true); }, []);

  return <BodyPortal>
    <ModalFocusScope ariaLabel={`${crate.name} unboxing`} suspended={suspended || overlay.closing}
      className={`reveal-overlay crate-reveal${overlay.active ? ' reveal-overlay--active' : ''}${overlay.closing ? ' reveal-overlay--closing' : ''}${suspended ? ' crate-reveal--suspended' : ''}${opening ? ' crate-reveal--opening' : ''}${fallback ? ' crate-reveal--fallback' : ''}${!handoff.fallbackVisible ? ' crate-reveal--ready' : ''}`}
      style={presentation.style} onClick={() => { if (isActive()) presentation.dismiss(); }}
      onContextMenu={event => event.preventDefault()} onDragStart={event => event.preventDefault()}>
      <div className="reveal-overlay__backdrop" />
      {!fallback ? <SceneBoundary onError={sceneFailed}><Suspense fallback={null}>
        <CrateScene assets={assets} hit={hit} press={press} opening={opening} active={active && entered && !pageHidden} closing={overlay.closing} suspended={suspended}
          reducedMotion={reducedMotion} viewport={overlay.viewport} crateRect={overlay.targetRect}
          onReady={sceneBecameReady} onAssetsReady={previewsBecameReady} onComplete={complete} onError={sceneFailed} onFrame={handoff.onModelFrame} />
      </Suspense></SceneBoundary> : null}
      <div className="reveal-overlay__frame crate-reveal__frame" onTransitionEnd={presentation.transitionEnd}>
        <img className="reveal-overlay__image crate-reveal__reference" src={ETHEREUM_CONTAINER_MEDIA.crate.src}
          width={ETHEREUM_CONTAINER_MEDIA.crate.width} height={ETHEREUM_CONTAINER_MEDIA.crate.height} alt="" draggable={false} />
        <button type="button" className="crate-reveal__hit" aria-label={`Reveal ${crate.name}`}
          aria-busy={overlay.attempted && !opening} aria-disabled={opening || overlay.closing} disabled={opening || overlay.closing}
          onPointerDown={event => {
            event.stopPropagation();
            input.onPointerDown(event);
            if (event.isPrimary && event.button === 0) event.currentTarget.setPointerCapture?.(event.pointerId);
          }}
          onPointerMove={event => input.onPointerMove(event)} onPointerUp={event => {
            event.stopPropagation();
            input.onPointerUp(event);
            if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={event => input.onPointerCancel(event)} onLostPointerCapture={event => input.onLostPointerCapture(event)}
          onClick={event => { event.stopPropagation(); input.onClick(event); }} />
      </div>
      {fallback && assets && opening ? <div className="crate-reveal__results" aria-label="Revealed artworks">
        {assets.items.map((item, index) => {
          const tile = tiles[index];
          return <PreparedPreview key={item.id} preview={item} style={{ left: tile.left, top: tile.top, width: tile.width,
              height: tile.height, '--crate-preview-delay': `${reducedMotion ? 0 : Math.min(index * 24, 480)}ms`,
            } as CSSProperties} />;
        })}
      </div> : null}
      <div className="crate-reveal__status" role="status" aria-live="polite">
        {assetError ? 'Couldn’t load the artwork previews.' : null}
        {overlay.resultsVisible ? <span className="crate-reveal__announcement">{overlay.results.length} artworks revealed</span> : null}
        {assetError ? <div className="crate-reveal__actions" onClick={event => event.stopPropagation()}>
          <button type="button" onClick={() => setAssetAttempt(value => value + 1)}>Retry loading</button>
          <button type="button" onClick={presentation.close}>Back to inventory</button>
        </div> : null}
      </div>
    </ModalFocusScope>
  </BodyPortal>;
}
