import { useEffect, useMemo, useState } from 'react';
import type { EthereumInventoryItem } from '../../../shared/ethereum/protocol';
import { getRevealOverlayViewport } from '../../lib/revealOverlayLayout';
import { ETHEREUM_CONTAINER_MEDIA } from '../containerMedia';
import { EthereumInventoryOverlays } from '../EthereumInventoryOverlays';
import { useEthereumInventoryPresentation } from '../useEthereumInventoryPresentation';
import { loadWarehouseCrateImage, warehouseCratePreviews, type WarehouseCrateImage } from './warehouseAssets';
import { playWarehouseImpactSound, unlockWarehouseSounds } from './warehouseSounds';
import WarehouseScene from './WarehouseScene';

const warehouse: EthereumInventoryItem = {
  id: 'warehouse-fixture', tokenId: '122222', name: 'Warehouse #1', kind: 'warehouse',
  owner: `0x${'11'.repeat(20)}`, chainId: 11155111, contractAddress: `0x${'33'.repeat(20)}`,
  displayId: 1, image: ETHEREUM_CONTAINER_MEDIA.warehouse.src,
};
const hash = `0x${'bb'.repeat(32)}`;
const noop = () => {};

export default function WarehouseDevApp() {
  const [params] = useState(() => new URLSearchParams(window.location.search));
  const inspecting = params.get('inspect') === '1';
  const [delay, setDelay] = useState(Math.max(0, Number(params.get('delay')) || 0));
  const [failure, setFailure] = useState(params.get('failure') === '1');
  const [session, setSession] = useState(0);
  const [submission, setSubmission] = useState(0);
  const [confirmation, setConfirmation] = useState<{ delay: number; failure: boolean } | null>(null);
  const [results, setResults] = useState<readonly EthereumInventoryItem[] | null>(null);
  const [confirmedError, setConfirmedError] = useState('');
  const [crateImage, setCrateImage] = useState<WarehouseCrateImage | null>(null);
  const [inspectionTime, setInspectionTime] = useState(Math.max(0, Math.min(2800, Number(params.get('time')) || 0)));
  const [hits, setHits] = useState<readonly { id: number; x: number; y: number }[]>([]);
  const [error, setError] = useState('');
  const [viewport, setViewport] = useState(getRevealOverlayViewport);
  const [reduced, setReduced] = useState(params.get('reduced') === '1');
  const [suspended, setSuspended] = useState(false);
  const items = useMemo<readonly EthereumInventoryItem[]>(() => Array.from({ length: 11 }, (_, index) => ({
    ...warehouse, id: `warehouse-crate-${index + 1}`, tokenId: String(111112 + index), displayId: index + 1,
    kind: 'crate', name: `Crate #${index + 1}`, image: ETHEREUM_CONTAINER_MEDIA.crate.src,
  })), []);
  const assets = useMemo(() => warehouseCratePreviews(items, crateImage), [items, crateImage]);
  const presentation = useEthereumInventoryPresentation({
    scope: `warehouse-fixture:${session}`, suspended,
    onUnpack: async () => {
      setConfirmedError('');
      setError('');
      setSubmission(value => value + 1);
      setConfirmation({ delay, failure });
      return hash;
    },
    onError: setError,
    unpackResults: results ? { [hash]: results } : {},
    unpackErrors: confirmedError ? { [hash]: confirmedError } : {},
  });
  useEffect(() => {
    const resize = () => setViewport(getRevealOverlayViewport());
    window.addEventListener('resize', resize);
    window.visualViewport?.addEventListener('resize', resize);
    window.visualViewport?.addEventListener('scroll', resize);
    return () => {
      window.removeEventListener('resize', resize);
      window.visualViewport?.removeEventListener('resize', resize);
      window.visualViewport?.removeEventListener('scroll', resize);
    };
  }, []);
  useEffect(() => {
    if (!confirmation) return;
    const timer = window.setTimeout(() => {
      if (confirmation.failure) setConfirmedError('Simulated warehouse confirmation failure. Turn off Failed confirmation and retry.');
      else setResults(items);
    }, confirmation.delay);
    return () => window.clearTimeout(timer);
  }, [confirmation, items]);
  useEffect(() => {
    if (!inspecting) return;
    const controller = new AbortController();
    let resident: WarehouseCrateImage | null = null;
    setCrateImage(null);
    setError('');
    void loadWarehouseCrateImage({ signal: controller.signal }).then(value => {
      if (controller.signal.aborted) { value.release(); return; }
      resident = value;
      setCrateImage(value);
    }).catch(value => { if (!controller.signal.aborted) setError(String(value)); });
    return () => { controller.abort(); resident?.release(); };
  }, [inspecting, session]);
  const aspect = ETHEREUM_CONTAINER_MEDIA.warehouse.aspectRatio;
  const width = Math.min(viewport.width * 0.82, viewport.height * 0.48 * aspect, 640);
  const height = width / aspect;
  const containerRect = { left: viewport.left + (viewport.width - width) / 2,
    top: viewport.top + viewport.height * 0.56 - height / 2, width, height };
  const reset = () => {
    setSession(value => value + 1);
    setResults(null);
    setConfirmedError('');
    setError('');
    setSubmission(0);
    setConfirmation(null);
    setHits([]);
    setInspectionTime(0);
  };
  return <main style={{ minHeight: '100dvh', background: '#fff', color: '#333', padding: 20 }}>
    <div style={{ position: 'relative', zIndex: 3000, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
      <strong>111k warehouse preview</strong>
      <span data-submissions={submission}>11 crates · {submission} submissions</span>
      {inspecting ? <>
        <label>Time <input aria-label="Opening time" type="range" min={0} max={2800} step={1} value={inspectionTime}
          onChange={event => setInspectionTime(Number(event.target.value))} /> {inspectionTime} ms</label>
        <button disabled={hits.length >= 3} onClick={() => {
          void unlockWarehouseSounds();
          setHits(previous => [...previous, { id: previous.length + 1, x: previous.length % 2 ? 0.3 : -0.2, y: -0.2 }]);
        }}>Ice hit</button>
        <label><input type="checkbox" checked={reduced} onChange={event => setReduced(event.target.checked)} /> Reduced motion</label>
      </> : <>
        <label>Delay <input aria-label="Result delay" type="number" min={0} step={1000} value={delay}
          onChange={event => setDelay(Math.max(0, Number(event.target.value) || 0))} style={{ width: 80 }} /> ms</label>
        <label><input type="checkbox" checked={failure} onChange={event => setFailure(event.target.checked)} /> Failed confirmation</label>
        <button disabled={presentation.open} onClick={() => {
          setResults(null);
          setConfirmedError('');
          presentation.openUnpack([warehouse]);
        }}>Open warehouse</button>
      </>}
      <button onClick={reset}>Reset</button>
      <button onClick={() => setSuspended(value => !value)}>{suspended ? 'Resume' : 'Suspend'}</button>
      <a href={inspecting ? '/111k_devnet/warehouse-preview' : '/111k_devnet/warehouse-preview?inspect=1'}>
        {inspecting ? 'Interactive' : 'Inspect frames'}
      </a>
      <a href="/111k_devnet/crate-preview">Crate preview</a>
    </div>
    {error ? <p role="alert" style={{ position: 'relative', zIndex: 3000 }}>{error}</p> : null}
    {inspecting ? <WarehouseScene key={session} assets={assets} crateImage={crateImage} hits={hits} opening={false} active suspended={suspended}
      reducedMotion={reduced} viewport={viewport} containerRect={containerRect} inspectionTime={inspectionTime}
      onReady={noop} onAssetsReady={noop} onComplete={noop} onFrame={noop} onError={value => setError(value.message)}
      onImpact={critical => { void playWarehouseImpactSound(critical, () => !suspended && !document.hidden); }} />
      : <EthereumInventoryOverlays presentation={presentation} suspended={suspended} />}
  </main>;
}
