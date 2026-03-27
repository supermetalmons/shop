import DrifEffectCard from './DrifEffectCard';
import type { DrifCardConfig } from '../drifCards';

export default function WipInteractiveCard({ card }: { card: DrifCardConfig }) {
  return (
    <DrifEffectCard
      card={card}
      ariaLabel="Revealed Poncho Drifella card"
      imageAlt="Revealed Poncho Drifella card"
    />
  );
}
