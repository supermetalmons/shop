import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import WipInteractiveCard from '../../src/components/WipInteractiveCard';
import { useMiNoteCardAssets } from '../../src/hooks/useMiNoteCardAssets';
import { createMiNoteCard, MI_NOTE_CARD_COUNT } from '../../src/lib/miNoteCards';
import { computeRecordingFrameStyle, RECORDING_MOTION_LOOPS } from './motion';
import { alignedDocumentExtent, unrotateSceneRect } from './captureGeometry';
import preset from './preset.json';
import './capture.css';

type Slot = { id: number; generation: number };
type Readiness = Slot & { ready: boolean; error: Error | null };
type CaptureState = {
  cardId: number;
  generation: number;
  ready: boolean;
  paintReady: boolean;
  error: string | null;
  busy: boolean;
  frame: number;
  motionLoop: string | null;
  motionVersion: number | null;
  width: number;
  height: number;
  dpr: number;
  nativePixels: boolean;
  gutterPixels: number;
  captureScale: number;
  rotationDegrees: 0 | 90;
  background: '#ffffff' | '#000000';
  shadowEnabled: boolean;
};
type ViewportOptions = {
  nativePixels: boolean;
  gutterPixels?: number;
  captureScale?: number;
  rotationDegrees?: 0 | 90;
  background?: '#ffffff' | '#000000';
  shadowEnabled?: boolean;
};
type Rect = { x: number; y: number; width: number; height: number };
type Snapshot = CaptureState & {
  stageRect: Rect | null;
  cardRect: Rect | null;
  rotatorRect: Rect | null;
  unrotatedCardRect: Rect | null;
  unrotatedRotatorRect: Rect | null;
  viewport: { width: number; height: number; visibility: DocumentVisibilityState };
  scrollX: number;
  scrollY: number;
  scrollPixels: { x: number; y: number };
  documentSize: { width: number; height: number };
  documentPixels: { width: number; height: number };
  expectedPhysicalSize: { width: number; height: number };
  stageDocumentPixels: Rect | null;
  effect: Record<string, string> | null;
  assets: { front: string; mask: string; grain: string; naturalWidth: number; naturalHeight: number } | null;
  userAgent: string;
};
type CaptureApi = {
  readonly state: CaptureState;
  setCard: (id: number) => Promise<Snapshot>;
  setFrame: (index: number) => Promise<Snapshot>;
  configureViewport: (options: ViewportOptions) => Promise<Snapshot>;
  setScrollPixels: (x: number, y: number) => Promise<Snapshot>;
  snapshot: () => Snapshot;
};

declare global {
  interface Window {
    miNoteCaptureComparison?: CaptureApi;
  }
}

const parameters = new URLSearchParams(location.search);
const requestedLoop = parameters.get('loop');
const motionLoop = RECORDING_MOTION_LOOPS.find(loop => loop.id === requestedLoop)?.id;
if (requestedLoop && !motionLoop) throw new Error('Unknown or unsupported recording motion loop.');
const motion = {
  effectOpacity: preset.effectOpacity,
  tilt: true,
  lightPath: 'orbit' as const,
  ...(motionLoop ? { motionLoop } : {}),
};
const initialId = Number(new URLSearchParams(location.search).get('id') || '1');

function waitForPaint() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

function validateCardId(id: number) {
  if (!Number.isInteger(id) || id < 1 || id > MI_NOTE_CARD_COUNT) throw new Error(`Invalid card ID: ${id}`);
}

function CaptureCard({ slot, onReadiness }: { slot: Slot; onReadiness: (state: Readiness) => void }) {
  const card = useMemo(() => ({
    ...createMiNoteCard(slot.id),
    imageSrc: `https://cdn.lil.org/nft/mi_note_cards/fronts/${slot.id}.png`,
  }), [slot.id]);
  const assets = useMiNoteCardAssets([card]);
  const [imageReady, setImageReady] = useState(false);

  useEffect(() => {
    onReadiness({ ...slot, ready: assets.ready && imageReady && !assets.error, error: assets.error });
  }, [assets.ready, assets.error, imageReady, onReadiness, slot]);

  return <WipInteractiveCard card={card} interactive={false} wakeOnInteractiveUnlock={false}
    showEffectAtRest onImageReadyChange={setImageReady} imageAlt={`Mi Note Card ${slot.id}`} />;
}

