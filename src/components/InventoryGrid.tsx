import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import type { InventoryItem, InventoryPreviewVideo } from '../types';
import { getFrontendDrop, isDropFamily } from '../config/deployment';
import { dropAssetCount, dropMintSelectionLabel } from '../lib/dropLabels';
import { hideImageShowFallback, showImageHideFallback } from '../lib/imageFallback';
import { getInventoryRevealRect } from '../lib/inventoryMediaRect';
import { playMutedAutoplayVideo } from '../lib/autoplayVideo';
import {
  createMobileTapCandidate,
  findTouchByIdentifier,
  isMobileBrowser,
  prepareMobileTouchActivation,
  shouldCompleteMobileTapCandidate,
  updateMobileTapCandidateForMove,
  type MobileTapCandidate,
} from '../lib/mobileInteractionGuards';

type InventoryGridSharedProps = {
  items: InventoryItem[];
  itemClassName?: string;
  className?: string;
  pendingRevealIds?: Set<string>;
  onReveal?: (id: string, rect: DOMRect) => void;
  onViewItem?: (item: InventoryItem, rect: DOMRect) => void;
  canRevealItem?: (item: InventoryItem) => boolean;
  revealLoadingId?: string | null;
  revealDisabled?: boolean;
  emptyStateVisibility?: 'visible' | 'hidden' | 'none';
  emptyStateContent?: string;
  figureMediaMode?: 'background' | 'image';
};

type InventoryGridDefaultProps = InventoryGridSharedProps & {
  interactionMode?: 'default';
  selected: Set<string>;
  onToggle: (id: string) => void;
};

type InventoryGridViewOnlyProps = InventoryGridSharedProps & {
  interactionMode: 'view-only';
  selected?: Set<string>;
  onToggle?: (id: string) => void;
  onViewItem: (item: InventoryItem, rect: DOMRect) => void;
};

type InventoryGridProps = InventoryGridDefaultProps | InventoryGridViewOnlyProps;

type InventoryTapCandidate = MobileTapCandidate & {
  itemId: string;
  target: HTMLElement;
};

type SuppressedMobileClick = {
  itemId: string;
  expiresAt: number;
};

type InventoryInteractionMode = 'select' | 'reveal' | 'view' | null;

type InventoryInteractionContext = {
  selected: Set<string>;
  interactionMode?: InventoryGridProps['interactionMode'];
  pendingRevealIds?: Set<string>;
  onReveal?: InventoryGridProps['onReveal'];
  onViewItem?: InventoryGridProps['onViewItem'];
  canRevealItem?: InventoryGridProps['canRevealItem'];
  revealLoadingId?: string | null;
  revealDisabled?: boolean;
};

type InventoryActivationContext = {
  onToggle: (id: string) => void;
  onReveal?: InventoryGridProps['onReveal'];
  onViewItem?: InventoryGridProps['onViewItem'];
};

type InventoryTouchState = InventoryInteractionContext & InventoryActivationContext & {
  itemsById: Map<string, InventoryItem>;
};

type InventoryInteractionState = {
  mode: InventoryInteractionMode;
  isReceipt: boolean;
  isPendingReveal: boolean;
  canSelect: boolean;
  isSelected: boolean;
  revealEnabled: boolean;
  viewEnabled: boolean;
  canInteract: boolean;
};

const EMPTY_INVENTORY_SELECTION = new Set<string>();
const noopInventoryToggle = () => undefined;

