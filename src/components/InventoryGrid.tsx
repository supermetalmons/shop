import { useEffect, useRef, useState, type MouseEvent } from 'react';
import type { InventoryItem, InventoryPreviewVideo } from '../types';
import { getFrontendDrop, isDropFamily } from '../config/deployment';
import { dropAssetCount, dropMintSelectionLabel } from '../lib/dropLabels';
import { hideImageShowFallback, showImageHideFallback } from '../lib/imageFallback';
import { getInventoryRevealRect } from '../lib/inventoryMediaRect';
import { playMutedAutoplayVideo } from '../lib/autoplayVideo';

interface InventoryGridProps {
  items: InventoryItem[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  itemClassName?: string;
  className?: string;
  pendingRevealIds?: Set<string>;
  onReveal?: (id: string, rect: DOMRect) => void;
  onViewItem?: (item: InventoryItem, rect: DOMRect) => void;
  canRevealItem?: (item: InventoryItem) => boolean;
  revealLoadingId?: string | null;
  revealDisabled?: boolean;
  emptyStateVisibility?: 'visible' | 'hidden' | 'none';
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

function InventoryMedia({ item }: { item: InventoryItem }) {
  const isFigure = item.kind === 'dude';
  const previewVideo = item.previewVideo;
  const [figureImageFailed, setFigureImageFailed] = useState(false);

  useEffect(() => {
    setFigureImageFailed(false);
  }, [item.image]);

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

  return (
    <>
      <img
        className="inventory__image"
        src={item.image}
        alt={item.name}
        loading="lazy"
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

export function InventoryGrid({
  items,
  selected,
  onToggle,
  itemClassName,
  className,
  pendingRevealIds,
  onReveal,
  onViewItem,
  canRevealItem,
  revealLoadingId,
  revealDisabled,
  emptyStateVisibility = 'visible',
}: InventoryGridProps) {
  const getRevealRect = (target: HTMLElement) => getInventoryRevealRect(target);

  if (!items.length) {
    if (emptyStateVisibility === 'none') return null;
    const isHidden = emptyStateVisibility === 'hidden';
    return (
      <div className={`muted small${isHidden ? ' empty-state--hidden' : ''}`} aria-hidden={isHidden}>
        No items yet.
      </div>
    );
  }

  const gridClassName = ['inventory', className].filter(Boolean).join(' ');

  return (
    <div className={gridClassName}>
      {items.map((item) => {
        const isReceipt = item.kind === 'certificate';
        const isPendingReveal = pendingRevealIds?.has(item.id) ?? false;
        const isPendingLocal = item.status === 'pending';
        const canSelect = !isReceipt && !isPendingReveal && !isPendingLocal;
        const isSelected = canSelect ? selected.has(item.id) : false;
        const canReveal = Boolean(isPendingReveal && onReveal && (canRevealItem ? canRevealItem(item) : true));
        const isRevealing = revealLoadingId === item.id;
        const revealEnabled = canReveal && selected.size === 0 && !revealDisabled && !isRevealing;
        const viewEnabled = Boolean(!canSelect && !revealEnabled && onViewItem);
        const hasFooter = Boolean(item.assignedDudes?.length);
        const canInteract = canSelect || revealEnabled || viewEnabled;
        const isInteractiveCardFigure = item.kind === 'dude' && isDropFamily(item.dropId, 'card_nft_2');
        const sizeLabel = dropMintSelectionLabel(getFrontendDrop(item.dropId), item.boxId ?? item.dudeId);
        const handleClick = canSelect
          ? () => onToggle(item.id)
          : revealEnabled
            ? (evt: MouseEvent<HTMLElement>) => {
                onReveal?.(item.id, getRevealRect(evt.currentTarget));
              }
            : viewEnabled
              ? (evt: MouseEvent<HTMLElement>) => {
                  onViewItem?.(item, getRevealRect(evt.currentTarget));
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
                      if (canSelect) {
                        onToggle(item.id);
                      } else if (revealEnabled && onReveal) {
                        onReveal(item.id, getRevealRect(e.currentTarget as HTMLElement));
                      } else if (viewEnabled && onViewItem) {
                        onViewItem(item, getRevealRect(e.currentTarget as HTMLElement));
                      }
                    }
                  }
                : undefined
            }
          >
            <div className="inventory__media">
              <InventoryMedia item={item} />
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
                <div className="inventory__actions" />
              </div>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}
