import { useEffect, useRef, useState } from 'react';
import { formatEtherAmount } from '../../shared/ethereum/protocol';
import { ethereumExplorerTransaction } from '../../shared/ethereum/config';
import { isEthereumCheckoutPartnerOrigin } from '../../shared/ethereum/checkout';
import { DeliveryForm } from '../components/DeliveryForm';
import { ShopHeader } from '../components/ShopHeader';
import { getInjectedWalletIconSrc } from '../wallet/injectedEthereumProviders';
import type { EthereumWallet } from '../ethereum/useEthereum111k';
import { useEthereumCheckout, type CheckoutLocation } from './useEthereumCheckout';

function shortAddress(address: string): string { return `${address.slice(0, 6)}…${address.slice(-4)}`; }

export function CheckoutPageContent({ wallet, ...location }: CheckoutLocation & { wallet: EthereumWallet }) {
  const model = useEthereumCheckout(location, wallet);
  const checkout = model.checkout;
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [transactionHash, setTransactionHash] = useState('');
  const firstWallet = useRef<HTMLButtonElement>(null);
  const walletSection = useRef<HTMLElement>(null);
  const choosing = wallet.status === 'choosing';
  const walletBusy = wallet.status === 'connecting' || wallet.status === 'restoring';
  const pending = checkout?.status === 'pending' || checkout?.status === 'submitting';
  const terminal = checkout?.status === 'success' || checkout?.status === 'failed';
  const owned = checkout?.items.filter(item => item.owner === wallet.address).length ?? 0;
  const ownsAll = Boolean(checkout && !checkout.unavailableTokenIds.length && owned === checkout.tokenIds.length);
  const matchesCheckout = !checkout?.wallet || checkout.wallet === wallet.address;
  const readyWallet = wallet.status === 'connected' && ownsAll && matchesCheckout;
  const txLink = checkout?.transactionHash ? ethereumExplorerTransaction(checkout.config, checkout.transactionHash) : null;
  const returnUrl = checkout?.returnUrl ? new URL(checkout.returnUrl) : null;
  if (model.uncertain && returnUrl) returnUrl.searchParams.set('result', 'pending');
  const canReturn = Boolean(returnUrl && (!model.busy || pending || terminal || model.uncertain));
  let returnLabel = 'Return to mons.shop';
  if (returnUrl && isEthereumCheckoutPartnerOrigin(returnUrl.origin)) returnLabel = 'Return to VVV';
  useEffect(() => { if (choosing) firstWallet.current?.focus(); }, [choosing]);

  return <div className="page">
    <ShopHeader renderRight={({ interactive }) => <div className="shipping-checkout__header-wallet">
      {wallet.address ? <span title={wallet.address}>{shortAddress(wallet.address)}</span> : null}
      <button type="button" className="ghost" disabled={!interactive || Boolean(model.busy) || walletBusy}
        tabIndex={interactive ? undefined : -1}
        onClick={() => { walletSection.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }); wallet.chooseWallet(); }}>
        {wallet.address ? 'Change wallet' : 'Connect Ethereum'}
      </button>
    </div>} />
    <main className="shipping-checkout">
      <div className="shipping-checkout__heading">
        <h2>Shipping checkout</h2>
        <p className="muted small">111K test drop · No physical items will be shipped.</p>
      </div>
      {model.loading ? <p role="status">Loading your checkout…</p> : null}
      {!checkout && model.error ? <p className="error" role="alert">{model.error}</p> : null}
      {model.loadError ? <div className="error" role="alert">
        {checkout ? 'Couldn’t refresh checkout. Your existing transaction is still being tracked.' : 'Couldn’t load checkout.'}
        <button type="button" className="ghost" onClick={model.retry}>Retry</button>
      </div> : null}
      {checkout ? <div className="shipping-checkout__layout">
        <section aria-label="Selected items">
          <h3>{checkout.tokenIds.length} {checkout.tokenIds.length === 1 ? 'item' : 'items'} selected</h3>
          <ul className="shipping-checkout__items">
            {checkout.tokenIds.map(id => {
              const item = checkout.items.find(candidate => candidate.tokenId === id);
              const unavailable = checkout.unavailableTokenIds.includes(id) || !item;
              return <li key={id} className="shipping-checkout__item">
                {item ? <img src={item.image} alt={item.name} loading="lazy" decoding="async" /> : null}
                <div className="shipping-checkout__item-name">{item?.name ?? `Token #${id}`}</div>
                {!pending && !terminal && unavailable ? <div className="shipping-checkout__item-note error">Unavailable for delivery</div> :
                  !pending && !terminal && wallet.address && item?.owner !== wallet.address ?
                    <div className="shipping-checkout__item-note muted">Held by another wallet</div> : null}
              </li>;
            })}
          </ul>
          <p className="muted small">Delivery fee: {formatEtherAmount(checkout.config.deliveryFeeWei)} ETH per order, plus network gas.</p>
          {!pending && !terminal ? <p className="muted small">Redeeming burns the selected NFTs and mints delivery receipt NFTs.</p> : null}
        </section>
        <div>
          <section ref={walletSection} className="shipping-checkout__wallet" aria-label="Ethereum wallet">
            <h3>Ethereum wallet</h3>
            {wallet.address ? <p className="shipping-checkout__wallet-address" title={wallet.address}>
              {shortAddress(wallet.address)} <span className="muted">· {model.chainId === checkout.chainId ? checkout.config.chainName :
                model.chainId === null ? 'Checking network…' : `Chain ${model.chainId}`}</span>
            </p> : <p className="muted small">Connect the wallet that holds your selected NFTs.</p>}
            {choosing ? <div className="shipping-checkout__choices" role="group" aria-label="Choose Ethereum wallet"
              onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); wallet.cancel(); } }}>
              {wallet.wallets.map((candidate, index) => {
                const icon = getInjectedWalletIconSrc(candidate.info.icon);
                return <button key={candidate.info.uuid} ref={index === 0 ? firstWallet : undefined} type="button"
                  onClick={() => wallet.selectWallet(candidate)}>{icon ? <img src={icon} alt="" /> : null}{candidate.info.name}</button>;
              })}
              {!wallet.wallets.length ? <p className="muted small">No Ethereum wallet found. Open this page in your wallet’s browser or install a wallet extension.</p> : null}
              <button type="button" className="ghost" onClick={wallet.cancel}>Cancel wallet selection</button>
            </div> : <div className="shipping-checkout__actions">
              <button type="button" className="ghost" onClick={wallet.address ? wallet.chooseWallet : wallet.connect}
                disabled={Boolean(model.busy) || walletBusy}>{walletBusy ? 'Connecting…' : wallet.address ? 'Change wallet' : 'Connect wallet'}</button>
              {wallet.address ? <button type="button" className="ghost" onClick={wallet.changeAccount}
                disabled={Boolean(model.busy) || walletBusy}>Change account</button> : null}
            </div>}
            {wallet.error ? <div className="error small" role="alert">
              <p>{wallet.error}</p>
              {wallet.address ? <button type="button" className="ghost" onClick={wallet.checkAccount} disabled={Boolean(model.busy) || walletBusy}>Check account</button> : null}
            </div> : null}
            {wallet.address && model.chainId !== null && model.chainId !== checkout.chainId ? <p className="muted small" role="status">
              Switch to {checkout.config.chainName} to redeem these items.{' '}
              <button type="button" className="ghost" onClick={() => void model.switchNetwork()} disabled={Boolean(model.busy) || walletBusy || choosing}>Switch network</button>
            </p> : null}
            {!pending && !terminal && wallet.address && !ownsAll && !choosing ? <p className="error small" role="status">
              This wallet holds {owned} of {checkout.tokenIds.length} selected items. Switch to the wallet that holds all of them.
            </p> : null}
            {!pending && !terminal && wallet.address && ownsAll && !matchesCheckout ? <p className="error small" role="status">
              Continue this checkout with {shortAddress(checkout.wallet!)}.
            </p> : null}
          </section>

          <section className="shipping-checkout__address" hidden={checkout.status !== 'ready'} aria-label="Shipping address">
            <h3>Shipping address</h3>
            <p className="muted small">We use your email for shipping updates.</p>
            <DeliveryForm mode="modal" onSubmit={model.submit} submitDisabled={!readyWallet || Boolean(model.busy) || model.uncertain}
              submitLabel={`Redeem for ${formatEtherAmount(checkout.config.deliveryFeeWei)} ETH`}
              shippingNote={`Test delivery: ${formatEtherAmount(checkout.config.deliveryFeeWei)} ETH per order, up to ${checkout.config.maxDeliveryItems} items.`} />
          </section>
          {checkout.status === 'prepared' ? <section className="shipping-checkout__status" aria-label="Saved shipping details">
            <h3>Shipping details saved</h3>
            <p className="muted small">Continue with the address saved for this checkout. To use another address, return and start a new checkout.</p>
            <button type="button" onClick={() => void model.submit()} disabled={!readyWallet || Boolean(model.busy) || model.uncertain}>
              Continue with saved address
            </button>
          </section> : null}
          {model.busy ? <p className="muted small" role="status" aria-live="polite">{model.busy}</p> : null}
          {model.uncertain && !pending ? <p className="muted small" role="status">Checking whether your transaction was started. Refresh before continuing.</p> : null}
          {pending ? <section className="shipping-checkout__status" aria-label="Delivery status" aria-live="polite">
            <h3>{checkout.transactionHash ? 'Delivery pending' : 'Waiting for your transaction'}</h3>
            <p className="muted small">You can return or close this page. We’ll keep checking your transaction.</p>
            {checkout.transactionHash ? <>
              <p className="muted small">{checkout.confirmations} of {checkout.requiredConfirmations} confirmations</p>
              <p className="shipping-checkout__hash">{txLink ? <a href={txLink} target="_blank" rel="noreferrer">View transaction ↗</a> : checkout.transactionHash}</p>
            </> : <p className="muted small">If your wallet is still asking for approval, check it before submitting anything else.</p>}
          </section> : null}
          {checkout.status === 'success' ? <section className="shipping-checkout__status" aria-label="Delivery status" aria-live="polite">
            <h3>Redemption confirmed</h3>
            <p className="muted small">Your test delivery was accepted{checkout.orderId ? ` as order #${checkout.orderId}` : ''}.</p>
            {txLink ? <a href={txLink} target="_blank" rel="noreferrer">View transaction ↗</a> : null}
          </section> : null}
          {checkout.status === 'failed' ? <section className="shipping-checkout__status" aria-label="Delivery status" aria-live="polite">
            <h3>Redemption wasn’t completed</h3>
            <p className="muted small">This checkout couldn’t be completed. Return to your collection to start again.</p>
            {txLink ? <a href={txLink} target="_blank" rel="noreferrer">View transaction ↗</a> : null}
          </section> : null}
          {model.error ? <p className="error small" role="alert">{model.error}</p> : null}
          {model.blockingCheckoutId ? <p className="small"><a href={`/checkout/${model.blockingCheckoutId}`}>Resume pending checkout</a></p> : null}
          {!terminal ? <div className="shipping-checkout__actions">
            <button type="button" className="ghost" onClick={() => void model.refresh()} disabled={model.refreshing}>
              {model.refreshing ? 'Refreshing…' : 'Refresh status'}
            </button>
            {pending && checkout.attempt ? <button type="button" className="ghost" onClick={() => setRecoveryOpen(value => !value)}>Transaction changed?</button> : null}
          </div> : null}
          {recoveryOpen && pending ? <section className="shipping-checkout__recovery" aria-label="Recover transaction">
            <p className="muted small">Paste the transaction hash from your wallet, including a replacement or cancellation. Connect the wallet used for this checkout.</p>
            <form onSubmit={event => { event.preventDefault(); void model.recover(transactionHash); }}>
              <label>Transaction hash<input value={transactionHash} onChange={event => setTransactionHash(event.target.value)}
                autoComplete="off" spellCheck={false} placeholder="0x…" required /></label>
              <button type="submit" disabled={Boolean(model.busy) || wallet.status !== 'connected'}>Check transaction</button>
            </form>
          </section> : null}
          {canReturn ? <a className="shipping-checkout__return" href={returnUrl!.href}>{returnLabel}</a> : null}
        </div>
      </div> : !model.loading ? <a className="shipping-checkout__return" href="/111k_devnet">Return to mons.shop</a> : null}
    </main>
  </div>;
}
