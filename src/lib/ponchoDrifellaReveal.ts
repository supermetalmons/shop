import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getDrifCardByFigureId, type DrifCardConfig } from '../drifCards';

const PONCHO_DRIFELLA_PUNCH_VARIANT_NUMBERS = [1, 2, 3] as const;
const PONCHO_DRIFELLA_PUNCH_FRAME_NUMBERS = [1, 2, 3] as const;
const PONCHO_DRIFELLA_SEGMENT_1_1_FRAME_IDS = [13, 16, 19] as const;
const PONCHO_DRIFELLA_SEGMENT_1_2_FRAME_IDS = [30, 33, 38] as const;
const PONCHO_DRIFELLA_SEGMENT_AUTOPLAY_FRAME_IDS = [56, 60, 64, 65, 66, 68, 70, 71, 72, 77] as const;
const PONCHO_DRIFELLA_PUNCH_SEQUENCE_BASE_URL = '/Poncho_Drifella/pack/recoverable_punches';
const PONCHO_DRIFELLA_SEQUENCE_BASE_URL = '/Poncho_Drifella/pack/final_sequences';
export const PONCHO_DRIFELLA_INITIAL_FRAME_URL = '/Poncho_Drifella/pack/initial.webp';
export const PONCHO_DRIFELLA_PUNCH_FRAME_DURATION_MS = 100;
export const PONCHO_DRIFELLA_SEQUENCE_AUTOPLAY_DELAY_MS = 42;
export const PONCHO_DRIFELLA_PACK_DISCARD_DURATION_MS = 777;
const PONCHO_DRIFELLA_CARD_INTERACTION_UNLOCK_DELAY_MS = Math.round(PONCHO_DRIFELLA_PACK_DISCARD_DURATION_MS / 2);
const PONCHO_DRIFELLA_ASSET_RETRY_DELAY_MS = 180;
const PONCHO_DRIFELLA_PUNCH_FALLBACK_FRAME_URLS = [PONCHO_DRIFELLA_INITIAL_FRAME_URL] as const;

export const PONCHO_DRIFELLA_BOX_SOUND_REVEAL_URL = '/Poncho_Drifella/sounds/crash.mp3';
export const PONCHO_DRIFELLA_BOX_SOUND_CLICK_URLS = [
  '/Poncho_Drifella/sounds/hit1.mp3',
  '/Poncho_Drifella/sounds/hit2.mp3',
  '/Poncho_Drifella/sounds/hit3.mp3',
] as const;

export function getRandomPonchoDrifellaBoxClickSoundUrl() {
  return (
    PONCHO_DRIFELLA_BOX_SOUND_CLICK_URLS[
      Math.floor(Math.random() * PONCHO_DRIFELLA_BOX_SOUND_CLICK_URLS.length)
    ] || PONCHO_DRIFELLA_BOX_SOUND_CLICK_URLS[0]
  );
}

function buildPonchoDrifellaNumberedFrameUrls(baseUrl: string, frameCount: number) {
  return Array.from({ length: frameCount }, (_, index) => `${baseUrl}/${index + 1}.webp`);
}

