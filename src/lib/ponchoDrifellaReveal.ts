import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getDrifCardByFigureId, type DrifCardConfig } from '../drifCards';

const PONCHO_DRIFELLA_PACK_FRAME_IDS = [1, 48, 59, 69, 80, 86, 89, 90, 92, 95, 96, 99, 102] as const;
const PONCHO_DRIFELLA_PUNCH_FRAME_IDS = [71, 72, 75, 77, 79] as const;
const PONCHO_DRIFELLA_PACK_SEQUENCE_BASE_URL = '/Poncho_Drifella/pack/sequence_0';
const PONCHO_DRIFELLA_PUNCH_SEQUENCE_BASE_URL = '/Poncho_Drifella/pack/punch_0';
export const PONCHO_DRIFELLA_INITIAL_FRAME_URL = '/Poncho_Drifella/pack/initial.webp';
export const PONCHO_DRIFELLA_PUNCH_FRAME_DURATION_MS = 150;
export const PONCHO_DRIFELLA_SEQUENCE_AUTOPLAY_DELAY_MS = 30;

export const PONCHO_DRIFELLA_BOX_SOUND_REVEAL_URL = '/Poncho_Drifella/sounds/crash.mp3';
export const PONCHO_DRIFELLA_BOX_SOUND_CLICK_URL = '/Poncho_Drifella/sounds/hit.mp3';

export const PONCHO_DRIFELLA_PACK_FRAME_URLS = PONCHO_DRIFELLA_PACK_FRAME_IDS.map(
  (frameId) => `${PONCHO_DRIFELLA_PACK_SEQUENCE_BASE_URL}/1_${String(frameId).padStart(4, '0')}.webp`,
);
export const PONCHO_DRIFELLA_PUNCH_FRAME_URLS = PONCHO_DRIFELLA_PUNCH_FRAME_IDS.map(
  (frameId) => `${PONCHO_DRIFELLA_PUNCH_SEQUENCE_BASE_URL}/4_${String(frameId).padStart(4, '0')}.webp`,
);

export const PONCHO_DRIFELLA_REVEAL_FRAME_SEQUENCE = Object.freeze({
  frames: [...PONCHO_DRIFELLA_PACK_FRAME_URLS],
  frameCount: PONCHO_DRIFELLA_PACK_FRAME_URLS.length,
  clickMax: 8,
  autoplayStart: 9,
  mediaStart: PONCHO_DRIFELLA_PACK_FRAME_URLS.length,
});

export function getPonchoDrifellaCardByFigureId(figureId: number): DrifCardConfig | undefined {
  return getDrifCardByFigureId(figureId);
}

export type PonchoDrifellaRevealPhase = 'preparing' | 'ready' | 'revealed';
export type PonchoDrifellaRevealRequestStatus = 'resolved' | 'retry';
type PonchoDrifellaQueuedAction = 'none' | 'advance' | 'auto';

type UsePonchoDrifellaRevealControllerOptions = {
  active: boolean;
  phase: PonchoDrifellaRevealPhase;
  boxLabel: string;
  cardReady: boolean;
  resetKey: string | number;
  onRequestReveal?: () => PonchoDrifellaRevealRequestStatus | void | Promise<PonchoDrifellaRevealRequestStatus | void>;
  onPlayClick?: () => void;
  onPlayReveal?: () => void;
  autoplayDelayMs?: number;
};

type PonchoDrifellaRevealControllerState = {
  phase: PonchoDrifellaRevealPhase;
  frame: number;
  autoOpening: boolean;
  hasRevealAttempted: boolean;
  requestPending: boolean;
  boxFrameSrc: string;
  note: string;
  revealComplete: boolean;
  handleAdvance: () => void;
  startAutoOpening: () => void;
};

