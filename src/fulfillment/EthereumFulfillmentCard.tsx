import { useEffect, useRef, useState } from 'react';
import type { EthereumItemKind } from '../../shared/ethereum/protocol';
import { ethereumExplorerTransaction, resolveEthereum111kConfig } from '../../shared/ethereum/config';
import type { FulfillmentOrder } from '../types';
import { monsApiOrigin } from '../lib/monsApiOrigin';
import { fulfillmentOrderKey } from './orders';
import { fulfillmentBoxSecretCode, isUsedReceiptClaimStatus } from '../lib/fulfillmentCodes';
import { formatFulfillmentAddressText } from '../lib/fulfillmentExports';
import type { FulfillmentSecretCodeDownloadTarget } from './useFulfillmentExports';

const previews = new Map<string, Promise<string>>();

export function loadEthereumFulfillmentPreview(kind: EthereumItemKind, displayId: number): Promise<string> {
  const key = `${kind}:${displayId}`;
  const existing = previews.get(key);
  if (existing) return existing;
  const promise = fetch(`${monsApiOrigin()}/ethereum/111k/metadata?${new URLSearchParams({ kind, displayId: String(displayId) })}`, {
    headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30_000),
  }).then(async (response) => {
    if (!response.ok) throw new Error('The Ethereum preview is temporarily unavailable.');
    const value: unknown = await response.json();
    if (!value || typeof value !== 'object' || !('image' in value) || typeof value.image !== 'string' ||
      !value.image.startsWith('data:image/svg+xml;base64,')) throw new Error('Invalid Ethereum preview.');
    return value.image;
  }).catch((error: unknown) => { previews.delete(key); throw error; });
  previews.set(key, promise);
  return promise;
}

function EthereumPreview({ kind, displayId }: { kind: EthereumItemKind; displayId: number }) {
  const [image, setImage] = useState<string>();
  const frame = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let active = true;
    const load = () => { void loadEthereumFulfillmentPreview(kind, displayId).then((src) => { if (active) setImage(src); }).catch(() => {}); };
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { observer?.disconnect(); load(); }
    }, { rootMargin: '300px' });
    if (observer && frame.current) observer.observe(frame.current);
    else load();
    return () => { active = false; observer?.disconnect(); };
  }, [kind, displayId]);
  return <span ref={frame} className="fulfillment-image-frame" style={{ aspectRatio: 1 }}>
    {image ? <img src={image} alt={`${kind.replaceAll('_', ' ')} #${displayId}`} className="figure-image" loading="lazy" /> :
      <span className="figure-image figure-image--placeholder" aria-hidden="true" />}
  </span>;
}

export function EthereumFulfillmentCard({ order, showContactInfo, showFullAddress, canAdminEditFulfillmentAddress,
  secretCodeDownloadDisabled, onEditAddress, onEditStatus, onDownloadSecretCode }: {
  order: FulfillmentOrder;
  showContactInfo: boolean;
  showFullAddress: boolean;
  canAdminEditFulfillmentAddress: boolean;
  secretCodeDownloadDisabled: boolean;
  onEditAddress: (order: FulfillmentOrder) => void;
  onEditStatus: (key: string) => void;
  onDownloadSecretCode: (order: FulfillmentOrder, target: FulfillmentSecretCodeDownloadTarget) => void | Promise<void>;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const canShowAddress = showFullAddress && order.address.full && order.address.full !== '***';
  const transaction = order.ethereumTransaction;
  const transactionLink = transaction?.chainId === 11155111
    ? ethereumExplorerTransaction(resolveEthereum111kConfig({ chainId: transaction.chainId }), transaction.hash)
    : null;
  return <div className="fulfillment-order-section">
    <div className="card__head">
      <div>
        <div className="card__title">Order {order.deliveryId}</div>
        <div className="muted small">111K · Ethereum test order</div>
        {transactionLink ? <a className="muted small" href={transactionLink} target="_blank" rel="noopener noreferrer">View delivery transaction</a> : null}
        {showContactInfo && order.address.full !== '***' && order.address.email ? <div className="muted small">{order.address.email}</div> : null}
      </div>
      <button type="button" className="secondary-light" aria-label="Edit status" onClick={() => onEditStatus(fulfillmentOrderKey(order))}>
        {order.fulfillmentStatus || 'Set status'}
      </button>
    </div>
    {canShowAddress ? <div className="fulfillment-address" style={{ whiteSpace: 'pre-line' }}>{formatFulfillmentAddressText(order.address)}</div> : null}
    {canAdminEditFulfillmentAddress && showFullAddress && showContactInfo ? <button type="button" className="secondary-light" onClick={() => onEditAddress(order)}>Edit address</button> : null}
    <div className="muted small">Test fulfillment. Shipping labels and customer emails are disabled.</div>
    {order.fulfillmentTrackingCode ? <div className="muted small">Tracking: {order.fulfillmentTrackingCode}</div> : null}
    {order.boxes.map((box, index) => {
      const code = fulfillmentBoxSecretCode(box);
      const codeUnavailable = isUsedReceiptClaimStatus(box.receiptClaimStatus);
      const open = expanded.has(box.boxId);
      return <div className="order-items" key={box.boxId}>
        <div className="figure-grid"><div className="figure-tile">
          <EthereumPreview kind="crate_receipt" displayId={box.boxId} />
          <span className="muted small">Crate #{box.boxId} · {box.dudeIds.length} artworks</span>
          {code ? <span className="muted small">{box.receiptClaimStatus === 'pending' ? 'Confirming' : codeUnavailable ? 'Claimed' : code}</span> : null}
          {code && !codeUnavailable ? <button type="button" className="secondary-light" disabled={secretCodeDownloadDisabled}
            onClick={() => void onDownloadSecretCode(order, { kind: 'box', index })}>Download code PNG</button> : null}
        </div></div>
        <button type="button" className="secondary-light" aria-expanded={open} onClick={() => setExpanded((previous) => {
          const next = new Set(previous); if (next.has(box.boxId)) next.delete(box.boxId); else next.add(box.boxId); return next;
        })}>{open ? 'Hide contents' : 'Show contents'}</button>
        {open ? <div className="figure-grid">{box.dudeIds.map((id) => <div className="figure-tile" key={id}>
          <EthereumPreview kind="artwork_receipt" displayId={id} /><span className="muted small">Artwork #{id}</span>
        </div>)}</div> : null}
      </div>;
    })}
    {order.looseDudes.length ? <div className="figure-grid">{order.looseDudes.map((id) => <div className="figure-tile" key={id}>
      <EthereumPreview kind="artwork_receipt" displayId={id} /><span className="muted small">Artwork #{id}</span>
    </div>)}</div> : null}
  </div>;
}