function getInventoryItemInteraction(
  item: InventoryItem,
  {
    selected,
    interactionMode = 'default',
    pendingRevealIds,
    onReveal,
    onViewItem,
    canRevealItem,
    revealLoadingId,
    revealDisabled,
  }: InventoryInteractionContext,
): InventoryInteractionState {
  const isReceipt = item.kind === 'certificate';
  const isPendingReveal = pendingRevealIds?.has(item.id) ?? false;
  const isPendingLocal = item.status === 'pending';
  if (interactionMode === 'view-only') {
    const viewEnabled = Boolean(onViewItem);
    return {
      mode: viewEnabled ? 'view' : null,
      isReceipt,
      isPendingReveal,
      canSelect: false,
      isSelected: false,
      revealEnabled: false,
      viewEnabled,
      canInteract: viewEnabled,
    };
  }
  const canSelect = !isReceipt && !isPendingReveal && !isPendingLocal;
  const isSelected = canSelect ? selected.has(item.id) : false;
  const canReveal = Boolean(isPendingReveal && onReveal && (canRevealItem ? canRevealItem(item) : true));
  const isRevealing = revealLoadingId === item.id;
  const revealEnabled = canReveal && selected.size === 0 && !revealDisabled && !isRevealing;
  const viewEnabled = Boolean(!canSelect && !revealEnabled && onViewItem);
  const mode = canSelect ? 'select' : revealEnabled ? 'reveal' : viewEnabled ? 'view' : null;

  return {
    mode,
    isReceipt,
    isPendingReveal,
    canSelect,
    isSelected,
    revealEnabled,
    viewEnabled,
    canInteract: mode !== null,
  };
}

function activateInventoryItem(
  item: InventoryItem,
  interaction: InventoryInteractionState,
  target: HTMLElement,
  { onToggle, onReveal, onViewItem }: InventoryActivationContext,
): boolean {
  if (interaction.mode === 'select') {
    onToggle(item.id);
    return true;
  }
  if (interaction.mode === 'reveal') {
    if (!onReveal) return false;
    onReveal(item.id, getInventoryRevealRect(target));
    return true;
  }
  if (interaction.mode === 'view') {
    if (!onViewItem) return false;
    onViewItem(item, getInventoryRevealRect(target));
    return true;
  }
  return false;
}

type InventoryVideoMediaProps = {
  item: InventoryItem;
  sources: InventoryPreviewVideo['sources'];
  posterSrc?: string;
};

function InventoryVideoMedia({ item, sources, posterSrc }: InventoryVideoMediaProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [videoActive, setVideoActive] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);
  const sourceKey = sources.map((source) => `${source.src}:${source.type || ''}`).join('|');
  const videoKey = `${posterSrc || ''}|${sourceKey}`;
  const showVideo = videoActive && !videoFailed;
  const showPoster = Boolean(posterSrc);
  const showPlaceholder = !showVideo && !showPoster;

  useEffect(() => {
    setVideoFailed(false);
  }, [posterSrc, sourceKey]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof IntersectionObserver === 'undefined') {
      setVideoActive(true);
      return undefined;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        setVideoActive(Boolean(entry?.isIntersecting));
      },
      { rootMargin: '160px' },
    );
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (!showVideo) {
      video.pause();
      return;
    }
    playMutedAutoplayVideo(video);
    return () => {
      video.pause();
    };
  }, [showVideo, sourceKey]);

  return (
    <div ref={rootRef} className="inventory__video-stack" role="img" aria-label={item.name}>
      {posterSrc ? (
        <img
          className="inventory__video-poster"
          src={posterSrc}
          alt=""
          aria-hidden="true"
          loading="lazy"
          draggable={false}
          onDragStart={(evt) => evt.preventDefault()}
        />
      ) : null}
      {showVideo ? (
        <video
          key={videoKey}
          ref={videoRef}
          className="inventory__video"
          autoPlay
          loop
          muted
          playsInline
          preload="metadata"
          poster={posterSrc}
          aria-hidden="true"
          draggable={false}
          onDragStart={(evt) => evt.preventDefault()}
          onLoadStart={() => {
            setVideoFailed(false);
          }}
          onLoadedData={(evt) => {
            setVideoFailed(false);
            playMutedAutoplayVideo(evt.currentTarget);
          }}
          onCanPlay={(evt) => {
            setVideoFailed(false);
            playMutedAutoplayVideo(evt.currentTarget);
          }}
          onError={() => {
            setVideoFailed(true);
          }}
        >
          {sources.map((source) => (
            <source key={`${source.src}:${source.type || ''}`} src={source.src} type={source.type} />
          ))}
        </video>
      ) : null}
      <div className="placeholder" aria-hidden hidden={!showPlaceholder}>
        <span> </span>
      </div>
    </div>
  );
}

