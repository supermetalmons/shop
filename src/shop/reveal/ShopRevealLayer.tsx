import { BackgroundBlurPortal } from '../../components/BackgroundBlurLayer';
import ClearCardRevealOverlay from '../../components/ClearCardRevealOverlay';
import { InteractiveCardPackRevealOverlay, PonchoCardViewerOverlay } from '../../components/PonchoRevealOverlay';
import { getInteractiveCardPackRevealSequenceForDropId } from '../../lib/interactiveCardPackReveal';
import { ReceiptImageViewerOverlay } from './ReceiptImageViewerOverlay';
import { DefaultRevealOverlay } from './DefaultRevealOverlay';
import type { ReceiptImageViewerOverlayProps } from './types';
import type { ShopRevealController } from './useShopReveal';

export type RevealReceiptControls = Pick<ReceiptImageViewerOverlayProps, 'explorerHref' | 'transfer' | 'adminIrlRedeem'>;

export function ShopRevealLayer({ reveal, suspended: revealOverlaySuspended, receiptControls = {} }: {
  reveal: ShopRevealController;
  suspended: boolean;
  receiptControls?: RevealReceiptControls;
}) {
  const {
    revealOverlay, revealOverlayActive, revealOverlayClosing, revealLoading, suspended,
    handleRevealOverlayDismiss, handleRevealOverlayTransitionEnd,
    handlePonchoOverlayRequestReveal, handlePonchoOverlayPlayClick, handlePonchoOverlayPlayReveal,
    handlePonchoOverlayPlayCardSwipe, handlePonchoOverlayPlayCardSpread, ensureRevealOverlayAdvanceAllowed,
    updateAssetGatedRevealComplete, updateClearCardDismissReady, updatePonchoDismissReady,
  } = reveal;
  const {
    revealOverlayUsesPonchoViewer, revealOverlayUsesReceiptImage,
    revealOverlayCanRenderClearCard3d, revealOverlayCanRenderInteractiveCardPack,
    revealOverlayStyle, interactiveViewerCard, revealOverlayClearCardViewerMode,
    clearCardRevealId, revealOverlayUsesClearCardViewer, interactiveRevealCards,
    revealOverlayContainerLabel,
  } = reveal.presentation;
  const { ponchoImageCacheRef } = reveal.assets;
  const revealOverlayNode = suspended ? null : revealOverlay ? (
    revealOverlayUsesPonchoViewer ? (
      <PonchoCardViewerOverlay
        overlayStyle={revealOverlayStyle}
        active={revealOverlayActive}
        closing={revealOverlayClosing}
        suspended={revealOverlaySuspended}
        ariaLabel={`${revealOverlay.name} viewer`}
        card={interactiveViewerCard}
        loadingImageSrc={revealOverlay.image}
        onDismiss={handleRevealOverlayDismiss}
        onTransitionEnd={handleRevealOverlayTransitionEnd}
      />
    ) : revealOverlayUsesReceiptImage ? (
      <ReceiptImageViewerOverlay
        dropId={revealOverlay.dropId}
        overlayStyle={revealOverlayStyle}
        active={revealOverlayActive}
        closing={revealOverlayClosing}
        suspended={revealOverlaySuspended}
        images={revealOverlay.receiptImages}
        imageSrc={revealOverlay.image}
        alt={revealOverlay.name}
        viewerSize={revealOverlay.imageViewerSize}
        {...receiptControls}
        onDismiss={handleRevealOverlayDismiss}
        onTransitionEnd={handleRevealOverlayTransitionEnd}
      />
    ) : revealOverlayCanRenderClearCard3d ? (
      <ClearCardRevealOverlay
        key={`${revealOverlay.dropId}:${revealOverlay.id}`}
        overlayStyle={revealOverlayStyle}
        active={revealOverlayActive}
        closing={revealOverlayClosing}
        suspended={revealOverlaySuspended}
        viewerMode={revealOverlayClearCardViewerMode}
        phase={revealOverlay.phase}
        cardId={clearCardRevealId}
        loadingImageSrc={revealOverlay.image}
        resetKey={revealOverlay.id}
        boxName={revealOverlay.name}
        onRequestReveal={
          revealOverlayUsesClearCardViewer ? undefined : handlePonchoOverlayRequestReveal
        }
        onPlayHit={
          revealOverlayUsesClearCardViewer ? undefined : handlePonchoOverlayPlayClick
        }
        onPlayBreak={
          revealOverlayUsesClearCardViewer ? undefined : handlePonchoOverlayPlayReveal
        }
        onDismiss={handleRevealOverlayDismiss}
        onTransitionEnd={handleRevealOverlayTransitionEnd}
        onRevealCompleteChange={
          revealOverlayUsesClearCardViewer ? undefined : updateAssetGatedRevealComplete
        }
        onDismissReadyChange={
          revealOverlayUsesClearCardViewer ? undefined : updateClearCardDismissReady
        }
      />
    ) : revealOverlayCanRenderInteractiveCardPack ? (
      <InteractiveCardPackRevealOverlay
        mode="inventory-unbox"
        overlayStyle={revealOverlayStyle}
        active={revealOverlayActive}
        closing={revealOverlayClosing}
        suspended={revealOverlaySuspended}
        phase={revealOverlay.phase}
        cards={interactiveRevealCards}
        cardReady={interactiveRevealCards.length > 0}
        loading={revealLoading === revealOverlay.id}
        boxName={revealOverlay.name}
        boxLabel={revealOverlayContainerLabel}
        imageCache={ponchoImageCacheRef.current}
        packSequence={getInteractiveCardPackRevealSequenceForDropId(revealOverlay.dropId, revealOverlay.packMediaId)}
        cardLabel={reveal.presentation.cardLabel}
        resetKey={revealOverlay.id}
        onRequestReveal={handlePonchoOverlayRequestReveal}
        onPlayClick={handlePonchoOverlayPlayClick}
        onPlayReveal={handlePonchoOverlayPlayReveal}
        onPlayCardSwipe={handlePonchoOverlayPlayCardSwipe}
        onPlayCardSpread={handlePonchoOverlayPlayCardSpread}
        onBeforeAdvance={ensureRevealOverlayAdvanceAllowed}
        onDismiss={handleRevealOverlayDismiss}
        onTransitionEnd={handleRevealOverlayTransitionEnd}
        onRevealCompleteChange={updateAssetGatedRevealComplete}
        onDismissReadyChange={updatePonchoDismissReady}
      />
    ) : (
      <DefaultRevealOverlay reveal={reveal} suspended={revealOverlaySuspended} />
    )
  ) : null;

  return (
    <BackgroundBlurPortal
      open={Boolean(revealOverlayNode)}
      active={Boolean(revealOverlayNode && revealOverlayActive && !revealOverlayClosing)}
    >
      {revealOverlayNode}
    </BackgroundBlurPortal>
  );
}
