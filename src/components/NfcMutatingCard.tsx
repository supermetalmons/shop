import { useCallback, useRef } from 'react';
import { useNfcCardImagesReady } from '../hooks/useNfcCardImagesReady';

const FRAME_URLS = [
  'https://wip.lil.org/mutating_card_0.webp',
  'https://wip.lil.org/mutating_card_1.webp',
  'https://wip.lil.org/mutating_card_2.webp',
];

export function NfcMutatingCard({ alt, width, height }: { alt: string; width: number; height: number }) {
  const imagesRef = useRef<Array<HTMLImageElement | null>>([]);
  const getImages = useCallback(() => imagesRef.current, []);
  const ready = useNfcCardImagesReady(getImages);

  return (
    <div className={`nfc-mutating-card${ready ? ' nfc-mutating-card--ready' : ''}`} style={{ aspectRatio: `${width} / ${height}` }}>
      {FRAME_URLS.map((src, index) => (
        <img
          key={src}
          ref={(image) => { imagesRef.current[index] = image; }}
          className="nfc-mutating-card__frame"
          src={src}
          alt={index === 0 ? alt : ''}
          aria-hidden={index === 0 ? undefined : true}
          width={width}
          height={height}
          style={{ aspectRatio: `${width} / ${height}`, opacity: index === 0 ? 1 : 0 }}
          decoding="async"
          loading="eager"
          draggable={false}
        />
      ))}
    </div>
  );
}
