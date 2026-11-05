import { type MouseEvent, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ETHEREUM_MAX_RELICS, formatEtherAmount } from '../../shared/ethereum/protocol';
import type { Pre111kNetwork } from '../../shared/ethereum/pre111k';
import { MintPanelFrame, MintPanelPurchaseFooter, MintPanelTitle } from '../components/MintPanel';
import { ShopHeader } from '../components/ShopHeader';
import { formatRemainingCount } from '../lib/formatRemainingCount';
import { getInjectedWalletIconSrc } from '../wallet/injectedEthereumProviders';
import { Pre111kAccessGate } from './Pre111kAccessGate';
import { usePre111k } from './usePre111k';
import { usePre111kAccess } from './usePre111kAccess';
import '../styles/pre111k.css';

const INITIAL_PRICE_WEI: Record<Pre111kNetwork, string> = {
  mainnet: '2230000000000000000',
  devnet: '3330000000000000',
};

const narrowFooterQuery = () => window.matchMedia('(max-width: 860px)');

function subscribeToFooterWidth(onChange: () => void) {
  const query = narrowFooterQuery();
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

function RelicCount({ value, digits, loadingLabel }: { value: string | number | null | undefined; digits: number; loadingLabel?: string }) {
  return <span className="mint-panel__remaining-count" style={{ minWidth: `${digits}ch` }}>
    {value ?? (loadingLabel ? <span role="status" aria-label={loadingLabel}>
      {Array.from({ length: digits }, (_, index) => <span key={index} className="mint-panel__digit-placeholder" aria-hidden="true" />)}
    </span> : '—')}
  </span>;
}

export default function DirectPaymentPage({ network }: { network: Pre111kNetwork }) {
  const narrowFooter = useSyncExternalStore(subscribeToFooterWidth, () => narrowFooterQuery().matches, () => false);
  const access = usePre111kAccess();
  const approved = Boolean(access.code);
  const model = usePre111k(network, access.code, access.reject);
  const { wallet, status } = model;
  const reservationSection = useRef<HTMLElement>(null);
  const previouslyApproved = useRef(approved);
  const firstWallet = useRef<HTMLButtonElement>(null);
  const walletTrigger = useRef<HTMLButtonElement>(null);
  const choosing = wallet.status === 'choosing';
  const connecting = !wallet.ready || wallet.status === 'connecting' || wallet.status === 'restoring';
  const connected = wallet.status === 'connected' && Boolean(wallet.address);
  const count = status?.reservedRelics;
  const remaining = model.statusQuery.isError ? null : status?.remainingRelics;
  const available = status?.config.enabled && remaining != null && remaining > 0;
  const soldOut = remaining === 0;
  const [prices, setPrices] = useState(INITIAL_PRICE_WEI);
  const lastPriceUpdate = useRef({ mainnet: 0, devnet: 0 });
  const backendPrice = status?.config.priceWei;
  const { dataUpdatedAt } = model.statusQuery;
  useEffect(() => {
    if (backendPrice === undefined || dataUpdatedAt <= lastPriceUpdate.current[network]) return;
    lastPriceUpdate.current[network] = dataUpdatedAt;
    if (backendPrice !== prices[network]) setPrices({ ...prices, [network]: backendPrice });
  }, [backendPrice, dataUpdatedAt, network, prices]);
  const currentPrice = model.statusQuery.isError ? undefined : backendPrice;
  const price = `${formatEtherAmount(currentPrice ?? prices[network], 18)} ETH`;
  const action = approved ? 'Reserve' : 'Reserve Relic';
  const actionLabel = `${action} · ${price}`;
  const explorerLink = model.transactionHash && status?.config.explorerUrl ? `${status.config.explorerUrl}/tx/${model.transactionHash}` : null;
  const hasFeedback = Boolean(model.statusQuery.isError || status && !status.config.enabled || model.error || explorerLink);

  useEffect(() => {
    document.body.classList.add('relic-page-body');
    return () => { document.body.classList.remove('relic-page-body'); };
  }, []);

  useEffect(() => {
    if (approved && !previouslyApproved.current) {
      if (document.activeElement instanceof window.HTMLInputElement) document.activeElement.blur();
      reservationSection.current?.focus({ preventScroll: true });
    }
    previouslyApproved.current = approved;
  }, [approved]);

  useEffect(() => { if (approved && choosing) firstWallet.current?.focus(); }, [approved, choosing, wallet.wallets.length]);
  const connectWallet = (event: MouseEvent<HTMLButtonElement>) => {
    walletTrigger.current = event.currentTarget;
    wallet.connect();
  };
  const cancelChoice = () => { wallet.cancel(); requestAnimationFrame(() => walletTrigger.current?.focus()); };

  const artwork = (
    <picture className="relic-page__picture">
      <source media="(max-aspect-ratio: 10/13)" srcSet="/images/111k-relics-portrait.webp" width={1309} height={1630} />
      <img className="relic-page__artwork" src="/images/111k-relics.webp" width={1448} height={1086} alt="111K relics on display in a warehouse" draggable={false} />
    </picture>
  );
  const reserveLabel = model.stage ?? (soldOut ? 'Preorders ended' : null);
  const reserve = <button type="button"
    className={`relic-preorder__reserve${approved ? ` mint-panel__submit${reserveLabel ? ' mint-panel__submit--busy' : ''}` : ''}`}
    aria-label={reserveLabel ?? actionLabel}
    disabled={!approved || connecting || choosing || model.inFlight || soldOut || (connected && !available)}
    onClick={connected ? () => { void model.reserve(); } : connectWallet}>
    {approved ? reserveLabel ? <span className="mint-panel__submit-text">{reserveLabel}</span> : <>
      <span className="mint-panel__submit-text">Reserve</span>
      <span className="mint-panel__submit-price">{price}</span>
    </> : reserveLabel ?? actionLabel}
  </button>;
  const showReservedCount = model.statusQuery.isPending || count != null;
  const walletControls = <div key="wallet" className="relic-preorder__wallet" aria-label="Ethereum wallet">
    {wallet.ready && (approved || wallet.address) ? <div className="relic-preorder__connection">
      {wallet.address ? <>
        <span className="relic-preorder__address" title={wallet.address}>{wallet.address.slice(0, 6)}…{wallet.address.slice(-4)}</span>
        {showReservedCount ? <span className="relic-preorder__reserved" aria-live="polite">
          <RelicCount value={count} digits={1} loadingLabel="Loading reserved count" /> reserved
        </span> : null}
      </> : <button type="button" className="relic-preorder__text-button" disabled={connecting || choosing}
        onClick={connectWallet}>Connect Wallet</button>}
    </div> : null}
    {choosing ? <div className="relic-preorder__choices" role="group" aria-label="Select Ethereum wallet" onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelChoice(); }
    }}>
      {wallet.wallets.map((choice, index) => {
        const icon = getInjectedWalletIconSrc(choice.info.icon);
        return <button key={choice.info.uuid} ref={index === 0 ? firstWallet : undefined} type="button" onClick={() => wallet.selectWallet(choice)}>
          {icon ? <img src={icon} alt="" /> : null}<span>{choice.info.name}</span>
        </button>;
      })}
      <button type="button" className="relic-preorder__text-button" onClick={cancelChoice}>Cancel</button>
    </div> : null}
  </div>;
  const feedback = <div key="feedback" className="relic-preorder__feedback" aria-live="polite" tabIndex={hasFeedback ? 0 : undefined}
    role={hasFeedback ? 'region' : undefined} aria-label={hasFeedback ? 'Reservation messages' : undefined}>
    {model.statusQuery.isError ? <p>{status ? 'Couldn’t refresh reservations.' : 'Couldn’t load reservations.'} <button type="button" className="relic-preorder__text-button" onClick={() => { void model.statusQuery.refetch(); }}>Retry</button></p>
      : status && !status.config.enabled ? <p>Reservations are not open yet.</p> : null}
    {model.error ? <p role="alert">{model.error}</p> : null}
    {explorerLink ? <p><a href={explorerLink} target="_blank" rel="noopener noreferrer">View transaction ↗</a></p> : null}
  </div>;

  return (
    <div className={`relic-page ${approved ? 'relic-page--unlocked' : 'relic-page--locked'}`}>
      <ShopHeader scrollHomeToTop hidden={!approved} showXLink />
      <div className="relic-page__content" role={approved ? 'main' : undefined} inert={!approved || undefined} aria-hidden={!approved || undefined}>
        {!approved ? <main className="relic-page__main">
          <figure className="relic-page__showcase">
            {artwork}
          </figure>
        </main> : null}
        <section ref={reservationSection} className="relic-preorder" aria-label="Reserve a relic" tabIndex={-1}>
          {approved ? <MintPanelFrame quantity={1} quantityLabel="Relic"
            previewContent={<div className="mint-panel__preview relic-preorder__preview">{artwork}</div>}>
            <MintPanelPurchaseFooter hasControls={false}
              info={<>
                <MintPanelTitle title="111K Relics" helpContent={<>
                  <p>Reserve a relic now.</p>
                  <p>On 11/11, choose a specific one and claim it.</p>
                  <p>First come, first served.</p>
                </>} />
                <div className="mint-panel__remaining mint-panel__availability">
                  <RelicCount value={remaining != null ? formatRemainingCount(remaining, ETHEREUM_MAX_RELICS) : null} digits={2}
                    loadingLabel={model.statusQuery.isPending ? 'Loading availability' : undefined} />
                  <span> / {ETHEREUM_MAX_RELICS} left</span>
                </div>
              </>}
              controls={<div className="relic-preorder__support">
                {narrowFooter ? [walletControls, feedback] : [feedback, walletControls]}
              </div>}
              actions={<div className="mint-panel__cta">{reserve}</div>}
            />
          </MintPanelFrame> : <>{reserve}{walletControls}{feedback}</>}
        </section>
      </div>
      <Pre111kAccessGate open={!approved} input={access.input} setInput={access.setInput}
        verifying={access.verifying} error={access.error} submit={access.submit} />
    </div>
  );
}
