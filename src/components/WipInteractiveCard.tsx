import DrifEffectCard, { type DrifEffectCardInteractionMode } from './DrifEffectCard';
import type { DrifCardConfig } from '../drifCards';

export default function WipInteractiveCard({
  card,
  interactive = true,
  loadingImageSrc,
  onActivate,
  onImageReadyChange,
  wakeOnInteractiveUnlock = true,
  showEffectAtRest = false,
  interactionMode = 'normal',
  ariaLabel = 'Revealed card',
  imageAlt = 'Revealed card',
}: {
  card: DrifCardConfig;
  interactive?: boolean;
  loadingImageSrc?: string;
  onActivate?: () => void;
  onImageReadyChange?: (ready: boolean) => void;
  wakeOnInteractiveUnlock?: boolean;
  showEffectAtRest?: boolean;
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
      onActivate={onActivate}
      onImageReadyChange={onImageReadyChange}
      disableGlow
      enableInteractiveUnlockWake={wakeOnInteractiveUnlock}
      showEffectAtRest={showEffectAtRest}
      interactive={interactive}
      interactionMode={interactionMode}
      imageLoading="eager"
    />
  );
}
