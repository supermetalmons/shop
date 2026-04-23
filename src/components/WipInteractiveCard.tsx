import DrifEffectCard from './DrifEffectCard';
import type { DrifCardConfig } from '../drifCards';

export default function WipInteractiveCard({
  card,
  interactive = true,
  loadingImageSrc,
  onImageReadyChange,
  wakeOnInteractiveUnlock = true,
}: {
  card: DrifCardConfig;
  interactive?: boolean;
  loadingImageSrc?: string;
  onImageReadyChange?: (ready: boolean) => void;
  wakeOnInteractiveUnlock?: boolean;
}) {
  return (
    <DrifEffectCard
      card={card}
      ariaLabel="Revealed Poncho Drifella card"
      imageAlt="Revealed Poncho Drifella card"
      loadingImageSrc={loadingImageSrc}
      onImageReadyChange={onImageReadyChange}
      disableGlow
      enableInteractiveUnlockWake={wakeOnInteractiveUnlock}
      interactive={interactive}
      imageLoading="eager"
    />
  );
}
