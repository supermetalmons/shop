import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import miNoteCollections from '../../mi_note_eth.json';
import { miNoteAddressFromSearch } from '../../shared/miNoteCards';
import { useMiNoteCards } from '../hooks/useMiNoteCards';
import { useMiNoteEthereumWallet } from '../hooks/useMiNoteEthereumWallet';
import type { PreorderCheckout } from '../hooks/usePreorderCheckout';
import { preorderImageUrl } from '../../shared/preorders';
import { subscribeToNavigation } from '../navigation';
import { getInjectedWalletIconSrc } from '../wallet/injectedEthereumProviders';
import { BackgroundLayerPortal } from './BackgroundBlurLayer';
import '../styles/mi-note-cards.css';

const MI_NOTE_OPENSEA_URLS = new Map(miNoteCollections.flatMap(({ contractAddress, tokens }) => (
  tokens.map(({ id, mid }) => [mid, `https://opensea.io/item/ethereum/${contractAddress}/${id}`] as const)
)));

type MiNoteCardsGalleryProps = {
  preorder?: PreorderCheckout;
};

const MI_NOTE_CARDS_BY_ID = new Map(miNoteCollections.flatMap(({ tokens }) => tokens.map((card) => [card.clean_card_id, card] as const)));

const currentSearch = () => window.location.search;

function MiNoteWalletControls({ wallet }: { wallet: ReturnType<typeof useMiNoteEthereumWallet> }) {
  const connectRef = useRef<HTMLButtonElement>(null);
  const firstWalletRef = useRef<HTMLButtonElement>(null);
  const disconnectRef = useRef<HTMLButtonElement>(null);
  const previousStatus = useRef(wallet.status);
  const busy = wallet.status === 'connecting' || wallet.status === 'restoring';

  useEffect(() => {
    if (wallet.status === 'choosing') {
      firstWalletRef.current?.focus();
    } else if (
      previousStatus.current !== wallet.status &&
      previousStatus.current !== 'disconnected' &&
      previousStatus.current !== 'restoring' &&
      document.activeElement === document.body
    ) {
      (wallet.address ? disconnectRef : connectRef).current?.focus();
    }
    previousStatus.current = wallet.status;
  }, [wallet.address, wallet.status]);

  return (
    <div className="mi-note-cards__wallet">
      {wallet.address ? (
        <div className="mi-note-cards__connection">
          <span className="mi-note-cards__address" title={wallet.address}>
            {wallet.address.slice(0, 6)}…{wallet.address.slice(-4)}
          </span>
          <button ref={disconnectRef} type="button" className="ghost" onClick={wallet.disconnect}>
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
            wallet.cancel();
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
          <button type="button" className="ghost" onClick={wallet.cancel}>Cancel</button>
        </div>
      ) : (
        <>
          <button ref={connectRef} type="button" disabled={busy} onClick={wallet.connect}>
            {wallet.status === 'connecting' ? 'Connecting…' : 'Connect Ethereum Wallet'}
          </button>
          {busy && (
            <p className="mi-note-cards__message" role="status">
              {wallet.status === 'restoring' ? 'Reconnecting wallet…' : 'Check your wallet to connect.'}
            </p>
          )}
        </>
      )}
      {wallet.error && <p className="mi-note-cards__message" role="alert">{wallet.error}</p>}
    </div>
  );
}