type InventoryImageWithFallbackProps = {
  src: string;
  alt: string;
  ariaHidden?: boolean;
  decoding?: 'async' | 'auto' | 'sync';
};

function InventoryImageWithFallback({
  src,
  alt,
  ariaHidden = false,
  decoding,
}: InventoryImageWithFallbackProps) {
  return (
    <>
      <img
        className="inventory__image"
        src={src}
        alt={ariaHidden ? '' : alt}
        aria-hidden={ariaHidden ? 'true' : undefined}
        loading="lazy"
        decoding={decoding}
        draggable={false}
        onDragStart={(evt) => evt.preventDefault()}
        onLoad={(evt) => showImageHideFallback(evt.currentTarget)}
        onError={(evt) => hideImageShowFallback(evt.currentTarget)}
      />
      <div className="placeholder" aria-hidden hidden>
        <span> </span>
      </div>
    </>
  );
}

function InventoryFigureBackgroundMedia({ item }: { item: InventoryItem }) {
  const [figureImageFailed, setFigureImageFailed] = useState(false);

  useEffect(() => {
    setFigureImageFailed(false);
  }, [item.image]);

  return (
    <>
      <img
        src={item.image}
        alt=""
        aria-hidden="true"
        hidden
        loading="lazy"
        draggable={false}
        onDragStart={(evt) => evt.preventDefault()}
        onError={() => setFigureImageFailed(true)}
      />
      {figureImageFailed ? (
        <div className="placeholder" aria-hidden>
          <span> </span>
        </div>
      ) : (
        <div
          className="inventory__image"
          style={{ backgroundImage: `url(${item.image})` }}
          role="img"
          aria-label={item.name}
        />
      )}
    </>
  );
}

function InventoryMedia({
  item,
  figureMediaMode = 'background',
}: {
  item: InventoryItem;
  figureMediaMode?: InventoryGridSharedProps['figureMediaMode'];
}) {
  const isFigure = item.kind === 'dude';
  const previewVideo = item.previewVideo;

  if (previewVideo) {
    const previewVideoSources = previewVideo.sources.filter((source) => source.src);
    if (previewVideoSources.length) {
      return <InventoryVideoMedia item={item} sources={previewVideoSources} posterSrc={previewVideo.posterSrc} />;
    }
  }

  if (!item.image) {
    return (
      <div className="placeholder" aria-hidden>
        <span> </span>
      </div>
    );
  }

  if (isFigure) {
    if (figureMediaMode === 'image') {
      return <InventoryImageWithFallback src={item.image} alt={item.name} ariaHidden decoding="async" />;
    }

    return <InventoryFigureBackgroundMedia item={item} />;
  }

  return <InventoryImageWithFallback src={item.image} alt={item.name} />;
}

