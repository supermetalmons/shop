import { useEffect, useMemo, useState } from 'react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey, type VersionedTransaction } from '@solana/web3.js';
import { MintPanel } from './components/MintPanel';
import { InventoryGrid } from './components/InventoryGrid';
import { DeliveryForm } from './components/DeliveryForm';
import { DeliveryPanel } from './components/DeliveryPanel';
import { Modal } from './components/Modal';
import { ClaimForm } from './components/ClaimForm';
import { useMintProgress } from './hooks/useMintProgress';
import { useInventory } from './hooks/useInventory';
import { usePendingOpenBoxes } from './hooks/usePendingOpenBoxes';
import { useSolanaAuth } from './hooks/useSolanaAuth';
import {
  requestClaimTx,
  requestDeliveryTx,
  revealDudes,
  saveEncryptedAddress,
  removeAddress,
  issueReceipts,
} from './lib/api';
import { buildMintBoxesTx, buildStartOpenBoxTx, fetchBoxMinterConfig } from './lib/boxMinter';
import { encryptAddressPayload, isBlockhashExpiredError, sendPreparedTransaction, shortAddress } from './lib/solana';
import { DeliveryOrderSummary, InventoryItem } from './types';
import { FRONTEND_DEPLOYMENT } from './config/deployment';

function hiddenInventoryKey(wallet?: string) {
  return wallet ? `monsHiddenAssets:${wallet}` : 'monsHiddenAssets:disconnected';
}

function loadHiddenAssets(wallet?: string): Set<string> {
  if (typeof window === 'undefined' || !wallet) return new Set();
  try {
    const raw = window.localStorage?.getItem(hiddenInventoryKey(wallet));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v) => typeof v === 'string' && v));
  } catch {
    return new Set();
  }
}

function persistHiddenAssets(wallet: string, ids: Set<string>) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage?.setItem(hiddenInventoryKey(wallet), JSON.stringify(Array.from(ids)));
  } catch {
    // ignore storage failures
  }
}

