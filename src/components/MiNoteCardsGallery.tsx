import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import miNoteCollections from '../../mi_note_eth.json';
import type { useMiNoteEthereumWallet } from '../hooks/useMiNoteEthereumWallet';
import type { PreorderCheckout } from '../hooks/usePreorderCheckout';
import { preorderImageUrl } from '../../shared/preorders';
import type { MiNoteVerification } from '../hooks/useMiNoteVerification';
import { getInjectedWalletIconSrc } from '../wallet/injectedEthereumProviders';
import { BackgroundLayerPortal } from './BackgroundBlurLayer';
import { PreorderSelectionBar } from '../shop/ui/ShopSelectionBar';
import type { ReceiptViewerSource } from '../shop/reveal/types';
import type { InventoryItem } from '../types';
import '../styles/mi-note-cards.css';

type MiNoteCardsGalleryProps = {
  preorder?: PreorderCheckout;
  wallet: ReturnType<typeof useMiNoteEthereumWallet>;
  verification: MiNoteVerification;
  onAdminSignIn?: () => Promise<void>;
  onCancelPendingSignIn?: () => void;
  showToast?: (message: string) => void;
  onViewPreordered?: (item: ReceiptViewerSource, originRect: DOMRect | null, aspectRatio?: number) => boolean;
};

const MI_NOTE_CARDS_BY_ID = new Map(miNoteCollections.flatMap(({ tokens }) => tokens.map((card) => [card.clean_card_id, card] as const)));
const MI_NOTE_COLLECTION_LINKS = [
  { label: 'Mi Note', href: 'https://opensea.io/collection/minote' },
  { label: 'Mi Note 2', href: 'https://opensea.io/collection/mi-note2' },
  { label: 'Mi Note 3', href: 'https://opensea.io/collection/mi-note-3' },
];

type WalletSignInAttempt = { verify: MiNoteVerification['verify'] | null };