export function InventoryGrid({
  items,
  selected = EMPTY_INVENTORY_SELECTION,
  onToggle = noopInventoryToggle,
  interactionMode = 'default',
  itemClassName,
  className,
  pendingRevealIds,
  onReveal,
  onViewItem,
  canRevealItem,
  revealLoadingId,
  revealDisabled,
  emptyStateVisibility = 'visible',
  emptyStateContent = 'No items yet.',
  figureMediaMode = 'background',
}: InventoryGridProps) {
  const gridRef = useRef<HTMLDivElement | null>(null);
  const tapCandidateRef = useRef<InventoryTapCandidate | null>(null);
  const suppressedMobileClickRef = useRef<SuppressedMobileClick | null>(null);
  const itemsById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const touchStateRef = useRef<InventoryTouchState>({
    itemsById,
    selected,
    interactionMode,
    onToggle,
    pendingRevealIds,
    onReveal,
    onViewItem,
    canRevealItem,
    revealLoadingId,
    revealDisabled,
  });
  useLayoutEffect(() => {
    touchStateRef.current = {
      itemsById,
      selected,
      interactionMode,
      onToggle,
      pendingRevealIds,
      onReveal,
      onViewItem,
      canRevealItem,
      revealLoadingId,
      revealDisabled,
    };
  });

  useEffect(() => {
    if (!isMobileBrowser()) return undefined;

    const handleDocumentTouchStart = (event: globalThis.TouchEvent) => {
      tapCandidateRef.current = null;
      const gridElement = gridRef.current;
      if (!gridElement || !(event.target instanceof Element)) return;
      const itemElement = event.target.closest<HTMLElement>('[data-inventory-id]');
      if (!itemElement || !gridElement.contains(itemElement)) return;

      const itemId = itemElement.dataset.inventoryId;
      const touchState = touchStateRef.current;
      const item = itemId ? touchState.itemsById.get(itemId) : undefined;
      if (!item) return;

      const interaction = getInventoryItemInteraction(item, touchState);
      if (!interaction.canInteract) return;
      const touch = event.changedTouches.item(0);
      if (!touch || event.touches.length !== 1) return;
      tapCandidateRef.current = {
        ...createMobileTapCandidate(touch),
        itemId: item.id,
        target: itemElement,
      };
    };

    const handleDocumentTouchMove = (event: globalThis.TouchEvent) => {
      const candidate = tapCandidateRef.current;
      if (!candidate) return;
      const touch = findTouchByIdentifier(event.changedTouches, candidate.identifier);
      tapCandidateRef.current = updateMobileTapCandidateForMove(candidate, touch);
    };

    const handleDocumentTouchEnd = (event: globalThis.TouchEvent) => {
      const candidate = tapCandidateRef.current;
      if (!candidate) return;
      const touch = findTouchByIdentifier(event.changedTouches, candidate.identifier);
      tapCandidateRef.current = null;
      if (!shouldCompleteMobileTapCandidate(candidate, touch)) return;
      if (!prepareMobileTouchActivation(event)) return;

      const gridElement = gridRef.current;
      if (!gridElement || !gridElement.contains(candidate.target)) return;
      const touchState = touchStateRef.current;
      const item = touchState.itemsById.get(candidate.itemId);
      if (!item) return;
      const interaction = getInventoryItemInteraction(item, touchState);
      if (activateInventoryItem(item, interaction, candidate.target, touchState)) {
        suppressedMobileClickRef.current = {
          itemId: candidate.itemId,
          expiresAt: Date.now() + 700,
        };
      }
    };

    const handleDocumentTouchCancel = (event: globalThis.TouchEvent) => {
      const candidate = tapCandidateRef.current;
      if (!candidate) return;
      if (!findTouchByIdentifier(event.changedTouches, candidate.identifier)) return;
      tapCandidateRef.current = null;
    };

    document.addEventListener('touchstart', handleDocumentTouchStart, { passive: false });
    document.addEventListener('touchmove', handleDocumentTouchMove, { passive: true });
    document.addEventListener('touchend', handleDocumentTouchEnd, { passive: false });
    document.addEventListener('touchcancel', handleDocumentTouchCancel, { passive: true });
    return () => {
      document.removeEventListener('touchstart', handleDocumentTouchStart);
      document.removeEventListener('touchmove', handleDocumentTouchMove);
      document.removeEventListener('touchend', handleDocumentTouchEnd);
      document.removeEventListener('touchcancel', handleDocumentTouchCancel);
    };
  }, []);

  if (!items.length) {
    if (emptyStateVisibility === 'none') return null;
    const isHidden = emptyStateVisibility === 'hidden';
    return (
      <div className={`muted small${isHidden ? ' empty-state--hidden' : ''}`} aria-hidden={isHidden}>
        {emptyStateContent}
      </div>
    );
  }

  const gridClassName = ['inventory', className].filter(Boolean).join(' ');

  return (
    <div ref={gridRef} className={gridClassName}>
      {items.map((item) => {
        const interaction = getInventoryItemInteraction(item, {
          selected,
          interactionMode,
          pendingRevealIds,
          onReveal,
          onViewItem,
          canRevealItem,
          revealLoadingId,
          revealDisabled,
        });
        const {
          isReceipt,
          isPendingReveal,
          canSelect,
          isSelected,
          revealEnabled,
          viewEnabled,
          canInteract,
        } = interaction;
        const hasFooter = Boolean(item.assignedDudes?.length);
        const isInteractiveCardFigure = item.kind === 'dude' && isDropFamily(item.dropId, 'card_nft_2');
        const sizeLabel = isSelected
          ? dropMintSelectionLabel(getFrontendDrop(item.dropId), item.boxId ?? item.dudeId)
          : '';
        const handleActivate = (target: HTMLElement) => {
          activateInventoryItem(item, interaction, target, {
            onToggle,
            onReveal,
            onViewItem,
          });
        };
        const handleClick = canInteract
          ? (evt: MouseEvent<HTMLElement>) => {
              const suppressedClick = suppressedMobileClickRef.current;
              if (suppressedClick) {
                if (suppressedClick.expiresAt <= Date.now()) {
                  suppressedMobileClickRef.current = null;
                } else if (suppressedClick.itemId === item.id) {
                  evt.preventDefault();
                  evt.stopPropagation();
                  suppressedMobileClickRef.current = null;
                  return;
                }
              }
              handleActivate(evt.currentTarget);
            }
          : undefined;
        return (
          <article
            key={item.id}
            data-inventory-id={item.id}
            className={[
              'inventory__item',
              item.kind === 'box' ? 'inventory__item--box' : '',
              canSelect ? 'inventory__item--selectable' : '',
              revealEnabled ? 'inventory__item--revealable' : '',
              viewEnabled ? 'inventory__item--viewable' : '',
              isSelected ? 'inventory__item--selected' : '',
              hasFooter ? 'inventory__item--hasFooter' : '',
              isPendingReveal ? 'inventory__item--pending' : '',
              isReceipt ? 'inventory__item--receipt' : '',
              isInteractiveCardFigure ? 'inventory__item--interactive-card-figure' : '',
              itemClassName || '',
            ]
              .filter(Boolean)
              .join(' ')}
            onClick={handleClick}
            role={canInteract ? 'button' : undefined}
            tabIndex={canInteract ? 0 : undefined}
            draggable={false}
            onDragStart={(evt) => evt.preventDefault()}
            aria-pressed={canSelect ? isSelected : undefined}
            aria-label={viewEnabled ? `View ${item.name}` : undefined}
            onKeyDown={
              canSelect || revealEnabled || viewEnabled
                ? (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleActivate(e.currentTarget as HTMLElement);
                    }
                  }
                : undefined
            }
          >
            <div className="inventory__media">
              <InventoryMedia item={item} figureMediaMode={figureMediaMode} />
            </div>
            {sizeLabel && isSelected ? (
              <span className="inventory__size-badge" aria-label={`Size ${sizeLabel}`}>
                {sizeLabel}
              </span>
            ) : null}
            {hasFooter ? (
              <div className="inventory__body">
                {!isPendingReveal && item.assignedDudes?.length ? (
                  <p className="muted">
                    Contains {dropAssetCount(getFrontendDrop(item.dropId), 'figure', item.assignedDudes.length)}
                  </p>
                ) : null}
              </div>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}
