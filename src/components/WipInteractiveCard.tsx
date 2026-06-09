import DrifEffectCard from './DrifEffectCard';
import type { DrifCardConfig } from '../drifCards';

export default function WipInteractiveCard({
  card,
  interactive = true,
  loadingImageSrc,
  onImageReadyChange,
  wakeOnInteractiveUnlock = true,
  ariaLabel = 'Revealed card',
  imageAlt = 'Revealed card',
}: {
  card: DrifCardConfig;
  interactive?: boolean;
  loadingImageSrc?: string;
  onImageReadyChange?: (ready: boolean) => void;
  wakeOnInteractiveUnlock?: boolean;
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
      imageLoading="eager"
    />
  );
}
