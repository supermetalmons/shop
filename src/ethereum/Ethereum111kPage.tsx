import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ethereumItemDisplayIdMaximum, formatEtherAmount, type EthereumContainerKind } from '../../shared/ethereum/protocol';
import type { EthereumInventoryItem } from '../../shared/ethereum/api';
import { InventoryGrid } from '../components/InventoryGrid';
import { Modal } from '../components/Modal';
import { getInventoryRevealRect } from '../lib/inventoryMediaRect';
import { ShopSelectionBar } from '../shop/ui/ShopSelectionBar';
import { getInjectedWalletIconSrc } from '../wallet/injectedEthereumProviders';
import type { InventoryItem } from '../types';
import { EthereumMintPanel } from './EthereumMintPanel';
import { ethereumMintPrice, ethereumMintRemaining } from './mint';
import { ethereumInventoryView, isEthereumInventoryView, toggleEthereumSelection } from './state';
import { buildEthereumInventoryItems } from './inventory';
import { useEthereum111k, type EthereumWallet } from './useEthereum111k';
import { useEthereumMintAction } from './useEthereumMintAction';
import { useEthereumRelicClaimAction } from './useEthereumRelicClaimAction';
import { EthereumInventoryOverlays } from './EthereumInventoryOverlays';
import { useEthereumInventoryPresentation } from './useEthereumInventoryPresentation';

