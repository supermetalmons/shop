import type { RefObject } from 'react';
import type { InventoryItem } from '../../types';
import type { PendingSubmittedClaimTransaction } from '../../lib/pendingPreparedTransactions';
import type { DeferredOverlayActionKind } from '../../lib/deferredOverlayActions';
import type { FrontendDeploymentConfig } from '../../config/deployment';
import type { ReceiptViewerSource } from '../reveal/types';
import { buildClaimedReceiptPreviewItems, loadClaimedReceiptImage, normalizeClaimedReceiptIds } from './claims';
import type { CommerceInventoryRefresh } from './contracts';

type ClaimPresentationOptions = {
  requireKnownDropConfig: (dropId: string | undefined, context: string) => FrontendDeploymentConfig;
  connectedWalletRef: RefObject<string | null>;
  ownerRef: RefObject<string | undefined>;
  claimOpen: boolean;
  claimModalGenerationRef: RefObject<number>;
  closeClaimModal: () => void;
  inventory: InventoryItem[];
  refetchInventory: CommerceInventoryRefresh;
  queueOverlayAction: (run: () => void, kind?: DeferredOverlayActionKind) => void;
  openReceiptImageViewerGroup: (
    items: readonly ReceiptViewerSource[],
    originRect: null,
    options?: { inventorySnapshot?: InventoryItem[]; allowPlaceholders?: boolean },
  ) => boolean;
};

export function useClaimPresentation({
  requireKnownDropConfig,
  connectedWalletRef,
  ownerRef,
  claimOpen,
  claimModalGenerationRef,
  closeClaimModal,
  inventory,
  refetchInventory,
  queueOverlayAction,
  openReceiptImageViewerGroup,
}: ClaimPresentationOptions) {
  function presentConfirmedNumericClaim(
    record: PendingSubmittedClaimTransaction,
    previousReceiptIds: ReadonlySet<string> = new Set(),
    uiIsCurrent: () => boolean = () => connectedWalletRef.current === record.wallet,
  ) {
    const claimDrop = requireKnownDropConfig(record.dropId, 'pending claim');
    const claimedFigureIds = normalizeClaimedReceiptIds(record.certificates);
    const canPresent = (
      connectedWalletRef.current === record.wallet &&
      ownerRef.current === record.wallet &&
      uiIsCurrent()
    );
    if (canPresent && claimOpen) closeClaimModal();
    const previewGeneration = claimModalGenerationRef.current;
    const claimPreviewIsCurrent = () => (
      canPresent &&
      connectedWalletRef.current === record.wallet &&
      ownerRef.current === record.wallet &&
      claimModalGenerationRef.current === previewGeneration
    );

    let opened = false;
    const openClaimedReceiptPreview = (
      previewItems: readonly ReceiptViewerSource[],
      snapshot: InventoryItem[],
      options?: { allowPlaceholders?: boolean },
    ) => {
      if (!claimPreviewIsCurrent()) return;
      if (opened) return;
      if (!previewItems.length) return;
      if (!options?.allowPlaceholders && previewItems.some((item) => !item.image)) return;
      queueOverlayAction(() => {
        if (!claimPreviewIsCurrent() || opened) return;
        opened = openReceiptImageViewerGroup(previewItems, null, {
          inventorySnapshot: snapshot,
          allowPlaceholders: options?.allowPlaceholders,
        });
      }, 'presentation');
    };

    const initialPreviewItems = buildClaimedReceiptPreviewItems(
      inventory,
      claimDrop.dropId,
      claimedFigureIds,
      previousReceiptIds,
      record.certificateId,
    );
    openClaimedReceiptPreview(initialPreviewItems, inventory);

    const missingFallbackFigureIds = claimedFigureIds.filter((_, index) => !initialPreviewItems[index]?.image);
    if (missingFallbackFigureIds.length && !opened) {
      void Promise.all(
        missingFallbackFigureIds.map(async (figureId): Promise<[number, string | undefined]> => [
          figureId,
          await loadClaimedReceiptImage(claimDrop.dropId, figureId),
        ]),
      )
        .then((entries) => {
          const fallbackImages = new Map(
            entries.filter((entry): entry is [number, string] => Boolean(entry[1])),
          );
          openClaimedReceiptPreview(
            buildClaimedReceiptPreviewItems(
              inventory,
              claimDrop.dropId,
              claimedFigureIds,
              previousReceiptIds,
              record.certificateId,
              fallbackImages,
            ),
            inventory,
            { allowPlaceholders: true },
          );
        })
        .catch(() => undefined);
    }

    void refetchInventory()
      .then((result) => {
        const refreshedInventory = result.data ?? inventory;
        openClaimedReceiptPreview(
          buildClaimedReceiptPreviewItems(
            refreshedInventory,
            claimDrop.dropId,
            claimedFigureIds,
            previousReceiptIds,
            record.certificateId,
          ),
          refreshedInventory,
        );
      })
      .catch((err) => {
        console.warn('[mons] failed to refresh inventory after claim', err);
      });

    return {
      itemsPerBox: claimDrop.itemsPerBox,
      boxNamePrefix: claimDrop.namePrefix,
      figureNamePrefix: claimDrop.figureNamePrefix,
      deferred: true,
    };
  }

  return presentConfirmedNumericClaim;
}