function MiNoteWalletControls({ wallet, verification, verified }: Pick<MiNoteCardsGalleryProps, 'wallet' | 'verification'> & { verified: boolean }) {
  const displayAddress = useMemo(() => {
    if (!wallet.address) return null;
    const address = wallet.address.slice(2).toLowerCase();
    const hash = bytesToHex(keccak_256(address));
    return `0x${Array.from(address, (char, index) => Number.parseInt(hash[index], 16) >= 8 ? char.toUpperCase() : char).join('')}`;
  }, [wallet.address]);
  const connectRef = useRef<HTMLButtonElement>(null);
  const firstWalletRef = useRef<HTMLButtonElement>(null);
  const disconnectRef = useRef<HTMLButtonElement>(null);
  const attempt = useRef<WalletSignInAttempt | null>(null);
  const [pendingAttempt, setPendingAttempt] = useState<WalletSignInAttempt | null>(null);
  const busy = Boolean(pendingAttempt) || !verification.ready || verification.verifying || wallet.status === 'connecting' || wallet.status === 'restoring';
  const previous = useRef({ status: wallet.status, busy, verified });

  const finishAttempt = useCallback((current: WalletSignInAttempt) => {
    if (attempt.current !== current) return;
    attempt.current = null;
    setPendingAttempt(null);
  }, []);

  const startVerification = useCallback((current: WalletSignInAttempt, verify: MiNoteVerification['verify']) => {
    if (attempt.current !== current) return;
    current.verify = verify;
    void verify().catch(() => undefined).finally(() => finishAttempt(current));
  }, [finishAttempt]);

  useEffect(() => {
    const current = pendingAttempt;
    if (!current || attempt.current !== current) return;
    if (verified || (current.verify && current.verify !== verification.verify)) {
      finishAttempt(current);
    } else if (!current.verify) {
      if (wallet.status === 'connected' && wallet.address && wallet.provider && verification.ready) {
        startVerification(current, verification.verify);
      } else if (wallet.status === 'disconnected') {
        finishAttempt(current);
      }
    }
  }, [finishAttempt, pendingAttempt, startVerification, verification.ready, verification.verify, verified, wallet.address, wallet.provider, wallet.status]);

  useEffect(() => () => {
    const current = attempt.current;
    attempt.current = null;
    if (current && !current.verify) wallet.cancel();
  }, [wallet.cancel]);

  const connect = () => {
    if (attempt.current || busy || verified) return;
    const current: WalletSignInAttempt = { verify: null };
    attempt.current = current;
    setPendingAttempt(current);
    wallet.connect();
  };

  const cancel = () => {
    if (attempt.current) finishAttempt(attempt.current);
    wallet.cancel();
  };

  useEffect(() => {
    if (wallet.status === 'choosing' && previous.current.status !== 'choosing') {
      firstWalletRef.current?.focus();
    } else if (
      !busy &&
      (previous.current.status !== wallet.status || previous.current.busy || previous.current.verified !== verified) &&
      (previous.current.status !== 'disconnected' || previous.current.busy) &&
      previous.current.status !== 'restoring' &&
      document.activeElement === document.body
    ) {
      (verified ? disconnectRef : connectRef).current?.focus();
    }
    previous.current = { status: wallet.status, busy, verified };
  }, [busy, verified, wallet.status]);

  return (
    <div className="mi-note-cards__wallet">
      {verified && displayAddress ? (
        <div className="mi-note-cards__connection">
          <span className="mi-note-cards__address" title={displayAddress}>
            {displayAddress.slice(0, 6)}…{displayAddress.slice(-4)}
          </span>
          <button ref={disconnectRef} type="button" className="ghost" onClick={() => { verification.invalidate(); wallet.disconnect(); }}>
            Disconnect
          </button>
        </div>
      ) : wallet.status === 'choosing' ? (
        <div
          className="mi-note-cards__wallet-picker"
          role="group"
          aria-label="Select Ethereum wallet"
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            cancel();
          }}
        >
          <p className="mi-note-cards__message">Select a wallet</p>
          {wallet.wallets.map((choice, index) => {
            const icon = getInjectedWalletIconSrc(choice.info.icon);
            return (
              <button
                key={choice.info.uuid}
                ref={index === 0 ? firstWalletRef : undefined}
                type="button"
                className="secondary-light mi-note-cards__wallet-choice"
                onClick={() => wallet.selectWallet(choice)}
              >
                {icon && <img className="mi-note-cards__wallet-icon" src={icon} alt="" />}
                <span>{choice.info.name}</span>
              </button>
            );
          })}
          <button type="button" className="ghost" onClick={cancel}>Cancel</button>
        </div>
      ) : (
        <button ref={connectRef} type="button" disabled={busy} onClick={connect}>
          {busy ? 'Connecting...' : 'Connect Ethereum Wallet'}
        </button>
      )}
    </div>
  );
}

