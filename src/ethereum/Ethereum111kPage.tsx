import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ethereumExplorerTransaction } from '../../shared/ethereum/config';
import { ETHEREUM_CHECKOUT_ID, checkoutEntryUrl, type EthereumCheckoutStatusResponse } from '../../shared/ethereum/checkout';
import { ETHEREUM_MAX_EXPECTED_IDS, ethereumItemDisplayIdMaximum, ethereumReceiptTokenId, formatEtherAmount, type EthereumMintKind } from '../../shared/ethereum/protocol';
import type { EthereumInventoryItem } from '../../shared/ethereum/api';
import { InventoryGrid } from '../components/InventoryGrid';
import { Modal } from '../components/Modal';
import { BackgroundLayerPortal } from '../components/BackgroundBlurLayer';
import { getInjectedWalletIconSrc } from '../wallet/injectedEthereumProviders';
import { navigate } from '../navigation';
import type { InventoryItem } from '../types';
import { EthereumMintPanel } from './EthereumMintPanel';
import { ethereumMintPrice, ethereumMintRemaining } from './mint';
import { ethereumInventoryQueryKey, ethereumInventoryScope, ethereumInventoryView, isEthereumInventoryView, readEthereumExpected, toggleEthereumSelection, writeEthereumExpected } from './state';
import { useEthereum111k, type EthereumWallet } from './useEthereum111k';
import { useEthereumMintAction } from './useEthereumMintAction';
import { EthereumCheckoutReturn, type EthereumCheckoutReturnStatus } from './EthereumCheckoutReturn';
import { EthereumArtworkMedia } from './EthereumArtworkMedia';
import { checkoutReservesItems, useCheckoutReservations } from './checkoutReservations';

export type Ethereum111kPageProps = {
  header?: ReactNode;
  wallet: EthereumWallet;
  claimReceiptId?: string;
  claimCode?: string;
  checkoutReturnId?: string;
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
  onModalOpenChange?: (open: boolean) => void;
  showToast?: (message: string) => void;
};

