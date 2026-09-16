import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import miNoteCollections from '../../mi_note_eth.json';
import { miNoteAddressFromSearch } from '../../shared/miNoteCards';
import { useMiNoteCards } from '../hooks/useMiNoteCards';
import { useMiNoteEthereumWallet } from '../hooks/useMiNoteEthereumWallet';
import { subscribeToNavigation } from '../navigation';
import { getInjectedWalletIconSrc } from '../wallet/injectedEthereumProviders';
import { BackgroundLayerPortal } from './BackgroundBlurLayer';
import '../styles/mi-note-cards.css';

const MI_NOTE_OPENSEA_URLS = new Map(miNoteCollections.flatMap(({ contractAddress, tokens }) => (
  tokens.map(({ id, mid }) => [mid, `https://opensea.io/item/ethereum/${contractAddress}/${id}`] as const)
)));

type MiNoteCardsGalleryProps = {
  onNotify: () => void;
};

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

export default function MiNoteCardsGallery({ onNotify }: MiNoteCardsGalleryProps) {
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
      <main className="mi-note-cards" aria-label="Mi Note cards">
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
            {cards.map((card) => (
              <figure key={card.mid} className="mi-note-cards__item">
                <img
                  className="mi-note-cards__image"
                  src={card.mid.replace('/mid/', '/thumbs/')}
                  alt={card.name}
                  loading="lazy"
                  decoding="async"
                  draggable={false}
                  onDragStart={(event) => event.preventDefault()}
                />
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
                </figcaption>
              </figure>
            ))}
          </div>
        </div>
      </main>
      <BackgroundLayerPortal placement="trailing">
        <button type="button" className="mi-note-cards__notify" onClick={onNotify}>
          Notify me
        </button>
      </BackgroundLayerPortal>
    </>
  );
}
