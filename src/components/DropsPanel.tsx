import type { CSSProperties, MouseEvent } from 'react';
import { navigate } from '../navigation';
import { mintPanelPreviewImage, resolveDropContent } from '../lib/dropContent';
import { dropPath, listUpcomingDropRoutes, resolveUpcomingRouteDrop } from '../lib/dropConfig';

const lsbImage = mintPanelPreviewImage('little_swag_boxes');
const ponchoImage = mintPanelPreviewImage('poncho_drifella');
const upcomingDropRoutes = listUpcomingDropRoutes();

function resolveUpcomingTileSource(dropId: string, fallbackTitle: string) {
  const path = dropPath(dropId);
  const route = upcomingDropRoutes.find((candidate) => candidate.path === path);
  const liveDrop = resolveUpcomingRouteDrop(route);
  const previewDropId = liveDrop?.dropId || route?.previewDropId || dropId;
  const dropContent = previewDropId ? resolveDropContent(previewDropId) : undefined;

  return {
    image: dropContent?.mintPanel.previewImageUrl || dropContent?.box.previewImageUrl || route?.previewImageUrl,
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
  alt: string;
  title: string;
  path: string;
  background?: string;
  titleColor?: string;
  imageMaxWidth?: string;
  imageMaxHeight?: string;
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
  '--drops-panel-image-x'?: string;
  '--drops-panel-image-y'?: string;
  '--drops-panel-image-scale'?: string;
  '--drops-panel-compact-image-scale'?: string;
  '--drops-panel-image-gap'?: string;
  '--drops-panel-compact-image-gap'?: string;
  '--drops-panel-image-bottom-space'?: string;
  '--drops-panel-compact-image-bottom-space'?: string;
};

function dropPanelTileStyle(item: DropPanelItem): DropPanelTileStyle {
  return {
    '--drops-panel-tile-bg': item.background,
    '--drops-panel-title-color': item.titleColor,
    '--drops-panel-image-max-width': item.imageMaxWidth,
    '--drops-panel-image-max-height': item.imageMaxHeight,
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

function DropPanelTile({ item }: { item: DropPanelItem }) {
  const handleClick = (evt: MouseEvent<HTMLAnchorElement>) => {
    if (evt.defaultPrevented || evt.button !== 0 || evt.metaKey || evt.altKey || evt.ctrlKey || evt.shiftKey) {
      return;
    }

    evt.preventDefault();
    navigate(item.path);
    window.scrollTo({ top: 0, left: 0 });
  };

  return (
    <a
      className={`drops-panel__tile drops-panel__tile--${item.size}`}
      href={item.path}
      aria-label={item.title}
      draggable={false}
      style={dropPanelTileStyle(item)}
      onClick={handleClick}
      onDragStart={(evt) => evt.preventDefault()}
    >
      <span className="drops-panel__title">{item.title}</span>
      <span className="drops-panel__image-stage">
        {item.image ? (
          <img
            className="drops-panel__image"
            src={item.image}
            alt={item.alt}
            draggable={false}
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
      alt: cardNft2.alt,
      title: cardNft2.title,
      path: cardNft2.path,
      background: '#f5f5f7',
      titleColor: '#1d1d1f',
      imageMaxWidth: '62%',
      imageMaxHeight: 'clamp(160px, 23.5cqw, 236px)',
      imageScale: 0.98,
      imageGap: 'clamp(40px, 4.8cqw, 52px)',
      compactImageGap: 'clamp(18px, 5cqw, 26px)',
      imageBottomSpace: 'clamp(30px, 3.8cqw, 42px)',
      compactImageBottomSpace: 'clamp(18px, 5cqw, 24px)',
    },
    {
      key: 'little_swag_boxes',
      size: 'half',
      image: lsbImage,
      alt: 'Little Swag Boxes',
      title: 'Little Swag Boxes',
      path: dropPath('little_swag_boxes'),
      background: '#f5f5f7',
      titleColor: '#1d1d1f',
      imageMaxWidth: '88%',
      imageMaxHeight: 'clamp(120px, 20cqw, 200px)',
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
      alt: 'Poncho Drifella',
      title: 'Poncho Drifella',
      path: dropPath('poncho_drifella'),
      background: '#050505',
      titleColor: '#f5f5f7',
      imageMaxWidth: '78%',
      imageMaxHeight: 'clamp(145px, 23cqw, 220px)',
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
      alt: littleSwagHoodies.alt,
      title: littleSwagHoodies.title,
      path: littleSwagHoodies.path,
      background: '#f5f5f7',
      titleColor: '#1d1d1f',
      imageMaxWidth: '82%',
      imageMaxHeight: 'clamp(150px, 24cqw, 240px)',
      imageScale: 1.04,
      compactImageScale: 1,
      imageGap: 'clamp(24px, 3.2cqw, 36px)',
      compactImageGap: 'clamp(14px, 4.4cqw, 22px)',
      imageBottomSpace: 'clamp(28px, 3.4cqw, 38px)',
      compactImageBottomSpace: 'clamp(18px, 5cqw, 26px)',
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
