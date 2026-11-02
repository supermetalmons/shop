import { useEffect, useRef, useState } from 'react';
import type { Pre111kNetwork } from '../../shared/ethereum/pre111k';
import { ShopHeader } from '../components/ShopHeader';
import { getInjectedWalletIconSrc } from '../wallet/injectedEthereumProviders';
import { Pre111kAccessGate } from './Pre111kAccessGate';
import { usePre111k } from './usePre111k';
import { usePre111kAccess } from './usePre111kAccess';
import '../styles/pre111k.css';

export default function DirectPaymentPage({ network }: { network: Pre111kNetwork }) {
  const access = usePre111kAccess();
  const approved = Boolean(access.code);
  const model = usePre111k(network, access.code, access.reject);
  const { wallet, status, pending } = model;
  const reservationSection = useRef<HTMLElement>(null);
  const previouslyApproved = useRef(approved);
  const firstWallet = useRef<HTMLButtonElement>(null);
  const reserveButton = useRef<HTMLButtonElement>(null);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [replacementHash, setReplacementHash] = useState('');
  const [confirmStop, setConfirmStop] = useState(false);
  const choosing = wallet.status === 'choosing';
  const connecting = !wallet.ready || wallet.status === 'connecting' || wallet.status === 'restoring';
  const connected = wallet.status === 'connected' && Boolean(wallet.address);
  const count = status?.reservedRelics;
  const available = status?.config.enabled && status.remainingRelics !== null && status.remainingRelics > 0 && !model.statusQuery.isError;
  const soldOut = status?.remainingRelics === 0;
  const price = network === 'mainnet' ? '2.3' : '0.0023';
  const explorerLink = pending?.hash && status?.config.explorerUrl ? `${status.config.explorerUrl}/tx/${pending.hash}` : null;
  const hasFeedback = Boolean(model.statusQuery.isError || status && !status.config.enabled || model.error || model.message || pending && (explorerLink || !model.inFlight));

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
  useEffect(() => { setRecoveryOpen(false); setReplacementHash(''); setConfirmStop(false); }, [network, wallet.address, pending?.hash]);
  const cancelChoice = () => { wallet.cancel(); requestAnimationFrame(() => reserveButton.current?.focus()); };

  return (
    <div className={`relic-page${approved ? '' : ' relic-page--locked'}`}>
      <ShopHeader scrollHomeToTop hidden={!approved} />
      <div className="relic-page__content" inert={!approved || undefined} aria-hidden={!approved || undefined}>
        <main className="relic-page__main">
          <figure className="relic-page__showcase">
            <img className="relic-page__artwork" src="https://wip.lil.org/111k/artwork_placeholder.png" width={932} height={1006} alt="Artwork" draggable={false} />
          </figure>
        </main>
        <section ref={reservationSection} className="relic-preorder" aria-label="Reserve a relic" tabIndex={-1}>
          <button ref={reserveButton} type="button" className="relic-preorder__reserve" disabled={!approved || connecting || choosing || model.inFlight || Boolean(pending) || (connected && !available)}
            onClick={() => { if (connected) void model.reserve(); else wallet.connect(); }}>
            {model.stage ?? (pending ? pending.hash ? 'Confirming reservation…' : 'Check your wallet…' : connecting ? 'Connecting…' : connected && soldOut ? 'All relics reserved' : `Reserve Relic · ${price} ETH`)}
          </button>
          <div className="relic-preorder__wallet" aria-label="Ethereum wallet">
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
          </div>
          <div className="relic-preorder__feedback" aria-live="polite" tabIndex={hasFeedback ? 0 : undefined}
            role={hasFeedback ? 'region' : undefined} aria-label={hasFeedback ? 'Reservation messages' : undefined}>
            {model.statusQuery.isError ? <p>Couldn’t load reservations. <button type="button" className="relic-preorder__text-button" onClick={() => { void model.statusQuery.refetch(); }}>Retry</button></p>
              : status && !status.config.enabled ? <p>Reservations are not open yet.</p> : null}
            {model.error ? <p role="alert">{model.error}</p> : model.message ? <p role="status">{model.message}</p> : null}
            {pending ? <p>{explorerLink ? <a href={explorerLink} target="_blank" rel="noopener noreferrer">View transaction ↗</a> : null}
              {!model.inFlight ? <button type="button" className="relic-preorder__text-button" onClick={() => setRecoveryOpen(value => !value)}>{pending.hash ? 'Manage pending transaction' : 'Track transaction'}</button> : null}</p> : null}
          </div>
          {pending && recoveryOpen ? <div className="relic-preorder__recovery">
            <form onSubmit={event => { event.preventDefault(); model.track(replacementHash); }}>
              <label>Transaction hash<input value={replacementHash} onChange={event => setReplacementHash(event.target.value)} placeholder="0x…" autoComplete="off" spellCheck={false} /></label>
              <button type="submit" disabled={model.inFlight}>Track transaction</button>
            </form>
            {confirmStop ? <><p>Stopping tracking does not cancel the transaction. It may still reserve a relic. Check your wallet before reserving again.</p>
              <button type="button" className="relic-preorder__text-button" onClick={model.stopTracking}>Stop tracking this transaction</button></>
              : <button type="button" className="relic-preorder__text-button" onClick={() => setConfirmStop(true)}>Stop tracking…</button>}
          </div> : null}
        </section>
      </div>
      <Pre111kAccessGate open={!approved} input={access.input} setInput={access.setInput}
        verifying={access.verifying} error={access.error} submit={access.submit} />
    </div>
  );
}