export default function MiNoteCardsGallery({ preorder, wallet, verification, onAdminSignIn, onCancelPendingSignIn, showToast, onViewPreordered }: MiNoteCardsGalleryProps) {
  const verified = Boolean(wallet.status === 'connected' && wallet.provider && verification.session && verification.session.expiresAtMs > Date.now() && verification.session.address === wallet.address &&
    verification.session.preorderId === preorder?.config.preorderId);
  const scopedAvailability = verified && preorder?.availability?.ethereumAddress === wallet.address &&
    preorder.availability.preorderId === preorder.config.preorderId ? preorder.availability : null;
  const cards = useMemo(() => scopedAvailability?.items.flatMap(({ id }) => {
    const card = MI_NOTE_CARDS_BY_ID.get(id);
    return card ? [card] : [];
  }) ?? [], [scopedAvailability]);
  const selectionScope = `${preorder?.config.preorderId}:${verification.session?.token ?? ''}`;
  const renderedScope = useRef(selectionScope);
  const selectionCurrent = renderedScope.current === selectionScope;
  const [selected, setSelected] = useState<number[]>([]);
  const [selectedPreordered, setSelectedPreordered] = useState<number | null>(null);
  const selectedPreorderedButton = useRef<HTMLButtonElement>(null);
  const previousBuyer = useRef(preorder?.buyer);
  const cancelPendingSignIn = useRef(onCancelPendingSignIn);
  cancelPendingSignIn.current = onCancelPendingSignIn;
  const lastToastedError = useRef<string | null>(null);
  const availability = useMemo(() => new Map(
    scopedAvailability?.items.map((item) => [item.id, item.status]) ?? [],
  ), [scopedAvailability]);
  const preorderEnabled = preorder?.config.enabled === true;
  const purchaseLocked = Boolean(preorder?.busy || preorder?.pending);

  useEffect(() => {
    const message = preorderEnabled ? preorder?.error : null;
    if (!message) {
      lastToastedError.current = null;
    } else if (showToast && message !== lastToastedError.current) {
      lastToastedError.current = message;
      showToast(message);
    }
  }, [preorderEnabled, preorder?.error, showToast]);

  useEffect(() => {
    renderedScope.current = selectionScope;
    cancelPendingSignIn.current?.();
    setSelected([]);
    setSelectedPreordered(null);
  }, [selectionScope, preorderEnabled]);
  useEffect(() => {
    if (previousBuyer.current && previousBuyer.current !== preorder?.buyer) {
      setSelected([]);
      setSelectedPreordered(null);
    }
    previousBuyer.current = preorder?.buyer;
  }, [preorder?.buyer]);
  useEffect(() => {
    if (!scopedAvailability) return;
    setSelected((current) => current.filter((id) => availability.get(id) === 'available'));
    setSelectedPreordered((current) => current !== null && availability.get(current) === 'preordered' ? current : null);
  }, [availability, scopedAvailability]);
  useEffect(() => {
    if (preorder?.order && !['prepared', 'submitted'].includes(preorder.order.status)) setSelected([]);
  }, [preorder?.order]);
  useEffect(() => {
    if (purchaseLocked) setSelectedPreordered(null);
    const pendingIds = preorder?.pending?.cardIds;
    if (pendingIds) setSelected((current) => current.filter((id) => pendingIds.includes(id)));
  }, [purchaseLocked, preorder?.pending]);

  const pendingAddress = preorder?.pending?.ethereumAddress ?? (
    preorder?.pending?.orderId === preorder?.order?.orderId ? preorder?.order?.ethereumAddress : null
  );
  const pendingMatches = verified && pendingAddress === wallet.address;
  const pendingHidden = Boolean(preorder?.pending && !pendingMatches);
  const panelIds = !verified || !selectionCurrent || pendingHidden ? [] : preorder?.pending?.cardIds ?? selected;
  const preorderedCard = !verified || !selectionCurrent || selectedPreordered === null ? undefined : MI_NOTE_CARDS_BY_ID.get(selectedPreordered);
  const viewableItem: InventoryItem | null = preorderedCard && preorder && availability.get(preorderedCard.clean_card_id) === 'preordered' && !purchaseLocked ? {
    id: `${preorder.config.preorderId}:${preorderedCard.clean_card_id}`,
    dropId: preorder.config.preorderId,
    kind: 'preorder',
    preorderId: preorderedCard.clean_card_id,
    name: `Preorder #${preorderedCard.clean_card_id}`,
    image: preorderImageUrl(preorder.config, preorderedCard.clean_card_id),
  } : null;
  const submitting = preorder?.order?.status === 'submitted' || preorder?.pending?.submittedAttempt;
  const canAbandon = Boolean(preorder?.pending && !preorder.pending.orderId && !preorder.pending.submittedAttempt && !preorder.pendingOrder);
  const canResume = !preorder?.pending || Boolean(preorder.pending.requestId);
  const actionLabel = preorder?.phase === 'authenticating' ? 'Signing in…'
    : preorder?.phase === 'preparing' ? 'Preparing…'
    : preorder?.phase === 'signing' ? 'Check wallet…'
    : preorder?.phase === 'submitting' || submitting ? 'Confirming…'
    : preorder?.phase === 'cancelling' ? 'Cancelling…'
    : !preorder?.recoveryReady ? 'Checking…'
    : preorder?.pending ? 'Continue preorder' : 'Preorder';
  const totalPrice = preorder ? (panelIds.length * preorder.config.unitPriceLamports / 1_000_000_000).toLocaleString('en-US', { maximumFractionDigits: 9 }) : '';

  return (
    <>
      <main className={`mi-note-cards${cards.length === 0 ? ' mi-note-cards--empty' : ''}${(preorderEnabled && panelIds.length) || viewableItem ? ' mi-note-cards--selection' : ''}`} aria-label="Mi Note cards">
        <div className="mi-note-cards__content">
          {cards.length === 0 && <header className="mi-note-cards__header">
            <h1 className="mi-note-cards__title">Preorder Mi Note Cards</h1>
            <div className="mi-note-cards__intro">
              <p>One unique card for each Mi Note.</p>
              <p>Preorders are open until October 8.</p>
              <p>Cards reveal and public mint for the remaining cards on October 9.</p>
            </div>
          </header>}
          <MiNoteWalletControls key={preorder?.config.preorderId} wallet={wallet} verification={verification} verified={verified} />
          {verified && (
            <>
              {scopedAvailability?.requiresAdminSignIn && <div className="mi-note-cards__wallet">
                <p className="mi-note-cards__message">Sign in with the admin Solana wallet to use the devnet test cards.</p>
                {onAdminSignIn && <button type="button" disabled={preorder?.busy} onClick={() => { void onAdminSignIn(); }}>Sign in with Solana</button>}
              </div>}
              {!scopedAvailability && !preorder?.availabilityError && <p className="mi-note-cards__message" role="status">Loading...</p>}
              {scopedAvailability?.ownershipStatus === 'success' && cards.length === 0 && <p className="mi-note-cards__message" role="status">No Mi Notes available for preorder.</p>}
              {(preorder?.availabilityError || scopedAvailability?.ownershipStatus === 'partial') && <div className="mi-note-cards__error">
                <p className="mi-note-cards__message" role="alert">{preorder?.availabilityError || 'Some cards couldn’t be loaded.'}</p>
                <button type="button" className="ghost" onClick={() => { void preorder?.refreshAvailability(); }}>Try again</button>
              </div>}
            </>
          )}
          {pendingHidden && <div className="mi-note-cards__wallet">
            <p className="mi-note-cards__message" role="status">{submitting ? 'Confirming your previous preorder…'
              : pendingAddress ? 'Switch back to the Ethereum wallet for your pending preorder, or cancel it.'
              : 'Cancel your previous preorder to start with a verified Ethereum wallet.'}</p>
            {preorder?.order?.status === 'prepared' && <button type="button" className="ghost" disabled={preorder.busy} onClick={() => { void preorder.cancel(); }}>Cancel preorder</button>}
            {canAbandon && preorder && <button type="button" className="ghost" disabled={preorder.busy} onClick={() => { void preorder.cancel(); }}>Abandon preparation</button>}
          </div>}
          <div className="mi-note-cards__grid" hidden={cards.length === 0}>
            {cards.map((card) => {
              const availabilityStatus = availability.get(card.clean_card_id);
              const isPreordered = availabilityStatus === 'preordered';
              const unavailable = availabilityStatus === 'reserved' || availabilityStatus === 'preordered';
              const isSelected = selectionCurrent && (isPreordered ? selectedPreordered === card.clean_card_id : selected.includes(card.clean_card_id));
              const image = (
                <img
                  className={`mi-note-cards__image${isPreordered ? ' mi-note-cards__image--preordered' : ''}`}
                  src={isPreordered ? preorderImageUrl(preorder!.config, card.clean_card_id) : card.mid}
                  alt={card.name}
                  loading="lazy"
                  decoding="async"
                  draggable={false}
                  onDragStart={(event) => event.preventDefault()}
                />
              );
              return (
              <figure key={card.mid} className="mi-note-cards__item">
                {preorderEnabled || isPreordered ? (
                  <button
                    ref={isPreordered && isSelected ? selectedPreorderedButton : undefined}
                    type="button"
                    className={`mi-note-cards__selectable${isPreordered ? ' mi-note-cards__selectable--preordered' : ''}${isSelected ? ' mi-note-cards__selectable--selected' : ''}`}
                    disabled={purchaseLocked || (!isPreordered && availabilityStatus !== 'available')}
                    aria-pressed={isSelected}
                    aria-label={`${unavailable ? availabilityStatus === 'reserved' ? 'Reserved' : 'Preordered' : 'Select'} preorder #${card.clean_card_id}: ${card.name}`}
                    onClick={() => {
                      if (isPreordered) {
                        setSelected([]);
                        setSelectedPreordered((current) => current === card.clean_card_id ? null : card.clean_card_id);
                      } else {
                        setSelectedPreordered(null);
                        setSelected((current) => current.includes(card.clean_card_id)
                          ? current.filter((id) => id !== card.clean_card_id)
                          : [...current, card.clean_card_id].slice(-preorder!.config.maxItems));
                      }
                    }}
                  >
                    {image}
                  </button>
                ) : image}
              </figure>
              );
            })}
          </div>
        </div>
        <footer className="mi-note-cards__footer">
          <nav aria-label="Mi Note collections">
            {MI_NOTE_COLLECTION_LINKS.map(({ label, href }) => (
              <a key={href} href={href} target="_blank" rel="noopener noreferrer" aria-label={`${label} (opens in a new tab)`}>
                {label} <span aria-hidden="true">↗</span>
              </a>
            ))}
          </nav>
        </footer>
      </main>
      {viewableItem && (
        <PreorderSelectionBar
          selectedCount={1}
          selectedPreview={[{ item: viewableItem, previewImage: viewableItem.image }]}
          selectedOverflow={0}
          canViewSelected={true}
          clearSelection={() => setSelectedPreordered(null)}
          handleViewSelectedItem={() => {
            const image = selectedPreorderedButton.current?.querySelector('img');
            const aspectRatio = image && image.naturalWidth > 0 && image.naturalHeight > 0 ? image.naturalWidth / image.naturalHeight : undefined;
            if (onViewPreordered?.(viewableItem, image?.getBoundingClientRect() ?? null, aspectRatio)) setSelectedPreordered(null);
          }}
        />
      )}
      {!viewableItem && preorderEnabled && preorder && panelIds.length > 0 && (
        <BackgroundLayerPortal>
          <div className="selection-panel mi-note-preorder-panel">
            <div className="selection-panel__left">
              <div className="selection-panel__preview" aria-label={`${panelIds.length} cards selected`}>
                {panelIds.map((id, index) => (
                  <div key={id} className="selection-panel__thumb" aria-hidden="true" style={{
                    backgroundImage: `url("${MI_NOTE_CARDS_BY_ID.get(id)?.mid}")`,
                    zIndex: index + 1,
                  }} />
                ))}
              </div>
            </div>
            <div className="selection-panel__actions">
              <button type="button" className="quiet" disabled={!onCancelPendingSignIn && (preorder.busy || Boolean(submitting) || Boolean(preorder.pending && !preorder.order && !canAbandon))} onClick={() => {
                if (onCancelPendingSignIn) onCancelPendingSignIn();
                else if (canAbandon) { setSelected([]); void preorder.cancel(); }
                else if (preorder.pendingOrder) void preorder.cancel();
                else setSelected([]);
              }}>{canAbandon ? 'Abandon preparation' : 'Cancel'}</button>
              <button
                type="button"
                className="mi-note-preorder-panel__submit"
                aria-label={`${actionLabel} for ${totalPrice} SOL`}
                disabled={preorder.busy || Boolean(submitting) || !canResume || !preorder.recoveryReady || !preorder.availability || Boolean(preorder.availabilityError)}
                onClick={() => { void preorder.purchase(panelIds); }}
              >
                <span className="mi-note-preorder-panel__label" aria-live="polite" aria-atomic="true">{actionLabel}</span>
                {` • ${totalPrice} SOL`}
              </button>
            </div>
          </div>
        </BackgroundLayerPortal>
      )}
    </>
  );
}