export const PONCHO_DRIFELLA_PUNCH_FRAME_URLS_BY_VARIANT = PONCHO_DRIFELLA_PUNCH_VARIANT_NUMBERS.map((variantNumber) =>
  buildPonchoDrifellaNumberedFrameUrls(
    `${PONCHO_DRIFELLA_PUNCH_SEQUENCE_BASE_URL}/${variantNumber}`,
    PONCHO_DRIFELLA_PUNCH_FRAME_NUMBERS.length,
  ),
);
export const PONCHO_DRIFELLA_SEGMENT_1_1_FRAME_URLS = buildPonchoDrifellaNumberedFrameUrls(
  `${PONCHO_DRIFELLA_SEQUENCE_BASE_URL}/1/1`,
  PONCHO_DRIFELLA_SEGMENT_1_1_FRAME_IDS.length,
);
export const PONCHO_DRIFELLA_SEGMENT_1_2_FRAME_URLS = buildPonchoDrifellaNumberedFrameUrls(
  `${PONCHO_DRIFELLA_SEQUENCE_BASE_URL}/1/2`,
  PONCHO_DRIFELLA_SEGMENT_1_2_FRAME_IDS.length,
);
export const PONCHO_DRIFELLA_SEGMENT_AUTOPLAY_FRAME_URLS = buildPonchoDrifellaNumberedFrameUrls(
  `${PONCHO_DRIFELLA_SEQUENCE_BASE_URL}/1/autoplay`,
  PONCHO_DRIFELLA_SEGMENT_AUTOPLAY_FRAME_IDS.length,
);
export const PONCHO_DRIFELLA_SEGMENT_AUTOPLAY_OVERTOP_FRAME_URLS = buildPonchoDrifellaNumberedFrameUrls(
  `${PONCHO_DRIFELLA_SEQUENCE_BASE_URL}/1/autoplay/overtop`,
  PONCHO_DRIFELLA_SEGMENT_AUTOPLAY_FRAME_IDS.length,
);

const PONCHO_DRIFELLA_MANUAL_SEQUENCE_FRAME_URLS = [
  ...PONCHO_DRIFELLA_SEGMENT_1_1_FRAME_URLS,
  ...PONCHO_DRIFELLA_SEGMENT_1_2_FRAME_URLS,
];
const PONCHO_DRIFELLA_SEQUENCE_FRAME_URLS = [
  ...PONCHO_DRIFELLA_MANUAL_SEQUENCE_FRAME_URLS,
  ...PONCHO_DRIFELLA_SEGMENT_AUTOPLAY_FRAME_URLS,
];
const PONCHO_DRIFELLA_REQUIRED_FIXED_SEQUENCE_FRAME_URLS = [
  ...PONCHO_DRIFELLA_SEGMENT_1_1_FRAME_URLS,
  ...PONCHO_DRIFELLA_SEGMENT_1_2_FRAME_URLS,
  ...PONCHO_DRIFELLA_SEGMENT_AUTOPLAY_FRAME_URLS,
  ...PONCHO_DRIFELLA_SEGMENT_AUTOPLAY_OVERTOP_FRAME_URLS,
];

export const PONCHO_DRIFELLA_REVEAL_FRAME_SEQUENCE = Object.freeze({
  frames: [...PONCHO_DRIFELLA_SEQUENCE_FRAME_URLS],
  frameCount: PONCHO_DRIFELLA_SEQUENCE_FRAME_URLS.length,
  clickMax: PONCHO_DRIFELLA_MANUAL_SEQUENCE_FRAME_URLS.length,
  autoplayStart: PONCHO_DRIFELLA_MANUAL_SEQUENCE_FRAME_URLS.length + 1,
  mediaStart: PONCHO_DRIFELLA_SEQUENCE_FRAME_URLS.length,
});

export function getPonchoDrifellaCardByFigureId(figureId: number): DrifCardConfig | undefined {
  return getDrifCardByFigureId(figureId);
}

export type PonchoDrifellaRevealPhase = 'preparing' | 'ready' | 'revealed';
export type PonchoDrifellaRevealRequestStatus = 'resolved' | 'retry';
type PonchoDrifellaRevealStage =
  | 'idle'
  | 'punch'
  | 'segment_1_1'
  | 'segment_1_1_hold'
  | 'segment_1_2'
  | 'segment_1_2_hold'
  | 'autoplay'
  | 'revealed';

type UsePonchoDrifellaRevealControllerOptions = {
  active: boolean;
  phase: PonchoDrifellaRevealPhase;
  boxLabel: string;
  cardReady: boolean;
  cardDisplayReady?: boolean;
  loadedImages?: Set<string>;
  pendingImages?: Map<string, HTMLImageElement>;
  resetKey: string | number;
  onRequestReveal?: () => PonchoDrifellaRevealRequestStatus | void | Promise<PonchoDrifellaRevealRequestStatus | void>;
  onPlayClick?: () => void;
  onPlayReveal?: () => void;
  autoplayDelayMs?: number;
};