export type Ethereum111kPageProps = {
  header?: ReactNode;
  wallet: EthereumWallet;
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
  header, wallet, solanaInventoryItems, solanaSelected, onSolanaToggle, clearSolanaSelection,
  pendingRevealIds, onSolanaReveal, onSolanaView, canOpenSolanaBoxes, solanaRevealLoading,
  solanaInventoryReady, externalBusy = false, suspended = false, onModalOpenChange, showToast,
}: Ethereum111kPageProps) {
  const [kind, setKind] = useState<EthereumContainerKind>('crate');
  const model = useEthereum111k(wallet, kind, suspended);
  const relicMode = kind === 'relic';
  const publicKind = relicMode ? 'crate' : kind;
  const deploymentKey = `${model.config.chainId}:${model.config.contractAddress}`;
  const [relicSelection, setRelicSelection] = useState<{ deployment: string; owner: string | null; id: number } | null>(null);
  const previousRelicWallet = useRef({ deployment: deploymentKey, owner: model.owner, provider: wallet.provider });
  const selectedRelicId = relicSelection?.deployment === deploymentKey &&
    (relicSelection.owner === null || relicSelection.owner === model.owner) ? relicSelection.id : null;
  const relicData = model.relics.data?.chainId === model.config.chainId && model.relics.data.contractAddress === model.config.contractAddress &&
    model.relics.data.owner === model.owner ? model.relics.data : undefined;
  const [freshRelicRead, setFreshRelicRead] = useState(0);
  useEffect(() => {
    const remaining = model.relics.dataUpdatedAt + 8_000 - Date.now();
    if (!relicMode || suspended || !relicData || model.relics.error || remaining <= 0) { setFreshRelicRead(0); return; }
    setFreshRelicRead(model.relics.dataUpdatedAt);
    const timer = setTimeout(() => setFreshRelicRead(0), remaining);
    return () => clearTimeout(timer);
  }, [relicMode, suspended, relicData, model.relics.dataUpdatedAt, model.relics.error]);
  const relicReadFresh = Boolean(relicData && !model.relics.error && freshRelicRead === model.relics.dataUpdatedAt &&
    Date.now() - model.relics.dataUpdatedAt < 8_000);
  useLayoutEffect(() => {
    const previous = previousRelicWallet.current;
    previousRelicWallet.current = { deployment: deploymentKey, owner: model.owner, provider: wallet.provider };
    if (previous.deployment !== deploymentKey || previous.owner && (previous.owner !== model.owner || previous.provider !== wallet.provider)) {
      setRelicSelection(null);
    } else if (model.owner) {
      setRelicSelection(current => current?.owner === null ? { ...current, owner: model.owner } : current);
    }
  }, [deploymentKey, model.owner, wallet.provider]);
  useEffect(() => {
    if (selectedRelicId !== null && (model.pendingRelicIds.has(selectedRelicId) || relicData &&
      ((relicData.claimedMask & (1 << (selectedRelicId - 1))) !== 0 || relicData.remainingRelics === 0))) setRelicSelection(null);
  }, [selectedRelicId, relicData, model.pendingRelicIds]);

  const [quantity, setQuantity] = useState(1);
  const [selection, setSelection] = useState<{ scope: string | null; ids: Set<string> }>({ scope: null, ids: new Set() });
  const selected = useMemo(() => selection.scope === model.scope ? selection.ids : new Set<string>(), [selection, model.scope]);
  const itemsById = useMemo(() => new Map(model.items.map(item => [item.id, item])), [model.items]);
  const selectedItems = useMemo(() => [...selected].map(id => itemsById.get(id))
    .filter((item): item is EthereumInventoryItem => Boolean(item)), [selected, itemsById]);
  const walletPickerOpen = wallet.status === 'choosing';
  const actionBlocked = Boolean(model.busy || externalBusy || suspended);
  const remaining = relicMode ? relicData?.remainingRelics : model.mintSupply ? ethereumMintRemaining(publicKind, model.mintSupply) : undefined;
  const maxQuantity = relicMode ? 1 : Math.max(1, Math.min(model.config.maxMintQuantity, remaining ?? model.config.maxMintQuantity));
  const total = relicMode ? relicData?.relicsAllocated ?? 18 : ethereumItemDisplayIdMaximum(kind);
  const price = formatEtherAmount(BigInt(relicMode ? '0' : ethereumMintPrice(publicKind, model.stats.data ?? model.config)) * BigInt(quantity));
  const quote = relicMode ? null : model.mintQuote(publicKind, quantity);
  const discountPrice = quote?.discounted ? formatEtherAmount(BigInt(quote.unitPriceWei) * BigInt(quantity)) : price;
  const discountError = kind === 'crate' && model.discountCheckRequired && model.discountProof.error;
  const mintDataError = model.configQuery.error && !model.configQuery.data ? 'Couldn’t load this drop. Please try again.' :
    model.stats.error && !model.stats.data ? 'Couldn’t load availability. Please try again.' :
    discountError ? 'Couldn’t check your mint discount. Please try again.' : null;
  const mintAction = useEthereumMintAction({
    wallet, config: model.configQuery.data, kind: publicKind, quantity, remaining, saleActive: model.stats.data?.saleActive,
    loadError: mintDataError, blocked: actionBlocked || relicMode,
    priceKey: model.stats.data ? publicKind !== 'crate' ? ethereumMintPrice(publicKind, model.stats.data) :
      [model.stats.data.cratePriceWei, model.stats.data.discountCratePriceWei, model.stats.data.discountMerkleRoot].join(':') : undefined,
    suspended, onMint: model.mint, mintQuote: model.mintQuote,
  });
  const relicDataError = model.configQuery.error && !model.configQuery.data ? 'Couldn’t load this drop. Please try again.' :
    model.relics.error ? 'Couldn’t load relic availability. Please try again.' : null;
  const relicAction = useEthereumRelicClaimAction({ wallet, config: model.configQuery.data, active: relicMode,
    selectedId: selectedRelicId, status: relicReadFresh ? relicData : undefined, loadError: relicDataError,
    blocked: actionBlocked, suspended, onClaim: model.claimRelic });
  const panelActionPending = mintAction.pending || relicAction.pending;
  const kindDisabled = actionBlocked || panelActionPending || wallet.status === 'connecting' || walletPickerOpen;
  const mintDisabled = kindDisabled || Boolean(mintDataError) || model.configQuery.data?.enabled === false ||
    model.stats.data?.saleActive === false || remaining === 0 || quantity > maxQuantity;
  const relicDisabled = kindDisabled || !relicReadFresh || selectedRelicId === null || model.configQuery.data?.enabled !== true ||
    !relicData?.saleActive || relicData.remainingRelics === 0 || Boolean(model.owner && relicData.remainingAllowance === 0);
  const actionError = model.error || (relicMode ? relicAction.error : mintAction.error);
  const inventory = useMemo(() => buildEthereumInventoryItems({ items: model.items, pendingMints: model.pendingMints,
    solanaItems: solanaInventoryItems, dropId: model.config.dropId }), [model.items, model.pendingMints, model.config.dropId, solanaInventoryItems]);
  const combinedSelection = selected.size ? selected : solanaSelected;
  const onUnpack = (items: readonly EthereumInventoryItem[]) => {
    mintAction.clearError();
    relicAction.clearError();
    model.clearError();
    return model.unbox(items);
  };
  const presentation = useEthereumInventoryPresentation({ scope: model.scope, onUnpack,
    unpackResults: model.unpackResults, unpackErrors: model.unpackErrors, applyArtwork: model.applyArtwork, onError: showToast, suspended });
  const modalOpen = !suspended && (walletPickerOpen || presentation.open);
  useLayoutEffect(() => { onModalOpenChange?.(modalOpen); }, [modalOpen, onModalOpenChange]);
  useLayoutEffect(() => () => { onModalOpenChange?.(false); }, [onModalOpenChange]);
  useEffect(() => { if (!relicMode) setQuantity(current => Math.min(current, maxQuantity)); }, [maxQuantity, relicMode]);

  const announcedError = useRef<string | null>(null);
  const visibleError = wallet.error || actionError || mintDataError || (relicMode && relicDataError) ||
    (relicMode && model.relicMetadata.error ? 'Couldn’t load relic images. Please try again.' : null) ||
    (model.inventory.error ? 'Couldn’t load inventory. Please try again.' : null);
  useEffect(() => {
    if (!visibleError) announcedError.current = null;
    else if (showToast && announcedError.current !== visibleError) {
      announcedError.current = visibleError;
      showToast(visibleError);
    }
  }, [visibleError, showToast]);
  useEffect(() => {
    setSelection(current => {
      if (current.scope !== model.scope) return { scope: model.scope, ids: new Set() };
      if (!model.inventory.isSuccess) return current;
      const valid = new Set([...current.ids].filter(id => itemsById.has(id)));
      return valid.size === current.ids.size ? current : { ...current, ids: valid };
    });
  }, [itemsById, model.scope, model.inventory.isSuccess]);
  const clear = useCallback(() => setSelection({ scope: model.scope, ids: new Set() }), [model.scope]);
  useEffect(() => {
    if (!selected.size || suspended || walletPickerOpen || presentation.open) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      clear();
    };
    document.addEventListener('keydown', dismiss);
    return () => document.removeEventListener('keydown', dismiss);
  }, [selected.size, suspended, walletPickerOpen, presentation.open, clear]);
  const select = (id: string) => {
    if (suspended || inventory.busyItemIds.has(id)) return;
    const item = itemsById.get(id);
    if (item) {
      clearSolanaSelection();
      setSelection(current => ({ scope: model.scope, ids: toggleEthereumSelection(
        current.scope === model.scope ? current.ids : new Set(), item) }));
    } else if (!externalBusy) { clear(); onSolanaToggle(id); }
  };
  const view = (item: InventoryItem, rect: DOMRect) => {
    if (suspended || inventory.busyItemIds.has(item.id)) return;
    if (isEthereumInventoryView(item)) {
      if (presentation.openViewer(item.ethereum, rect)) { clearSolanaSelection(); clear(); }
    } else onSolanaView(item, rect);
  };
  const itemRect = (item: EthereumInventoryItem) => {
    const target = document.querySelector<HTMLElement>(`[data-inventory-id="${item.id}"]`);
    return target ? getInventoryRevealRect(target) : undefined;
  };
  const selectedViews = selectedItems.map(item => ethereumInventoryView(item, model.config.dropId));
  const selectedContainer = selectedItems.length === 1 && ['crate', 'warehouse', 'relic'].includes(selectedItems[0].kind) ? selectedItems[0] : null;
  const canOpenSelected = Boolean(selectedContainer);
  const selectedPending = selectedItems.some(item => model.pendingItemIds.has(item.id));
  const mintStatus = model.configQuery.data?.enabled === false ? 'Mint unavailable' : model.stats.data && !model.stats.data.saleActive ? 'Minting is paused' : undefined;
  const relicStatus = model.configQuery.data?.enabled === false || relicDataError ? 'Unavailable' :
    !relicReadFresh ? 'Loading…' : !relicData?.saleActive ? 'Paused' : relicData.remainingRelics === 0 ? 'Sold out' :
    model.owner ? relicData.relicLimit === 0 ? 'Not eligible' : `${relicData.remainingAllowance} claims left` : undefined;
  const claimedRelicMask = [...model.pendingRelicIds].reduce((mask, id) => mask | (1 << (id - 1)), relicData?.claimedMask ?? 0);

  return <>
    <div className="drop-page-frame drop-page-frame--active">
      {header}
      <EthereumMintPanel kind={kind} kindDisabled={kindDisabled}
        onKindChange={value => { if (!kindDisabled && value !== kind) { mintAction.clearError(); relicAction.clearError(); setKind(value); } }}
        quantity={relicMode ? 1 : quantity} maxQuantity={maxQuantity} remaining={remaining} total={total} price={price}
        discountPrice={discountPrice} useDiscountMint={Boolean(quote?.discounted)}
        statusText={relicMode ? relicStatus : mintStatus} disabled={Boolean(relicMode ? relicDisabled : mintDisabled)} busy={panelActionPending}
        relicMetadata={model.relicMetadata.data} claimedRelicMask={claimedRelicMask} selectedRelicId={selectedRelicId}
        relicSelectionDisabled={kindDisabled || !relicReadFresh || relicData?.remainingRelics === 0}
        onRelicSelect={id => { relicAction.clearError(); model.clearError(); setRelicSelection({ deployment: deploymentKey, owner: model.owner, id }); }}
        onQuantityChange={setQuantity} onMint={() => { model.clearError(); (relicMode ? relicAction.claim : mintAction.mint)(); }} />
    </div>
    <section className="app-section inventory-section" aria-label="Combined inventory">
      <div className="app-section__head"><div className="app-section__title">Inventory</div></div>
      <InventoryGrid items={inventory.items} selected={combinedSelection} onToggle={select} busyItemIds={inventory.busyItemIds}
        pendingRevealIds={pendingRevealIds} onReveal={onSolanaReveal}
        canRevealItem={item => !isEthereumInventoryView(item) && canOpenSolanaBoxes(item.dropId)}
        onViewItem={view} revealLoadingId={solanaRevealLoading} revealDisabled={externalBusy || suspended} figureMediaMode="image"
        emptyStateVisibility={solanaInventoryReady && (!model.owner || !model.config.enabled || model.inventory.isFetched) ? 'visible' : 'hidden'} />
    </section>
    <ShopSelectionBar selectedCount={selectedItems.length}
      selectedPreview={selectedViews.slice(0, 5).map(item => ({ item, previewImage: item.image }))}
      selectedOverflow={Math.max(0, selectedViews.length - 5)} canViewSelected={selectedItems.length === 1}
      canOpenSelected={canOpenSelected} canShipSelected={false} hasPreorderSelected={false}
      selectedBox={canOpenSelected ? selectedViews[0] : null} clearSelection={clear}
      handleViewSelectedItem={() => { if (selectedItems[0] && presentation.openViewer(selectedItems[0], itemRect(selectedItems[0]))) clear(); }}
      handleOpenSelectedBox={() => { if (canOpenSelected && !selectedPending && presentation.openUnpack(selectedItems, itemRect(selectedItems[0]))) clear(); }}
      handleOpenShip={() => {}} walletActionBusy={actionBlocked || selectedPending} startOpenLoading={null}
      openActionLabelForDropId={() => 'Open'} openActionProgressForDropId={() => 'Opening…'} />
    <EthereumInventoryOverlays presentation={presentation} suspended={suspended} />
    <Modal open={walletPickerOpen} title="Connect wallet" onClose={() => {
      if (mintAction.connecting) mintAction.cancel(); else if (relicAction.connecting) relicAction.cancel(); else wallet.cancel();
    }} suspended={suspended}>
      <div className="ethereum111k__wallets">{wallet.wallets.map(candidate => {
        const icon = getInjectedWalletIconSrc(candidate.info.icon);
        return <button key={candidate.info.uuid} type="button" onClick={() => wallet.selectWallet(candidate)}>
          {icon ? <img src={icon} alt="" /> : null}{candidate.info.name}
        </button>;
      })}</div>
    </Modal>
  </>;
}
