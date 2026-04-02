import DrifEffectCard from './DrifEffectCard';
import type { DrifCardConfig } from '../drifCards';

export default function WipInteractiveCard({
  card,
  interactive = true,
  onImageReadyChange,
}: {
  card: DrifCardConfig;
  interactive?: boolean;
  onImageReadyChange?: (ready: boolean) => void;
}) {
  return (
    <DrifEffectCard
      card={card}
      ariaLabel="Revealed Poncho Drifella card"
      imageAlt="Revealed Poncho Drifella card"
      onImageReadyChange={onImageReadyChange}
      disableGlow
      interactive={interactive}
      imageLoading="eager"
    />
  );
}