function App() {
  const [slot, setSlot] = useState<Slot>({ id: initialId, generation: 0 });
  const stageRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<CaptureState>({
    cardId: initialId, generation: 0, ready: false, paintReady: false, error: null, busy: false,
    frame: 0, motionLoop: motionLoop ?? null, motionVersion: motionLoop ? 1 : null,
    width: preset.width, height: preset.height, dpr: devicePixelRatio,
    nativePixels: false, gutterPixels: 0, captureScale: 1,
    rotationDegrees: 0, background: '#000000', shadowEnabled: false,
  });
  const paintVersionRef = useRef(0);
  const mountedRef = useRef(true);

  const update = useCallback((patch: Partial<CaptureState>) => {
    stateRef.current = { ...stateRef.current, ...patch, dpr: devicePixelRatio };
  }, []);

  const snapshot = useCallback((): Snapshot => {
    const rect = (element: Element | null): Rect | null => {
      if (!element) return null;
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    };
    const card = wrapperRef.current?.querySelector<HTMLElement>('.drif-effect-card') ?? null;
    const rotator = card?.querySelector<HTMLElement>('.drif-effect-card__rotator');
    const image = card?.querySelector<HTMLImageElement>('.drif-effect-card__front img');
    const style = card ? getComputedStyle(card) : null;
    const stageRect = rect(stageRef.current);
    const dpr = devicePixelRatio;
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    const documentSize = {
      width: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      height: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
    };
    const physicalScale = stateRef.current.nativePixels ? stateRef.current.captureScale : dpr;
    const stageDocumentPixels = stageRect ? {
      x: (stageRect.x + scrollX) * dpr, y: (stageRect.y + scrollY) * dpr,
      width: stageRect.width * dpr, height: stageRect.height * dpr,
    } : null;
    const cardRect = rect(card);
    const rotatorRect = rect(rotator ?? null);
    const unrotatedRect = (value: Rect | null) => value && stageDocumentPixels ? unrotateSceneRect({
      x: (value.x + scrollX) * dpr - stageDocumentPixels.x,
      y: (value.y + scrollY) * dpr - stageDocumentPixels.y,
      width: value.width * dpr, height: value.height * dpr,
    }, stageDocumentPixels.width, stateRef.current.rotationDegrees) : null;
    const effect = style ? Object.fromEntries([
      ['pointerX', '--pointer-x'], ['pointerY', '--pointer-y'],
      ['backgroundX', '--background-x'], ['backgroundY', '--background-y'],
      ['pointerFromCenter', '--pointer-from-center'], ['opacity', '--card-opacity'],
      ['rotateX', '--rotate-x'], ['rotateY', '--rotate-y'], ['scale', '--card-scale'],
      ['translateX', '--translate-x'], ['translateY', '--translate-y'],
    ].map(([key, property]) => [key, style.getPropertyValue(property).trim()])) : null;
    if (effect && rotator) {
      effect.shadow = getComputedStyle(rotator).boxShadow;
      effect.transform = getComputedStyle(rotator).transform;
    }
    return {
      ...stateRef.current, dpr,
      stageRect, cardRect, rotatorRect,
      unrotatedCardRect: unrotatedRect(cardRect), unrotatedRotatorRect: unrotatedRect(rotatorRect),
      viewport: { width: innerWidth, height: innerHeight, visibility: document.visibilityState },
      scrollX, scrollY, scrollPixels: { x: scrollX * dpr, y: scrollY * dpr }, documentSize,
      documentPixels: { width: documentSize.width * dpr, height: documentSize.height * dpr },
      expectedPhysicalSize: { width: preset.width * physicalScale, height: preset.height * physicalScale },
      stageDocumentPixels,
      effect,
      assets: image && style ? {
        front: image.currentSrc, mask: style.getPropertyValue('--mask').trim(),
        grain: style.getPropertyValue('--grain').trim(), naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight,
      } : null,
      userAgent: navigator.userAgent,
    };
  }, []);

  const setFrame = useCallback(async (index: number) => {
    if (stateRef.current.busy) throw new Error('A native capture action is already running.');
    if (!stateRef.current.ready) throw new Error(stateRef.current.error || 'Card assets are not ready.');
    if (!Number.isInteger(index) || index < 0 || index >= preset.frames) throw new Error(`Invalid frame index: ${index}`);
    const card = wrapperRef.current?.querySelector<HTMLElement>('.drif-effect-card');
    const rotator = card?.querySelector<HTMLElement>('.drif-effect-card__rotator');
    if (!card || !rotator) throw new Error('Card element is unavailable.');
    const paintVersion = ++paintVersionRef.current;
    update({ frame: index, paintReady: false });
    for (const declaration of computeRecordingFrameStyle(index, preset.frames, motion).split(';')) {
      const colon = declaration.indexOf(':');
      if (colon > 0) card.style.setProperty(declaration.slice(0, colon), declaration.slice(colon + 1), 'important');
    }
    card.classList.add('interacting');
    card.classList.remove('loading', 'active', 'is-scaled');
    rotator.style.setProperty('box-shadow', stateRef.current.shadowEnabled ? preset.cardShadow : 'none', 'important');
    await waitForPaint();
    if (mountedRef.current && paintVersion === paintVersionRef.current) update({ paintReady: true });
    return snapshot();
  }, [snapshot, update]);

  const onReadiness = useCallback((readiness: Readiness) => {
    if (readiness.generation !== stateRef.current.generation || readiness.id !== stateRef.current.cardId) return;
    update({ ready: readiness.ready, paintReady: false, error: readiness.error?.message || null });
    if (readiness.ready) void setFrame(0).catch((error: unknown) => {
      if (readiness.generation === stateRef.current.generation) {
        update({ ready: false, error: error instanceof Error ? error.message : String(error) });
      }
    });
  }, [setFrame, update]);

  const setCard = useCallback(async (id: number) => {
    validateCardId(id);
    if (stateRef.current.busy) throw new Error('A native capture action is already running.');
    const generation = stateRef.current.generation + 1;
    paintVersionRef.current++;
    update({ cardId: id, generation, ready: false, paintReady: false, error: null, frame: 0 });
    flushSync(() => setSlot({ id, generation }));
    const deadline = performance.now() + 45_000;
    while (performance.now() < deadline) {
      if (!mountedRef.current || stateRef.current.generation !== generation) throw new Error('Card load was superseded.');
      if (stateRef.current.error) throw new Error(stateRef.current.error);
      if (stateRef.current.ready && stateRef.current.paintReady) return snapshot();
      await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
    }
    const error = `Timed out waiting for card ${id}.`;
    update({ error, ready: false, paintReady: false });
    throw new Error(error);
  }, [snapshot, update]);

  const configureViewport = useCallback(async ({
    nativePixels, gutterPixels = 32, captureScale = 1,
    rotationDegrees = 0, background = '#000000', shadowEnabled = false,
  }: ViewportOptions) => {
    if (stateRef.current.busy) throw new Error('A native capture action is already running.');
    const stage = stageRef.current;
    if (!stage) throw new Error('Capture stage is unavailable.');
    if (!Number.isInteger(gutterPixels) || gutterPixels < 0) throw new Error('Gutter must be a nonnegative integer pixel count.');
    if (!Number.isFinite(captureScale) || captureScale <= 0
      || !Number.isInteger(preset.width * captureScale) || !Number.isInteger(preset.height * captureScale)) {
      throw new Error('Capture scale must produce positive integer physical dimensions.');
    }
    if (!nativePixels && captureScale !== 1) throw new Error('Capture scale requires native pixel mode.');
    if (rotationDegrees !== 0 && rotationDegrees !== 90) throw new Error('Capture rotation must be 0 or 90 degrees.');
    if (rotationDegrees === 90 && !nativePixels) throw new Error('Landscape rotation requires native pixel mode.');
    if (background !== '#000000' || shadowEnabled !== false) throw new Error('Native capture requires black without a shadow.');
    if (typeof shadowEnabled !== 'boolean') throw new Error('Capture shadow setting must be boolean.');
    const dpr = devicePixelRatio;
    const zoom = nativePixels ? captureScale / dpr : 1;
    const offset = gutterPixels / (dpr * zoom);
    const documentExtent = (size: number, viewport: number) => {
      const required = Math.ceil(size * zoom + gutterPixels * 2 / dpr);
      if (!nativePixels || captureScale <= 1 || required <= viewport) return required;
      return alignedDocumentExtent({ sceneSize: size, viewportSize: viewport, gutterPixels, dpr, captureScale });
    };
    const documentWidth = documentExtent(preset.width, innerWidth);
    const documentHeight = documentExtent(preset.height, innerHeight);
    const root = document.getElementById('root');
    if (!root) throw new Error('Capture document is unavailable.');
    paintVersionRef.current++;
    root.style.width = `${documentWidth}px`;
    root.style.height = `${documentHeight}px`;
    document.body.style.minWidth = `${documentWidth}px`;
    document.body.style.minHeight = `${documentHeight}px`;
    stage.style.zoom = String(zoom);
    stage.style.left = `${offset}px`;
    stage.style.top = `${offset}px`;
    if (rotationDegrees === 90) stage.dataset.captureRotation = '90';
    else delete stage.dataset.captureRotation;
    if (background === '#000000') document.documentElement.dataset.captureBackground = 'black';
    else delete document.documentElement.dataset.captureBackground;
    window.scrollTo(0, 0);
    update({ nativePixels, gutterPixels, captureScale, rotationDegrees, background, shadowEnabled, paintReady: false });
    await waitForPaint();
    if (window.scrollX !== 0 || window.scrollY !== 0) throw new Error('Capture viewport did not return to its document origin.');
    let rect = stage.getBoundingClientRect();
    const target = gutterPixels / dpr;
    if (Math.abs(rect.x * dpr - gutterPixels) > 0.075 || Math.abs(rect.y * dpr - gutterPixels) > 0.075) {
      stage.style.left = `${offset + 1}px`;
      stage.style.top = `${offset + 1}px`;
      await waitForPaint();
      const probe = stage.getBoundingClientRect();
      const stepX = probe.x - rect.x;
      const stepY = probe.y - rect.y;
      if (stepX > 0 && stepY > 0) {
        stage.style.left = `${offset + (target - rect.x) / stepX}px`;
        stage.style.top = `${offset + (target - rect.y) / stepY}px`;
        await waitForPaint();
        rect = stage.getBoundingClientRect();
      }
    }
    if (Math.abs(rect.x * dpr - gutterPixels) > 0.075 || Math.abs(rect.y * dpr - gutterPixels) > 0.075) {
      const error = `Capture gutter is not aligned to ${gutterPixels} physical pixels.`;
      update({ error });
      throw new Error(error);
    }
    const expectedScale = nativePixels ? captureScale : dpr;
    if (Math.abs(rect.width * dpr - preset.width * expectedScale) > 0.075
      || Math.abs(rect.height * dpr - preset.height * expectedScale) > 0.075) {
      const error = 'Capture stage does not match its expected physical dimensions.';
      update({ error });
      throw new Error(error);
    }
    if (stateRef.current.ready) return setFrame(stateRef.current.frame);
    return snapshot();
  }, [setFrame, snapshot, update]);

  const setScrollPixels = useCallback(async (x: number, y: number) => {
    if (stateRef.current.busy) throw new Error('A native capture action is already running.');
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0) {
      throw new Error('Capture scroll coordinates must be nonnegative integer physical pixels.');
    }
    const dpr = devicePixelRatio;
    const documentState = snapshot();
    const maxX = Math.max(0, (documentState.documentSize.width - innerWidth) * dpr);
    const maxY = Math.max(0, (documentState.documentSize.height - innerHeight) * dpr);
    if (x > maxX + 0.075 || y > maxY + 0.075) {
      throw new Error(`Capture scroll (${x}, ${y}) exceeds the document bounds (${maxX}, ${maxY}).`);
    }
    const paintVersion = ++paintVersionRef.current;
    update({ paintReady: false });
    window.scrollTo(x / dpr, y / dpr);
    await waitForPaint();
    if (Math.abs(window.scrollX * dpr - x) > 0.075 || Math.abs(window.scrollY * dpr - y) > 0.075) {
      const error = 'Capture scroll did not align to the requested physical pixels.';
      update({ error });
      throw new Error(error);
    }
    if (mountedRef.current && paintVersion === paintVersionRef.current) update({ paintReady: stateRef.current.ready });
    return snapshot();
  }, [snapshot, update]);

  useEffect(() => {
    mountedRef.current = true;
    const api: CaptureApi = { get state() { return stateRef.current; }, setCard, setFrame, configureViewport, setScrollPixels, snapshot };
    window.miNoteCaptureComparison = api;
    return () => {
      mountedRef.current = false;
      paintVersionRef.current++;
      if (window.miNoteCaptureComparison === api) delete window.miNoteCaptureComparison;
    };
  }, [configureViewport, setCard, setFrame, setScrollPixels, snapshot]);

  return <div id="comparison-stage" ref={stageRef}
    style={{ width: preset.width, height: preset.height, backgroundColor: preset.background }}>
    <div id="comparison-card" ref={wrapperRef} style={{ width: preset.cardWidth }}>
      <CaptureCard key={slot.generation} slot={slot} onReadiness={onReadiness} />
    </div>
  </div>;
}

validateCardId(initialId);
createRoot(document.getElementById('root')!).render(<App />);
