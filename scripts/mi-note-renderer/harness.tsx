import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import WipInteractiveCard from '../../src/components/WipInteractiveCard';
import { useMiNoteCardAssets } from '../../src/hooks/useMiNoteCardAssets';
import { createMiNoteCard } from '../../src/lib/miNoteCards';
import './capture.css';

function captureState(id: number, matte: string, ready: boolean) {
  const rect = (selector: string) => {
    const box = document.querySelector(selector)!.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  };
  const element = document.querySelector('.drif-effect-card')!;
  const style = getComputedStyle(element);
  const dpr = window.devicePixelRatio;
  return {
    id, matte, ready, dpr, zoom: 2000 / (360 * dpr), innerWidth, innerHeight,
    assetUrls: {
      front: `https://cdn.lil.org/nft/mi_note_cards/fronts/${id}.png`,
      foil: `https://cdn.lil.org/nft/mi_note_cards/foils/${id}.webp`,
      mask: `https://cdn.lil.org/nft/mi_note_cards/masks/${id}.webp`,
    },
    frame: rect('#frame'), card: rect('#card'),
    sourceImage: Array.from(document.images).map(image => ({
      src: image.currentSrc, complete: image.complete, width: image.naturalWidth, height: image.naturalHeight,
    })),
    effect: {
      opacity: style.getPropertyValue('--card-opacity'), pointerX: style.getPropertyValue('--pointer-x'),
      pointerY: style.getPropertyValue('--pointer-y'), rotateX: style.getPropertyValue('--rotate-x'),
      rotateY: style.getPropertyValue('--rotate-y'),
      shadow: getComputedStyle(document.querySelector('.drif-effect-card__rotator')!).boxShadow,
    },
    loading: element.classList.contains('loading'),
    frontOpacity: getComputedStyle(document.querySelector('.drif-effect-card__front')!).opacity,
    userAgent: navigator.userAgent, timestamp: new Date().toISOString(),
  };
}

type CaptureState = ReturnType<typeof captureState> | { id: number; matte: string; ready: false };

declare global {
  interface Window {
    __miNoteCapture?: { state: CaptureState; setCard: (id: number) => void; setMatte: (matte: string) => void };
  }
}

function CaptureCard({ id, notifyReady }: { id: number; notifyReady: (ready: boolean) => void }) {
  const card = useMemo(() => ({
    ...createMiNoteCard(id), imageSrc: `https://cdn.lil.org/nft/mi_note_cards/fronts/${id}.png`,
  }), [id]);
  const assets = useMiNoteCardAssets([card]);
  const [imageReady, setImageReady] = useState(false);
  useEffect(() => {
    notifyReady(assets.ready && imageReady && !assets.error);
  }, [assets.ready, assets.error, imageReady, notifyReady]);
  return <div id="card" aria-busy={!assets.ready || !imageReady}>
    <WipInteractiveCard card={card} interactive={false} wakeOnInteractiveUnlock={false}
      onImageReadyChange={setImageReady} imageAlt={`Mi Note Card ${id}`} />
    {assets.error && <span role="alert">{assets.error.message}</span>}
  </div>;
}

function App() {
  const [id, setId] = useState(Number(new URLSearchParams(location.search).get('id') || '460'));
  const [matte, setMatte] = useState('transparent');
  const [ready, setReady] = useState(false);
  const [state, setState] = useState<CaptureState>({ id, matte, ready: false });
  useEffect(() => {
    window.__miNoteCapture = {
      state,
      setCard(next) { if (next !== id) { setReady(false); setId(next); } },
      setMatte(next) { setMatte(next); },
    };
  }, [id, state]);
  useEffect(() => {
    let cancelled = false;
    setState({ id, matte, ready: false });
    document.documentElement.style.background = matte;
    document.body.style.background = matte;
    document.getElementById('frame')!.style.zoom = String(2000 / (360 * devicePixelRatio));
    document.title = `Loading ${id} — Mi Note capture`;
    const timer = setTimeout(async () => {
      if (!ready || cancelled) return;
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      if (cancelled) return;
      setState(captureState(id, matte, ready));
      document.title = `READY ${id} ${matte} — Mi Note capture`;
    }, 500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [id, matte, ready]);
  return <div id="frame"><CaptureCard key={id} id={id} notifyReady={setReady} /></div>;
}

createRoot(document.getElementById('root')!).render(<App />);
