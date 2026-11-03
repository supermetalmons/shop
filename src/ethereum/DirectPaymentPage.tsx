import { useEffect, useRef } from 'react';
import { PRE111K_MAX_RELICS, type Pre111kNetwork } from '../../shared/ethereum/pre111k';
import { MintPanelFrame, MintPanelPurchaseFooter, MintPanelTitle } from '../components/MintPanel';
import { ShopHeader } from '../components/ShopHeader';
import { formatRemainingCount } from '../lib/formatRemainingCount';
import { getInjectedWalletIconSrc } from '../wallet/injectedEthereumProviders';
import { Pre111kAccessGate } from './Pre111kAccessGate';
import { usePre111k } from './usePre111k';
import { usePre111kAccess } from './usePre111kAccess';
import '../styles/pre111k.css';

export default function DirectPaymentPage({ network }: { network: Pre111kNetwork }) {
  const access = usePre111kAccess();
  const approved = Boolean(access.code);
  const model = usePre111k(network, access.code, access.reject);
  const { wallet, status } = model;
  const reservationSection = useRef<HTMLElement>(null);
  const previouslyApproved = useRef(approved);
  const firstWallet = useRef<HTMLButtonElement>(null);
  const reserveButton = useRef<HTMLButtonElement>(null);
  const choosing = wallet.status === 'choosing';
  const connecting = !wallet.ready || wallet.status === 'connecting' || wallet.status === 'restoring';
  const connected = wallet.status === 'connected' && Boolean(wallet.address);
  const count = status?.reservedRelics;
  const remaining = model.statusQuery.isError || status?.remainingRelics == null ? null : Math.max(0, status.remainingRelics - 1);
  const available = status?.config.enabled && remaining !== null && remaining > 0;
  const soldOut = remaining === 0;
  const price = network === 'mainnet' ? '2.3' : '0.0023';
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
  const cancelChoice = () => { wallet.cancel(); requestAnimationFrame(() => reserveButton.current?.focus()); };

  const artwork = <img className="relic-page__artwork" src="https://wip.lil.org/111k/artwork_placeholder.png" width={932} height={1006} alt="Artwork" draggable={false} />;
  const reserveLabel = model.stage ?? (soldOut ? 'Preorders ended' : null);
  const reserve = <button ref={reserveButton} type="button"
    className={`relic-preorder__reserve${approved ? ` mint-panel__submit${reserveLabel ? ' mint-panel__submit--busy' : ''}` : ''}`}
    aria-label={reserveLabel ?? `${approved ? 'Reserve' : 'Reserve Relic'} · ${price} ETH`}
    disabled={!approved || connecting || choosing || model.inFlight || soldOut || (connected && !available)}
    onClick={() => { if (connected) void model.reserve(); else wallet.connect(); }}>
    {approved ? reserveLabel ? <span className="mint-panel__submit-text">{reserveLabel}</span> : <>
      <span className="mint-panel__submit-text">Reserve</span>
      <span className="mint-panel__submit-price">{price} ETH</span>
    </> : reserveLabel ?? `Reserve Relic · ${price} ETH`}
  </button>;
  const walletControls = <div className="relic-preorder__wallet" aria-label="Ethereum wallet">
    {wallet.address ? <div className="relic-preorder__connection">
      {!model.statusQuery.isError && typeof count === 'number' && count > 0 ? <span aria-live="polite">{count} reserved</span> : null}
      <span className="relic-preorder__address" title={wallet.address}>{wallet.address.slice(0, 6)}…{wallet.address.slice(-4)}</span>
      <button type="button" className="relic-preorder__text-button relic-preorder__disconnect" onClick={wallet.disconnect}>Disconnect</button>
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
  const feedback = <div className="relic-preorder__feedback" aria-live="polite" tabIndex={hasFeedback ? 0 : undefined}
    role={hasFeedback ? 'region' : undefined} aria-label={hasFeedback ? 'Reservation messages' : undefined}>
    {model.statusQuery.isError ? <p>Couldn’t load reservations. <button type="button" className="relic-preorder__text-button" onClick={() => { void model.statusQuery.refetch(); }}>Retry</button></p>
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
                <MintPanelTitle title="111K Relics" />
                <div className="mint-panel__remaining mint-panel__availability">
                  <span className="mint-panel__remaining-count" style={{ minWidth: '2ch' }}>
                    {remaining != null ? formatRemainingCount(remaining, PRE111K_MAX_RELICS) : model.statusQuery.isPending ? <span role="status" aria-label="Loading availability">
                      <span className="mint-panel__digit-placeholder" aria-hidden="true" /><span className="mint-panel__digit-placeholder" aria-hidden="true" />
                    </span> : '—'}
                  </span>
                  <span> / {PRE111K_MAX_RELICS} left</span>
                </div>
              </>}
              controls={<div className="relic-preorder__support" data-empty={!wallet.address && !choosing && !hasFeedback}>
                {walletControls}
                {feedback}
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
