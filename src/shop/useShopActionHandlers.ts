import { useRef } from 'react';
import type { InventoryItem } from '../types';
import type { PreorderCheckout } from '../hooks/usePreorderCheckout';
import { profileApiTimeoutMs } from '../api/transport';
import { hasAlphabeticClaimCodeCharacters, isStripeReceiptClaimCode } from '../lib/stripeReceiptClaims';
import type { useShopActionContinuation } from './account/useShopActionContinuation';
import type { useShopInventoryQueries } from './inventory/useShopInventoryQueries';
import type { useShopInventorySelectionState, ShopInventorySelection } from './inventory/useShopInventorySelection';
import type { useShopInventoryView } from './inventory/useShopInventoryView';
import type { useShopPurchaseActions } from './purchase/useShopPurchaseActions';
import type { useCommerceModals } from './commerce/useCommerceModals';
import type { useDeliveryActions } from './commerce/useDeliveryActions';
import type { useClaimActions } from './commerce/useClaimActions';
import type { useReceiptActions } from './commerce/useReceiptActions';
import type { ShopRevealController } from './reveal/useShopReveal';
import { isUserRejectedError } from './commerce/transactionSupport';

type ActionHandlersOptions = {
  continuation: ReturnType<typeof useShopActionContinuation>;
  owner: string | undefined;
  routeDropId: string | undefined;
  blockViewerModeAction: () => boolean;
  showToast: (message: string) => void;
  selection: ShopInventorySelection;
  selectionState: ReturnType<typeof useShopInventorySelectionState>;
  inventory: ReturnType<typeof useShopInventoryView>;
  queries: ReturnType<typeof useShopInventoryQueries>;
  modals: ReturnType<typeof useCommerceModals>;
  preorder: PreorderCheckout;
  purchase: ReturnType<typeof useShopPurchaseActions>;
  delivery: ReturnType<typeof useDeliveryActions>;
  claim: ReturnType<typeof useClaimActions>;
  receipts: ReturnType<typeof useReceiptActions>;
  reveal: ShopRevealController;
};

