import { useEffect, useMemo, useState } from 'react';
import type { EthereumInventoryItem } from '../../../shared/ethereum/protocol';
import { getRevealOverlayViewport } from '../../lib/revealOverlayLayout';
import { ETHEREUM_CONTAINER_MEDIA } from '../containerMedia';
import { EthereumInventoryOverlays } from '../EthereumInventoryOverlays';
import { useEthereumInventoryPresentation } from '../useEthereumInventoryPresentation';
import { loadCratePreviewAssets, type CratePreviewAssets } from './crateAssets';
import CrateScene from './CrateScene';

const crate: EthereumInventoryItem = { id: 'crate-fixture', tokenId: '111112', name: 'Crate #1', kind: 'crate',
  owner: `0x${'11'.repeat(20)}`, chainId: 11155111, contractAddress: `0x${'33'.repeat(20)}`, displayId: 1,
  image: ETHEREUM_CONTAINER_MEDIA.crate.src };
const hash = `0x${'aa'.repeat(32)}`;
const noop = () => {};

function fixtureItems(count: number, failure: boolean): EthereumInventoryItem[] {
  return Array.from({ length: count }, (_, index) => {
    const category = (['painting', 'egg', 'video', '3d', 'animated'] as const)[index % 5];
    const directory = { painting: 'paintings', egg: 'eggs', video: 'videos', '3d': '3d', animated: 'animated' }[category];
    const assetId = Math.floor(index / 5) + 1;
    return { ...crate, id: `fixture-artwork-${index}`, tokenId: String(index + 1), displayId: index + 1,
      kind: 'artwork', name: `Artwork #${index + 1}`, category,
      image: failure && index === count - 1 ? '/111k/intentionally-missing.webp' : `https://wip.lil.org/111k/${directory}/${assetId}.webp`,
      ...(category === 'video' || category === 'animated' ? { animation_url: `https://wip.lil.org/111k/${directory}/${assetId}.mp4` }
        : category === '3d' ? { animation_url: `https://wip.lil.org/111k/3d/${assetId}.glb` } : {}),
    };
  });
}

export default function CrateDevApp() {
  const [params] = useState(() => new URLSearchParams(window.location.search));
  const inspecting = params.get('inspect') === '1';
  const [count, setCount] = useState(Number(params.get('count')) === 31 ? 31 : 20);
  const [delay, setDelay] = useState(Number(params.get('delay')) || 0);
  const [failure, setFailure] = useState(params.get('failure') === '1');
  const [session, setSession] = useState(0);
  const [submission, setSubmission] = useState(0);
  const [results, setResults] = useState<readonly EthereumInventoryItem[] | null>(null);
  const [assets, setAssets] = useState<CratePreviewAssets | null>(null);
  const [inspectionTime, setInspectionTime] = useState(Number(params.get('time')) || 0);
  const [hit, setHit] = useState<{ id: number; x: number; y: number } | null>(null);
  const [error, setError] = useState('');
  const [viewport, setViewport] = useState(getRevealOverlayViewport);
  const [reduced, setReduced] = useState(false);
  const [suspended, setSuspended] = useState(false);
  const items = useMemo(() => fixtureItems(count, failure), [count, failure]);
  const presentation = useEthereumInventoryPresentation({ scope: `fixture:${session}`, suspended,
    onUnpack: async () => { setSubmission(value => value + 1); return hash; }, unpackResults: results ? { [hash]: results } : {}, unpackErrors: {} });
  useEffect(() => {
    const resize = () => setViewport(getRevealOverlayViewport());
    window.addEventListener('resize', resize);
    window.visualViewport?.addEventListener('resize', resize);
    return () => { window.removeEventListener('resize', resize); window.visualViewport?.removeEventListener('resize', resize); };
  }, []);
  useEffect(() => {
    if (!submission) return;
    const timer = window.setTimeout(() => setResults(items), delay);
    return () => window.clearTimeout(timer);
  }, [submission, items, delay]);
  useEffect(() => {
    if (!inspecting) return;
    const controller = new AbortController();
    setAssets(null);
    setError('');
    void loadCratePreviewAssets(items, { signal: controller.signal }).then(setAssets).catch(value => {
      if (!controller.signal.aborted) setError(String(value));
    });
    return () => controller.abort();
  }, [inspecting, items, session]);
  const width = Math.min(viewport.width * 0.85, (viewport.height - 110) * ETHEREUM_CONTAINER_MEDIA.crate.aspectRatio);
  const height = width / ETHEREUM_CONTAINER_MEDIA.crate.aspectRatio;
  const crateRect = { left: viewport.left + (viewport.width - width) / 2,
    top: viewport.top + 80 + (viewport.height - 110 - height) / 2, width, height };
  return <main style={{ minHeight: '100dvh', background: '#fff', color: '#333', padding: 20 }}>
    <div style={{ position: 'relative', zIndex: 3000, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
      <strong>111k crate preview</strong>
      <label>Items <select value={count} onChange={event => setCount(Number(event.target.value))}>
        <option value={20}>20</option><option value={31}>31</option>
      </select></label>
      <label>Delay <input aria-label="Result delay" type="number" min={0} step={1000} value={delay}
        onChange={event => setDelay(Number(event.target.value))} style={{ width: 80 }} /> ms</label>
      <label><input type="checkbox" checked={failure} onChange={event => setFailure(event.target.checked)} /> Failed preview</label>
      {inspecting ? <>
        <label>Time <input aria-label="Opening time" type="range" min={0} max={2150} step={1} value={inspectionTime}
          onChange={event => setInspectionTime(Number(event.target.value))} /> {inspectionTime} ms</label>
        <button onClick={() => setHit(previous => ({ id: (previous?.id ?? 0) + 1, x: 0, y: 0 }))}>Hit</button>
        <label><input type="checkbox" checked={reduced} onChange={event => setReduced(event.target.checked)} /> Reduced motion</label>
      </> : <button onClick={() => { setResults(null); presentation.openUnpack([crate]); }}>Open crate</button>}
      <button onClick={() => { setSession(value => value + 1); setResults(null); setSubmission(0); setHit(null); }}>Reset</button>
      <button onClick={() => setSuspended(value => !value)}>{suspended ? 'Resume' : 'Suspend'}</button>
      <a href={inspecting ? '/111k_devnet/crate-preview' : '/111k_devnet/crate-preview?inspect=1'}>{inspecting ? 'Interactive' : 'Inspect frames'}</a>
    </div>
    {error ? <p role="alert">{error}</p> : null}
    {inspecting ? <CrateScene key={session} assets={assets} hit={hit} opening={false} active suspended={suspended}
      reducedMotion={reduced} viewport={viewport} crateRect={crateRect} inspectionTime={inspectionTime}
      onReady={noop} onAssetsReady={noop} onComplete={noop} onFrame={noop} onError={value => setError(value.message)} />
      : <EthereumInventoryOverlays presentation={presentation} suspended={suspended} />}
  </main>;
}
