import { useEffect, useState } from 'react';

export function useNfcCardImagesReady(
  getImages: () => readonly (HTMLImageElement | null)[],
  { allowLoadedFallback = false }: { allowLoadedFallback?: boolean } = {},
): boolean {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let active = true;
    const cleanups: Array<() => void> = [];

    const imagePromises = getImages().map((image) => new Promise<void>((resolve, reject) => {
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
      if (active && image?.decode) {
        try {
          await image.decode();
        } catch (error) {
          if (!allowLoadedFallback || !image.complete || image.naturalWidth === 0) throw error;
        }
      }
    }));

    void Promise.all(imagePromises).then(() => {
      if (active) setReady(true);
    }).catch(() => {
      cleanups.forEach((cleanup) => cleanup());
    });

    return () => {
      active = false;
      cleanups.forEach((cleanup) => cleanup());
    };
  }, [getImages, allowLoadedFallback]);

  return ready;
}
