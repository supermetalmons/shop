import type { CSSProperties, MouseEvent } from 'react';
import { navigate } from '../navigation';
import { CARD_NFT_2_PACK_IMAGE_DIMENSIONS_BY_SRC, CARD_NFT_2_PACK_IMAGE_SRCS } from '../lib/cardNft2Packs';
import { mintPanelPreviewAspectRatio, mintPanelPreviewImage, resolveDropContent } from '../lib/dropContent';
import { dropPath, listUpcomingDropRoutes, resolveUpcomingRouteDrop } from '../lib/dropConfig';

type DropPanelImageDimensions = {
  width: number;
  height: number;
};

const lsbImage = mintPanelPreviewImage('little_swag_boxes');
const lsbImageDimensions = imageDimensionsForAspectRatio(mintPanelPreviewAspectRatio('little_swag_boxes'));
const ponchoImage = mintPanelPreviewImage('poncho_drifella');
const ponchoImageDimensions = imageDimensionsForAspectRatio(mintPanelPreviewAspectRatio('poncho_drifella'));
const CARD_NFT_2_PACK_TILE_COUNT = 3;
const upcomingDropRoutes = listUpcomingDropRoutes();

function imageDimensionsForAspectRatio(aspectRatio: number, height = 1000): DropPanelImageDimensions | undefined {
  if (!Number.isFinite(aspectRatio) || aspectRatio <= 0) return undefined;

  return {
    width: Math.round(aspectRatio * height),
    height,
  };
}

function randomPackSelection(images: string[], count: number): string[] {
  const shuffled = images.slice();

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }

  return shuffled.slice(0, Math.max(0, Math.min(count, shuffled.length)));
}

const cardNft2PackImages = randomPackSelection(CARD_NFT_2_PACK_IMAGE_SRCS, CARD_NFT_2_PACK_TILE_COUNT);

function resolveUpcomingTileSource(dropId: string, fallbackTitle: string) {
  const path = dropPath(dropId);
  const route = upcomingDropRoutes.find((candidate) => candidate.path === path);
  const liveDrop = resolveUpcomingRouteDrop(route);
  const previewDropId = liveDrop?.dropId || route?.previewDropId || dropId;
  const dropContent = previewDropId ? resolveDropContent(previewDropId) : undefined;
  const image = dropContent?.mintPanel.previewImageUrl || dropContent?.box.previewImageUrl || route?.previewImageUrl;
  const aspectRatio = dropContent?.mintPanel.previewImageUrl
    ? dropContent.mintPanel.aspectRatio
    : dropContent?.box.previewImageUrl
      ? dropContent.box.aspectRatio
      : route?.previewAspectRatio;

  return {
    image,
    imageDimensions: imageDimensionsForAspectRatio(aspectRatio || 0),
    alt: route?.label || fallbackTitle,
    title: route?.label || fallbackTitle,
    path: liveDrop?.dropId ? dropPath(liveDrop.dropId) : route?.path || path,
  };
}

type DropPanelTileSize = 'full' | 'half';

type DropPanelItem = {
  key: string;
  size: DropPanelTileSize;
  image?: string;
  imageDimensions?: DropPanelImageDimensions;
  images?: string[];
  imageDimensionsBySrc?: Record<string, DropPanelImageDimensions>;
  alt: string;
  title: string;
  path: string;
  background?: string;
  titleColor?: string;
  imageMaxWidth?: string;
  imageMaxHeight?: string;
  compactImageMaxHeight?: string;
  imageOffsetX?: string;
  imageOffsetY?: string;
  imageScale?: number;
  compactImageScale?: number;
  imageGap?: string;
  compactImageGap?: string;
  imageBottomSpace?: string;
  compactImageBottomSpace?: string;
};

