import DrifEffectCard, { type DrifEffectCardInteractionMode } from './DrifEffectCard';
import type { DrifCardConfig } from '../drifCards';

export default function WipInteractiveCard({
  card,
  interactive = true,
  loadingImageSrc,
  onImageReadyChange,
  wakeOnInteractiveUnlock = true,
  interactionMode = 'normal',
  ariaLabel = 'Revealed card',
  imageAlt = 'Revealed card',
}: {
  card: DrifCardConfig;
  interactive?: boolean;
  loadingImageSrc?: string;
  onImageReadyChange?: (ready: boolean) => void;
  wakeOnInteractiveUnlock?: boolean;
  interactionMode?: DrifEffectCardInteractionMode;
  ariaLabel?: string;
  imageAlt?: string;
}) {
  return (
    <DrifEffectCard
      card={card}
      ariaLabel={ariaLabel}
      imageAlt={imageAlt}
      loadingImageSrc={loadingImageSrc}
      onImageReadyChange={onImageReadyChange}
      disableGlow
      enableInteractiveUnlockWake={wakeOnInteractiveUnlock}
      interactive={interactive}
      interactionMode={interactionMode}
      imageLoading="eager"
    />
  );
}
