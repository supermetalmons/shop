import { BodyPortal } from '../../components/BackgroundBlurLayer';
import { SuccessHud } from '../../components/SuccessHud';
import type { useShopFeedback } from './useShopFeedback';

export function ShopStatus({ feedback, suspended, toastAboveModal }: {
  feedback: ReturnType<typeof useShopFeedback>;
  suspended: boolean;
  toastAboveModal: boolean;
}) {
  const { successHudPhase, successAnnouncement, toast, toastVisible } = feedback;
  return (
    <>
      <SuccessHud phase={successHudPhase} announcement={successAnnouncement} />
      {!suspended && toast ? (
        <BodyPortal>
          <div
            className={`toast${toastVisible ? '' : ' toast--hidden'}${toastAboveModal ? ' toast--above-modal' : ''}`}
            role="status"
            aria-live="polite"
          >
            {toast}
          </div>
        </BodyPortal>
      ) : null}
    </>
  );
}