export function useShopActionHandlers(options: ActionHandlersOptions) {
  const latest = useRef(options);
  const opening = useRef<{
    id: string;
    dropId: string | undefined;
    reveal?: Promise<Awaited<ReturnType<ShopRevealController['handlePonchoOverlayRequestReveal']>>>;
  } | null>(null);
  latest.current = options;
  const { continuation } = options;
  const report = (error: unknown) => {
    if (!isUserRejectedError(error)) {
      latest.current.showToast(error instanceof Error ? error.message : 'Couldn’t complete this action. Please try again.');
    }
  };
  const inventoryIntent = (items: InventoryItem[], restoreSelection = false) => {
    const expectedWallet = options.owner;
    const targets = items.map(({ id, dropId, kind }) => ({ id, dropId, kind }));
    return {
      expectedWallet,
      prepare: () => {
        const current = latest.current;
        if (!expectedWallet || current.owner !== expectedWallet) return false;
        if (!current.queries.inventoryFetched) return false;
        if (!targets.every((target) => {
          const item = findItem(current, target.id);
          return item?.dropId === target.dropId && item.kind === target.kind;
        })) throw new Error('These items are no longer available.');
        if (restoreSelection && !selectionMatches(targets.map(({ id }) => id), current.selection.selected)) {
          current.selectionState.replaceSelection(targets.map(({ id }) => id));
        }
        return true;
      },
      ready: () => !restoreSelection || selectionMatches(targets.map(({ id }) => id), latest.current.selection.selected),
    };
  };
  const handleSignIn = (key: 'header-sign-in' | 'shipments-sign-in') => continuation.run({
    key, requirement: 'sign-in', cancelled: undefined,
    execute: () => undefined,
  });
  const handleMint = (mode: 'mint' | 'discount', quantity: number, variantKey?: string) => {
    if (options.blockViewerModeAction()) return Promise.resolve();
    const dropId = options.routeDropId;
    return continuation.run({
      key: mode, requirement: 'wallet', cancelled: undefined,
      isCurrent: () => latest.current.routeDropId === dropId,
      execute: () => mode === 'mint'
        ? latest.current.purchase.handleMint(quantity, variantKey)
        : latest.current.purchase.handleDiscountMint(quantity, variantKey),
    }).catch(report);
  };
  const handlePreorder = (ids: number[]) => {
    if (options.blockViewerModeAction()) return Promise.resolve();
    const cardIds = [...ids];
    const preorderId = options.preorder.config.preorderId;
    const ethereumAddress = options.preorder.ethereumAddress;
    return continuation.run({
      key: 'preorder', requirement: 'sign-in', cancelled: undefined,
      readinessTimeoutMs: 2 * profileApiTimeoutMs('/preorders/availability') + 5_000,
      isCurrent: () => latest.current.preorder.config.preorderId === preorderId && latest.current.preorder.ethereumAddress === ethereumAddress,
      ready: () => {
        const current = latest.current.preorder;
        if (current.recoveryReady && current.pending) return true;
        if (current.availabilityError) throw new Error('Couldn’t check card availability. Please try again.');
        return current.recoveryReady && Boolean(current.availability);
      },
      execute: () => {
        if (latest.current.blockViewerModeAction()) return;
        const current = latest.current.preorder;
        if (current.pending && !selectionMatches(cardIds.map(String), new Set(current.pending.cardIds.map(String)))) {
          throw new Error('Another preorder is active. Continue to resolve it.');
        }
        if (!current.pending && !cardIds.every((id) => current.availability?.items.some((item) => item.id === id && item.status === 'available'))) {
          throw new Error('Some selected cards are no longer available.');
        }
        return current.purchase(cardIds);
      },
    }).catch(report);
  };
  const handleClaim: ActionHandlersOptions['claim']['handleClaim'] = (payload) => {
    if (isStripeReceiptClaimCode(payload.code) || hasAlphabeticClaimCodeCharacters(payload.code)) {
      return latest.current.claim.handleClaim(payload);
    }
    if (options.blockViewerModeAction()) return Promise.resolve({ deferred: true });
    const input = { ...payload };
    const generation = options.modals.claimIntentGenerationRef.current;
    return continuation.run({
      key: 'claim', requirement: 'sign-in', cancelled: { deferred: true } as const,
      isCurrent: () => latest.current.modals.claimOpen && latest.current.modals.claimIntentGenerationRef.current === generation,
      execute: () => latest.current.claim.handleClaim(input),
    });
  };
  const handleOpenShip = () => {
    if (options.blockViewerModeAction() || !options.selection.canShipSelected) return Promise.resolve();
    const intent = inventoryIntent(options.selection.deliverableItems, true);
    return continuation.run({
      ...intent, key: 'open-ship', requirement: 'sign-in', cancelled: undefined,
      execute: () => latest.current.delivery.handleOpenShip(),
    }).catch(report);
  };
  const handleShip: ActionHandlersOptions['delivery']['handleShip'] = (payload) => {
    if (options.blockViewerModeAction()) return Promise.resolve();
    const input = { ...payload };
    const generation = options.modals.deliveryIntentGenerationRef.current;
    const intent = inventoryIntent(options.selection.deliverableItems, true);
    return continuation.run({
      ...intent, key: 'ship', requirement: 'sign-in', cancelled: undefined,
      isCurrent: () => latest.current.modals.deliveryOpen && latest.current.modals.deliveryIntentGenerationRef.current === generation,
      execute: () => latest.current.delivery.handleShip(input),
    });
  };
  const openBox = (item: InventoryItem, rect?: DOMRect) => {
    if (options.blockViewerModeAction()) return Promise.resolve();
    const intent = inventoryIntent([item]);
    const { id } = item;
    return continuation.run({
      ...intent, key: rect ? 'pending-reveal' : 'open-box', requirement: 'sign-in', cancelled: undefined,
      execute: async () => {
        const current = latest.current;
        const target = current.inventory.inventoryIndex.get(id);
        if (!target) throw new Error('This item is no longer available.');
        if (rect) return current.reveal.openPendingReveal(target, rect);
        const operation: NonNullable<typeof opening.current> = { id: target.id, dropId: target.dropId };
        opening.current = operation;
        try {
          await current.reveal.openSelectedBox(target);
          await operation.reveal;
        } finally {
          if (opening.current === operation) opening.current = null;
        }
      },
    }).catch(report);
  };
  const handleAdminIrlRedeem: ActionHandlersOptions['receipts']['handleAdminIrlRedeem'] = (target) => {
    if (options.blockViewerModeAction()) return Promise.resolve();
    const intent = inventoryIntent(target ? [target] : options.selection.deliverableItems, !target);
    const overlayGeneration = options.reveal.getSessionGeneration();
    const deliveryGeneration = options.modals.deliveryIntentGenerationRef.current;
    return continuation.run({
      ...intent, key: 'admin-redeem', requirement: 'sign-in', cancelled: undefined,
      isCurrent: () => target
        ? latest.current.reveal.getSessionGeneration() === overlayGeneration && !latest.current.reveal.isClosing()
        : latest.current.modals.deliveryOpen && latest.current.modals.deliveryIntentGenerationRef.current === deliveryGeneration,
      execute: () => {
        const currentTarget = target ? findItem(latest.current, target.id) : undefined;
        if (target && !currentTarget) throw new Error('This item is no longer available.');
        return latest.current.receipts.handleAdminIrlRedeem(currentTarget);
      },
    }).catch(report);
  };
  const handleReceiptTransfer: ActionHandlersOptions['receipts']['handleReceiptTransfer'] = (destination) => {
    const target = options.modals.receiptTransferTarget;
    if (!target || options.blockViewerModeAction()) return Promise.resolve();
    return continuation.run({
      key: 'transfer', requirement: 'wallet', expectedWallet: options.owner, cancelled: undefined,
      isCurrent: () => latest.current.modals.receiptTransferTarget === target,
      execute: () => latest.current.receipts.handleReceiptTransfer(destination),
    });
  };
  const continueReveal = <T,>(execute: () => T | Promise<T>, cancelled: T) => {
    const generation = options.reveal.getSessionGeneration();
    return continuation.run({
      key: 'reveal', requirement: 'sign-in', expectedWallet: options.owner, cancelled,
      isCurrent: () => latest.current.reveal.getSessionGeneration() === generation && !latest.current.reveal.isClosing(),
      execute,
    }).catch((error) => { report(error); return cancelled; });
  };
  return {
    handleHeaderSignIn: () => handleSignIn('header-sign-in'),
    handleShipmentsSignIn: () => handleSignIn('shipments-sign-in'),
    handleMint: (quantity: number, variantKey?: string) => handleMint('mint', quantity, variantKey),
    handleDiscountMint: (quantity: number, variantKey?: string) => handleMint('discount', quantity, variantKey),
    handlePreorder, handleClaim, handleOpenShip, handleShip, handleAdminIrlRedeem, handleReceiptTransfer,
    openSelectedBox: (item: InventoryItem) => openBox(item),
    openPendingReveal: (item: InventoryItem, rect: DOMRect) => openBox(item, rect),
    handleRevealOverlayClick: () => {
      const overlay = latest.current.reveal.getCurrentOverlay();
      if (overlay?.hasRevealAttempted || overlay?.revealedIds?.length) {
        return latest.current.reveal.handleRevealOverlayClick();
      }
      return continueReveal(() => latest.current.reveal.handleRevealOverlayClick(), undefined);
    },
    handlePonchoOverlayRequestReveal: () => {
      const operation = opening.current;
      const overlay = latest.current.reveal.getCurrentOverlay();
      if (operation && overlay?.id === operation.id && overlay.dropId === operation.dropId && !latest.current.reveal.isClosing()) {
        operation.reveal ??= Promise.resolve(latest.current.reveal.handlePonchoOverlayRequestReveal());
        return operation.reveal;
      }
      return continueReveal(() => latest.current.reveal.handlePonchoOverlayRequestReveal(), 'retry' as const);
    },
  };
}

function selectionMatches(ids: string[], selected: ReadonlySet<string>): boolean {
  return ids.length === selected.size && ids.every((id) => selected.has(id));
}

function findItem(options: ActionHandlersOptions, id: string): InventoryItem | undefined {
  return options.inventory.inventoryIndex.get(id) || options.queries.inventory.find((item) => item.id === id);
}
