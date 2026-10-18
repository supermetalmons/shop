import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ethereumExplorerTransaction } from '../../shared/ethereum/config';
import { ETHEREUM_MAX_EXPECTED_IDS, formatEtherAmount } from '../../shared/ethereum/protocol';
import type { EthereumInventoryItem } from '../../shared/ethereum/api';
import { InventoryGrid } from '../components/InventoryGrid';
import { DeliveryForm } from '../components/DeliveryForm';
import { Modal } from '../components/Modal';
import { BackgroundLayerPortal } from '../components/BackgroundBlurLayer';
import { getInjectedWalletIconSrc } from '../wallet/injectedEthereumProviders';
import type { InventoryItem } from '../types';
import { ethereumApi } from './api';
import { ethereumContainerPreview } from './preview';
import { ethereumInventoryView, isEthereumInventoryView, readEthereumExpected, toggleEthereumSelection, writeEthereumExpected } from './state';
import { useEthereum111k, type EthereumWallet } from './useEthereum111k';

export type Ethereum111kPageProps = {
  wallet: EthereumWallet;
  claimReceiptId?: string;
  claimCode?: string;
  addressEncryptionPublicKey: string;
  solanaInventoryItems: InventoryItem[];
  solanaSelected: Set<string>;
  onSolanaToggle: (id: string) => void;
  clearSolanaSelection: () => void;
  pendingRevealIds: Set<string>;
  onSolanaReveal: (id: string, rect: DOMRect) => void;
  onSolanaView: (item: InventoryItem, rect: DOMRect) => void;
  canOpenSolanaBoxes: (dropId?: string) => boolean;
  solanaRevealLoading: string | null;
  solanaInventoryReady: boolean;
  externalBusy?: boolean;
  suspended?: boolean;
};

