import { useEffect, useMemo, useState } from 'react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import type { VersionedTransaction } from '@solana/web3.js';
import { MintPanel } from './components/MintPanel';
import { InventoryGrid } from './components/InventoryGrid';
import { DeliveryForm } from './components/DeliveryForm';
import { DeliveryPanel } from './components/DeliveryPanel';
import { ContactEmail } from './components/ContactEmail';
import { ClaimForm } from './components/ClaimForm';
import { EmailSubscribe } from './components/EmailSubscribe';
import { useMintProgress } from './hooks/useMintProgress';
import { useInventory } from './hooks/useInventory';
import { useSolanaAuth } from './hooks/useSolanaAuth';
import {
  requestClaimTx,
  requestDeliveryTx,
  requestMintTx,
  requestOpenBoxTx,
  finalizeMintTx,
  finalizeClaimTx,
  saveEncryptedAddress,
  finalizeDeliveryTx,
} from './lib/api';
import { encryptAddressPayload, estimateDeliveryLamports, sendPreparedTransaction, shortAddress } from './lib/solana';
import { InventoryItem } from './types';

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
  const { data: inventory = [], refetch: refetchInventory } = useInventory(token);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [minting, setMinting] = useState(false);
  const [openLoading, setOpenLoading] = useState<string | null>(null);
  const [deliveryLoading, setDeliveryLoading] = useState(false);
  const [deliveryCost, setDeliveryCost] = useState<number | undefined>();
  const [status, setStatus] = useState<string>('');
  const [lastOpen, setLastOpen] = useState<{ boxId: string; dudeIds: number[]; signature: string } | null>(null);
  const [contactEmail, setContactEmail] = useState(profile?.email || '');

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
      const resp = await requestMintTx(publicKey.toBase58(), quantity, token || undefined);
      const sig = await sendPreparedTransaction(resp.encodedTx, connection, signAndSendViaConnection);
      try {
        await finalizeMintTx(publicKey.toBase58(), sig, token || undefined);
        setStatus(`Minted ${resp.allowedQuantity || quantity} boxes · ${sig}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to record mint';
        console.error(err);
        setStatus(`Minted ${resp.allowedQuantity || quantity} boxes · ${sig} (finalize warning: ${msg})`);
      }
      await Promise.all([refetchStats(), refetchInventory()]);
    } finally {
      setMinting(false);
    }
  };

  const handleOpenBox = async (item: InventoryItem) => {
    if (!publicKey) throw new Error('Connect wallet to open a box');
    setOpenLoading(item.id);
    setStatus('');
    setLastOpen(null);
    try {
      const resp = await requestOpenBoxTx(publicKey.toBase58(), item.id, token || undefined);
      const sig = await sendPreparedTransaction(resp.encodedTx, connection, signAndSendViaConnection);
      const revealedDudes = (resp.assignedDudeIds || []).map((id) => Number(id));
      setLastOpen({ boxId: item.id, dudeIds: revealedDudes, signature: sig });
      const revealCopy = revealedDudes.length ? ` · dudes ${revealedDudes.join(', ')}` : '';
      setStatus(`Opened box · ${sig}${revealCopy}`);
      await refetchInventory();
    } catch (err) {
      console.error(err);
      setStatus(err instanceof Error ? err.message : 'Failed to open box');
    } finally {
      setOpenLoading(null);
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
    const session = token ? { token, profile } : await signIn();
    const idToken = session?.token || token;
    const encryptionKey = import.meta.env.VITE_ADDRESS_ENCRYPTION_PUBLIC_KEY || '';
    if (!encryptionKey) throw new Error('Missing VITE_ADDRESS_ENCRYPTION_PUBLIC_KEY');
    const { cipherText, hint } = encryptAddressPayload(formatted, encryptionKey);
    if (!idToken) throw new Error('Missing auth token');
    const saved = await saveEncryptedAddress(cipherText, country, label, idToken, hint, email, countryCode);
    if (updateProfile && (session?.profile || profile)) {
      const base = session?.profile || profile!;
      updateProfile({
        ...base,
        email: email || base.email,
        addresses: [...(base.addresses || []), { ...saved, hint }],
      });
    }
    setStatus('Address saved and encrypted');
  };

  const handleSaveEmail = async (value: string) => {
    const normalized = value.trim();
    setContactEmail(normalized);
    if (updateProfile && profile) {
      updateProfile({ ...profile, email: normalized });
    }
    setStatus('Contact email updated for deliveries');
  };

  const handleRequestDelivery = async (addressId: string | null) => {
    if (!publicKey) throw new Error('Connect wallet first');
    const session = token ? { token, profile } : await signIn();
    const idToken = session?.token || token;
    if (!addressId) throw new Error('Select a delivery address');
    const itemIds = Array.from(selected);
    if (!itemIds.length) throw new Error('Select items to deliver');
    const addr = savedAddresses.find((a) => a.id === addressId);
    if (!addr) throw new Error('Select a delivery address');
    if (!idToken) throw new Error('Missing auth token');
    const deliverableIds = itemIds.filter((id) => {
      const item = inventory.find((entry) => entry.id === id);
      return item && item.kind !== 'certificate';
    });
    if (!deliverableIds.length) throw new Error('Select boxes or dudes to deliver');
    if (deliverableIds.length !== itemIds.length) {
      setSelected(new Set(deliverableIds));
    }
    const deliveryCountry = addr.countryCode || addr.country;

    setDeliveryLoading(true);
    setStatus('');
    try {
      setDeliveryCost(estimateDeliveryLamports(deliveryCountry, deliverableIds.length));
      const resp = await requestDeliveryTx(publicKey.toBase58(), { itemIds: deliverableIds, addressId }, idToken || '');
      setDeliveryCost(resp.deliveryLamports ?? estimateDeliveryLamports(deliveryCountry, deliverableIds.length));
      const sig = await sendPreparedTransaction(resp.encodedTx, connection, signAndSendViaConnection);
      try {
        if (resp.orderId) {
          await finalizeDeliveryTx(publicKey.toBase58(), sig, resp.orderId, idToken);
          setStatus(`Delivery recorded · ${sig}`);
        } else {
          setStatus(`Delivery requested · ${sig}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to record delivery';
        setStatus(`Delivery requested · ${sig} (finalize warning: ${msg})`);
      }
      setSelected(new Set());
      await refetchInventory();
    } catch (err) {
      console.error(err);
      setStatus(err instanceof Error ? err.message : 'Failed to request delivery');
    } finally {
      setDeliveryLoading(false);
    }
  };

  const handleClaim = async ({ code }: { code: string }) => {
    if (!publicKey) throw new Error('Connect wallet to claim');
    const session = token ? { token, profile } : await signIn();
    const idToken = session?.token || token;
    if (!idToken) throw new Error('Missing auth token');
    setStatus('');
    const resp = await requestClaimTx(publicKey.toBase58(), code, idToken);
    const sig = await sendPreparedTransaction(resp.encodedTx, connection, signAndSendViaConnection);
    try {
      await finalizeClaimTx(publicKey.toBase58(), code, sig, idToken);
      setStatus(`Claimed certificates · ${sig}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to record claim';
      setStatus(`Claimed certificates · ${sig} (finalize warning: ${msg})`);
    }
    await refetchInventory();
  };

  // TODO: fix links
  const secondaryLinks = [
    { label: 'Tensor', href: 'https://www.tensor.trade/trade/mons' },
    { label: 'Magic Eden', href: 'https://magiceden.io/' },
  ];

  const savedAddresses = profile?.addresses || [];
  const [addressId, setAddressId] = useState<string | null>(null);

  useEffect(() => {
    if (!addressId && savedAddresses.length) {
      setAddressId(savedAddresses[0].id);
    }
  }, [addressId, savedAddresses]);

  useEffect(() => {
    setContactEmail(profile?.email || '');
  }, [profile?.email]);

  useEffect(() => {
    const addr = savedAddresses.find((a) => a.id === addressId);
    const deliverableIds = Array.from(selected).filter((id) => {
      const item = inventory.find((inv) => inv.id === id);
      return item && item.kind !== 'certificate';
    });
    if (!addr || !deliverableIds.length) {
      setDeliveryCost(undefined);
      return;
    }
    const deliveryCountry = addr.countryCode || addr.country;
    setDeliveryCost(estimateDeliveryLamports(deliveryCountry, deliverableIds.length));
  }, [addressId, savedAddresses, selected, inventory]);

  return (
    <div className="page">
      <header className="top">
        <div className="brand">
          <h1><img src="/favicon.svg" alt="" className="brand-icon" />mons.shop</h1>
        </div>
        <WalletMultiButton />
      </header>

      <div className="hero">
        <div className="hero__media">
          <img src="https://assets.mons.link/shop/drops/1/box/default.webp" alt="mons blind box" />
        </div>
        <div className="card hero__copy">
          <div className="eyebrow">Mint drop</div>
          <div className="card__title">IRL blind boxes, digital certificates</div>
          <p className="muted small">Mint boxes on-chain, reveal dudes, then burn for delivery and certificates.</p>
          <ul className="muted small">
            <li>Mint 1-20 compressed blind boxes per tx until the 333 supply is gone.</li>
            <li>Open a box to burn it and mint 3 dudes, co-signed by our cloud function.</li>
            <li>Select boxes + dudes for delivery; pay shipping in SOL, burn items, receive certificates.</li>
            <li>Use the IRL code inside a shipped box to mint dudes certificates for that specific box.</li>
          </ul>
        </div>
      </div>

      <MintPanel stats={mintStats} onMint={handleMint} busy={minting} />

      {mintedOut ? (
        <section className="card">
          <div className="card__title">Minted out</div>
          <p className="muted">All boxes are gone. Grab them on secondary or drop your email for the next wave.</p>
          <div className="row">
            {secondaryLinks.map((link) => (
              <a key={link.href} className="pill" href={link.href} target="_blank" rel="noreferrer">
                {link.label}
              </a>
            ))}
          </div>
          <EmailSubscribe />
        </section>
      ) : null}

      <section className="card">
        <div className="card__title">Inventory</div>
        <p className="muted small">Boxes, dudes, and certificates fetched directly from Helius.</p>
        <InventoryGrid items={inventory} selected={selected} onToggle={toggleSelected} onOpenBox={handleOpenBox} />
        {openLoading ? <div className="muted">Opening {shortAddress(openLoading)}…</div> : null}
      </section>

      {lastOpen ? (
        <section className="card subtle">
          <div className="card__title">Revealed dudes</div>
          <p className="muted small">
            Box {shortAddress(lastOpen.boxId)} revealed:
          </p>
          <div className="row">
            {lastOpen.dudeIds.map((id) => (
              <span key={id} className="pill">
                Dude #{id}
              </span>
            ))}
          </div>
          <p className="muted small">Tx {shortAddress(lastOpen.signature)}</p>
        </section>
      ) : null}

      <div className="grid">
        <ContactEmail email={contactEmail} onChange={setContactEmail} onSave={handleSaveEmail} />
        <DeliveryPanel
          selectedCount={selected.size}
          addresses={savedAddresses.map((addr) => ({ ...addr, hint: addr.hint || addr.id.slice(0, 4) }))}
          addressId={addressId}
          onSelectAddress={setAddressId}
          onRequestDelivery={() => handleRequestDelivery(addressId)}
          loading={deliveryLoading}
          costLamports={deliveryCost}
        />
        <DeliveryForm onSave={handleSaveAddress} contactEmail={contactEmail} />
      </div>

      <ClaimForm onClaim={handleClaim} />

      {authError ? <div className="error">{authError}</div> : null}
      {status ? <div className="success">{status}</div> : null}

      <footer className="muted small">
        {publicKey ? `Connected: ${shortAddress(publicKey.toBase58())}` : 'Connect a wallet to start'} ·
        {authLoading ? ' Signing in…' : profile ? ` Signed in as ${shortAddress(profile.wallet)}` : ' Sign in for delivery'}
      </footer>
    </div>
  );
}

export default App;
