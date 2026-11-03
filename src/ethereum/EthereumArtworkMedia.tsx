import { Component, lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { EthereumInventoryItem } from '../../shared/ethereum/protocol';
import { playMutedAutoplayVideo } from '../lib/autoplayVideo';
import { ethereumInventoryView } from './state';

const createModelViewer = () => lazy(() => import('./EthereumModelViewer'));

class ModelErrorBoundary extends Component<{ children: ReactNode; onError: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.onError(); }
  render() { return this.state.failed ? null : this.props.children; }
}

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
  const [ModelViewer, setModelViewer] = useState(createModelViewer);
  const [modelAttempt, setModelAttempt] = useState(0);
  const [readyModel, setReadyModel] = useState<object | null>(null);
  const [failedModel, setFailedModel] = useState<object | null>(null);
  const animation = item.category === 'video' || item.category === 'animated' ? item.animation_url : undefined;
  const model = item.category === '3d' && viewer ? item.animation_url : undefined;
  const modelKey = `${model}:${item.name}:${modelAttempt}`;
  const modelSession = useMemo(() => ({}), [modelKey]);
  const showModel = Boolean(model && failedModel !== modelSession);
  const modelReady = showModel && readyModel === modelSession;
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
      hidden={modelReady || failedImage === preview.image} onError={() => setFailedImage(preview.image ?? null)} />
    {showVideo ? <video key={animation} ref={video} src={animation} poster={preview.image}
      width={dimensions?.width} height={dimensions?.height} aria-label={item.name}
      autoPlay={!reducedMotion} loop muted playsInline controls={viewer} preload="metadata"
      style={{ opacity: viewer || readyVideo === animation ? 1 : 0 }}
      onLoadedData={event => {
        setReadyVideo(animation!);
        if (!reducedMotion) playMutedAutoplayVideo(event.currentTarget);
      }} onError={() => setFailedVideo(animation!)} /> : null}
    {showModel ? <span className="ethereum111k__model" style={{ opacity: modelReady ? 1 : 0 }}>
      <ModelErrorBoundary key={modelKey} onError={() => setFailedModel(modelSession)}>
        <Suspense fallback={null}>
          <ModelViewer src={model!} label={item.name} onReady={() => setReadyModel(modelSession)} onError={() => setFailedModel(modelSession)} />
        </Suspense>
      </ModelErrorBoundary>
    </span> : null}
    {failedImage === preview.image && !modelReady && (!showVideo || readyVideo !== animation) ? <span className="placeholder" role="status">Artwork unavailable</span> : null}
    {model ? <span className="ethereum111k__model-status" role="status">
      {failedModel === modelSession ? <>3D model unavailable. <button type="button" onClick={() => {
        setModelAttempt(value => value + 1);
        setModelViewer(createModelViewer);
      }}>Retry</button></> : modelReady ? 'Drag to rotate · Scroll or pinch to zoom' : 'Loading 3D model…'}
    </span> : null}
  </span>;
}