function formatOrderStatus(status: string): string {
  const normalized = String(status || '').replace(/_/g, ' ').trim();
  if (!normalized) return 'Unknown';
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function formatOrderDate(order: DeliveryOrderSummary): string {
  const timestamp = order.processedAt ?? order.createdAt;
  if (!timestamp) return 'Date pending';
  return new Date(timestamp).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' });
}

function App() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { publicKey, sendTransaction } = wallet;
  const { data: mintStats, refetch: refetchStats } = useMintProgress();
  const {
    profile,
    token,
    loading: authLoading,
    error: authError,
    signIn,
    updateProfile,
  } = useSolanaAuth();
  const { data: inventory = [], refetch: refetchInventory } = useInventory();
  const { data: pendingOpenBoxes = [], refetch: refetchPendingOpenBoxes } = usePendingOpenBoxes();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [minting, setMinting] = useState(false);
  const [startOpenLoading, setStartOpenLoading] = useState<string | null>(null);
  const [revealLoading, setRevealLoading] = useState<string | null>(null);
  const [deliveryLoading, setDeliveryLoading] = useState(false);
  const [deliveryCost, setDeliveryCost] = useState<number | undefined>();
  const [status, setStatus] = useState<string>('');
  const [lastReveal, setLastReveal] = useState<{ boxId: string; dudeIds: number[]; signature: string } | null>(null);
  const [addressId, setAddressId] = useState<string | null>(null);
  const [addAddressOpen, setAddAddressOpen] = useState(false);
  const [removeAddressLoading, setRemoveAddressLoading] = useState<string | null>(null);
  const owner = publicKey?.toBase58();
  const [hiddenAssets, setHiddenAssets] = useState<Set<string>>(() => loadHiddenAssets(owner));

  useEffect(() => {
    setHiddenAssets(loadHiddenAssets(owner));
  }, [owner]);

  const markAssetsHidden = useMemo(() => {
    if (!owner) return (_ids: string[]) => undefined;
    return (ids: string[]) => {
      setHiddenAssets((prev) => {
        const next = new Set(prev);
        ids.forEach((id) => {
          if (typeof id === 'string' && id) next.add(id);
        });
        persistHiddenAssets(owner, next);
        return next;
      });
    };
  }, [owner]);

  const visibleInventory = useMemo(() => {
    if (!hiddenAssets.size) return inventory;
    return inventory.filter((item) => !hiddenAssets.has(item.id));
  }, [inventory, hiddenAssets]);

  // Prefer signing locally + sending via our app RPC connection. This avoids wallet-side cluster mismatches
  // (e.g. Phantom set to mainnet while the app is on devnet) and surfaces clearer RPC errors.
  const signAndSendViaConnection = async (tx: VersionedTransaction) => {
    if (wallet.signTransaction) {
      const signed = await wallet.signTransaction(tx);
      const raw = signed.serialize();
      return connection.sendRawTransaction(raw, {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
        maxRetries: 3,
      });
    }
    return sendTransaction(tx, connection, { skipPreflight: false });
  };

  const mintedOut = useMemo(() => {
    if (!mintStats) return false;
    return mintStats.remaining <= 0;
  }, [mintStats]);

  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const copy = new Set(prev);
      if (copy.has(id)) copy.delete(id);
      else copy.add(id);
      return copy;
    });
  };

  const handleMint = async (quantity: number) => {
    if (!publicKey) throw new Error('Connect wallet to mint');
    setMinting(true);
    setStatus('');
    try {
      const cfg = await fetchBoxMinterConfig(connection);
      const sendOnce = async () => {
        const tx = await buildMintBoxesTx(connection, cfg, publicKey, quantity);
        const sig = await signAndSendViaConnection(tx);
        await connection.confirmTransaction(sig, 'confirmed');
        return sig;
      };
      let sig: string;
      try {
        sig = await sendOnce();
      } catch (err) {
        if (!isBlockhashExpiredError(err)) throw err;
        setStatus('Transaction expired before you approved it. Please approve again…');
        sig = await sendOnce();
      }
      setStatus(`Minted ${quantity} boxes · ${sig}`);
      await Promise.all([refetchStats(), refetchInventory()]);
    } finally {
      setMinting(false);
    }
  };

  const handleStartOpenBox = async (item: InventoryItem) => {
    if (!publicKey) throw new Error('Connect wallet to open a box');
    setStartOpenLoading(item.id);
    setStatus('');
    setLastReveal(null);
    try {
      const cfg = await fetchBoxMinterConfig(connection);
      const sendOnce = async () => {
        const tx = await buildStartOpenBoxTx(connection, cfg, publicKey, new PublicKey(item.id));
        const sig = await signAndSendViaConnection(tx);
        await connection.confirmTransaction(sig, 'confirmed');
        return sig;
      };
      let sig: string;
      try {
        sig = await sendOnce();
      } catch (err) {
        if (!isBlockhashExpiredError(err)) throw err;
        setStatus('Transaction expired before you approved it. Please approve again…');
        sig = await sendOnce();
      }
      setStatus(`Box sent to vault · ${sig}`);
      // Helius indexing can lag after transfers; hide immediately once the tx is confirmed.
      markAssetsHidden([item.id]);
      await Promise.all([refetchInventory(), refetchPendingOpenBoxes()]);
    } catch (err) {
      console.error(err);
      setStatus(err instanceof Error ? err.message : 'Failed to open box');
    } finally {
      setStartOpenLoading(null);
    }
  };

  const handleRevealDudes = async (boxAssetId: string) => {
    if (!publicKey) throw new Error('Connect wallet first');
    // Ensure the wallet session exists (reveal is an authenticated callable).
    if (!token) {
      await signIn();
    }
    setRevealLoading(boxAssetId);
    setStatus('');
    setLastReveal(null);
    try {
      const resp = await revealDudes(publicKey.toBase58(), boxAssetId);
      const revealed = (resp?.dudeIds || []).map((n) => Number(n)).filter((n) => Number.isFinite(n));
      setLastReveal({ boxId: boxAssetId, dudeIds: revealed, signature: resp.signature });
      const revealCopy = revealed.length ? ` · dudes ${revealed.join(', ')}` : '';
      setStatus(`Revealed dudes · ${resp.signature}${revealCopy}`);
      await Promise.all([refetchInventory(), refetchPendingOpenBoxes()]);
    } catch (err) {
      console.error(err);
      setStatus(err instanceof Error ? err.message : 'Failed to reveal dudes');
    } finally {
      setRevealLoading(null);
    }
  };

  const handleSaveAddress = async ({
    formatted,
    country,
    label,
    email,
    countryCode,
  }: {
    formatted: string;
    country: string;
    label: string;
    email: string;
    countryCode: string;
  }) => {
    const encryptionKey = (FRONTEND_DEPLOYMENT.addressEncryptionPublicKey || '').trim();
    if (!encryptionKey) throw new Error('Missing address encryption public key (src/config/deployment.ts)');
    const { cipherText, hint } = encryptAddressPayload(formatted, encryptionKey);
    // Ensure wallet session exists for authenticated callable.
    const session = token ? { profile } : await signIn();
    const saved = await saveEncryptedAddress(cipherText, country, label, hint, email, countryCode);
    const base = (session?.profile || profile) as typeof profile;
    if (updateProfile && base) {
      updateProfile({
        ...base,
        email: email || base.email,
        addresses: [...(base.addresses || []), { ...saved, hint }],
      });
    }
    setAddressId(saved.id);
    setAddAddressOpen(false);
    setStatus('Address saved and encrypted');
  };

  const handleRemoveAddress = async (id: string) => {
    if (!publicKey) throw new Error('Connect a wallet to manage delivery addresses');
    setStatus('');
    setRemoveAddressLoading(id);
    try {
      const session = token ? { profile } : await signIn();
      await removeAddress(id);
      const base = session?.profile || profile;
      const remaining = (base?.addresses || []).filter((addr) => addr.id !== id);
      if (updateProfile && base) {
        updateProfile({
          ...base,
          addresses: remaining,
        });
      }
      if (addressId === id) {
        setAddressId(remaining.length ? remaining[0].id : null);
      }
      setStatus('Address removed');
    } catch (err) {
      console.error(err);
      setStatus(err instanceof Error ? err.message : 'Failed to remove address');
    } finally {
      setRemoveAddressLoading(null);
    }
  };

  const handleSignInForDelivery = async () => {
    setStatus('');
    await signIn();
    setStatus('Signed in. Saved addresses loaded.');
  };

  const handleRequestDelivery = async (addressId: string | null) => {
    if (!publicKey) throw new Error('Connect wallet first');
    if (!addressId) throw new Error('Select a delivery address');
    const itemIds = Array.from(selected);
    if (!itemIds.length) throw new Error('Select items to deliver');
    const addr = savedAddresses.find((a) => a.id === addressId);
    if (!addr) throw new Error('Select a delivery address');
    // Ensure wallet session exists for authenticated callable.
    if (!token) {
      await signIn();
    }
    const deliverableIds = itemIds.filter((id) => {
      const item = inventory.find((entry) => entry.id === id);
      return item && item.kind !== 'certificate';
    });
    if (!deliverableIds.length) throw new Error('Select boxes or dudes to deliver');
    if (deliverableIds.length !== itemIds.length) {
      setSelected(new Set(deliverableIds));
    }

    setDeliveryLoading(true);
    setStatus('');
    setDeliveryCost(undefined);
    try {
      const requestTx = () => requestDeliveryTx(publicKey.toBase58(), { itemIds: deliverableIds, addressId });
      let resp = await requestTx();
      setDeliveryCost(typeof resp.deliveryLamports === 'number' ? resp.deliveryLamports : undefined);
      let sig: string;
      try {
        sig = await sendPreparedTransaction(resp.encodedTx, connection, signAndSendViaConnection);
      } catch (err) {
        if (!isBlockhashExpiredError(err)) throw err;
        setStatus('Prepared transaction expired before you approved it. Preparing a fresh one…');
        resp = await requestTx();
        setDeliveryCost(typeof resp.deliveryLamports === 'number' ? resp.deliveryLamports : undefined);
        sig = await sendPreparedTransaction(resp.encodedTx, connection, signAndSendViaConnection);
      }
      const idSuffix = resp.deliveryId ? ` · id ${resp.deliveryId}` : '';
      setStatus(`Delivery submitted${idSuffix} · ${sig}`);
      // Delivery transfers the selected assets to the vault; hide them immediately once confirmed.
      markAssetsHidden(deliverableIds);
      setSelected(new Set());
      await refetchInventory();
      if (resp.deliveryId) {
        try {
          setStatus(`Delivery submitted${idSuffix} · ${sig} · issuing receipts…`);
          const issued = await issueReceipts(publicKey.toBase58(), resp.deliveryId, sig);
          const minted = Number(issued?.receiptsMinted || 0);
          setStatus(`Delivery submitted${idSuffix} · ${sig} · receipts issued (${minted})`);
          await refetchInventory();
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Failed to issue receipts';
          setStatus(`Delivery submitted${idSuffix} · ${sig} (receipt warning: ${msg})`);
        }
      }
    } catch (err) {
      console.error(err);
      setStatus(err instanceof Error ? err.message : 'Failed to request delivery');
    } finally {
      setDeliveryLoading(false);
    }
  };

  const handleClaim = async ({ code }: { code: string }) => {
    if (!publicKey) throw new Error('Connect wallet to claim');
    // Ensure wallet session exists for authenticated callable.
    if (!token) {
      await signIn();
    }
    setStatus('');
    const requestTx = () => requestClaimTx(publicKey.toBase58(), code);
    let resp = await requestTx();
    let sig: string;
    try {
      sig = await sendPreparedTransaction(resp.encodedTx, connection, signAndSendViaConnection);
    } catch (err) {
      if (!isBlockhashExpiredError(err)) throw err;
      setStatus('Prepared transaction expired before you approved it. Preparing a fresh one…');
      resp = await requestTx();
      sig = await sendPreparedTransaction(resp.encodedTx, connection, signAndSendViaConnection);
    }
    setStatus(`Claimed certificates · ${sig}`);
    await refetchInventory();
  };

  const secondaryLinks = [
    { label: 'Tensor', href: 'https://www.tensor.trade/trade/mons' },
    { label: 'Magic Eden', href: 'https://magiceden.io/' },
  ];

  const savedAddresses = profile?.addresses || [];
  const deliveryOrders = profile?.orders || [];

  useEffect(() => {
    if (!addressId && savedAddresses.length) {
      setAddressId(savedAddresses[0].id);
    }
  }, [addressId, savedAddresses]);

  useEffect(() => {
    // Delivery cost is returned by the server when preparing the delivery transaction.
    // Clear any previously-returned value whenever the inputs change to avoid showing stale fees.
    setDeliveryCost(undefined);
  }, [addressId, selected]);

  return (
    <div className="page">
      <header className="top">
        <div className="brand">
          <h1><img src="https://assets.mons.link/shop/logo.webp" alt="" className="brand-icon" />mons.shop</h1>
        </div>
        <WalletMultiButton />
      </header>

      <div className="hero">
        <div className="hero__media">
          <img src={`${FRONTEND_DEPLOYMENT.paths.base}/box/default.webp`} alt="mons blind box" />
        </div>
      </div>

      <MintPanel stats={mintStats} onMint={handleMint} busy={minting} />

      {mintedOut ? (
        <section className="card">
          <div className="card__title">Minted out</div>
          <p className="muted">All boxes are gone. Grab them on secondary.</p>
          <div className="row">
            {secondaryLinks.map((link) => (
              <a key={link.href} className="pill" href={link.href} target="_blank" rel="noreferrer">
                {link.label}
              </a>
            ))}
          </div>
        </section>
      ) : null}

      <section className="card">
        <div className="card__title">Pending reveals</div>
        {pendingOpenBoxes.length ? (
          <div className="grid">
            {pendingOpenBoxes.map((p) => (
              <div key={p.pendingPda} className="card subtle">
                <div className="card__head">
                  <div>
                    <div className="pill">Pending</div>
                    <div className="muted small">Box {shortAddress(p.boxAssetId)}</div>
                  </div>
                  <div className="card__actions">
                    <button
                      className="ghost"
                      onClick={() => handleRevealDudes(p.boxAssetId)}
                      disabled={Boolean(revealLoading) || Boolean(startOpenLoading)}
                    >
                      {revealLoading === p.boxAssetId ? 'Revealing…' : 'Reveal dudes'}
                    </button>
                  </div>
                </div>
                <div className="muted small">Pending id {shortAddress(p.pendingPda)}</div>
              </div>
            ))}
          </div>
        ) : (
          <div className="muted small">No pending reveals.</div>
        )}
      </section>

      <section className="card">
        <div className="card__title">Inventory</div>
        <InventoryGrid items={visibleInventory} selected={selected} onToggle={toggleSelected} onOpenBox={handleStartOpenBox} />
        {startOpenLoading ? <div className="muted">Sending {shortAddress(startOpenLoading)} to the vault…</div> : null}
      </section>

      {lastReveal ? (
        <section className="card subtle">
          <div className="card__title">Revealed dudes</div>
          <p className="muted small">
            Box {shortAddress(lastReveal.boxId)} revealed:
          </p>
          <div className="row">
            {lastReveal.dudeIds.map((id) => (
              <span key={id} className="pill">
                Dude #{id}
              </span>
            ))}
          </div>
          <p className="muted small">Tx {shortAddress(lastReveal.signature)}</p>
        </section>
      ) : null}

      <DeliveryPanel
        selectedCount={selected.size}
        addresses={savedAddresses.map((addr) => ({ ...addr, hint: addr.hint || addr.id.slice(0, 4) }))}
        addressId={addressId}
        onSelectAddress={setAddressId}
        onRequestDelivery={() => handleRequestDelivery(addressId)}
        loading={deliveryLoading}
        costLamports={deliveryCost}
        signedIn={Boolean(profile)}
        signingIn={authLoading}
        walletConnected={Boolean(publicKey)}
        onSignIn={handleSignInForDelivery}
        onAddAddress={() => setAddAddressOpen(true)}
        onRemoveAddress={handleRemoveAddress}
        removingAddressId={removeAddressLoading}
      />

      <Modal open={addAddressOpen} title="Add a delivery address" onClose={() => setAddAddressOpen(false)}>
        <DeliveryForm
          mode="modal"
          onSave={handleSaveAddress}
          defaultEmail={profile?.email || ''}
          onCancel={() => setAddAddressOpen(false)}
        />
      </Modal>

      <ClaimForm onClaim={handleClaim} />

      {authError ? <div className="error">{authError}</div> : null}
      {status ? <div className="success">{status}</div> : null}

      <section className="card">
        <div className="card__title">Deliveries</div>
        {!profile ? (
          <div className="muted small">Sign in to view your deliveries.</div>
        ) : deliveryOrders.length ? (
          <div className="grid">
            {deliveryOrders.map((order) => (
              <div key={order.deliveryId} className="card subtle">
                <div className="card__head">
                  <div>
                    <div className="card__title">Delivery #{order.deliveryId}</div>
                    <div className="muted small">{formatOrderDate(order)}</div>
                  </div>
                  <div className="pill">{formatOrderStatus(order.status)}</div>
                </div>
                {order.items.length ? (
                  <div className="pill-row">
                    {order.items.map((item, idx) => (
                      <span key={`${order.deliveryId}:${item.kind}:${item.refId}:${idx}`} className="pill">
                        {item.kind === 'box' ? 'Box' : 'Dude'} #{item.refId}
                      </span>
                    ))}
                  </div>
                ) : (
                  <div className="muted small">Items unavailable.</div>
                )}
                {order.fulfillmentStatus ? (
                  <div className="muted small">Fulfillment update: {order.fulfillmentStatus}</div>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <div className="muted small">No deliveries yet.</div>
        )}
      </section>
    </div>
  );
}

export default App;
