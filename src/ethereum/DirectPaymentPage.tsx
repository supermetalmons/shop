import { useEffect, useRef, useState } from 'react';
import type { Pre111kNetwork } from '../../shared/ethereum/pre111k';
import { ShopHeader } from '../components/ShopHeader';
import { getInjectedWalletIconSrc } from '../wallet/injectedEthereumProviders';
import { usePre111k } from './usePre111k';
import '../drif.css';

export default function DirectPaymentPage({ network }: { network: Pre111kNetwork }) {
  const model = usePre111k(network);
  const { wallet, status, pending } = model;
  const firstWallet = useRef<HTMLButtonElement>(null);
  const connectButton = useRef<HTMLButtonElement>(null);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [replacementHash, setReplacementHash] = useState('');
  const [confirmStop, setConfirmStop] = useState(false);
  const choosing = wallet.status === 'choosing';
  const connecting = !wallet.ready || wallet.status === 'connecting' || wallet.status === 'restoring';
  const count = status?.reservedRelics;
  const available = status?.config.enabled && status.remainingRelics !== null && status.remainingRelics > 0 && !model.statusQuery.isError;
  const soldOut = status?.remainingRelics === 0;
  const price = network === 'mainnet' ? '2.3' : '0.0023';
  const explorerLink = pending?.hash && status?.config.explorerUrl ? `${status.config.explorerUrl}/tx/${pending.hash}` : null;

  useEffect(() => {
    document.body.classList.add('drif-body');
    return () => { document.body.classList.remove('drif-body'); };
  }, []);

  useEffect(() => { if (choosing) firstWallet.current?.focus(); }, [choosing, wallet.wallets.length]);
  useEffect(() => { setRecoveryOpen(false); setReplacementHash(''); setConfirmStop(false); }, [network, wallet.address, pending?.hash]);
  const cancelChoice = () => { wallet.cancel(); requestAnimationFrame(() => connectButton.current?.focus()); };

  return (
    <div className="drif-page drif-page--relics">
      <ShopHeader scrollHomeToTop variant="drif" />
      <main className="drif-main">
        <figure className="drif-card-showcase drif-card-showcase--caption">
          <img className="drif-static-artwork" src="https://wip.lil.org/111k/artwork_placeholder.png" alt="Artwork" draggable={false} />
          <figcaption className="drif-artwork-caption">111k reserved relic{network === 'devnet' ? ' · Sepolia testnet' : ''}</figcaption>
        </figure>
      </main>
      <section className="relic-preorder" aria-label="Reserve a relic">
        <div className="relic-preorder__wallet" aria-label="Ethereum wallet">
          {wallet.address ? <div className="relic-preorder__connection">
            <span className="relic-preorder__address" title={wallet.address}>{wallet.address.slice(0, 6)}…{wallet.address.slice(-4)}</span>
            <span aria-live="polite">{model.statusQuery.isError || status?.config.contractAddress === null ? 'Reservations unavailable' : count === null || count === undefined ? 'Loading reservations…' : `${count} reserved`}</span>
            <button type="button" className="relic-preorder__text-button" onClick={wallet.disconnect}>Disconnect</button>
          </div> : !choosing ? <button ref={connectButton} type="button" className="relic-preorder__text-button"
            disabled={connecting || model.inFlight} onClick={wallet.connect}>{connecting ? 'Connecting…' : 'Connect wallet'}</button> : null}
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
        <button type="button" className="relic-preorder__reserve" disabled={!available || !wallet.ready || wallet.status !== 'connected' || !wallet.address || connecting || choosing || model.inFlight || Boolean(pending)}
          onClick={() => { void model.reserve(); }}>
          {model.stage ?? (pending ? pending.hash ? 'Confirming reservation…' : 'Check your wallet…' : soldOut ? 'All relics reserved' : `Reserve relic · ${price} ETH`)}
        </button>
        <div className="relic-preorder__feedback" aria-live="polite">
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
  );
}
