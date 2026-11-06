import type { CSSProperties } from 'react';
import { BackgroundBlurPortal } from '../components/BackgroundBlurLayer';
import { MediaWithFallback } from '../components/MediaWithFallback';
import { MediaViewerOverlay } from '../shop/reveal/MediaViewerOverlay';
import { RevealOverlayShell } from '../shop/reveal/RevealOverlayShell';
import { EthereumArtworkMedia } from './EthereumArtworkMedia';
import { ethereumRevealTiles } from './revealLayout';
import { ethereumInventoryView } from './state';
import type { EthereumInventoryPresentation } from './useEthereumInventoryPresentation';

export function EthereumInventoryOverlays({ presentation, suspended = false }: {
  presentation: EthereumInventoryPresentation;
  suspended?: boolean;
}) {
  const { overlay, style, close, dismiss, requestUnpack, transitionEnd } = presentation;
  const item = overlay?.mode === 'viewer' ? presentation.viewerItem : overlay?.items[0];
  const tiles = overlay ? ethereumRevealTiles(overlay.results.length, overlay.viewport) : [];
  return <BackgroundBlurPortal open={Boolean(overlay) && !suspended} active={Boolean(overlay?.active && !overlay.closing) && !suspended}>
    {overlay && item && !suspended ? overlay.mode === 'viewer' ?
      <MediaViewerOverlay name={item.name} resetKey={item.id} active={overlay.active} closing={overlay.closing}
        suspended={suspended} style={style} className="ethereum-artwork-viewer" dismissIgnoreSelector="video, canvas"
        onDismiss={close} onTransitionEnd={transitionEnd}>
        <EthereumArtworkMedia item={item} viewer fullscreen chrome={false} />
      </MediaViewerOverlay> :
      <RevealOverlayShell name={item.name} imageSrc={ethereumInventoryView(item).image}
        stage={overlay.results.length ? 'revealed' : 'ready'} active={overlay.active} closing={overlay.closing}
        suspended={suspended} style={style} className="reveal-overlay--dense-results"
        busy={overlay.attempted && !overlay.results.length} disabled={overlay.closing || overlay.results.length > 0}
        showOutcome={overlay.resultsVisible} onDismiss={dismiss} onReveal={() => { void requestUnpack(); }} onTransitionEnd={transitionEnd}>
        {tiles.length ? <div className={`reveal-overlay__media reveal-overlay__media--dense${overlay.resultsVisible ? ' reveal-overlay__media--visible' : ''}`}
          style={{ left: overlay.viewport.left - overlay.targetRect.left, top: overlay.viewport.top - overlay.targetRect.top,
            width: overlay.viewport.width, height: overlay.viewport.height }} aria-hidden="true">
          {overlay.results.map((result, index) => {
            const tile = tiles[index];
            const image = ethereumInventoryView(result).image;
            return <div key={result.id} className="reveal-overlay__media-item" data-reveal-item={result.id}
              style={{ width: tile.width, height: tile.height,
                left: (overlay.resultsVisible ? tile.left + tile.width / 2 : overlay.targetRect.left + overlay.targetRect.width / 2) - overlay.viewport.left,
                top: (overlay.resultsVisible ? tile.top + tile.height / 2 : overlay.targetRect.top + overlay.targetRect.height / 2) - overlay.viewport.top,
                '--reveal-media-delay': `${Math.min(index * 35, index * 700 / tiles.length)}ms`,
              } as CSSProperties}>
              <div className="reveal-overlay__media-float">
                <MediaWithFallback imageSources={image ? [image] : []}
                  imageProps={{ alt: result.name, className: 'reveal-overlay__still', draggable: false }}
                  renderPlaceholder={hidden => <div className="reveal-overlay__still reveal-overlay__still--placeholder" hidden={hidden} />} />
              </div>
            </div>;
          })}
        </div> : null}
      </RevealOverlayShell> : null}
  </BackgroundBlurPortal>;
}
