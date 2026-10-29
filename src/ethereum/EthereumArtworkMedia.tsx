import { useEffect, useRef, useState } from 'react';
import type { EthereumInventoryItem } from '../../shared/ethereum/protocol';
import { playMutedAutoplayVideo } from '../lib/autoplayVideo';
import { ethereumInventoryView } from './state';

export function EthereumArtworkMedia({ item, viewer = false }: { item: EthereumInventoryItem; viewer?: boolean }) {
  const preview = ethereumInventoryView(item);
  const dimensions = preview.imageDimensions;
  const ratio = dimensions ? dimensions.width / dimensions.height : undefined;
  const maximumWidth = item.aspectRatio ? '' : dimensions ? `${dimensions.width}px, ` : '';
  const root = useRef<HTMLSpanElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [active, setActive] = useState(viewer);
  const [reducedMotion, setReducedMotion] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true);
  const [failedVideo, setFailedVideo] = useState<string | null>(null);
  const [readyVideo, setReadyVideo] = useState<string | null>(null);
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const animation = item.animation_url;
  useEffect(() => {
    const preference = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!preference) return;
    const update = () => setReducedMotion(preference.matches);
    update();
    preference.addEventListener('change', update);
    return () => preference.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (viewer || !root.current || typeof IntersectionObserver === 'undefined') { setActive(true); return; }
    const observer = new IntersectionObserver(([entry]) => setActive(Boolean(entry?.isIntersecting)), { rootMargin: '160px' });
    observer.observe(root.current);
    return () => observer.disconnect();
  }, [viewer]);
  useEffect(() => {
    const media = video.current;
    if (!media) return;
    if (active && !reducedMotion) playMutedAutoplayVideo(media);
    else media.pause();
    return () => media.pause();
  }, [active, animation, reducedMotion]);
  const showVideo = Boolean(animation && active && failedVideo !== animation && (viewer || !reducedMotion));
  return <span ref={root} className={`ethereum111k__artwork-media${viewer ? ' ethereum111k__artwork-media--viewer' : ''}`}
    style={{ aspectRatio: ratio, ...(viewer && ratio ? { width: `min(100%, ${maximumWidth}calc(60svh * ${ratio}))` } : {}) }}>
    <img className={viewer ? 'ethereum111k__view-image' : undefined} src={preview.image}
      width={dimensions?.width} height={dimensions?.height} alt={item.name} loading="lazy" decoding="async"
      hidden={failedImage === preview.image} onError={() => setFailedImage(preview.image ?? null)} />
    {showVideo ? <video key={animation} ref={video} src={animation} poster={preview.image}
      width={dimensions?.width} height={dimensions?.height} aria-label={item.name}
      autoPlay={!reducedMotion} loop muted playsInline controls={viewer} preload="metadata"
      style={{ opacity: viewer || readyVideo === animation ? 1 : 0 }}
      onLoadedData={event => {
        setReadyVideo(animation!);
        if (!reducedMotion) playMutedAutoplayVideo(event.currentTarget);
      }} onError={() => setFailedVideo(animation!)} /> : null}
    {failedImage === preview.image && (!showVideo || readyVideo !== animation) ? <span className="placeholder" role="status">Artwork unavailable</span> : null}
  </span>;
}