export default function MiNoteCardsGallery({ preorder }: MiNoteCardsGalleryProps) {
  const search = useSyncExternalStore(subscribeToNavigation, currentSearch);
  const request = useMemo(() => miNoteAddressFromSearch(search), [search]);
  const [tab, setTab] = useState<'all' | 'your'>('all');
  const tabsRef = useRef<Array<HTMLButtonElement | null>>([]);
  const tabsId = useId();
  const yourView = !request.present && tab === 'your';
  const wallet = useMiNoteEthereumWallet(yourView);
  const { cards, status, retry } = useMiNoteCards(request.present
    ? request.address ? { mode: 'owned', address: request.address } : { mode: 'inactive' }
    : tab === 'all' ? { mode: 'all' }
    : wallet.address ? { mode: 'owned', address: wallet.address } : { mode: 'inactive' });
  const [selected, setSelected] = useState<number[]>([]);
  const previousBuyer = useRef(preorder?.buyer);
  const availability = useMemo(() => new Map(preorder?.availability?.items.map((item) => [item.id, item.status])), [preorder?.availability]);
  const preorderEnabled = preorder?.config.enabled === true;
  const purchaseLocked = Boolean(preorder?.busy || preorder?.pending);

  useEffect(() => { setSelected([]); }, [search, tab, wallet.address, preorderEnabled, preorder?.config.cluster]);
  useEffect(() => {
    if (previousBuyer.current && previousBuyer.current !== preorder?.buyer) setSelected([]);
    previousBuyer.current = preorder?.buyer;
  }, [preorder?.buyer]);
  useEffect(() => {
    setSelected((current) => current.filter((id) => availability.get(id) === 'available'));
  }, [availability]);
  useEffect(() => {
    if (preorder?.order && !['prepared', 'submitted'].includes(preorder.order.status)) setSelected([]);
  }, [preorder?.order]);

  const panelIds = preorder?.pending?.cardIds ?? selected;
  const submitting = preorder?.order?.status === 'submitted' || preorder?.pending?.submittedAttempt;
  const canResume = !preorder?.pending || Boolean(preorder.pending.requestId);
  const actionLabel = preorder?.phase === 'authenticating' ? 'Connecting…'
    : preorder?.phase === 'preparing' ? 'Preparing…'
    : preorder?.phase === 'signing' ? 'Check wallet…'
    : preorder?.phase === 'submitting' || submitting ? 'Confirming…'
    : preorder?.phase === 'cancelling' ? 'Cancelling…'
    : !preorder?.recoveryReady ? 'Checking…'
    : preorder?.pending ? 'Continue preorder' : 'Preorder';
  const totalPrice = preorder ? (panelIds.length * preorder.config.unitPriceLamports / 1_000_000_000).toLocaleString('en-US', { maximumFractionDigits: 9 }) : '';

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    let next: 'all' | 'your';
    if (event.key === 'Home') next = 'all';
    else if (event.key === 'End') next = 'your';
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') next = tab === 'all' ? 'your' : 'all';
    else return;
    event.preventDefault();
    setTab(next);
    tabsRef.current[next === 'all' ? 0 : 1]?.focus();
  };

  return (
    <>
      <main className={`mi-note-cards${preorderEnabled && panelIds.length ? ' mi-note-cards--selection' : ''}`} aria-label="Mi Note cards">
        {!request.present && (
          <div className="mi-note-cards__tabs" role="tablist" aria-label="Mi Note cards">
            {(['all', 'your'] as const).map((value, index) => (
              <button
                key={value}
                ref={(element) => { tabsRef.current[index] = element; }}
                type="button"
                role="tab"
                id={`${tabsId}-${value}`}
                aria-controls={`${tabsId}-panel`}
                aria-selected={tab === value}
                tabIndex={tab === value ? 0 : -1}
                onClick={() => setTab(value)}
                onKeyDown={handleTabKeyDown}
              >
                {value === 'all' ? 'All' : 'Your'}
              </button>
            ))}
          </div>
        )}
        <div
          role={request.present ? undefined : 'tabpanel'}
          id={request.present ? undefined : `${tabsId}-panel`}
          aria-labelledby={request.present ? undefined : `${tabsId}-${tab}`}
        >
          {preorderEnabled && preorder?.availabilityError && (
            <div className="mi-note-cards__error">
              <p className="mi-note-cards__message" role="alert">{preorder.availabilityError}</p>
              <button type="button" className="ghost" onClick={() => { void preorder.refreshAvailability(); }}>Try again</button>
            </div>
          )}
          {yourView && <MiNoteWalletControls wallet={wallet} />}
          {yourView && wallet.address && (
            <>
              {status === 'loading' && <p className="mi-note-cards__message" role="status">Loading your cards…</p>}
              {status === 'success' && cards.length === 0 && (
                <p className="mi-note-cards__message" role="status">No Mi Note cards found.</p>
              )}
              {(status === 'error' || status === 'partial') && (
                <div className="mi-note-cards__error">
                  <p className="mi-note-cards__message" role="alert">
                    {status === 'partial' ? 'Some cards couldn’t be loaded.' : 'Couldn’t load your cards.'}
                  </p>
                  <button type="button" className="ghost" onClick={retry}>Try again</button>
                </div>
              )}
            </>
          )}
          <div className="mi-note-cards__grid">
            {cards.map((card) => {
              const availabilityStatus = availability.get(card.clean_card_id);
              const isPreordered = preorderEnabled && availabilityStatus === 'preordered';
              const unavailable = availabilityStatus === 'reserved' || availabilityStatus === 'preordered';
              const isSelected = selected.includes(card.clean_card_id);
              const image = (
                <img
                  className={`mi-note-cards__image${isPreordered ? ' mi-note-cards__image--preordered' : ''}`}
                  src={isPreordered ? preorderImageUrl(preorder!.config, card.clean_card_id) : card.mid.replace('/mid/', '/thumbs/')}
                  alt={card.name}
                  loading="lazy"
                  decoding="async"
                  draggable={false}
                  onDragStart={(event) => event.preventDefault()}
                />
              );
              const artwork = isPreordered ? <span className="mi-note-cards__preorder-artwork">{image}</span> : image;
              return (
              <figure key={card.mid} className="mi-note-cards__item">
                {preorderEnabled ? (
                  <button
                    type="button"
                    className={`mi-note-cards__selectable${isSelected ? ' mi-note-cards__selectable--selected' : ''}`}
                    disabled={purchaseLocked || availabilityStatus !== 'available' || (!isSelected && selected.length >= preorder!.config.maxItems)}
                    aria-pressed={isSelected}
                    aria-label={`${unavailable ? availabilityStatus === 'reserved' ? 'Reserved' : 'Preordered' : 'Select'} preorder #${card.clean_card_id}: ${card.name}`}
                    onClick={() => setSelected((current) => current.includes(card.clean_card_id)
                      ? current.filter((id) => id !== card.clean_card_id)
                      : [...current, card.clean_card_id])}
                  >
                    {artwork}
                  </button>
                ) : artwork}
                <figcaption className="mi-note-cards__name">
                  <a
                    className="mi-note-cards__link"
                    href={MI_NOTE_OPENSEA_URLS.get(card.mid)}
                    target="_blank"
                    rel="noopener noreferrer"
                    draggable={false}
                    onDragStart={(event) => event.preventDefault()}
                  >
                    {card.name}
                  </a>
                  {preorderEnabled && unavailable && <span className="mi-note-cards__availability">{availabilityStatus === 'reserved' ? 'Reserved' : 'Preordered'}</span>}
                </figcaption>
              </figure>
              );
            })}
          </div>
        </div>
      </main>
      {preorderEnabled && preorder && (panelIds.length > 0 || preorder.error) && (
        <BackgroundLayerPortal>
          <div className="selection-panel mi-note-preorder-panel">
            {panelIds.length > 0 && (
              <>
                <div className="selection-panel__left">
                  <div className="selection-panel__preview" aria-label={`${panelIds.length} cards selected`}>
                    {panelIds.map((id, index) => (
                      <div key={id} className="selection-panel__thumb" aria-hidden="true" style={{
                        backgroundImage: `url("${MI_NOTE_CARDS_BY_ID.get(id)?.mid.replace('/mid/', '/thumbs/')}")`,
                        zIndex: index + 1,
                      }} />
                    ))}
                  </div>
                </div>
                <div className="selection-panel__actions">
                  <button type="button" className="quiet" disabled={preorder.busy || Boolean(submitting) || Boolean(preorder.pending && !preorder.order)} onClick={() => {
                    if (preorder.pendingOrder) void preorder.cancel();
                    else setSelected([]);
                  }}>Cancel</button>
                  <button
                    type="button"
                    className="mint-panel__submit mi-note-preorder-panel__submit"
                    aria-label={`${actionLabel} for ${totalPrice} SOL`}
                    disabled={preorder.busy || Boolean(submitting) || !canResume || !preorder.recoveryReady || !preorder.availability || Boolean(preorder.availabilityError)}
                    onClick={() => { void preorder.purchase(panelIds); }}
                  >
                    <span className="mint-panel__submit-text">{actionLabel}</span>
                    <span className="mint-panel__submit-price">{totalPrice} SOL</span>
                  </button>
                </div>
                <p className="mi-note-preorder-panel__note">
                  {preorder.order?.status === 'prepared' ? `Reserved for ${preorder.remainingSeconds}s. ` : ''}
                  Up to {preorder.config.maxItems} cards per transaction. Network and creation fees extra.
                </p>
              </>
            )}
            {preorder.error && <p className="mi-note-preorder-panel__error" role="alert">{preorder.error}</p>}
            {submitting && <p className="mi-note-preorder-panel__note" role="status">Confirming your preorder…</p>}
          </div>
        </BackgroundLayerPortal>
      )}
    </>
  );
}