export default function Ethereum111kPage({
  wallet, claimReceiptId, claimCode: linkedClaimCode, addressEncryptionPublicKey, solanaInventoryItems, solanaSelected, onSolanaToggle, clearSolanaSelection,
  pendingRevealIds, onSolanaReveal, onSolanaView, canOpenSolanaBoxes, solanaRevealLoading,
  solanaInventoryReady, externalBusy = false, suspended = false,
}: Ethereum111kPageProps) {
  const model = useEthereum111k(wallet, addressEncryptionPublicKey);
  const [kind, setKind] = useState<'crate' | 'warehouse'>('crate');
  const [quantity, setQuantity] = useState(1);
  const [selection, setSelection] = useState<{ scope: string | null; ids: Set<string> }>({ scope: null, ids: new Set() });
  const [viewed, setViewed] = useState<EthereumInventoryItem | null>(null);
  const [deliveryOpen, setDeliveryOpen] = useState(false);
  const [receiptAction, setReceiptAction] = useState<'transfer' | 'claim' | null>(null);
  const [recipient, setRecipient] = useState('');
  const [claimCode, setClaimCode] = useState('');
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [replacementHash, setReplacementHash] = useState('');
  const [confirmDismiss, setConfirmDismiss] = useState(false);
  const [claimLinkHandled, setClaimLinkHandled] = useState<string | null>(null);
  const firstWalletRef = useRef<HTMLButtonElement>(null);
  const previousWalletScope = useRef({ scope: model.scope, chainId: model.chainId, provider: wallet.provider });
  const selected = useMemo(() => selection.scope === model.scope ? selection.ids : new Set<string>(), [selection, model.scope]);
  const itemsById = useMemo(() => new Map(model.items.map(item => [item.id, item])), [model.items]);
  const selectedItems = useMemo(() => [...selected].map(id => itemsById.get(id)).filter((item): item is EthereumInventoryItem => Boolean(item)), [selected, itemsById]);
  const disabled = Boolean(model.busy || model.pending || model.submission || externalBusy || suspended);
  const walletPickerOpen = wallet.status === 'choosing';
  const hasSubmittedTransaction = Boolean(model.pending || (model.submission && !model.busy));
  const remaining = kind === 'crate' ? model.stats.data?.remainingCrates : model.stats.data?.remainingWarehouses;
  const unitPrice = kind === 'crate' ? model.stats.data?.cratePriceWei ?? model.config.cratePriceWei : model.stats.data?.warehousePriceWei ?? model.config.warehousePriceWei;
  const price = formatEtherAmount(BigInt(unitPrice) * BigInt(quantity));
  const preview = useQuery({ queryKey: ['ethereum111k', 'preview', model.config.chainId, model.config.contractAddress, kind],
    queryFn: ({ signal }) => ethereumApi.preview(kind, signal), enabled: model.config.enabled, retry: false, staleTime: Infinity });
  const image = preview.data ?? ethereumContainerPreview(kind);
  const ethereumItems = useMemo(() => model.items.filter(item => !item.kind.endsWith('_receipt')).map(ethereumInventoryView), [model.items]);
  const receipts = useMemo(() => model.items.filter(item => item.kind.endsWith('_receipt')).map(ethereumInventoryView), [model.items]);
  const inventoryItems = useMemo(() => [...ethereumItems, ...solanaInventoryItems], [ethereumItems, solanaInventoryItems]);
  const combinedSelection = useMemo(() => selected.size ? selected : solanaSelected, [selected, solanaSelected]);
  const selectedContainer = selectedItems.length === 1 && ['crate', 'warehouse'].includes(selectedItems[0].kind) ? selectedItems[0] : null;
  const selectedCrates = selectedItems.length > 0 && selectedItems.every(item => item.kind === 'crate');
  const unboxLimitExceeded = selectedCrates && selectedItems.length > model.config.maxUnboxQuantity;
  const canDeliver = selectedItems.length > 0 && selectedItems.length <= model.config.maxDeliveryItems && selectedItems.every(item => ['crate', 'artwork'].includes(item.kind));
  const txLink = model.pending ? ethereumExplorerTransaction(model.config, model.pending.hash) : null;
  const claimLinkKey = claimReceiptId && linkedClaimCode ? `${claimReceiptId}:${linkedClaimCode}` : null;
  useEffect(() => {
    setQuantity(current => Math.max(1, Math.min(current, model.config.maxMintQuantity, remaining ?? 15)));
  }, [remaining, model.config.maxMintQuantity]);

  useEffect(() => {
    const previous = previousWalletScope.current;
    previousWalletScope.current = { scope: model.scope, chainId: model.chainId, provider: wallet.provider };
    if (previous.scope === model.scope && previous.provider === wallet.provider &&
      (previous.chainId === null || previous.chainId === model.chainId || model.chainId === model.config.chainId)) return;
    setSelection({ scope: model.scope, ids: new Set() });
    setViewed(null);
    setDeliveryOpen(false);
    setReceiptAction(null);
    setRecoveryOpen(false);
    setConfirmDismiss(false);
  }, [model.scope, model.chainId, model.config.chainId, wallet.provider]);
  useEffect(() => {
    if (!claimLinkKey) return;
    const url = new URL(window.location.href);
    url.searchParams.delete('receiptId');
    url.searchParams.delete('claim');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  }, [claimLinkKey]);
  useEffect(() => {
    if (!model.scope || !claimReceiptId || !claimLinkKey || claimLinkHandled === claimLinkKey) return;
    const expected = readEthereumExpected(model.scope);
    if (expected.includes(claimReceiptId)) return;
    writeEthereumExpected(model.scope, [...expected, claimReceiptId].slice(-ETHEREUM_MAX_EXPECTED_IDS));
    model.refresh();
  }, [model.scope, claimReceiptId, claimLinkKey, claimLinkHandled, model.refresh]);
  useEffect(() => {
    if (!claimLinkKey || claimLinkHandled === claimLinkKey || !linkedClaimCode) return;
    const receipt = model.items.find(item => item.tokenId === claimReceiptId && item.kind === 'crate_receipt');
    if (!receipt) return;
    clearSolanaSelection();
    setDeliveryOpen(false);
    setRecoveryOpen(false);
    setConfirmDismiss(false);
    setViewed(receipt);
    setReceiptAction('claim');
    setClaimCode(linkedClaimCode);
    setClaimLinkHandled(claimLinkKey);
  }, [claimLinkKey, claimLinkHandled, claimReceiptId, linkedClaimCode, model.items, clearSolanaSelection]);
  useEffect(() => {
    setRecoveryOpen(false);
    setReplacementHash('');
    setConfirmDismiss(false);
  }, [model.pending?.hash, model.submission?.submittedAt, model.scope]);
  useEffect(() => {
    if (hasSubmittedTransaction) {
      setSelection({ scope: model.scope, ids: new Set() });
      setDeliveryOpen(false);
      setViewed(null);
      setReceiptAction(null);
    }
  }, [model.pending?.hash, model.submission?.submittedAt, model.scope, hasSubmittedTransaction]);
  useEffect(() => {
    if (!model.revealed) return;
    setViewed(null);
    setDeliveryOpen(false);
    setRecoveryOpen(false);
    setReceiptAction(null);
  }, [model.revealed]);
  useEffect(() => {
    if (!selected.size || disabled || viewed || deliveryOpen || recoveryOpen || walletPickerOpen || model.revealed) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      setSelection({ scope: model.scope, ids: new Set() });
    };
    document.addEventListener('keydown', dismiss);
    return () => document.removeEventListener('keydown', dismiss);
  }, [selected.size, disabled, viewed, deliveryOpen, recoveryOpen, walletPickerOpen, model.revealed, model.scope]);
  useEffect(() => {
    if (walletPickerOpen) firstWalletRef.current?.focus();
  }, [walletPickerOpen]);
  useEffect(() => {
    setSelection(current => {
      if (current.scope !== model.scope || !model.inventory.isSuccess) return current;
      const valid = new Set([...current.ids].filter(id => itemsById.has(id)));
      return valid.size === current.ids.size ? current : { ...current, ids: valid };
    });
  }, [itemsById, model.scope, model.inventory.isSuccess]);
  const clear = () => setSelection({ scope: model.scope, ids: new Set() });
  const select = (id: string) => {
    if (disabled) return;
    const item = itemsById.get(id);
    if (item) {
      clearSolanaSelection();
      setSelection({ scope: model.scope, ids: toggleEthereumSelection(selected, item, itemsById, model.config.maxDeliveryItems) });
    } else {
      clear();
      onSolanaToggle(id);
    }
  };
  const view = (item: InventoryItem, rect: DOMRect) => {
    if (isEthereumInventoryView(item)) {
      clearSolanaSelection();
      setViewed(item.ethereum);
      setReceiptAction(null);
    } else onSolanaView(item, rect);
  };
  const mint = (event: FormEvent) => {
    event.preventDefault();
    if (!model.owner) { wallet.connect(); return; }
    void model.mint(kind, quantity);
  };
  const totalState = model.configQuery.isPending ? 'Loading testnet…' : !model.config.enabled ? 'Testnet deployment pending' :
    model.stats.isPending ? 'Loading availability…' : !model.stats.data?.saleActive ? 'Minting is paused' : `${(remaining ?? 0).toLocaleString()} ${kind === 'crate' ? 'crates' : 'warehouses'} available`;
  const revealItems = model.revealed ?? [];
  const connectedLabel = model.owner ? `${model.owner.slice(0, 6)}…${model.owner.slice(-4)}` : 'Connect Ethereum';

  return <div className="ethereum111k">
    <section className="ethereum111k__purchase" aria-label="111K testnet mint">
      <div className="ethereum111k__edition">
        <span>111K / {model.config.chainName}</span>
        <button type="button" className="ghost" onClick={() => model.owner ? model.disconnect() : wallet.connect()} disabled={Boolean(model.busy)} aria-label={model.owner ? 'Disconnect Ethereum wallet' : 'Connect Ethereum wallet'}>
          {wallet.status === 'connecting' || wallet.status === 'restoring' ? 'Connecting…' : model.owner ? `${connectedLabel} · Disconnect` : connectedLabel}
        </button>
      </div>
      <div className="ethereum111k__preview" key={kind}>
        <img src={image} alt={kind === 'crate' ? '111K crate' : '111K warehouse'} draggable={false} />
      </div>
      <form className="ethereum111k__mint" onSubmit={mint}>
        <div className="ethereum111k__product">
          <h1>111K</h1>
          <p>{kind === 'crate' ? 'A crate of 20 artworks. Crate #5555 holds 31.' : 'One warehouse. Eleven crates.'}</p>
        </div>
        <fieldset className="ethereum111k__types" disabled={disabled}>
          <legend className="sr-only">Choose a container</legend>
          {(['crate', 'warehouse'] as const).map(value => <label key={value} className={kind === value ? 'is-selected' : ''}>
            <input type="radio" name="ethereum-container" value={value} checked={kind === value} onChange={() => { setKind(value); setQuantity(1); }} />
            <span>{value === 'crate' ? 'Crate' : 'Warehouse'}</span>
          </label>)}
        </fieldset>
        <div className="ethereum111k__quantity">
          <label htmlFor="ethereum-mint-quantity">Quantity <output>{quantity}</output></label>
          <input id="ethereum-mint-quantity" type="range" min={1} max={Math.max(1, Math.min(model.config.maxMintQuantity, remaining ?? 15))} value={quantity} onChange={event => setQuantity(Number(event.target.value))} disabled={disabled} />
        </div>
        <button className="ethereum111k__primary" type="submit" disabled={disabled || !model.config.enabled || (Boolean(model.owner) && (!model.stats.data?.saleActive || !remaining))}>
          <span>{model.busy ?? (model.owner ? `Mint ${quantity} ${kind}${quantity > 1 ? 's' : ''}` : 'Connect Ethereum')}</span>
          <span>{price} ETH</span>
        </button>
        <div className="ethereum111k__availability" role="status">{totalState}</div>
        <p className="ethereum111k__test-note">Testnet only. Test ETH; no physical shipments.</p>
        {model.owner && model.chainId !== null && model.chainId !== model.config.chainId ? <p className="muted small">Your wallet will switch to {model.config.chainName} before the transaction.</p> : null}
      </form>
      {model.configQuery.error ? <div className="error" role="alert">Couldn’t load this drop. <button type="button" className="ghost" onClick={() => void model.configQuery.refetch()}>Retry</button></div> : null}
      {wallet.error && !model.owner ? <p className="error" role="alert">{wallet.error}</p> : null}
      {claimLinkKey && claimLinkHandled !== claimLinkKey ? <p className="muted small" role="status">Connect the Ethereum wallet that owns crate receipt #{Number(claimReceiptId) - 2_000_000} to claim its contents.</p> : null}
      {model.error ? <div className="error" role="alert">{model.error} <button type="button" className="ghost" onClick={model.clearError}>Dismiss</button></div> : null}
      {model.notice ? <p className="muted small" role="status">{model.notice}</p> : null}
      {model.storageWarning ? <p className="error" role="alert" style={{ overflowWrap: 'anywhere' }}>{model.storageWarning}</p> : null}
      {model.submission && !model.busy ? <div className="ethereum111k__pending" role="status">
        <span>Check your wallet. The previous transaction may have been sent.</span>
        <button type="button" className="ghost" onClick={() => { setRecoveryOpen(true); setReplacementHash(''); setConfirmDismiss(false); }}>Recover transaction</button>
      </div> : null}
      {model.pending ? <div className="ethereum111k__pending" role="status" aria-live="polite">
        <span>{model.pending.action === 'unbox' ? 'Opening your containers' : model.pending.action === 'delivery' ? 'Confirming your delivery' : model.pending.action === 'cancel' ? 'Confirming your wallet cancellation' : 'Confirming your transaction'} · {model.confirmations}/{model.requiredConfirmations}</span>
        {txLink ? <a href={txLink} target="_blank" rel="noreferrer">View transaction ↗</a> : null}
        {['delivery', 'claim'].includes(model.pending.action) && !model.session ? <button type="button" onClick={() => void model.signIn()} disabled={Boolean(model.busy)}>Sign in to finish</button> : null}
        <button type="button" className="ghost" onClick={model.refresh}>Refresh</button>
        <button type="button" className="ghost" onClick={() => { setRecoveryOpen(true); setReplacementHash(''); setConfirmDismiss(false); }} disabled={Boolean(model.busy)}>Transaction changed?</button>
      </div> : null}
    </section>
    <section className="app-section inventory-section ethereum111k__inventory" aria-label="Combined inventory">
      <div className="app-section__head"><div className="app-section__title">Inventory</div><button type="button" className="ghost" onClick={model.refresh} disabled={model.inventory.isFetching}>Refresh</button></div>
      <InventoryGrid items={inventoryItems} selected={combinedSelection} onToggle={select} pendingRevealIds={pendingRevealIds}
        onReveal={onSolanaReveal} canRevealItem={item => !isEthereumInventoryView(item) && canOpenSolanaBoxes(item.dropId)}
        onViewItem={view} revealLoadingId={solanaRevealLoading} revealDisabled={disabled} figureMediaMode="image"
        emptyStateVisibility={solanaInventoryReady && (!model.owner || !model.config.enabled || model.inventory.isFetched) ? 'visible' : 'hidden'}
        emptyStateContent={model.owner ? 'Your crates, warehouses and artworks appear here.' : 'Connect Ethereum to see your 111K collection.'} />
      {model.inventory.error ? <p className="error" role="alert">Couldn’t refresh Ethereum inventory. <button type="button" className="ghost" onClick={model.refresh}>Retry</button></p> : null}
      {model.inventory.hasNextPage ? <button type="button" className="ghost" onClick={() => void model.inventory.fetchNextPage()} disabled={model.inventory.isFetchingNextPage}>{model.inventory.isFetchingNextPage ? 'Loading…' : 'Load more Ethereum items'}</button> : null}
    </section>
    {model.owner ? <>
      <section className="app-section ethereum111k__receipts">
        <div className="app-section__head"><div className="app-section__title">111K receipts</div></div>
        <InventoryGrid items={receipts} interactionMode="view-only" onViewItem={view} emptyStateContent="Your delivery receipts appear here." figureMediaMode="image" />
      </section>
      <section className="app-section ethereum111k__shipments">
        <div className="app-section__head"><div className="app-section__title">111K shipments</div></div>
        {!model.session ? <button type="button" className="ghost" onClick={() => void model.signIn()} disabled={Boolean(model.busy)}>Sign in with Ethereum to see shipments</button> :
          model.shipments.isPending ? <p className="muted">Loading shipments…</p> : model.shipments.error ? <p className="error">Couldn’t load shipments. <button type="button" className="ghost" onClick={model.refresh}>Retry</button></p> :
          !model.shipments.data?.orders.length ? <p className="muted">No test shipments yet.</p> : <ol className="ethereum111k__orders">{model.shipments.data.orders.map(order => <li key={order.deliveryId}>
            <span>Shipment #{order.deliveryId} <small>{order.items.length} items</small></span>
            <span>{order.fulfillmentStatus ?? order.status}{order.fulfillmentTrackingCode ? ` · ${order.fulfillmentTrackingCode}` : ''}</span>
          </li>)}</ol>}
      </section>
    </> : null}
    {selectedItems.length ? <BackgroundLayerPortal><div className="selection-panel selection-panel--inventory ethereum111k__selection">
      <div className="selection-panel__left"><span>{selectedItems.length} selected{unboxLimitExceeded ? <small> · Open up to {model.config.maxUnboxQuantity} crates at once</small> : null}</span></div>
      <div className="selection-panel__actions">
        <button type="button" className="quiet" onClick={clear}>Cancel</button>
        {selectedItems.length === 1 ? <button type="button" onClick={() => setViewed(selectedItems[0])}>View</button> : null}
        {selectedContainer || selectedCrates ? <button type="button" onClick={() => void model.unbox(selectedItems)} disabled={disabled || unboxLimitExceeded}>
          {selectedItems.length === 1 ? `Open ${selectedContainer!.kind}` : `Open ${selectedItems.length} crates`}
        </button> : null}
        {canDeliver ? <button type="button" onClick={() => setDeliveryOpen(true)} disabled={disabled}>Send</button> : null}
      </div>
    </div></BackgroundLayerPortal> : null}
    <Modal open={walletPickerOpen} title="Connect Ethereum" onClose={wallet.cancel} suspended={suspended}>
      <div className="ethereum111k__wallets">{wallet.wallets.map((candidate, index) => {
        const icon = getInjectedWalletIconSrc(candidate.info.icon);
        return <button key={candidate.info.uuid} ref={index === 0 ? firstWalletRef : undefined} type="button" onClick={() => wallet.selectWallet(candidate)}>{icon ? <img src={icon} alt="" /> : null}{candidate.info.name}</button>;
      })}</div>
    </Modal>
    <Modal open={recoveryOpen && Boolean(model.pending || model.submission) && !model.revealed} title="Recover a pending transaction" onClose={() => { if (!model.busy) setRecoveryOpen(false); }} suspended={suspended}>
      <p className="muted small">{model.submission ? 'Paste the transaction hash from your wallet to resume tracking.' : 'If you sped up or cancelled the transaction in your wallet, paste its new transaction hash.'}</p>
      <form className="ethereum111k__receipt-form" onSubmit={async event => {
        event.preventDefault();
        if (await model.replacePending(replacementHash)) setRecoveryOpen(false);
      }}>
        <label>{model.submission ? 'Transaction hash' : 'Replacement transaction hash'}<input required value={replacementHash} onChange={event => setReplacementHash(event.target.value)} placeholder="0x…" autoComplete="off" spellCheck={false} /></label>
        {model.error ? <p className="error" role="alert">{model.error}</p> : null}
        <button type="submit" disabled={Boolean(model.busy)}>{model.busy ?? (model.submission ? 'Track transaction' : 'Use replacement transaction')}</button>
      </form>
      <div className="ethereum111k__stop-tracking">
        {confirmDismiss ? <>
          <p className="muted small">This only stops tracking here. The original transaction may still execute. Check your wallet before submitting another transaction.</p>
          <button type="button" onClick={() => { model.dismissPending(); setRecoveryOpen(false); }} disabled={Boolean(model.busy)}>Stop tracking this transaction</button>
        </> : <button type="button" className="ghost" onClick={() => setConfirmDismiss(true)} disabled={Boolean(model.busy)}>Stop tracking…</button>}
      </div>
    </Modal>
    <Modal open={Boolean(viewed) && !model.revealed} title={viewed?.name ?? '111K artwork'} onClose={() => { if (!model.busy) { setViewed(null); setReceiptAction(null); } }} className="ethereum111k__viewer" suspended={suspended}>
      {viewed ? <>
        <img className="ethereum111k__view-image" src={viewed.image} alt={viewed.name} />
        {viewed.description ? <p className="muted small">{viewed.description}</p> : null}
        {viewed.kind.endsWith('_receipt') ? <div className="ethereum111k__receipt-actions">
          <button type="button" onClick={() => { setReceiptAction('transfer'); setRecipient(''); }} disabled={disabled}>Transfer receipt</button>
          {viewed.kind === 'crate_receipt' ? <button type="button" onClick={() => { setReceiptAction('claim'); setClaimCode(viewed.tokenId === claimReceiptId ? linkedClaimCode ?? '' : ''); }} disabled={disabled}>Claim crate contents</button> : null}
        </div> : null}
        {receiptAction ? <form className="ethereum111k__receipt-form" onSubmit={event => { event.preventDefault(); if (!disabled) void (receiptAction === 'transfer' ? model.transfer(viewed, recipient) : model.claim(viewed, claimCode)); }}>
          <label>{receiptAction === 'transfer' ? 'Recipient Ethereum address' : 'Crate claim code'}<input required autoComplete="off" spellCheck={false} value={receiptAction === 'transfer' ? recipient : claimCode} onChange={event => receiptAction === 'transfer' ? setRecipient(event.target.value) : setClaimCode(event.target.value)} /></label>
          {model.error ? <p className="error" role="alert">{model.error}</p> : null}
          <button type="submit" disabled={disabled}>{model.busy ?? (receiptAction === 'transfer' ? 'Transfer' : 'Claim contents')}</button>
        </form> : null}
      </> : null}
    </Modal>
    <Modal open={deliveryOpen && !model.revealed} title="Send for delivery" onClose={() => { if (!model.busy) setDeliveryOpen(false); }} suspended={suspended}>
      <p className="muted small">{selectedItems.length} selected · test order, no physical shipment.</p>
      <DeliveryForm mode="modal" defaultEmail={model.profile.data?.email} submitDisabled={disabled || !canDeliver}
        submitLabel={`Send for ${formatEtherAmount(model.config.deliveryFeeWei)} ETH`}
        shippingNote={`Test delivery: ${formatEtherAmount(model.config.deliveryFeeWei)} ETH per order, up to ${model.config.maxDeliveryItems} items.`}
        onSubmit={async address => { await model.deliver(selectedItems, address); }} />
      {model.error ? <p className="error" role="alert">{model.error}</p> : null}
    </Modal>
    <Modal open={Boolean(model.revealed)} title={revealItems[0]?.kind === 'crate' ? 'Your crates' : 'Your artworks'} onClose={model.closeReveal} className="ethereum111k__reveal" suspended={suspended}>
      <p className="muted small">{revealItems.length} {revealItems[0]?.kind === 'crate' ? 'crates' : 'artworks'}</p>
      <div className="ethereum111k__reveal-grid">{revealItems.map((item, index) => <button type="button" key={item.id} style={{ animationDelay: `${Math.min(index, 10) * 35}ms` }} onClick={() => { model.closeReveal(); setViewed(item); }}><img src={item.image} alt={item.name} loading="lazy" decoding="async" /><span>{item.name}</span></button>)}</div>
    </Modal>
  </div>;
}
