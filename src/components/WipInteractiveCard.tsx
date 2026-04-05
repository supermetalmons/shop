import DrifEffectCard from './DrifEffectCard';
import type { DrifCardConfig } from '../drifCards';

export default function WipInteractiveCard({
  card,
  interactive = true,
  loadingImageSrc,
  onImageReadyChange,
}: {
  card: DrifCardConfig;
  interactive?: boolean;
  loadingImageSrc?: string;
  onImageReadyChange?: (ready: boolean) => void;
}) {
  return (
    <DrifEffectCard
      card={card}
      ariaLabel="Revealed Poncho Drifella card"
      imageAlt="Revealed Poncho Drifella card"
      loadingImageSrc={loadingImageSrc}
      onImageReadyChange={onImageReadyChange}
      disableGlow
      enableInteractiveUnlockWake
      interactive={interactive}
      imageLoading="eager"
    />
  );
}