export default function Ethereum111kPage({
  header, wallet, claimReceiptId, claimCode: linkedClaimCode, checkoutReturnId, addressEncryptionPublicKey, solanaInventoryItems, solanaSelected, onSolanaToggle, clearSolanaSelection,
  pendingRevealIds, onSolanaReveal, onSolanaView, canOpenSolanaBoxes, solanaRevealLoading,
  solanaInventoryReady, externalBusy = false, suspended = false, onModalOpenChange, showToast,
}: Ethereum111kPageProps) {
  const [kind, setKind] = useState<EthereumMintKind>('crate');
  const model = useEthereum111k(wallet, addressEncryptionPublicKey, kind);
  const queryClient = useQueryClient();
  const onCheckoutConfirmed = useCallback((checkout: EthereumCheckoutStatusResponse) => {
    const scope = ethereumInventoryScope(checkout.config, checkout.wallet);
    if (!scope || checkout.status !== 'success' || !checkout.transactionHash) return;
    const mintedIds = checkout.items.flatMap(item => item.kind === 'crate' || item.kind === 'artwork'
      ? [ethereumReceiptTokenId(item.kind, item.displayId)] : []);
    writeEthereumExpected(scope, [...new Set([...readEthereumExpected(scope), ...checkout.tokenIds, ...mintedIds])]
      .slice(-ETHEREUM_MAX_EXPECTED_IDS));
    if (scope === model.scope) void queryClient.cancelQueries({ queryKey: ethereumInventoryQueryKey(scope) }).then(model.refresh);
  }, [model.refresh, model.scope, queryClient]);
  const [quantity, setQuantity] = useState(1);
  const [selection, setSelection] = useState<{ scope: string | null; ids: Set<string> }>({ scope: null, ids: new Set() });
  const [viewed, setViewed] = useState<EthereumInventoryItem | null>(null);
  const [receiptAction, setReceiptAction] = useState<'transfer' | 'claim' | null>(null);
  const [recipient, setRecipient] = useState('');
  const [claimCode, setClaimCode] = useState('');
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [replacementHash, setReplacementHash] = useState('');
  const [confirmDismiss, setConfirmDismiss] = useState(false);
  const [claimLinkHandled, setClaimLinkHandled] = useState<string | null>(null);
  const [dismissedClaimConnection, setDismissedClaimConnection] = useState<string | null>(null);
  const [checkoutReturnStatus, setCheckoutReturnStatus] = useState<EthereumCheckoutReturnStatus | null>(null);
  const checkoutReturnRef = useRef(checkoutReturnStatus);
  const onCheckoutStatus = useCallback((status: EthereumCheckoutReturnStatus) => {
    checkoutReturnRef.current = status;
    setCheckoutReturnStatus(status);
  }, []);
  useCheckoutReservations(model.owner, model.config.chainId, model.config.contractAddress);
  const firstWalletRef = useRef<HTMLButtonElement>(null);
  const announcedError = useRef<string | null>(null);
  const previousWalletScope = useRef({ scope: model.scope, chainId: model.chainId, provider: wallet.provider });
  const selected = useMemo(() => selection.scope === model.scope ? selection.ids : new Set<string>(), [selection, model.scope]);
  const itemsById = useMemo(() => new Map(model.items.map(item => [item.id, item])), [model.items]);
  const selectedItems = useMemo(() => [...selected].map(id => itemsById.get(id)).filter((item): item is EthereumInventoryItem => Boolean(item)), [selected, itemsById]);
  const checkoutBlocksUnbox = (items: readonly EthereumInventoryItem[], observed = checkoutReturnRef.current): boolean => {
    if (checkoutReservesItems(items)) return true;
    if (!checkoutReturnId || !ETHEREUM_CHECKOUT_ID.test(checkoutReturnId)) return false;
    if (observed?.checkoutId !== checkoutReturnId) return true;
    if (observed.status !== 'pending' && observed.status !== 'submitting') return false;
    return items.some(item => (!observed.wallet || observed.wallet === item.owner) && observed.chainId === item.chainId &&
      observed.contractAddress === item.contractAddress && observed.tokenIds.includes(item.tokenId));
  };
  const checkoutBlocksUnboxRef = useRef(checkoutBlocksUnbox);
  checkoutBlocksUnboxRef.current = checkoutBlocksUnbox;
  const operationBlocked = Boolean(model.busy || model.pending || model.submission || externalBusy || suspended);
  const walletPickerOpen = wallet.status === 'choosing';
  const hasSubmittedTransaction = Boolean(model.pending || (model.submission && !model.busy));
  const remaining = model.stats.data ? ethereumMintRemaining(kind, model.stats.data) : undefined;
  const maxQuantity = Math.max(1, Math.min(model.config.maxMintQuantity, remaining ?? model.config.maxMintQuantity));
  const total = ethereumItemDisplayIdMaximum(kind);
  const unitPrice = ethereumMintPrice(kind, model.stats.data ?? model.config);
  const price = formatEtherAmount(BigInt(unitPrice) * BigInt(quantity));
  const quote = model.mintQuote(kind, quantity);
  const discountPrice = quote?.discounted ? formatEtherAmount(BigInt(quote.unitPriceWei) * BigInt(quantity)) : price;
  const discountError = kind === 'crate' && model.discountCheckRequired && model.discountProof.error;
  const mintDataError = model.configQuery.error && !model.configQuery.data ? 'Couldn’t load this drop. Please try again.' :
    model.stats.error && !model.stats.data ? 'Couldn’t load availability. Please try again.' :
    discountError ? 'Couldn’t check your mint discount. Please try again.' : null;
  const mintAction = useEthereumMintAction({
    wallet, config: model.configQuery.data, kind, quantity, remaining, saleActive: model.stats.data?.saleActive,
    loadError: mintDataError, blocked: operationBlocked,
    priceKey: model.stats.data ? kind !== 'crate' ? ethereumMintPrice(kind, model.stats.data) :
      [model.stats.data.cratePriceWei, model.stats.data.discountCratePriceWei, model.stats.data.discountMerkleRoot].join(':') : undefined,
    suspended, onMint: model.mint, mintQuote: model.mintQuote,
  });
  const disabled = operationBlocked || mintAction.pending;
  const connectingWallet = wallet.status === 'connecting' || wallet.status === 'restoring' || walletPickerOpen;
  const kindDisabled = disabled || wallet.status === 'connecting' || walletPickerOpen;
  const mintDisabled = kindDisabled || Boolean(mintDataError) || model.configQuery.data?.enabled === false ||
    model.stats.data?.saleActive === false || remaining === 0 || quantity > maxQuantity;
  const actionError = model.error || mintAction.error;
  const ethereumItems = useMemo(() => model.items.filter(item => !item.kind.endsWith('_receipt')).map(ethereumInventoryView), [model.items]);
  const receipts = useMemo(() => model.items.filter(item => item.kind.endsWith('_receipt')).map(ethereumInventoryView), [model.items]);
  const inventoryItems = useMemo(() => [...ethereumItems, ...solanaInventoryItems], [ethereumItems, solanaInventoryItems]);
  const combinedSelection = useMemo(() => selected.size ? selected : solanaSelected, [selected, solanaSelected]);
  const selectedContainer = selectedItems.length === 1 && ['crate', 'warehouse', 'monument'].includes(selectedItems[0].kind) ? selectedItems[0] : null;
  const selectedCrates = selectedItems.length > 0 && selectedItems.every(item => item.kind === 'crate');
  const unboxLimitExceeded = selectedCrates && selectedItems.length > model.config.maxUnboxQuantity;
  const canDeliver = selectedItems.length > 0 && selectedItems.length <= model.config.maxDeliveryItems && selectedItems.every(item => ['crate', 'artwork'].includes(item.kind));
  const checkoutUnboxBlocked = selectedItems.length > 0 && checkoutBlocksUnbox(selectedItems, checkoutReturnStatus);
  const txLink = model.pending ? ethereumExplorerTransaction(model.config, model.pending.hash) : null;
  const claimLinkKey = claimReceiptId && linkedClaimCode ? `${claimReceiptId}:${linkedClaimCode}` : null;
  const claimConnectionOpen = Boolean(claimLinkKey && claimLinkHandled !== claimLinkKey && dismissedClaimConnection !== claimLinkKey &&
    !model.owner && !walletPickerOpen && !mintAction.pending);
  const revealOpen = Boolean(model.revealed);
  const viewerOpen = Boolean(viewed) && !revealOpen;
  const recoveryDialogOpen = recoveryOpen && Boolean(model.pending || model.submission) && !revealOpen;
  const modalOpen = !suspended && (walletPickerOpen || claimConnectionOpen || recoveryDialogOpen || viewerOpen || revealOpen);
  useLayoutEffect(() => { onModalOpenChange?.(modalOpen); }, [modalOpen, onModalOpenChange]);
  useLayoutEffect(() => () => { onModalOpenChange?.(false); }, [onModalOpenChange]);
  useEffect(() => {
    setQuantity(current => Math.min(current, maxQuantity));
  }, [maxQuantity]);
  useEffect(() => {
    const error = wallet.error || actionError;
    if (!error) {
      announcedError.current = null;
    } else if (showToast && announcedError.current !== error) {
      announcedError.current = error;
      showToast(error);
    }
  }, [wallet.error, actionError, showToast]);

  useEffect(() => {
    const previous = previousWalletScope.current;
    previousWalletScope.current = { scope: model.scope, chainId: model.chainId, provider: wallet.provider };
    if (previous.scope === model.scope && previous.provider === wallet.provider &&
      (previous.chainId === null || previous.chainId === model.chainId || model.chainId === model.config.chainId)) return;
    setSelection({ scope: model.scope, ids: new Set() });
    setViewed(null);
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
    if (mintAction.pending || !claimLinkKey || claimLinkHandled === claimLinkKey || !linkedClaimCode) return;
    const receipt = model.items.find(item => item.tokenId === claimReceiptId && item.kind === 'crate_receipt');
    if (!receipt) return;
    clearSolanaSelection();
    setRecoveryOpen(false);
    setConfirmDismiss(false);
    setViewed(receipt);
    setReceiptAction('claim');
    setClaimCode(linkedClaimCode);
    setClaimLinkHandled(claimLinkKey);
  }, [mintAction.pending, claimLinkKey, claimLinkHandled, claimReceiptId, linkedClaimCode, model.items, clearSolanaSelection]);
  useEffect(() => {
    setRecoveryOpen(false);
    setReplacementHash('');
    setConfirmDismiss(false);
  }, [model.pending?.hash, model.submission?.submittedAt, model.scope]);
  useEffect(() => {
    if (hasSubmittedTransaction) {
      setSelection({ scope: model.scope, ids: new Set() });
      setViewed(null);
      setReceiptAction(null);
    }
  }, [model.pending?.hash, model.submission?.submittedAt, model.scope, hasSubmittedTransaction]);
  useEffect(() => {
    if (!model.revealed) return;
    setViewed(null);
    setRecoveryOpen(false);
    setReceiptAction(null);
  }, [model.revealed]);
  useEffect(() => {
    if (!selected.size || disabled || viewed || recoveryOpen || walletPickerOpen || model.revealed) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      setSelection({ scope: model.scope, ids: new Set() });
    };
    document.addEventListener('keydown', dismiss);
    return () => document.removeEventListener('keydown', dismiss);
  }, [selected.size, disabled, viewed, recoveryOpen, walletPickerOpen, model.revealed, model.scope]);
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
  const runAction = <T,>(action: () => T): T => {
    mintAction.clearError();
    model.clearError();
    return action();
  };
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
    if (mintAction.pending) return;
    if (isEthereumInventoryView(item)) {
      clearSolanaSelection();
      setViewed(item.ethereum);
      setReceiptAction(null);
    } else onSolanaView(item, rect);
  };
  const mintStatus = model.configQuery.data?.enabled === false ? 'Mint unavailable' :
    model.stats.data && !model.stats.data.saleActive ? 'Minting is paused' : undefined;
  const revealItems = model.revealed ?? [];
  const viewedArtwork = viewed ? model.applyArtwork(viewed) : null;

  return <>
    <div className="drop-page-frame drop-page-frame--active">
      {header}
      <EthereumMintPanel kind={kind} kindDisabled={kindDisabled}
        onKindChange={value => { if (!kindDisabled && value !== kind) { mintAction.clearError(); setKind(value); } }}
        quantity={quantity} maxQuantity={maxQuantity} remaining={remaining} total={total} price={price}
        discountPrice={discountPrice} useDiscountMint={Boolean(quote?.discounted)}
        statusText={mintStatus} disabled={Boolean(mintDisabled)} busy={mintAction.pending}
        onQuantityChange={setQuantity} onMint={() => runAction(mintAction.mint)} />
    </div>
    <div className="ethereum111k">
      <div className="ethereum111k__status">
        {checkoutReturnId ? <EthereumCheckoutReturn checkoutId={checkoutReturnId} onConfirmed={onCheckoutConfirmed} onStatus={onCheckoutStatus} /> : null}
        {model.configQuery.error ? <div className="error" role="alert">Couldn’t load this drop. <button type="button" className="ghost" onClick={() => void model.configQuery.refetch()}>Retry</button></div> : null}
        {model.stats.error || discountError ? <div className="error" role="alert">{discountError ? 'Couldn’t check your mint discount.' : 'Couldn’t load availability.'} <button type="button" className="ghost" onClick={model.refresh}>Retry</button></div> : null}
        {wallet.error && !model.owner ? <p className="error" role="alert">{wallet.error}</p> : null}
        {claimLinkKey && claimLinkHandled !== claimLinkKey ? <p className="muted small" role="status">
          {model.owner ? `Looking for crate receipt #${Number(claimReceiptId) - 2_000_000} in your wallet.` :
            <button type="button" className="ghost" onClick={() => setDismissedClaimConnection(null)}>Claim crate contents</button>}
        </p> : null}
        {actionError ? <div className="error" role="alert">{actionError} <button type="button" className="ghost" onClick={() => { mintAction.clearError(); model.clearError(); }}>Dismiss</button></div> : null}
        {model.notice ? <p className="muted small" role="status">{model.notice}</p> : null}
        {model.storageWarning ? <p className="error" role="alert" style={{ overflowWrap: 'anywhere' }}>{model.storageWarning}</p> : null}
        {model.submission && !model.busy ? <div className="ethereum111k__pending" role="status">
          <span>Check your wallet. The previous transaction may have been sent.</span>
          <button type="button" className="ghost" onClick={() => { setRecoveryOpen(true); setReplacementHash(''); setConfirmDismiss(false); }}>Recover transaction</button>
        </div> : null}
        {model.pending ? <div className="ethereum111k__pending" role="status" aria-live="polite">
          <span>{model.pending.action === 'unbox' ? 'Opening your containers' : model.pending.action === 'delivery' ? 'Confirming your delivery' : model.pending.action === 'cancel' ? 'Confirming your wallet cancellation' : 'Confirming your transaction'} · {model.confirmations}/{model.requiredConfirmations}</span>
          {txLink ? <a href={txLink} target="_blank" rel="noreferrer">View transaction ↗</a> : null}
          {['delivery', 'claim'].includes(model.pending.action) && !model.session ? <button type="button" onClick={() => void runAction(model.signIn)} disabled={Boolean(model.busy || mintAction.pending)}>Sign in to finish</button> : null}
          <button type="button" className="ghost" onClick={model.refresh}>Refresh</button>
          <button type="button" className="ghost" onClick={() => { setRecoveryOpen(true); setReplacementHash(''); setConfirmDismiss(false); }} disabled={Boolean(model.busy)}>Transaction changed?</button>
        </div> : null}
      </div>
      <section className="app-section inventory-section ethereum111k__inventory" aria-label="Combined inventory">
        <div className="app-section__head">
          <div className="app-section__title">Inventory</div>
          {model.owner ? <button type="button" className="ghost" onClick={model.refresh} disabled={model.inventory.isFetching}>Refresh</button> :
            <button type="button" className="ghost" onClick={() => { mintAction.cancel(); wallet.connect(); }} disabled={disabled || connectingWallet}>View collection</button>}
        </div>
        <InventoryGrid items={inventoryItems} selected={combinedSelection} onToggle={select} pendingRevealIds={pendingRevealIds}
          onReveal={onSolanaReveal} canRevealItem={item => !isEthereumInventoryView(item) && canOpenSolanaBoxes(item.dropId)}
          onViewItem={view} revealLoadingId={solanaRevealLoading} revealDisabled={disabled} figureMediaMode="image"
          emptyStateVisibility={solanaInventoryReady && (!model.owner || !model.config.enabled || model.inventory.isFetched) ? 'visible' : 'hidden'}
          emptyStateContent={model.owner ? 'Your crates, warehouses, monuments and artworks appear here.' : 'Connect Ethereum to see your 111K collection.'} />
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
          {!model.session ? <button type="button" className="ghost" onClick={() => void runAction(model.signIn)} disabled={Boolean(model.busy || mintAction.pending)}>Sign in with Ethereum to see shipments</button> :
            model.shipments.isPending ? <p className="muted">Loading shipments…</p> : model.shipments.error ? <p className="error">Couldn’t load shipments. <button type="button" className="ghost" onClick={model.refresh}>Retry</button></p> :
            !model.shipments.data?.orders.length ? <p className="muted">No test shipments yet.</p> : <ol className="ethereum111k__orders">{model.shipments.data.orders.map(order => <li key={order.deliveryId}>
              <span>Shipment #{order.deliveryId} <small>{order.items.length} items</small></span>
              <span>{order.fulfillmentStatus ?? order.status}{order.fulfillmentTrackingCode ? ` · ${order.fulfillmentTrackingCode}` : ''}</span>
            </li>)}</ol>}
        </section>
      </> : null}
      {selectedItems.length ? <BackgroundLayerPortal><div className="selection-panel selection-panel--inventory ethereum111k__selection">
        <div className="selection-panel__left"><span>{selectedItems.length} selected{unboxLimitExceeded ? <small> · Open up to {model.config.maxUnboxQuantity} crates at once</small> : null}
          {checkoutUnboxBlocked ? <small> · {checkoutReturnId && checkoutReturnStatus?.checkoutId !== checkoutReturnId ? 'Checking redemption…' : 'Redemption pending'}</small> : null}
        </span></div>
        <div className="selection-panel__actions">
          <button type="button" className="quiet" onClick={clear}>Cancel</button>
          {selectedItems.length === 1 ? <button type="button" onClick={() => setViewed(selectedItems[0])} disabled={mintAction.pending}>View</button> : null}
          {selectedContainer || selectedCrates ? <button type="button" onClick={() => {
            if (!checkoutBlocksUnbox(selectedItems)) void runAction(() => model.unbox(selectedItems, () => !checkoutBlocksUnboxRef.current(selectedItems)));
          }} disabled={disabled || unboxLimitExceeded || checkoutUnboxBlocked}>
            {selectedItems.length === 1 ? `Open ${selectedContainer!.kind}` : `Open ${selectedItems.length} crates`}
          </button> : null}
          {canDeliver ? <button type="button" onClick={() => navigate(checkoutEntryUrl(selectedItems.map(item => item.tokenId)))} disabled={disabled}>Send</button> : null}
        </div>
      </div></BackgroundLayerPortal> : null}
      <Modal open={claimConnectionOpen} title="Claim crate contents" onClose={() => { setDismissedClaimConnection(claimLinkKey); wallet.cancel(); }} suspended={suspended}>
        <p className="muted small">Connect the wallet that owns crate receipt #{Number(claimReceiptId) - 2_000_000} to claim its contents.</p>
        <button type="button" onClick={() => { mintAction.cancel(); wallet.connect(); }} disabled={connectingWallet}>
          {connectingWallet ? 'Connecting…' : 'Connect wallet'}
        </button>
        {wallet.error ? <p className="error" role="alert">{wallet.error}</p> : null}
      </Modal>
      <Modal open={walletPickerOpen} title="Connect Ethereum" onClose={() => { if (mintAction.connecting) mintAction.cancel(); else wallet.cancel(); }} suspended={suspended}>
        <div className="ethereum111k__wallets">{wallet.wallets.map((candidate, index) => {
          const icon = getInjectedWalletIconSrc(candidate.info.icon);
          return <button key={candidate.info.uuid} ref={index === 0 ? firstWalletRef : undefined} type="button" onClick={() => wallet.selectWallet(candidate)}>{icon ? <img src={icon} alt="" /> : null}{candidate.info.name}</button>;
        })}</div>
      </Modal>
      <Modal open={recoveryDialogOpen} title="Recover a pending transaction" onClose={() => { if (!model.busy) setRecoveryOpen(false); }} suspended={suspended}>
        <p className="muted small">{model.submission ? 'Paste the transaction hash from your wallet to resume tracking.' : 'If you sped up or cancelled the transaction in your wallet, paste its new transaction hash.'}</p>
        <form className="ethereum111k__receipt-form" onSubmit={async event => {
          event.preventDefault();
          if (await runAction(() => model.replacePending(replacementHash))) setRecoveryOpen(false);
        }}>
          <label>{model.submission ? 'Transaction hash' : 'Replacement transaction hash'}<input required value={replacementHash} onChange={event => setReplacementHash(event.target.value)} placeholder="0x…" autoComplete="off" spellCheck={false} /></label>
          {model.error ? <p className="error" role="alert">{model.error}</p> : null}
          <button type="submit" disabled={Boolean(model.busy)}>{model.busy ?? (model.submission ? 'Track transaction' : 'Use replacement transaction')}</button>
        </form>
        <div className="ethereum111k__stop-tracking">
          {confirmDismiss ? <>
            <p className="muted small">This only stops tracking here. The original transaction may still execute. Check your wallet before submitting another transaction.</p>
            <button type="button" onClick={() => { runAction(model.dismissPending); setRecoveryOpen(false); }} disabled={Boolean(model.busy)}>Stop tracking this transaction</button>
          </> : <button type="button" className="ghost" onClick={() => setConfirmDismiss(true)} disabled={Boolean(model.busy)}>Stop tracking…</button>}
        </div>
      </Modal>
      <Modal open={viewerOpen} title={viewedArtwork?.name ?? '111K artwork'} onClose={() => { if (!model.busy) { setViewed(null); setReceiptAction(null); } }} className="ethereum111k__viewer" suspended={suspended}>
        {viewed ? <>
          <EthereumArtworkMedia item={viewedArtwork!} viewer />
          {viewedArtwork?.description ? <p className="muted small">{viewedArtwork.description}</p> : null}
          {viewed.kind.endsWith('_receipt') ? <div className="ethereum111k__receipt-actions">
            <button type="button" onClick={() => { setReceiptAction('transfer'); setRecipient(''); }} disabled={disabled}>Transfer receipt</button>
            {viewed.kind === 'crate_receipt' ? <button type="button" onClick={() => { setReceiptAction('claim'); setClaimCode(viewed.tokenId === claimReceiptId ? linkedClaimCode ?? '' : ''); }} disabled={disabled}>Claim crate contents</button> : null}
          </div> : null}
          {receiptAction ? <form className="ethereum111k__receipt-form" onSubmit={event => { event.preventDefault(); if (!disabled) void runAction(() => receiptAction === 'transfer' ? model.transfer(viewed, recipient) : model.claim(viewed, claimCode)); }}>
            <label>{receiptAction === 'transfer' ? 'Recipient Ethereum address' : 'Crate claim code'}<input required autoComplete="off" spellCheck={false} value={receiptAction === 'transfer' ? recipient : claimCode} onChange={event => receiptAction === 'transfer' ? setRecipient(event.target.value) : setClaimCode(event.target.value)} /></label>
            {model.error ? <p className="error" role="alert">{model.error}</p> : null}
            <button type="submit" disabled={disabled}>{model.busy ?? (receiptAction === 'transfer' ? 'Transfer' : 'Claim contents')}</button>
          </form> : null}
        </> : null}
      </Modal>
      <Modal open={revealOpen} title={revealItems[0]?.kind === 'crate' ? 'Your crates' : 'Your artworks'} onClose={model.closeReveal} className="ethereum111k__reveal" suspended={suspended}>
        <p className="muted small">{revealItems.length} {revealItems[0]?.kind === 'crate' ? 'crates' : 'artworks'}</p>
        <div className="ethereum111k__reveal-grid">{revealItems.map((item, index) => {
          return <button type="button" key={item.id} style={{ animationDelay: `${Math.min(index, 10) * 35}ms` }} onClick={() => { model.closeReveal(); setViewed(item); }}>
            <EthereumArtworkMedia item={item} />
            <span>{item.name}</span>
          </button>;
        })}</div>
      </Modal>
    </div>
  </>;
}