type WaitForPonchoDrifellaAssetsUntilReadyOptions = {
  signal?: AbortSignal;
  retryDelayMs?: number;
};

type PonchoDrifellaRevealControllerState = {
  phase: PonchoDrifellaRevealPhase;
  frame: number;
  animating: boolean;
  autoOpening: boolean;
  hasRevealAttempted: boolean;
  requestPending: boolean;
  boxFrameSrc: string;
  foregroundFrameSrc?: string;
  cardVisible: boolean;
  cardInteractive: boolean;
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

function ponchoDrifellaCardAssetSources(card: DrifCardConfig | undefined) {
  if (!card) return [];
  return Array.from(
    new Set(
      [card.imageSrc, card.textureSrc, card.foilSrc]
        .map((imageSrc) => String(imageSrc || '').trim())
        .filter((imageSrc): imageSrc is string => Boolean(imageSrc)),
    ),
  );
}

function ponchoDrifellaImageReady(
  imageSrc: string | undefined,
  loadedImages?: ReadonlySet<string>,
  pendingImages?: ReadonlyMap<string, HTMLImageElement>,
) {
  const normalizedImageSrc = String(imageSrc || '').trim();
  if (!normalizedImageSrc) return true;
  if (!loadedImages || !pendingImages) return false;
  return loadedImages.has(normalizedImageSrc) && !pendingImages.has(normalizedImageSrc);
}

function arePonchoDrifellaImageSourcesReady(
  imageSources: readonly string[],
  loadedImages?: ReadonlySet<string>,
  pendingImages?: ReadonlyMap<string, HTMLImageElement>,
) {
  if (!loadedImages || !pendingImages) return false;
  return imageSources.every((imageSrc) => ponchoDrifellaImageReady(imageSrc, loadedImages, pendingImages));
}

export function arePonchoDrifellaCardAssetsReady(
  card: DrifCardConfig | undefined,
  loadedImages?: ReadonlySet<string>,
  pendingImages?: ReadonlyMap<string, HTMLImageElement>,
) {
  return arePonchoDrifellaImageSourcesReady(ponchoDrifellaCardAssetSources(card), loadedImages, pendingImages);
}

function arePonchoDrifellaSequenceAssetsReady(
  loadedImages?: ReadonlySet<string>,
  pendingImages?: ReadonlyMap<string, HTMLImageElement>,
) {
  return arePonchoDrifellaImageSourcesReady(
    PONCHO_DRIFELLA_REQUIRED_FIXED_SEQUENCE_FRAME_URLS,
    loadedImages,
    pendingImages,
  );
}

function waitForPonchoDrifellaImage(
  imageSrc: string | undefined,
  loadedImages: Set<string>,
  pendingImages: Map<string, HTMLImageElement>,
) {
  const normalizedImageSrc = String(imageSrc || '').trim();
  if (!normalizedImageSrc) return Promise.resolve();
  preloadPonchoDrifellaImage(normalizedImageSrc, loadedImages, pendingImages);
  if (loadedImages.has(normalizedImageSrc) && !pendingImages.has(normalizedImageSrc)) {
    return Promise.resolve();
  }
  const pendingImage = pendingImages.get(normalizedImageSrc);
  if (!pendingImage) {
    return Promise.reject(new Error(`Failed to preload image: ${normalizedImageSrc}`));
  }
  return new Promise<void>((resolve, reject) => {
    const settle = () => {
      pendingImage.removeEventListener('load', handleLoad);
      pendingImage.removeEventListener('error', handleError);
      if (loadedImages.has(normalizedImageSrc) && !pendingImages.has(normalizedImageSrc)) {
        resolve();
        return;
      }
      reject(new Error(`Failed to preload image: ${normalizedImageSrc}`));
    };
    const handleLoad = () => {
      settle();
    };
    const handleError = () => {
      settle();
    };
    pendingImage.addEventListener('load', handleLoad);
    pendingImage.addEventListener('error', handleError);
    if (!pendingImages.has(normalizedImageSrc)) {
      settle();
    }
  });
}

function waitForPonchoDrifellaImageSources(
  imageSources: readonly string[],
  loadedImages: Set<string>,
  pendingImages: Map<string, HTMLImageElement>,
) {
  return Promise.all(imageSources.map((imageSrc) => waitForPonchoDrifellaImage(imageSrc, loadedImages, pendingImages))).then(
    () => undefined,
  );
}

export function waitForPonchoDrifellaCardAssets(
  card: DrifCardConfig | undefined,
  loadedImages: Set<string>,
  pendingImages: Map<string, HTMLImageElement>,
) {
  const assetSources = ponchoDrifellaCardAssetSources(card);
  if (!assetSources.length) return Promise.resolve();
  return waitForPonchoDrifellaImageSources(assetSources, loadedImages, pendingImages);
}

export function waitForPonchoDrifellaSequenceAssets(
  loadedImages: Set<string>,
  pendingImages: Map<string, HTMLImageElement>,
) {
  return waitForPonchoDrifellaImageSources(
    PONCHO_DRIFELLA_REQUIRED_FIXED_SEQUENCE_FRAME_URLS,
    loadedImages,
    pendingImages,
  );
}

function waitForPonchoDrifellaRetryDelay(delayMs: number, signal?: AbortSignal) {
  if (signal?.aborted) {
    return Promise.resolve(false);
  }
  return new Promise<boolean>((resolve) => {
    const timeoutId = globalThis.setTimeout(() => {
      signal?.removeEventListener('abort', handleAbort);
      resolve(true);
    }, delayMs);
    const handleAbort = () => {
      globalThis.clearTimeout(timeoutId);
      signal?.removeEventListener('abort', handleAbort);
      resolve(false);
    };
    signal?.addEventListener('abort', handleAbort, { once: true });
  });
}

async function waitForPonchoDrifellaAssetsUntilReady(
  waitForAssets: () => Promise<void>,
  { signal, retryDelayMs = PONCHO_DRIFELLA_ASSET_RETRY_DELAY_MS }: WaitForPonchoDrifellaAssetsUntilReadyOptions = {},
) {
  let retryAttempt = 0;
  while (!signal?.aborted) {
    try {
      await waitForAssets();
      return true;
    } catch {
      retryAttempt += 1;
      const nextRetryDelayMs = Math.min(retryDelayMs * 2 ** Math.max(0, retryAttempt - 1), 2_880);
      const shouldRetry = await waitForPonchoDrifellaRetryDelay(nextRetryDelayMs, signal);
      if (!shouldRetry) {
        return false;
      }
    }
  }
  return false;
}

export function waitForPonchoDrifellaCardAssetsUntilReady(
  card: DrifCardConfig | undefined,
  loadedImages: Set<string>,
  pendingImages: Map<string, HTMLImageElement>,
  signal?: AbortSignal,
) {
  const assetSources = ponchoDrifellaCardAssetSources(card);
  if (!assetSources.length) return Promise.resolve(true);
  return waitForPonchoDrifellaAssetsUntilReady(
    () => waitForPonchoDrifellaImageSources(assetSources, loadedImages, pendingImages),
    { signal },
  );
}

export function waitForPonchoDrifellaSequenceAssetsUntilReady(
  loadedImages: Set<string>,
  pendingImages: Map<string, HTMLImageElement>,
  signal?: AbortSignal,
) {
  return waitForPonchoDrifellaAssetsUntilReady(
    () => waitForPonchoDrifellaSequenceAssets(loadedImages, pendingImages),
    { signal },
  );
}

export function preloadPonchoDrifellaPunchAssets(
  loadedImages: Set<string>,
  pendingImages: Map<string, HTMLImageElement>,
) {
  preloadPonchoDrifellaImage(PONCHO_DRIFELLA_INITIAL_FRAME_URL, loadedImages, pendingImages);
  PONCHO_DRIFELLA_PUNCH_FRAME_URLS_BY_VARIANT.forEach((frameUrls) => {
    frameUrls.forEach((frameSrc) => {
      preloadPonchoDrifellaImage(frameSrc, loadedImages, pendingImages);
    });
  });
}

export function preloadPonchoDrifellaSequenceAssets(
  loadedImages: Set<string>,
  pendingImages: Map<string, HTMLImageElement>,
) {
  PONCHO_DRIFELLA_SEQUENCE_FRAME_URLS.forEach((frameSrc) => {
    preloadPonchoDrifellaImage(frameSrc, loadedImages, pendingImages);
  });
  PONCHO_DRIFELLA_SEGMENT_AUTOPLAY_OVERTOP_FRAME_URLS.forEach((frameSrc) => {
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
  cardDisplayReady = true,
  loadedImages,
  pendingImages,
  resetKey,
  onRequestReveal,
  onPlayClick,
  onPlayReveal,
  autoplayDelayMs = PONCHO_DRIFELLA_SEQUENCE_AUTOPLAY_DELAY_MS,
}: UsePonchoDrifellaRevealControllerOptions): PonchoDrifellaRevealControllerState {
  const [stage, setStage] = useState<PonchoDrifellaRevealStage>('idle');
  const [stageFrameIndex, setStageFrameIndex] = useState(0);
  const [activePunchFrameUrls, setActivePunchFrameUrls] = useState<readonly string[]>(
    PONCHO_DRIFELLA_PUNCH_FRAME_URLS_BY_VARIANT[0],
  );
  const [hasRevealAttempted, setHasRevealAttempted] = useState(false);
  const [requestPending, setRequestPending] = useState(false);
  const [autoplayQueued, setAutoplayQueued] = useState(false);
  const [cardInteractionUnlocked, setCardInteractionUnlocked] = useState(false);
  const [sequenceAssetsReady, setSequenceAssetsReady] = useState(
    () => !loadedImages || !pendingImages || arePonchoDrifellaSequenceAssetsReady(loadedImages, pendingImages),
  );
  const revealSoundPlayedRef = useRef(false);
  const requestStateRef = useRef<'idle' | 'pending' | 'sent'>('idle');
  const requestGenerationRef = useRef(0);
  const stageRef = useRef<PonchoDrifellaRevealStage>('idle');

  const selectPunchFrameUrls = useCallback(() => {
    const readinessByVariant = PONCHO_DRIFELLA_PUNCH_FRAME_URLS_BY_VARIANT.map((frameUrls) => {
      let readyFrameCount = frameUrls.length;
      if (loadedImages && pendingImages) {
        readyFrameCount = 0;
        for (const frameSrc of frameUrls) {
          if (!loadedImages.has(frameSrc) || pendingImages.has(frameSrc)) break;
          readyFrameCount += 1;
        }
      }
      return {
        frameUrls,
        readyFrameCount,
      };
    });
    const fullReadyVariants = readinessByVariant.filter(({ frameUrls, readyFrameCount }) => readyFrameCount >= frameUrls.length);
    if (fullReadyVariants.length) {
      return fullReadyVariants[Math.floor(Math.random() * fullReadyVariants.length)]!.frameUrls;
    }
    const partiallyReadyVariants = readinessByVariant.filter(({ readyFrameCount }) => readyFrameCount > 0);
    if (partiallyReadyVariants.length) {
      const maxReadyFrameCount = Math.max(...partiallyReadyVariants.map(({ readyFrameCount }) => readyFrameCount));
      const bestReadyVariants = partiallyReadyVariants.filter(({ readyFrameCount }) => readyFrameCount === maxReadyFrameCount);
      const selectedVariant = bestReadyVariants[Math.floor(Math.random() * bestReadyVariants.length)]!;
      return selectedVariant.frameUrls.slice(0, selectedVariant.readyFrameCount);
    }
    return PONCHO_DRIFELLA_PUNCH_FALLBACK_FRAME_URLS;
  }, [loadedImages, pendingImages]);

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
    stageRef.current = stage;
  }, [stage]);

  useEffect(() => {
    setStage('idle');
    setStageFrameIndex(0);
    setActivePunchFrameUrls(PONCHO_DRIFELLA_PUNCH_FRAME_URLS_BY_VARIANT[0]);
    setHasRevealAttempted(false);
    setAutoplayQueued(false);
    setCardInteractionUnlocked(false);
    revealSoundPlayedRef.current = false;
    resetRequestState();
  }, [resetKey, resetRequestState]);

  useEffect(() => {
    if (active) return;
    setStage('idle');
    setStageFrameIndex(0);
    setActivePunchFrameUrls(PONCHO_DRIFELLA_PUNCH_FRAME_URLS_BY_VARIANT[0]);
    setHasRevealAttempted(false);
    setAutoplayQueued(false);
    setCardInteractionUnlocked(false);
    revealSoundPlayedRef.current = false;
    resetRequestState();
  }, [active, resetRequestState]);

  useEffect(() => {
    if (!active) {
      setSequenceAssetsReady(!loadedImages || !pendingImages || arePonchoDrifellaSequenceAssetsReady(loadedImages, pendingImages));
      return undefined;
    }
    if (!loadedImages || !pendingImages) {
      setSequenceAssetsReady(true);
      return undefined;
    }
    if (arePonchoDrifellaSequenceAssetsReady(loadedImages, pendingImages)) {
      setSequenceAssetsReady(true);
      return undefined;
    }
    const abortController = new AbortController();
    setSequenceAssetsReady(false);
    void waitForPonchoDrifellaSequenceAssetsUntilReady(loadedImages, pendingImages, abortController.signal).then((ready) => {
      if (abortController.signal.aborted) return;
      setSequenceAssetsReady(ready);
    });
    return () => {
      abortController.abort();
    };
  }, [active, loadedImages, pendingImages, resetKey]);

  useEffect(() => {
    if (!active || phase !== 'ready' || stage !== 'punch' || typeof window === 'undefined') return undefined;
    const timeoutId = window.setTimeout(() => {
      if (stageFrameIndex >= activePunchFrameUrls.length - 1) {
        setStage('idle');
        setStageFrameIndex(0);
        return;
      }
      setStageFrameIndex((prevFrameIndex) => prevFrameIndex + 1);
    }, PONCHO_DRIFELLA_PUNCH_FRAME_DURATION_MS);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [active, activePunchFrameUrls.length, phase, stage, stageFrameIndex]);

  useEffect(() => {
    if (!active || phase !== 'ready' || stage !== 'segment_1_1' || typeof window === 'undefined') return undefined;
    const timeoutId = window.setTimeout(() => {
      if (stageFrameIndex >= PONCHO_DRIFELLA_SEGMENT_1_1_FRAME_URLS.length - 1) {
        setStage('segment_1_1_hold');
        return;
      }
      setStageFrameIndex((prevFrameIndex) => prevFrameIndex + 1);
    }, PONCHO_DRIFELLA_PUNCH_FRAME_DURATION_MS);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [active, phase, stage, stageFrameIndex]);

  useEffect(() => {
    if (!active || phase !== 'ready' || stage !== 'segment_1_2' || typeof window === 'undefined') return undefined;
    const timeoutId = window.setTimeout(() => {
      if (stageFrameIndex >= PONCHO_DRIFELLA_SEGMENT_1_2_FRAME_URLS.length - 1) {
        setStage('segment_1_2_hold');
        return;
      }
      setStageFrameIndex((prevFrameIndex) => prevFrameIndex + 1);
    }, PONCHO_DRIFELLA_PUNCH_FRAME_DURATION_MS);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [active, phase, stage, stageFrameIndex]);

  useEffect(() => {
    if (!active || phase !== 'ready' || stage !== 'autoplay' || typeof window === 'undefined') return undefined;
    const timeoutId = window.setTimeout(() => {
      if (stageFrameIndex >= PONCHO_DRIFELLA_SEGMENT_AUTOPLAY_FRAME_URLS.length - 1) {
        setStage('revealed');
        return;
      }
      setStageFrameIndex((prevFrameIndex) => prevFrameIndex + 1);
    }, autoplayDelayMs);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [active, autoplayDelayMs, phase, stage, stageFrameIndex]);

  useEffect(() => {
    if (!active || stage !== 'revealed' || typeof window === 'undefined') {
      setCardInteractionUnlocked(false);
      return undefined;
    }
    setCardInteractionUnlocked(false);
    const timeoutId = window.setTimeout(() => {
      setCardInteractionUnlocked(true);
    }, PONCHO_DRIFELLA_CARD_INTERACTION_UNLOCK_DELAY_MS);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [active, stage]);

  const revealPhase = useMemo<PonchoDrifellaRevealPhase>(() => {
    if (phase === 'preparing') return 'preparing';
    if (stage === 'revealed' && cardReady) return 'revealed';
    return 'ready';
  }, [cardReady, phase, stage]);

  useEffect(() => {
    if (revealPhase !== 'revealed' || revealSoundPlayedRef.current) return;
    revealSoundPlayedRef.current = true;
    onPlayReveal?.();
  }, [onPlayReveal, revealPhase]);

  const animating = stage === 'punch' || stage === 'segment_1_1' || stage === 'segment_1_2' || stage === 'autoplay';
  const autoOpening = stage === 'autoplay';
  const revealResolved = cardReady;
  const cardAssetsReady = cardDisplayReady;
  const fixedSequenceReady = revealResolved && cardAssetsReady && sequenceAssetsReady;
  const autoplayVisualsVisible = fixedSequenceReady && (stage === 'autoplay' || stage === 'revealed');

  const boxFrameSrc = useMemo(() => {
    if (stage === 'punch') {
      return activePunchFrameUrls[Math.min(stageFrameIndex, activePunchFrameUrls.length - 1)] || PONCHO_DRIFELLA_INITIAL_FRAME_URL;
    }
    if (stage === 'segment_1_1' || stage === 'segment_1_1_hold') {
      return PONCHO_DRIFELLA_SEGMENT_1_1_FRAME_URLS[Math.min(stageFrameIndex, PONCHO_DRIFELLA_SEGMENT_1_1_FRAME_URLS.length - 1)];
    }
    if (stage === 'segment_1_2' || stage === 'segment_1_2_hold') {
      return PONCHO_DRIFELLA_SEGMENT_1_2_FRAME_URLS[Math.min(stageFrameIndex, PONCHO_DRIFELLA_SEGMENT_1_2_FRAME_URLS.length - 1)];
    }
    if (stage === 'autoplay' || stage === 'revealed') {
      return PONCHO_DRIFELLA_SEGMENT_AUTOPLAY_FRAME_URLS[
        Math.min(stageFrameIndex, PONCHO_DRIFELLA_SEGMENT_AUTOPLAY_FRAME_URLS.length - 1)
      ];
    }
    return PONCHO_DRIFELLA_INITIAL_FRAME_URL;
  }, [activePunchFrameUrls, stage, stageFrameIndex]);

  const foregroundFrameSrc = useMemo(() => {
    if (!sequenceAssetsReady) return undefined;
    if (stage !== 'autoplay' && stage !== 'revealed') {
      return PONCHO_DRIFELLA_SEGMENT_AUTOPLAY_OVERTOP_FRAME_URLS[0];
    }
    return PONCHO_DRIFELLA_SEGMENT_AUTOPLAY_OVERTOP_FRAME_URLS[
      Math.min(stageFrameIndex, PONCHO_DRIFELLA_SEGMENT_AUTOPLAY_OVERTOP_FRAME_URLS.length - 1)
    ];
  }, [sequenceAssetsReady, stage, stageFrameIndex]);

  const frame = useMemo(() => {
    if (stage === 'segment_1_1' || stage === 'segment_1_1_hold') {
      return stageFrameIndex + 1;
    }
    if (stage === 'segment_1_2' || stage === 'segment_1_2_hold') {
      return PONCHO_DRIFELLA_SEGMENT_1_1_FRAME_URLS.length + stageFrameIndex + 1;
    }
    if (stage === 'autoplay' || stage === 'revealed') {
      return PONCHO_DRIFELLA_MANUAL_SEQUENCE_FRAME_URLS.length + stageFrameIndex + 1;
    }
    return 1;
  }, [stage, stageFrameIndex]);

  const note = useMemo(() => {
    if (revealPhase === 'preparing') return '';
    if (revealPhase === 'revealed') return '';
    if (autoOpening) return 'opening...';
    return hasRevealAttempted ? `keep clicking the ${boxLabel}` : `click the ${boxLabel} to open`;
  }, [autoOpening, boxLabel, hasRevealAttempted, revealPhase]);

  const cardVisible = autoplayVisualsVisible;
  const cardInteractive = stage === 'revealed' && cardInteractionUnlocked;

  const startPunch = useCallback(() => {
    setActivePunchFrameUrls(selectPunchFrameUrls());
    setStage('punch');
    setStageFrameIndex(0);
  }, [selectPunchFrameUrls]);

  const startSegment_1_1 = useCallback(() => {
    setStage('segment_1_1');
    setStageFrameIndex(0);
  }, []);

  const startSegment_1_2 = useCallback(() => {
    setStage('segment_1_2');
    setStageFrameIndex(0);
  }, []);

  const startAutoplay = useCallback(() => {
    setAutoplayQueued(false);
    setStage('autoplay');
    setStageFrameIndex(0);
  }, []);

  useEffect(() => {
    if (!active || phase !== 'ready' || stage !== 'segment_1_2_hold' || !autoplayQueued || !fixedSequenceReady) {
      return;
    }
    startAutoplay();
  }, [active, autoplayQueued, fixedSequenceReady, phase, stage, startAutoplay]);

  const startAutoOpening = useCallback(() => {
    if (!active || phase !== 'ready' || !revealResolved || animating) return;
    if (stageRef.current !== 'segment_1_2_hold') return;
    setHasRevealAttempted(true);
    if (!fixedSequenceReady) {
      setAutoplayQueued(true);
      return;
    }
    startAutoplay();
  }, [active, animating, fixedSequenceReady, phase, revealResolved, startAutoplay]);

  const handleAdvance = useCallback(() => {
    if (!active || phase !== 'ready') return;
    onPlayClick?.();
    setHasRevealAttempted(true);

    if (animating) {
      if (stageRef.current === 'punch') {
        startRevealRequest();
      }
      return;
    }

    if (!revealResolved) {
      startPunch();
      startRevealRequest();
      return;
    }

    if (stageRef.current === 'idle') {
      if (!fixedSequenceReady) {
        startPunch();
        return;
      }
      startSegment_1_1();
      return;
    }
    if (stageRef.current === 'segment_1_1_hold') {
      startSegment_1_2();
      return;
    }
    if (stageRef.current === 'segment_1_2_hold') {
      if (!fixedSequenceReady) {
        setAutoplayQueued(true);
        return;
      }
      startAutoplay();
    }
  }, [
    active,
    animating,
    fixedSequenceReady,
    onPlayClick,
    phase,
    revealResolved,
    startAutoplay,
    startPunch,
    startRevealRequest,
    startSegment_1_1,
    startSegment_1_2,
  ]);

  return {
    phase: revealPhase,
    frame,
    animating,
    autoOpening,
    hasRevealAttempted,
    requestPending,
    boxFrameSrc,
    foregroundFrameSrc,
    cardVisible,
    cardInteractive,
    note,
    revealComplete: stage === 'revealed',
    handleAdvance,
    startAutoOpening,
  };
}