type DropPanelTileStyle = CSSProperties & {
  '--drops-panel-tile-bg'?: string;
  '--drops-panel-title-color'?: string;
  '--drops-panel-image-max-width'?: string;
  '--drops-panel-image-max-height'?: string;
  '--drops-panel-compact-image-max-height'?: string;
  '--drops-panel-image-x'?: string;
  '--drops-panel-image-y'?: string;
  '--drops-panel-image-scale'?: string;
  '--drops-panel-compact-image-scale'?: string;
  '--drops-panel-image-gap'?: string;
  '--drops-panel-compact-image-gap'?: string;
  '--drops-panel-image-bottom-space'?: string;
  '--drops-panel-compact-image-bottom-space'?: string;
};

type DropPanelPackFrameStyle = CSSProperties & {
  '--drops-panel-pack-aspect-ratio'?: string;
};

function imageAspectRatio(dimensions: DropPanelImageDimensions | undefined): string | undefined {
  if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) return undefined;

  return `${dimensions.width} / ${dimensions.height}`;
}

function dropPanelTileStyle(item: DropPanelItem): DropPanelTileStyle {
  return {
    '--drops-panel-tile-bg': item.background,
    '--drops-panel-title-color': item.titleColor,
    '--drops-panel-image-max-width': item.imageMaxWidth,
    '--drops-panel-image-max-height': item.imageMaxHeight,
    '--drops-panel-compact-image-max-height': item.compactImageMaxHeight,
    '--drops-panel-image-x': item.imageOffsetX,
    '--drops-panel-image-y': item.imageOffsetY,
    '--drops-panel-image-scale': item.imageScale ? String(item.imageScale) : undefined,
    '--drops-panel-compact-image-scale': item.compactImageScale ? String(item.compactImageScale) : undefined,
    '--drops-panel-image-gap': item.imageGap,
    '--drops-panel-compact-image-gap': item.compactImageGap,
    '--drops-panel-image-bottom-space': item.imageBottomSpace,
    '--drops-panel-compact-image-bottom-space': item.compactImageBottomSpace,
  };
}

function dropPanelPackFrameStyle(dimensions: DropPanelImageDimensions | undefined): DropPanelPackFrameStyle {
  return {
    '--drops-panel-pack-aspect-ratio': imageAspectRatio(dimensions),
  };
}

