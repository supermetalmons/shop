import {
  useCallback,
  useEffect,
  useRef,
  useState
} from 'react';
import { ColorSchemeImage } from '../../components/ColorSchemeImage';
import {
  isDropFamily
} from '../../config/deployment';
import {
  normalizeBoxDisplayImage
} from '../../lib/dropContent';
import {
  loadFigureMetadata,
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
  const { dropId, figureId, alt, primarySrc, fallbackSrc, onMetadataResolved } = props;
  const [activeSrc, setActiveSrc] = useState<string | null>(() => primarySrc || fallbackSrc || null);
  const [usingFallback, setUsingFallback] = useState(() => !primarySrc && Boolean(fallbackSrc));
  const requestIdRef = useRef(0);

  useEffect(() => {
    requestIdRef.current += 1;
    if (primarySrc) {
      setActiveSrc(primarySrc);
      setUsingFallback(false);
      return;
    }
    if (fallbackSrc) {
      setActiveSrc(fallbackSrc);
      setUsingFallback(true);
      return;
    }
    setActiveSrc(null);
    setUsingFallback(false);
  }, [dropId, figureId, primarySrc]);

  useEffect(() => {
    if (!fallbackSrc) return;
    setActiveSrc((current) => (current ? current : fallbackSrc));
    setUsingFallback((current) => current || !primarySrc);
  }, [fallbackSrc, primarySrc]);

  useEffect(
    () => () => {
      requestIdRef.current += 1;
    },
    [],
  );

  const handleError = useCallback(() => {
    if (usingFallback) {
      setActiveSrc(null);
      return;
    }
    if (fallbackSrc && fallbackSrc !== primarySrc) {
      setActiveSrc(fallbackSrc);
      setUsingFallback(true);
      return;
    }
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setActiveSrc(null);
    void loadFigureMetadata(dropId, figureId)
      .then((record) => {
        if (requestIdRef.current !== requestId || !record?.image || record.image === primarySrc) return;
        onMetadataResolved?.(record);
        setActiveSrc(record.image);
        setUsingFallback(true);
      })
      .catch(() => {
        if (requestIdRef.current !== requestId) return;
        setActiveSrc(null);
      });
  }, [dropId, fallbackSrc, figureId, onMetadataResolved, primarySrc, usingFallback]);

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
