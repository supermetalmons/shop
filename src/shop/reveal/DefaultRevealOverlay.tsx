import { ModalFocusScope } from '../../components/ModalFocusScope';
import { MediaWithFallback } from '../../components/MediaWithFallback';
import { joinDropAssetUrl } from '../../lib/dropContent';
import type { ShopRevealController } from './useShopReveal';

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
    <ModalFocusScope
      ariaLabel={`${revealOverlay.name} unboxing`}
      suspended={revealOverlayClosing || revealOverlaySuspended}
      className={`reveal-overlay reveal-overlay--${revealOverlayStage}${revealOverlayActive ? ' reveal-overlay--active' : ''}${revealOverlayClosing ? ' reveal-overlay--closing' : ''}${revealOverlaySuspended ? ' reveal-overlay--suspended' : ''}`}
      style={revealOverlayStyle}
      onClick={() => {
        if (!revealOverlayClosing && !revealOverlaySuspended) {
          handleRevealOverlayDismiss();
        }
      }}
      onContextMenu={(evt) => evt.preventDefault()}
      onDragStart={(evt) => evt.preventDefault()}
    >
      <div className="reveal-overlay__backdrop" />
      <div
        className="reveal-overlay__frame"
        onTransitionEnd={handleRevealOverlayTransitionEnd}
      >
        <div
          className={`reveal-overlay__shine${showRevealOutcome ? ' reveal-overlay__shine--visible' : ''}`}
          aria-hidden="true"
        />
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
        <button
          type="button"
          className="reveal-overlay__box"
          aria-label={`Reveal ${revealOverlay.name}`}
          aria-busy={revealLoading === revealOverlay.id}
          aria-disabled={
            revealOverlayClosing ||
            revealOverlay.phase !== 'ready' ||
            revealOverlay.autoOpening ||
            (revealOverlayContent.reveal.mode === 'animated' &&
              revealOverlay.frame >= revealFrameCountForDropId(revealOverlay.dropId))
          }
          onClick={(evt) => {
            evt.stopPropagation();
            handleRevealOverlayClick();
          }}
        >
          <MediaWithFallback
            imageSources={revealBoxFrameSrc ? [revealBoxFrameSrc] : []}
            imageProps={{ alt: revealOverlay.name, className: 'reveal-overlay__image', draggable: false }}
            renderPlaceholder={(hidden) => (
              <div className="reveal-overlay__image reveal-overlay__image--placeholder" hidden={hidden} aria-hidden="true" />
            )}
          />
        </button>
      </div>
    </ModalFocusScope>
  ) : null;
}