function DropPanelTile({ item }: { item: DropPanelItem }) {
  const packImages = item.images || [];
  const hasImagePack = packImages.length > 0;
  const tileClassName = [
    'drops-panel__tile',
    `drops-panel__tile--${item.size}`,
    `drops-panel__tile--${item.key}`,
    hasImagePack ? 'drops-panel__tile--pack' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const handleClick = (evt: MouseEvent<HTMLAnchorElement>) => {
    if (evt.defaultPrevented || evt.button !== 0 || evt.metaKey || evt.altKey || evt.ctrlKey || evt.shiftKey) {
      return;
    }

    evt.preventDefault();
    window.scrollTo({ top: 0, left: 0 });
    navigate(item.path);
  };

  return (
    <a
      className={tileClassName}
      href={item.path}
      aria-label={item.title}
      draggable={false}
      style={dropPanelTileStyle(item)}
      onClick={handleClick}
      onDragStart={(evt) => evt.preventDefault()}
    >
      <span className="drops-panel__title">{item.title}</span>
      <span className="drops-panel__image-stage">
        {hasImagePack ? (
          <span className="drops-panel__image-pack" aria-hidden="true">
            {packImages.map((image) => {
              const dimensions = item.imageDimensionsBySrc?.[image];

              return (
                <span
                  key={image}
                  className="drops-panel__pack-frame"
                  style={dropPanelPackFrameStyle(dimensions)}
                >
                  <img
                    className="drops-panel__image drops-panel__image--pack"
                    src={image}
                    alt=""
                    width={dimensions?.width}
                    height={dimensions?.height}
                    draggable={false}
                    decoding="async"
                    onDragStart={(evt) => evt.preventDefault()}
                  />
                </span>
              );
            })}
          </span>
        ) : item.image ? (
          <img
            className="drops-panel__image"
            src={item.image}
            alt={item.alt}
            width={item.imageDimensions?.width}
            height={item.imageDimensions?.height}
            draggable={false}
            decoding="async"
            onDragStart={(evt) => evt.preventDefault()}
          />
        ) : (
          <span className="drops-panel__image-placeholder" aria-hidden="true" />
        )}
      </span>
    </a>
  );
}

export function DropsPanel() {
  const littleSwagHoodies = resolveUpcomingTileSource('little_swag_hoodies', 'Little Swag Hoodies');
  const cardNft2 = resolveUpcomingTileSource('card_nft_2', 'Card NFT 2');

  const items: DropPanelItem[] = [
    {
      key: 'card_nft_2',
      size: 'full',
      image: cardNft2.image,
      images: cardNft2PackImages,
      imageDimensionsBySrc: CARD_NFT_2_PACK_IMAGE_DIMENSIONS_BY_SRC,
      alt: cardNft2.alt,
      title: cardNft2.title,
      path: cardNft2.path,
      imageMaxWidth: '62%',
      imageMaxHeight: 'clamp(160px, 23.5cqw, 236px)',
      compactImageMaxHeight: 'clamp(160px, 32cqw, 184px)',
      imageScale: 0.98,
      imageGap: 'clamp(28px, 3.3cqw, 38px)',
      compactImageGap: 'clamp(12px, 3.8cqw, 18px)',
      imageBottomSpace: 'clamp(28px, 3.4cqw, 38px)',
      compactImageBottomSpace: 'clamp(14px, 4cqw, 20px)',
    },
    {
      key: 'little_swag_boxes',
      size: 'half',
      image: lsbImage,
      imageDimensions: lsbImageDimensions,
      alt: 'Little Swag Boxes',
      title: 'Little Swag Boxes',
      path: dropPath('little_swag_boxes'),
      imageMaxWidth: '88%',
      imageMaxHeight: 'clamp(140px, 23.5cqw, 230px)',
      compactImageMaxHeight: 'clamp(120px, 28cqw, 150px)',
      imageScale: 1.03,
      compactImageScale: 1,
      imageGap: 'clamp(28px, 3.3cqw, 38px)',
      compactImageGap: 'clamp(12px, 3.8cqw, 18px)',
      imageBottomSpace: 'clamp(28px, 3.4cqw, 38px)',
      compactImageBottomSpace: 'clamp(14px, 4cqw, 20px)',
    },
    {
      key: 'poncho_drifella',
      size: 'half',
      image: ponchoImage,
      imageDimensions: ponchoImageDimensions,
      alt: 'Poncho Drifella',
      title: 'Poncho Drifella',
      path: dropPath('poncho_drifella'),
      imageMaxWidth: '78%',
      imageMaxHeight: 'clamp(160px, 25cqw, 245px)',
      compactImageMaxHeight: 'clamp(145px, 30cqw, 170px)',
      imageScale: 0.92,
      compactImageScale: 0.88,
      imageGap: 'clamp(26px, 3cqw, 34px)',
      compactImageGap: 'clamp(10px, 3cqw, 16px)',
      imageBottomSpace: 'clamp(24px, 3cqw, 34px)',
      compactImageBottomSpace: 'clamp(14px, 4cqw, 20px)',
    },
    {
      key: 'little_swag_hoodies',
      size: 'full',
      image: littleSwagHoodies.image,
      imageDimensions: littleSwagHoodies.imageDimensions,
      alt: littleSwagHoodies.alt,
      title: littleSwagHoodies.title,
      path: littleSwagHoodies.path,
      imageMaxWidth: '82%',
      imageMaxHeight: 'clamp(150px, 24cqw, 240px)',
      compactImageMaxHeight: 'clamp(150px, 32cqw, 180px)',
      imageScale: 1.04,
      compactImageScale: 1,
      imageGap: 'clamp(28px, 3.3cqw, 38px)',
      compactImageGap: 'clamp(12px, 3.8cqw, 18px)',
      imageBottomSpace: 'clamp(28px, 3.4cqw, 38px)',
      compactImageBottomSpace: 'clamp(14px, 4cqw, 20px)',
    },
  ];

  return (
    <section className="drops-panel">
      <div className="drops-panel__grid">
        {items.map((item) => (
          <DropPanelTile
            key={item.key}
            item={item}
          />
        ))}
      </div>
    </section>
  );
}
