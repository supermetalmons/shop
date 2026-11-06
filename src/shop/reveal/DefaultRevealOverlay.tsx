import { MediaWithFallback } from '../../components/MediaWithFallback';
import { joinDropAssetUrl } from '../../lib/dropContent';
import type { ShopRevealController } from './useShopReveal';
import { RevealOverlayShell } from './RevealOverlayShell';

export function DefaultRevealOverlay({ reveal, suspended: revealOverlaySuspended }: {
  reveal: ShopRevealController;
  suspended: boolean;
}) {
  const {
    revealOverlay, revealOverlayActive, revealOverlayClosing, revealLoading,
    handleRevealOverlayDismiss, handleRevealOverlayTransitionEnd, handleRevealOverlayClick,
  } = reveal;
  const {
    revealOverlayStage, revealOverlayStyle, showRevealOutcome, revealMediaItems,
    revealMediaStyle, revealOverlayContent, revealMediaBase, revealBoxFrameSrc,
  } = reveal.presentation;
  const { revealFrameCountForDropId } = reveal.assets;
  return revealOverlay ? (
    <RevealOverlayShell
      name={revealOverlay.name}
      imageSrc={revealBoxFrameSrc}
      stage={revealOverlayStage}
      active={revealOverlayActive}
      closing={revealOverlayClosing}
      suspended={revealOverlaySuspended}
      style={revealOverlayStyle}
      busy={revealLoading === revealOverlay.id}
      disabled={Boolean(revealOverlayClosing || revealOverlay.phase !== 'ready' || revealOverlay.autoOpening ||
        (revealOverlayContent.reveal.mode === 'animated' && revealOverlay.frame >= revealFrameCountForDropId(revealOverlay.dropId)))}
      showOutcome={showRevealOutcome}
      onDismiss={handleRevealOverlayDismiss}
      onReveal={handleRevealOverlayClick}
      onTransitionEnd={handleRevealOverlayTransitionEnd}
    >
        {revealMediaItems.length ? (
          <div
            className={`reveal-overlay__media${showRevealOutcome ? ' reveal-overlay__media--visible' : ''}`}
            style={revealMediaStyle}
            aria-hidden="true"
          >
            {revealMediaItems.map(({ figureId, mediaId, image, index, name }) => {
              const count = revealMediaItems.length;
              const angle = -Math.PI / 2 + (index * (Math.PI * 2)) / Math.max(count, 1);
              const ring = count <= 1 ? 0 : count <= 3 ? 28 : count <= 5 ? 32 : count <= 8 ? 36 : 40;
              const left = 50 + Math.cos(angle) * ring;
              const top = 50 + Math.sin(angle) * ring;
              return (
                <div
                  key={`${revealOverlay.id}-${figureId}-${index}`}
                  className="reveal-overlay__media-item"
                  style={{
                    left: showRevealOutcome ? `${left}%` : '50%',
                    top: showRevealOutcome ? `${top}%` : '50%',
                    ['--reveal-media-delay' as never]: `${index * 70}ms`,
                  }}
                >
                  <div className="reveal-overlay__media-float">
                    {revealOverlayContent.figures.revealPresentation === 'videos' && revealMediaBase && mediaId ? (
                      <video
                        className="reveal-overlay__video"
                        autoPlay
                        muted
                        loop
                        playsInline
                        preload="metadata"
                        poster={image}
                        draggable={false}
                      >
                        <source
                          src={joinDropAssetUrl(revealMediaBase, `${mediaId}.mov`)}
                          type='video/quicktime; codecs="hvc1"'
                        />
                        <source src={joinDropAssetUrl(revealMediaBase, `${mediaId}.webm`)} type="video/webm" />
                      </video>
                    ) : (
                      <MediaWithFallback
                        dropId={revealOverlay.dropId}
                        imageSources={image ? [image] : []}
                        imageProps={{ alt: name, className: 'reveal-overlay__still', draggable: false }}
                        renderPlaceholder={(hidden) => (
                          <div className="reveal-overlay__still reveal-overlay__still--placeholder" hidden={hidden} />
                        )}
                      />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
    </RevealOverlayShell>
  ) : null;
}
