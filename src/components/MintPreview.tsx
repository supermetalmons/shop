import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PreviewVideoSource } from '../types';
import { isDropFamily } from '../config/deployment';
import {
  playMutedAutoplayVideo as playAutoplayVideo,
  prepareMutedAutoplayVideo as prepareAutoplayVideo,
} from '../lib/autoplayVideo';

type MintPanelVideoSource = PreviewVideoSource;

export type MintPanelBoxMedia = {
  imageSrc?: string;
  videoSources?: readonly MintPanelVideoSource[];
  videoPosterSrc?: string;
  mediaScale?: number;
  compactMediaScale?: number;
  aspectRatio?: number;
};

type MintPreviewProps = {
  boxMedia?: MintPanelBoxMedia;
  dropId?: string;
  quantity: number;
  quantityLabel: string;
};

type BoxPreviewLayout = { width: number; height: number; gapX: number; gapY: number; cols: number };
type BoxPreviewBounds = { width: number; height: number; viewportWidth: number; centerX: number };

const BOX_ASPECT_RATIO = 1440 / 1030;
const BOX_MAX_RELATIVE_HEIGHT = 0.777;
const BOX_MEDIA_SCALE_MAX = 1.5;

export function mintPanelPreviewQuantity(
  dropId: string | undefined,
  quantity: number,
  hasVideoSources: boolean,
): number {
  if (isDropFamily(dropId, 'clear_cards')) return 1;
  if (hasVideoSources && isDropFamily(dropId, 'card_nft_2')) return 1;
  return quantity;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function fallbackElementsAfter(element: HTMLElement): HTMLElement[] {
  const elements: HTMLElement[] = [];
  let fallback = element.nextElementSibling;
  while (fallback instanceof HTMLElement && fallback.dataset.mintMediaFallback === 'true') {
    elements.push(fallback);
    fallback = fallback.nextElementSibling;
  }

  return elements;
}

function hideFallbackElementsAfter(element: HTMLElement) {
  fallbackElementsAfter(element).forEach((fallback) => {
    fallback.hidden = true;
  });
}

function mediaFallbackFailed(fallback: HTMLElement): boolean {
  return fallback instanceof HTMLImageElement && fallback.complete && fallback.naturalWidth === 0;
}

function mediaFallbackReady(fallback: HTMLElement): boolean {
  return !(fallback instanceof HTMLImageElement) || (fallback.complete && fallback.naturalWidth > 0);
}

function showFirstAvailableFallbackAfter(element: HTMLElement) {
  let selectedFallback: HTMLElement | null = null;

  fallbackElementsAfter(element).forEach((fallback) => {
    if (mediaFallbackFailed(fallback)) {
      fallback.hidden = true;
      return;
    }

    if (!selectedFallback) {
      selectedFallback = fallback;
      fallback.hidden = false;
      return;
    }

    fallback.hidden = mediaFallbackReady(selectedFallback) || fallback instanceof HTMLImageElement;
  });
}

function showPrimaryMediaFallback(media: HTMLElement) {
  showFirstAvailableFallbackAfter(media);
}

function hideMediaShowFallback(media: HTMLElement) {
  media.hidden = true;
  showPrimaryMediaFallback(media);
}

function videoHasCurrentData(video: HTMLVideoElement): boolean {
  return !video.error && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
}

function hideLoadedImageFallbacks(image: HTMLImageElement) {
  if (image.hidden) return;
  hideFallbackElementsAfter(image);
}

function hideImageShowFallback(image: HTMLImageElement) {
  image.hidden = true;
  showFirstAvailableFallbackAfter(image);
}

function uniqueMediaSrcs(...sources: Array<string | undefined>): string[] {
  const uniqueSources = new Set<string>();
  sources.forEach((source) => {
    const trimmedSource = source?.trim();
    if (trimmedSource) uniqueSources.add(trimmedSource);
  });

  return Array.from(uniqueSources);
}

type RestartAutoplayVideoOptions = {
  reload?: boolean;
  reloadIfStale?: boolean;
};

function autoplayVideoNeedsReload(video: HTMLVideoElement): boolean {
  return Boolean(video.error) || video.readyState === 0;
}

function resetAutoplayVideoTime(video: HTMLVideoElement) {
  try {
    video.currentTime = 0;
  } catch {}
}

function stopAutoplayVideo(video: HTMLVideoElement) {
  video.pause();
  resetAutoplayVideoTime(video);
}

function restartAutoplayVideo(video: HTMLVideoElement, options: RestartAutoplayVideoOptions = {}) {
  const shouldReload = Boolean(options.reload || (options.reloadIfStale && autoplayVideoNeedsReload(video)));
  stopAutoplayVideo(video);
  if (shouldReload) {
    video.load();
  }
  playAutoplayVideo(video);
}

function calcBoxPreviewLayout(count: number, width: number, height: number, boxAspectRatio: number): BoxPreviewLayout {
  const safeCount = Math.max(1, Math.min(15, Math.floor(count)));
  const safeWidth = Math.max(0, Math.floor(width));
  const safeHeight = Math.max(0, Math.floor(height));
  const aspectRatio = clampNumber(boxAspectRatio || BOX_ASPECT_RATIO, 0.25, 4);
  const gapScaleX = safeCount > 1 ? 1.8 : 1;
  const gapScaleY = safeCount > 1 ? 2 : 1;

  if (!safeWidth || !safeHeight) {
    const fallbackHeight = 120;
    return {
      height: fallbackHeight,
      width: Math.max(1, Math.floor(fallbackHeight * aspectRatio)),
      gapX: 12 * gapScaleX,
      gapY: 12 * gapScaleY,
      cols: Math.min(safeCount, 4),
    };
  }

  const maxHeight = Math.max(1, Math.floor(safeHeight * BOX_MAX_RELATIVE_HEIGHT));
  let best: BoxPreviewLayout = { height: 1, width: Math.max(1, Math.floor(BOX_ASPECT_RATIO)), gapX: 8, gapY: 8, cols: 1 };

  for (let cols = 1; cols <= safeCount; cols += 1) {
    const rows = Math.ceil(safeCount / cols);

    let gapX = 12 * gapScaleX;
    let gapY = 12 * gapScaleY;
    let boxHeight = Math.min(
      (safeWidth - (cols - 1) * gapX) / (cols * aspectRatio),
      (safeHeight - (rows - 1) * gapY) / rows,
    );
    boxHeight = Math.min(boxHeight, maxHeight);
    const baseGap = clampNumber(Math.round(boxHeight * 0.08), 6, 14);
    gapX = baseGap * gapScaleX;
    gapY = baseGap * gapScaleY;
    boxHeight = Math.min(
      (safeWidth - (cols - 1) * gapX) / (cols * aspectRatio),
      (safeHeight - (rows - 1) * gapY) / rows,
    );
    boxHeight = Math.min(boxHeight, maxHeight);

    boxHeight = Math.floor(boxHeight) - 1;
    gapX = Math.max(0, Math.floor(gapX));
    gapY = Math.max(0, Math.floor(gapY));

    if (boxHeight < 1) continue;

    const boxWidth = Math.max(1, Math.floor(boxHeight * aspectRatio));

    if (boxHeight > best.height) {
      best = { width: boxWidth, height: boxHeight, gapX, gapY, cols };
      continue;
    }

    if (boxHeight === best.height) {
      const bestRows = Math.ceil(safeCount / best.cols);
      if (rows < bestRows) {
        best = { width: boxWidth, height: boxHeight, gapX, gapY, cols };
      }
    }
  }

  return best;
}

function normalizeBoxMediaScale(requestedScale: number | undefined): number {
  return clampNumber(Number(requestedScale) || 1, 1, BOX_MEDIA_SCALE_MAX);
}

function constrainBoxMediaScale(scale: number, layout: BoxPreviewLayout, bounds: BoxPreviewBounds): number {
  if (layout.width <= 0 || bounds.viewportWidth <= 0) return scale;

  const availableWidthAroundCenter = Math.max(
    0,
    2 * Math.min(bounds.centerX, bounds.viewportWidth - bounds.centerX),
  );
  if (availableWidthAroundCenter <= 0) return scale;

  return Math.min(scale, Math.max(1, availableWidthAroundCenter / layout.width));
}

type MintPanelBoxVideoProps = {
  playIfActive: (video: HTMLVideoElement) => void;
  registerVideo: (video: HTMLVideoElement, options?: Pick<RestartAutoplayVideoOptions, 'reload'>) => () => void;
  sources: readonly MintPanelVideoSource[];
};

function MintPanelBoxVideo({
  playIfActive,
  registerVideo,
  sources,
}: MintPanelBoxVideoProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const videoReadyRef = useRef(false);
  const registeredSourceKeyRef = useRef<string | null>(null);
  const [videoReady, setVideoReady] = useState(false);
  const sourceKey = sources.map((source) => source.src).join('|');
  const videoClassName = videoReady
    ? 'mint-panel__box mint-panel__box--video'
    : 'mint-panel__box mint-panel__box--video mint-panel__box--video-loading';

  const handleVideoReady = useCallback(
    (video: HTMLVideoElement) => {
      if (videoReadyRef.current) return;
      videoReadyRef.current = true;
      video.hidden = false;
      video.classList.remove('mint-panel__box--video-loading');
      setVideoReady(true);
      playIfActive(video);
      hideFallbackElementsAfter(video);
    },
    [playIfActive],
  );

  const handleVideoLoading = useCallback((video: HTMLVideoElement) => {
    videoReadyRef.current = false;
    video.classList.add('mint-panel__box--video-loading');
    setVideoReady(false);
    showPrimaryMediaFallback(video);
  }, []);

  const handleVideoError = useCallback((video: HTMLVideoElement) => {
    videoReadyRef.current = false;
    video.classList.add('mint-panel__box--video-loading');
    setVideoReady(false);
    hideMediaShowFallback(video);
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    handleVideoLoading(video);
    const registeredSourceKey = registeredSourceKeyRef.current;
    registeredSourceKeyRef.current = sourceKey;
    const unregisterVideo = registerVideo(video, { reload: registeredSourceKey !== null && registeredSourceKey !== sourceKey });
    if (videoHasCurrentData(video)) {
      handleVideoReady(video);
    }
    return unregisterVideo;
  }, [handleVideoLoading, handleVideoReady, registerVideo, sourceKey]);

  return (
    <video
      ref={videoRef}
      className={videoClassName}
      autoPlay
      loop
      muted
      playsInline
      preload="auto"
      aria-hidden="true"
      onLoadStart={(evt) => {
        handleVideoLoading(evt.currentTarget);
      }}
      onEmptied={(evt) => {
        handleVideoLoading(evt.currentTarget);
      }}
      onLoadedData={(evt) => {
        handleVideoReady(evt.currentTarget);
      }}
      onCanPlay={(evt) => {
        handleVideoReady(evt.currentTarget);
      }}
      onError={(evt) => {
        handleVideoError(evt.currentTarget);
      }}
    >
      {sources.map((source) => (
        <source key={source.src} src={source.src} type={source.type} />
      ))}
    </video>
  );
}

export function MintPreview({ boxMedia, dropId, quantity, quantityLabel }: MintPreviewProps) {
  const previewRef = useRef<HTMLDivElement | null>(null);
  const mintBoxVideosRef = useRef<Set<HTMLVideoElement>>(new Set());
  const mintBoxVideoPlaybackActiveRef = useRef(false);
  const [previewBounds, setPreviewBounds] = useState<BoxPreviewBounds>({
    width: 0,
    height: 0,
    viewportWidth: 0,
    centerX: 0,
  });

  const mintBoxImageSrc = boxMedia?.imageSrc;
  const mintBoxVideoSources = (boxMedia?.videoSources || []).filter((source) => source.src);
  const hasMintBoxVideoSources = mintBoxVideoSources.length > 0;
  const previewQuantity = mintPanelPreviewQuantity(dropId, quantity, hasMintBoxVideoSources);
  const mintBoxVideoPosterSrc = boxMedia?.videoPosterSrc || mintBoxImageSrc;
  const mintBoxVideoFallbackImageSrcs = uniqueMediaSrcs(mintBoxVideoPosterSrc, mintBoxImageSrc);

  const pruneMintBoxVideos = useCallback(() => {
    mintBoxVideosRef.current.forEach((video) => {
      if (video.isConnected) return;
      stopAutoplayVideo(video);
      mintBoxVideosRef.current.delete(video);
    });
  }, []);

  const setMintBoxVideoPlaybackActive = useCallback(
    (active: boolean, options: { reload?: boolean } = {}) => {
      pruneMintBoxVideos();
      const wasActive = mintBoxVideoPlaybackActiveRef.current;
      const reload = Boolean(options.reload);
      if (active === wasActive) {
        if (active && reload) {
          mintBoxVideosRef.current.forEach((video) => restartAutoplayVideo(video, { reload: true }));
        }
        return;
      }

      mintBoxVideoPlaybackActiveRef.current = active;

      mintBoxVideosRef.current.forEach((video) => {
        if (active) {
          restartAutoplayVideo(video, { reload, reloadIfStale: true });
        } else {
          stopAutoplayVideo(video);
        }
      });
    },
    [pruneMintBoxVideos],
  );

  const playMintBoxVideoIfActive = useCallback((video: HTMLVideoElement) => {
    if (mintBoxVideoPlaybackActiveRef.current) {
      playAutoplayVideo(video);
    }
  }, []);

  const registerMintBoxVideo = useCallback(
    (video: HTMLVideoElement, options: Pick<RestartAutoplayVideoOptions, 'reload'> = {}) => {
      pruneMintBoxVideos();
      prepareAutoplayVideo(video);
      mintBoxVideosRef.current.add(video);
      if (mintBoxVideoPlaybackActiveRef.current) {
        restartAutoplayVideo(video, { reload: options.reload });
      }

      return () => {
        stopAutoplayVideo(video);
        mintBoxVideosRef.current.delete(video);
      };
    },
    [pruneMintBoxVideos],
  );

  useEffect(() => {
    if (!hasMintBoxVideoSources) return undefined;

    const isDocumentVisible = () => document.visibilityState !== 'hidden';

    const suspendPlayback = () => {
      setMintBoxVideoPlaybackActive(false);
    };

    const resumePlayback = (options: { reload?: boolean } = {}) => {
      if (!isDocumentVisible()) {
        suspendPlayback();
        return;
      }
      setMintBoxVideoPlaybackActive(true, options);
    };

    const handleVisibilityChange = () => {
      if (isDocumentVisible()) {
        resumePlayback();
      } else {
        suspendPlayback();
      }
    };
    const handleFocus = () => resumePlayback();
    const handlePageShow = (evt: PageTransitionEvent) => resumePlayback({ reload: evt.persisted });

    resumePlayback();
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('blur', suspendPlayback);
    window.addEventListener('focus', handleFocus);
    window.addEventListener('pagehide', suspendPlayback);
    window.addEventListener('pageshow', handlePageShow);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('blur', suspendPlayback);
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('pagehide', suspendPlayback);
      window.removeEventListener('pageshow', handlePageShow);
      mintBoxVideoPlaybackActiveRef.current = false;
      mintBoxVideosRef.current.forEach((video) => stopAutoplayVideo(video));
      mintBoxVideosRef.current.clear();
    };
  }, [hasMintBoxVideoSources, setMintBoxVideoPlaybackActive]);

  useLayoutEffect(() => {
    const el = previewRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;

    const update = () => {
      const style = window.getComputedStyle(el);
      const paddingX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
      const paddingY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      const width = Math.max(0, Math.floor(el.clientWidth - paddingX));
      const height = Math.max(0, Math.floor(el.clientHeight - paddingY));
      const rect = el.getBoundingClientRect();
      const viewportWidth = Math.max(0, document.documentElement.clientWidth || window.innerWidth || 0);
      const centerX = rect.left + rect.width / 2;
      setPreviewBounds((prev) => (
        prev.width === width &&
        prev.height === height &&
        prev.viewportWidth === viewportWidth &&
        Math.abs(prev.centerX - centerX) < 0.5
          ? prev
          : { width, height, viewportWidth, centerX }
      ));
    };

    update();
    const ro = new ResizeObserver(() => update());
    ro.observe(el);
    window.addEventListener('resize', update);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', update);
    };
  }, []);

  const layout = useMemo(
    () => calcBoxPreviewLayout(previewQuantity, previewBounds.width, previewBounds.height, boxMedia?.aspectRatio || BOX_ASPECT_RATIO),
    [boxMedia?.aspectRatio, previewBounds.height, previewBounds.width, previewQuantity],
  );
  const effectiveBoxMediaScale = constrainBoxMediaScale(normalizeBoxMediaScale(boxMedia?.mediaScale), layout, previewBounds);
  const effectiveBoxCompactMediaScale = constrainBoxMediaScale(
    normalizeBoxMediaScale(boxMedia?.compactMediaScale ?? boxMedia?.mediaScale),
    layout,
    previewBounds,
  );

  return (
    <div ref={previewRef} className="mint-panel__preview">
      <div
        className="mint-panel__boxes"
        style={{
          ['--box-width' as never]: `${layout.width}px`,
          ['--box-height' as never]: `${layout.height}px`,
          ['--box-gap-x' as never]: `${layout.gapX}px`,
          ['--box-gap-y' as never]: `${layout.gapY}px`,
          ['--box-cols' as never]: String(layout.cols),
          ['--box-media-scale' as never]: String(effectiveBoxMediaScale),
          ['--box-compact-media-scale' as never]: String(effectiveBoxCompactMediaScale),
        }}
        aria-label={`Mint preview: ${quantityLabel}`}
      >
        {Array.from({ length: previewQuantity }, (_, idx) => (
          hasMintBoxVideoSources ? (
            <div key={idx} className="mint-panel__box mint-panel__box--media mint-panel__box-stack">
              <MintPanelBoxVideo
                playIfActive={playMintBoxVideoIfActive}
                registerVideo={registerMintBoxVideo}
                sources={mintBoxVideoSources}
              />
              {mintBoxVideoFallbackImageSrcs.map((src, fallbackIdx) => (
                <img
                  key={src}
                  className="mint-panel__box"
                  src={src}
                  alt=""
                  aria-hidden="true"
                  draggable={false}
                  hidden={fallbackIdx > 0}
                  loading="eager"
                  data-mint-media-fallback="true"
                  onDragStart={(evt) => evt.preventDefault()}
                  onLoad={(evt) => hideLoadedImageFallbacks(evt.currentTarget)}
                  onError={(evt) => hideImageShowFallback(evt.currentTarget)}
                />
              ))}
              <div
                className="mint-panel__box mint-panel__box--fallback"
                aria-hidden="true"
                data-mint-media-fallback="true"
              />
            </div>
          ) : mintBoxImageSrc ? (
            <div key={idx} className="mint-panel__box mint-panel__box-stack">
              <img
                className="mint-panel__box"
                src={mintBoxImageSrc}
                alt=""
                aria-hidden="true"
                draggable={false}
                onDragStart={(evt) => evt.preventDefault()}
                onLoad={(evt) => hideLoadedImageFallbacks(evt.currentTarget)}
                onError={(evt) => hideImageShowFallback(evt.currentTarget)}
              />
              <div
                className="mint-panel__box mint-panel__box--fallback"
                aria-hidden="true"
                data-mint-media-fallback="true"
              />
            </div>
          ) : (
            <div key={idx} className="mint-panel__box mint-panel__box--fallback" aria-hidden="true" />
          )
        ))}
      </div>
    </div>
  );
}
