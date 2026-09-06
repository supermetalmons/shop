import { useFigureImage } from '../../hooks/useFigureImage';
import { ColorSchemeImage } from '../../components/ColorSchemeImage';
import {
  isDropFamily
} from '../../config/deployment';
import {
  normalizeBoxDisplayImage
} from '../../lib/dropContent';
import {
  type FigureMetadataRecord
} from '../../lib/figureMetadata';
import {
  InventoryItem
} from '../../types';

export function moveLittleSwagBoxesFamilyToEnd<T extends { dropId?: string; }>(items: readonly T[]): T[] {
  const leading: T[] = [];
  const trailing: T[] = [];
  const littleSwagFamilyByDropId = new Map<string, boolean>();
  items.forEach((item) => {
    const dropId = item.dropId || '';
    let isLittleSwagFamily = littleSwagFamilyByDropId.get(dropId);
    if (typeof isLittleSwagFamily !== 'boolean') {
      isLittleSwagFamily = isDropFamily(dropId, 'little_swag_boxes');
      littleSwagFamilyByDropId.set(dropId, isLittleSwagFamily);
    }
    if (isLittleSwagFamily) trailing.push(item);
    else leading.push(item);
  });
  return trailing.length ? [...leading, ...trailing] : [...leading];
}

export function FigureTileImage(props: {
  dropId: string;
  figureId: number;
  alt: string;
  primarySrc?: string;
  fallbackSrc?: string;
  onMetadataResolved?: (record: FigureMetadataRecord) => void;
}) {
  const { dropId, alt } = props;
  const { activeSrc, handleError } = useFigureImage(props);

  if (!activeSrc) {
    return <div className="figure-image figure-image--placeholder" aria-hidden="true" />;
  }

  return (
    <ColorSchemeImage
      dropId={dropId}
      src={activeSrc}
      alt={alt}
      loading="lazy"
      className="figure-image"
      draggable={false}
      onDragStart={(evt) => evt.preventDefault()}
      onError={handleError}
    />
  );
}

export function boxDisplayImageForInventoryItem(item: Pick<InventoryItem, 'dropId' | 'image' | 'boxId'>): string | undefined {
  return normalizeBoxDisplayImage({ dropId: item.dropId, imageRaw: item.image, boxId: item.boxId });
}