export function preloadPonchoDrifellaImage(
  imageSrc: string | undefined,
  loadedImages: Set<string>,
  pendingImages: Map<string, HTMLImageElement>,
) {
  const normalizedImageSrc = String(imageSrc || '').trim();
  if (!normalizedImageSrc || loadedImages.has(normalizedImageSrc)) return;
  const img = new Image();
  img.decoding = 'async';
  img.onload = () => {
    pendingImages.delete(normalizedImageSrc);
  };
  img.onerror = () => {
    pendingImages.delete(normalizedImageSrc);
    loadedImages.delete(normalizedImageSrc);
  };
  pendingImages.set(normalizedImageSrc, img);
  loadedImages.add(normalizedImageSrc);
  img.src = normalizedImageSrc;
}

export function preloadPonchoDrifellaCardAssets(
  card: DrifCardConfig | undefined,
  loadedImages: Set<string>,
  pendingImages: Map<string, HTMLImageElement>,
) {
  if (!card) return;
  preloadPonchoDrifellaImage(card.imageSrc, loadedImages, pendingImages);
  preloadPonchoDrifellaImage(card.textureSrc, loadedImages, pendingImages);
  preloadPonchoDrifellaImage(card.foilSrc, loadedImages, pendingImages);
}

export function preloadPonchoDrifellaPunchAssets(
  loadedImages: Set<string>,
  pendingImages: Map<string, HTMLImageElement>,
) {
  preloadPonchoDrifellaImage(PONCHO_DRIFELLA_INITIAL_FRAME_URL, loadedImages, pendingImages);
  PONCHO_DRIFELLA_PUNCH_FRAME_URLS.forEach((frameSrc) => {
    preloadPonchoDrifellaImage(frameSrc, loadedImages, pendingImages);
  });
}

export function preloadPonchoDrifellaSequenceAssets(
  loadedImages: Set<string>,
  pendingImages: Map<string, HTMLImageElement>,
) {
  PONCHO_DRIFELLA_PACK_FRAME_URLS.forEach((frameSrc) => {
    preloadPonchoDrifellaImage(frameSrc, loadedImages, pendingImages);
  });
}

export function preloadPonchoDrifellaPackAssets(
  loadedImages: Set<string>,
  pendingImages: Map<string, HTMLImageElement>,
) {
  preloadPonchoDrifellaPunchAssets(loadedImages, pendingImages);
  preloadPonchoDrifellaSequenceAssets(loadedImages, pendingImages);
}

