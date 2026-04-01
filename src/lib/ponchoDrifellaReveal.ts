import { DRIF_CARDS, getDrifCardByFigureId, type DrifCardConfig } from '../drifCards';

const PONCHO_DRIFELLA_PACK_FRAME_IDS = [1, 48, 59, 69, 80, 86, 89, 90, 92, 95, 96, 99, 102] as const;
const PONCHO_DRIFELLA_PACK_SEQUENCE_BASE_URL = '/Poncho_Drifella/pack/sequence_0';

export const PONCHO_DRIFELLA_BOX_SOUND_REVEAL_URL = '/Poncho_Drifella/sounds/crash.mp3';
export const PONCHO_DRIFELLA_BOX_SOUND_CLICK_URL = '/Poncho_Drifella/sounds/hit.mp3';

export const PONCHO_DRIFELLA_PACK_FRAME_URLS = PONCHO_DRIFELLA_PACK_FRAME_IDS.map(
  (frameId) => `${PONCHO_DRIFELLA_PACK_SEQUENCE_BASE_URL}/1_${String(frameId).padStart(4, '0')}.webp`,
);

export const PONCHO_DRIFELLA_REVEAL_FRAME_SEQUENCE = Object.freeze({
  frames: [...PONCHO_DRIFELLA_PACK_FRAME_URLS],
  frameCount: PONCHO_DRIFELLA_PACK_FRAME_URLS.length,
  clickMax: 8,
  autoplayStart: 9,
  mediaStart: PONCHO_DRIFELLA_PACK_FRAME_URLS.length,
});

export function getPonchoDrifellaCardByFigureId(figureId: number): DrifCardConfig | undefined {
  return getDrifCardByFigureId(figureId);
}

export function preloadPonchoDrifellaImage(
  imageSrc: string | undefined,
  loadedImages: Set<string>,
  pendingImages: Map<string, HTMLImageElement>,
) {
  const normalizedImageSrc = String(imageSrc || '').trim();
  if (!normalizedImageSrc || loadedImages.has(normalizedImageSrc)) return;
  const img = new Image();
  img.decoding = 'async';
  img.onload = () => {
    pendingImages.delete(normalizedImageSrc);
  };
  img.onerror = () => {
    pendingImages.delete(normalizedImageSrc);
    loadedImages.delete(normalizedImageSrc);
  };
  pendingImages.set(normalizedImageSrc, img);
  loadedImages.add(normalizedImageSrc);
  img.src = normalizedImageSrc;
}

export function preloadPonchoDrifellaCardAssets(
  card: DrifCardConfig | undefined,
  loadedImages: Set<string>,
  pendingImages: Map<string, HTMLImageElement>,
) {
  if (!card) return;
  preloadPonchoDrifellaImage(card.imageSrc, loadedImages, pendingImages);
  preloadPonchoDrifellaImage(card.textureSrc, loadedImages, pendingImages);
  preloadPonchoDrifellaImage(card.foilSrc, loadedImages, pendingImages);
}
