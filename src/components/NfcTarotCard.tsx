import { useCallback, useRef, useState, type RefObject } from 'react';
import { useNfcCardImagesReady } from '../hooks/useNfcCardImagesReady';

const layerGroups = [
  { category: 'objects', ids: [1, 6, 7, 10] },
  { category: 'full-size', ids: [3, 4, 5] },
  { category: 'particles', ids: [2, 8, 9] },
];

function selectLayers() {
  return layerGroups.map(({ category, ids }) => ({
    category,
    id: ids[Math.floor(Math.random() * ids.length)],
  }));
}

type HeroRef = RefObject<HTMLImageElement | null>;

function TarotLayers({ layers, heroRef }: { layers: ReturnType<typeof selectLayers>; heroRef: HeroRef }) {
  const imagesRef = useRef<Array<HTMLImageElement | null>>([]);
  const getImages = useCallback(() => [heroRef.current, ...imagesRef.current], [heroRef]);
  const ready = useNfcCardImagesReady(getImages);

  return (
    <div className="nfc-tarot-layers" data-ready={ready} aria-hidden="true">
      {layers.map(({ category, id }, index) => (
        <img key={category} ref={image => { imagesRef.current[index] = image; }}
          data-layer={category} src={`https://wip.lil.org/tarot/layers/${id}.webp`}
          alt="" loading="eager" decoding="async" draggable={false} referrerPolicy="no-referrer" />
      ))}
    </div>
  );
}

export function NfcTarotCard({ tokenId, heroRef, animate }: { tokenId: number; heroRef: HeroRef; animate: boolean }) {
  const [layers] = useState(selectLayers);
  return (
    <div className="nfc-tarot-card-stack">
      {animate && <TarotLayers layers={layers} heroRef={heroRef} />}
      <img ref={heroRef} className="nfc-tarot-card" src={`https://wip.lil.org/tarot/heros/${tokenId}.webp`}
        alt="Mutating Card" width={1008} height={1600} loading="eager" fetchPriority="high"
        decoding="async" draggable={false} referrerPolicy="no-referrer" />
    </div>
  );
}