export function usePonchoDrifellaRevealController({
  active,
  phase,
  boxLabel,
  cardReady,
  resetKey,
  onRequestReveal,
  onPlayClick,
  onPlayReveal,
  autoplayDelayMs = PONCHO_DRIFELLA_SEQUENCE_AUTOPLAY_DELAY_MS,
}: UsePonchoDrifellaRevealControllerOptions): PonchoDrifellaRevealControllerState {
  const [frame, setFrame] = useState(1);
  const [autoOpening, setAutoOpening] = useState(false);
  const [hasRevealAttempted, setHasRevealAttempted] = useState(false);
  const [requestPending, setRequestPending] = useState(false);
  const [sequenceStarted, setSequenceStarted] = useState(false);
  const [punchRunId, setPunchRunId] = useState(0);
  const [punchFrameIndex, setPunchFrameIndex] = useState(0);
  const [queuedPostPunchAction, setQueuedPostPunchAction] = useState<PonchoDrifellaQueuedAction>('none');
  const revealSoundPlayedRef = useRef(false);
  const frameRef = useRef(1);
  const requestStateRef = useRef<'idle' | 'pending' | 'sent'>('idle');
  const requestGenerationRef = useRef(0);
  const punchFrameIndexRef = useRef(0);

  const resetRequestState = useCallback(() => {
    requestGenerationRef.current += 1;
    requestStateRef.current = 'idle';
    setRequestPending(false);
  }, []);

  const startRevealRequest = useCallback(() => {
    if (!onRequestReveal) return;
    if (requestStateRef.current !== 'idle') return;
    requestGenerationRef.current += 1;
    const requestGeneration = requestGenerationRef.current;
    requestStateRef.current = 'pending';
    setRequestPending(true);
    void Promise.resolve(onRequestReveal())
      .then((status) => {
        if (requestGenerationRef.current !== requestGeneration) return;
        const nextState = status === 'resolved' ? 'sent' : 'idle';
        requestStateRef.current = nextState;
        setRequestPending(false);
      })
      .catch(() => {
        if (requestGenerationRef.current !== requestGeneration) return;
        requestStateRef.current = 'idle';
        setRequestPending(false);
      });
  }, [onRequestReveal]);

  useEffect(() => {
    frameRef.current = frame;
  }, [frame]);

  useEffect(() => {
    punchFrameIndexRef.current = punchFrameIndex;
  }, [punchFrameIndex]);

  useEffect(() => {
    setFrame(1);
    setAutoOpening(false);
    setHasRevealAttempted(false);
    setSequenceStarted(false);
    setPunchRunId(0);
    setPunchFrameIndex(0);
    setQueuedPostPunchAction('none');
    revealSoundPlayedRef.current = false;
    frameRef.current = 1;
    punchFrameIndexRef.current = 0;
    resetRequestState();
  }, [resetKey, resetRequestState]);

  useEffect(() => {
    if (active) return;
    setFrame(1);
    setAutoOpening(false);
    setHasRevealAttempted(false);
    setSequenceStarted(false);
    setPunchRunId(0);
    setPunchFrameIndex(0);
    setQueuedPostPunchAction('none');
    revealSoundPlayedRef.current = false;
    frameRef.current = 1;
    punchFrameIndexRef.current = 0;
    resetRequestState();
  }, [active, resetRequestState]);

  useEffect(() => {
    if (!active || phase !== 'ready' || sequenceStarted || punchRunId <= 0 || typeof window === 'undefined') {
      setPunchFrameIndex(0);
      return undefined;
    }
    let frameIndex = 1;
    let timeoutId: number | undefined;

    const tick = () => {
      setPunchFrameIndex(frameIndex);
      timeoutId = window.setTimeout(() => {
        if (frameIndex >= PONCHO_DRIFELLA_PUNCH_FRAME_URLS.length) {
          setPunchFrameIndex(0);
          return;
        }
        frameIndex += 1;
        tick();
      }, PONCHO_DRIFELLA_PUNCH_FRAME_DURATION_MS);
    };

    tick();

    return () => {
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [active, phase, punchRunId, sequenceStarted]);

  useEffect(() => {
    if (!active || phase !== 'ready' || !sequenceStarted || !autoOpening || typeof window === 'undefined') return undefined;
    if (frame >= PONCHO_DRIFELLA_REVEAL_FRAME_SEQUENCE.frameCount) {
      setAutoOpening(false);
      return undefined;
    }
    const timeoutId = window.setTimeout(() => {
      setFrame((prevFrame) => {
        const nextFrame = Math.min(prevFrame + 1, PONCHO_DRIFELLA_REVEAL_FRAME_SEQUENCE.frameCount);
        frameRef.current = nextFrame;
        return nextFrame;
      });
    }, autoplayDelayMs);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [active, autoOpening, autoplayDelayMs, frame, phase, sequenceStarted]);

  const revealPhase = useMemo<PonchoDrifellaRevealPhase>(() => {
    if (phase === 'preparing') return 'preparing';
    if (sequenceStarted && cardReady && frame >= PONCHO_DRIFELLA_REVEAL_FRAME_SEQUENCE.mediaStart) return 'revealed';
    return 'ready';
  }, [cardReady, frame, phase, sequenceStarted]);

  useEffect(() => {
    if (revealPhase !== 'revealed' || revealSoundPlayedRef.current) return;
    revealSoundPlayedRef.current = true;
    onPlayReveal?.();
  }, [onPlayReveal, revealPhase]);

  const boxFrameSrc = useMemo(() => {
    if (!sequenceStarted) {
      if (punchFrameIndex > 0) {
        return PONCHO_DRIFELLA_PUNCH_FRAME_URLS[Math.min(punchFrameIndex - 1, PONCHO_DRIFELLA_PUNCH_FRAME_URLS.length - 1)];
      }
      return PONCHO_DRIFELLA_INITIAL_FRAME_URL;
    }
    return PONCHO_DRIFELLA_PACK_FRAME_URLS[Math.min(frame - 1, PONCHO_DRIFELLA_PACK_FRAME_URLS.length - 1)];
  }, [frame, punchFrameIndex, sequenceStarted]);

  const note = useMemo(() => {
    if (revealPhase === 'preparing') return '';
    if (revealPhase === 'revealed') return '';
    if (autoOpening) return 'opening...';
    return hasRevealAttempted ? `keep clicking the ${boxLabel}` : `click the ${boxLabel} to open`;
  }, [autoOpening, boxLabel, hasRevealAttempted, revealPhase]);

  const beginSequence = useCallback(() => {
    setSequenceStarted(true);
    setPunchFrameIndex(0);
    setFrame(1);
    frameRef.current = 1;
  }, []);

  const advanceSequence = useCallback(() => {
    setFrame((prevFrame) => {
      if (prevFrame >= PONCHO_DRIFELLA_REVEAL_FRAME_SEQUENCE.frameCount) return prevFrame;
      if (prevFrame >= PONCHO_DRIFELLA_REVEAL_FRAME_SEQUENCE.autoplayStart) return prevFrame;
      const nextFrame =
        prevFrame < PONCHO_DRIFELLA_REVEAL_FRAME_SEQUENCE.clickMax
          ? prevFrame + 1
          : prevFrame === PONCHO_DRIFELLA_REVEAL_FRAME_SEQUENCE.clickMax
            ? PONCHO_DRIFELLA_REVEAL_FRAME_SEQUENCE.autoplayStart
            : prevFrame;
      if (nextFrame === PONCHO_DRIFELLA_REVEAL_FRAME_SEQUENCE.autoplayStart && nextFrame !== prevFrame) {
        setAutoOpening(true);
      }
      frameRef.current = nextFrame;
      return nextFrame;
    });
  }, []);

  useEffect(() => {
    if (!active || phase !== 'ready' || sequenceStarted || !cardReady || queuedPostPunchAction === 'none') return;
    if (punchFrameIndex > 0) return;
    const queuedAction = queuedPostPunchAction;
    setQueuedPostPunchAction('none');
    beginSequence();
    if (queuedAction === 'auto') {
      setHasRevealAttempted(true);
      setAutoOpening(true);
      return;
    }
    setHasRevealAttempted(true);
    advanceSequence();
  }, [active, advanceSequence, beginSequence, cardReady, phase, punchFrameIndex, queuedPostPunchAction, sequenceStarted]);

  const startAutoOpening = useCallback(() => {
    if (!active || phase !== 'ready' || !cardReady) return;
    if (!sequenceStarted) {
      if (punchFrameIndexRef.current > 0) {
        setQueuedPostPunchAction('auto');
        return;
      }
      beginSequence();
    }
    if (frameRef.current >= PONCHO_DRIFELLA_REVEAL_FRAME_SEQUENCE.frameCount) return;
    setHasRevealAttempted(true);
    setAutoOpening(true);
  }, [active, beginSequence, cardReady, phase, sequenceStarted]);

  const handleAdvance = useCallback(() => {
    if (!active || phase !== 'ready') return;
    onPlayClick?.();
    setHasRevealAttempted(true);

    if (!sequenceStarted) {
      if (!cardReady) {
        setPunchFrameIndex(1);
        setQueuedPostPunchAction('none');
        setPunchRunId((prev) => prev + 1);
        startRevealRequest();
        return;
      }
      if (punchFrameIndexRef.current > 0) {
        setQueuedPostPunchAction('advance');
        return;
      }
      beginSequence();
    }

    advanceSequence();
  }, [active, advanceSequence, beginSequence, cardReady, onPlayClick, phase, sequenceStarted, startRevealRequest]);

  return {
    phase: revealPhase,
    frame,
    autoOpening,
    hasRevealAttempted,
    requestPending,
    boxFrameSrc,
    note,
    revealComplete: sequenceStarted && frame >= PONCHO_DRIFELLA_REVEAL_FRAME_SEQUENCE.frameCount,
    handleAdvance,
    startAutoOpening,
  };
}
