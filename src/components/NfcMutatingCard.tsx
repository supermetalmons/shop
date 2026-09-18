import { useEffect, useRef, useState } from 'react';

const FRAME_URLS = [
  'https://wip.lil.org/mutating_card_0.webp',
  'https://wip.lil.org/mutating_card_1.webp',
  'https://wip.lil.org/mutating_card_2.webp',
];

export function NfcMutatingCard({ alt, width, height }: { alt: string; width: number; height: number }) {
  const imagesRef = useRef<Array<HTMLImageElement | null>>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let active = true;
    const cleanups: Array<() => void> = [];

    const framePromises = imagesRef.current.map((image) => new Promise<void>((resolve, reject) => {
      if (!image) {
        reject();
        return;
      }
      const cleanup = () => {
        image.removeEventListener('load', loaded);
        image.removeEventListener('error', failed);
      };
      const loaded = () => {
        cleanup();
        resolve();
      };
      const failed = () => {
        cleanup();
        reject();
      };
      cleanups.push(cleanup);
      image.addEventListener('load', loaded);
      image.addEventListener('error', failed);
      if (image.complete) {
        if (image.naturalWidth > 0) loaded();
        else failed();
      }
    }).then(async () => {
      if (active && image?.decode) await image.decode();
    }));

    void Promise.all(framePromises).then(() => {
      if (!active) return;
      setReady(true);
    }).catch(() => {
      cleanups.forEach((cleanup) => cleanup());
    });

    return () => {
      active = false;
      cleanups.forEach((cleanup) => cleanup());
    };
  }, []);

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
