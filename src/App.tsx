import { useEffect, useMemo, useRef, useState } from 'react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey, type VersionedTransaction } from '@solana/web3.js';
import { FaPlane } from 'react-icons/fa6';
import { MintPanel } from './components/MintPanel';
import { InventoryGrid } from './components/InventoryGrid';
import { DeliveryForm } from './components/DeliveryForm';
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
import {
  encryptAddressPayload,
  isBlockhashExpiredError,
  lamportsToSol,
  normalizeCountryCode,
  sendPreparedTransaction,
  shortAddress,
} from './lib/solana';
import { countryLabel, findCountryByCode } from './lib/countries';
import { DeliveryOrderSummary, InventoryItem, ProfileAddress } from './types';
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

const MAX_SHIPMENT_ITEMS = 24;

function App() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { setVisible } = useWalletModal();
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
  const [toast, setToast] = useState<string | null>(null);
  const [toastVisible, setToastVisible] = useState(false);
  const toastFadeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastClearTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [lastReveal, setLastReveal] = useState<{ boxId: string; dudeIds: number[]; signature: string } | null>(null);
  const [addressId, setAddressId] = useState<string | null>(null);
  const [deliveryOpen, setDeliveryOpen] = useState(false);
  const [deliveryAddOpen, setDeliveryAddOpen] = useState(false);
  const [claimOpen, setClaimOpen] = useState(false);
  const [removeAddressLoading, setRemoveAddressLoading] = useState<string | null>(null);
  const owner = publicKey?.toBase58();
  const [hiddenAssets, setHiddenAssets] = useState<Set<string>>(() => loadHiddenAssets(owner));

  const TOAST_VISIBLE_MS = 1800;
  const TOAST_FADE_MS = 250;
  const showToast = (message: string) => {
    setToast(message);
    setToastVisible(true);
    if (toastFadeTimeoutRef.current) {
      clearTimeout(toastFadeTimeoutRef.current);
    }
    if (toastClearTimeoutRef.current) {
      clearTimeout(toastClearTimeoutRef.current);
    }
    toastFadeTimeoutRef.current = setTimeout(() => {
      setToastVisible(false);
    }, TOAST_VISIBLE_MS);
    toastClearTimeoutRef.current = setTimeout(() => {
      setToast(null);
    }, TOAST_VISIBLE_MS + TOAST_FADE_MS);
  };

  useEffect(() => {
    setHiddenAssets(loadHiddenAssets(owner));
  }, [owner]);

  useEffect(() => {
    return () => {
      if (toastFadeTimeoutRef.current) {
        clearTimeout(toastFadeTimeoutRef.current);
      }
      if (toastClearTimeoutRef.current) {
        clearTimeout(toastClearTimeoutRef.current);
      }
    };
  }, []);

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

  const defaultBoxImage = `${FRONTEND_DEPLOYMENT.paths.base}/box/tight.webp`;
  const pendingRevealIds = useMemo(
    () => new Set(pendingOpenBoxes.map((entry) => entry.boxAssetId).filter(Boolean)),
    [pendingOpenBoxes],
  );
  const pendingRevealItems = useMemo(() => {
    if (!pendingOpenBoxes.length) return [];
    const inventoryById = new Map(inventory.map((item) => [item.id, item]));
    const seen = new Set<string>();
    const pendingItems: InventoryItem[] = [];
    pendingOpenBoxes.forEach((entry) => {
      const id = entry.boxAssetId;
      if (!id || seen.has(id)) return;
      seen.add(id);
      const match = inventoryById.get(id);
      pendingItems.push({
        id,
        name: match?.name || `Box ${shortAddress(id)}`,
        kind: 'box',
        image: match?.image || defaultBoxImage,
      });
    });
    return pendingItems;
  }, [pendingOpenBoxes, inventory, defaultBoxImage]);

  const inventoryItems = useMemo(() => {
    const boxes: typeof visibleInventory = [];
    const dudes: typeof visibleInventory = [];
    visibleInventory.forEach((item) => {
      if (pendingRevealIds.has(item.id)) return;
      if (item.kind === 'box') boxes.push(item);
      else if (item.kind === 'dude') dudes.push(item);
    });
    return [...pendingRevealItems, ...boxes, ...dudes];
  }, [visibleInventory, pendingRevealIds, pendingRevealItems]);
  const receiptItems = useMemo(() => visibleInventory.filter((item) => item.kind === 'certificate'), [visibleInventory]);

  const selectedItems = useMemo(() => {
    if (!selected.size) return [] as InventoryItem[];
    const inventoryById = new Map(inventory.map((item) => [item.id, item]));
    return Array.from(selected)
      .map((id) => inventoryById.get(id))
      .filter((item): item is InventoryItem => Boolean(item));
  }, [selected, inventory]);
  const selectedCount = selected.size;
  const [compactPanel, setCompactPanel] = useState(false);
  const selectedPreview = useMemo(() => {
    const limit = compactPanel ? 3 : 5;
    const entries = selectedItems.map((item) => ({
      item,
      previewImage: item.image || (item.kind === 'box' ? defaultBoxImage : undefined),
    }));
    const preview: typeof entries = [];
    const counts = new Map<string, number>();
    const addEntry = (entry: (typeof entries)[number]) => {
      preview.push(entry);
      if (!entry.previewImage) return;
      counts.set(entry.previewImage, (counts.get(entry.previewImage) || 0) + 1);
    };
    entries.forEach((entry) => {
      if (preview.length < limit) {
        addEntry(entry);
        return;
      }
      if (!entry.previewImage) return;
      if (counts.has(entry.previewImage)) return;
      let replaceIndex = -1;
      for (let i = 0; i < preview.length; i += 1) {
        const img = preview[i].previewImage;
        if (!img) continue;
        if ((counts.get(img) || 0) > 1) {
          replaceIndex = i;
          break;
        }
      }
      if (replaceIndex === -1) return;
      const [removed] = preview.splice(replaceIndex, 1);
      if (removed.previewImage) {
        const nextCount = (counts.get(removed.previewImage) || 1) - 1;
        if (nextCount <= 0) counts.delete(removed.previewImage);
        else counts.set(removed.previewImage, nextCount);
      }
      addEntry(entry);
    });
    return preview;
  }, [selectedItems, defaultBoxImage, compactPanel]);
  const selectedOverflow = Math.max(0, selectedCount - selectedPreview.length);
  const canOpenSelected = selectedCount === 1 && selectedItems[0]?.kind === 'box';
  const selectedBox = canOpenSelected ? selectedItems[0] : null;

  useEffect(() => {
    if (!pendingRevealIds.size) return;
    setSelected((prev) => {
      let changed = false;
      const next = new Set(prev);
      pendingRevealIds.forEach((id) => {
        if (next.delete(id)) changed = true;
      });
      return changed ? next : prev;
    });
  }, [pendingRevealIds]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const media = window.matchMedia('(max-width: 720px)');
    const sync = () => setCompactPanel(media.matches);
    sync();
    if (media.addEventListener) {
      media.addEventListener('change', sync);
      return () => media.removeEventListener('change', sync);
    }
    media.addListener(sync);
    return () => media.removeListener(sync);
  }, []);

  useEffect(() => {
    if (!deliveryOpen || selectedCount) return;
    setDeliveryOpen(false);
    setDeliveryAddOpen(false);
  }, [deliveryOpen, selectedCount]);

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
      if (prev.has(id)) {
        const copy = new Set(prev);
        copy.delete(id);
        return copy;
      }
      if (prev.size >= MAX_SHIPMENT_ITEMS) return prev;
      const copy = new Set(prev);
      copy.add(id);
      return copy;
    });
  };

  const handleMint = async (quantity: number) => {
    if (!publicKey) {
      setVisible(true);
      return;
    }
    setMinting(true);
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
        showToast('Transaction expired before you approved it. Please approve again…');
        sig = await sendOnce();
      }
      showToast(`Minted ${quantity} boxes · ${sig}`);
      await Promise.all([refetchStats(), refetchInventory()]);
    } finally {
      setMinting(false);
    }
  };

  const handleStartOpenBox = async (item: InventoryItem) => {
    if (!publicKey) throw new Error('Connect wallet to open a box');
    setStartOpenLoading(item.id);
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
        showToast('Transaction expired before you approved it. Please approve again…');
        sig = await sendOnce();
      }
      showToast(`Box sent to vault · ${sig}`);
      // Helius indexing can lag after transfers; hide immediately once the tx is confirmed.
      markAssetsHidden([item.id]);
      await Promise.all([refetchInventory(), refetchPendingOpenBoxes()]);
    } catch (err) {
      console.error(err);
      showToast(err instanceof Error ? err.message : 'Failed to open box');
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
    setLastReveal(null);
    try {
      const resp = await revealDudes(publicKey.toBase58(), boxAssetId);
      const revealed = (resp?.dudeIds || []).map((n) => Number(n)).filter((n) => Number.isFinite(n));
      setLastReveal({ boxId: boxAssetId, dudeIds: revealed, signature: resp.signature });
      const revealCopy = revealed.length ? ` · figures ${revealed.join(', ')}` : '';
      showToast(`Revealed figures · ${resp.signature}${revealCopy}`);
      await Promise.all([refetchInventory(), refetchPendingOpenBoxes()]);
    } catch (err) {
      console.error(err);
      showToast(err instanceof Error ? err.message : 'Failed to reveal figures');
    } finally {
      setRevealLoading(null);
    }
  };

  const handleOpenSelectedBox = async () => {
    if (!selectedBox) return;
    setSelected(new Set());
    await handleStartOpenBox(selectedBox);
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
    setDeliveryAddOpen(false);
    showToast('Address saved and encrypted');
  };

  const handleRemoveAddress = async (id: string) => {
    if (!publicKey) throw new Error('Connect a wallet to manage shipping addresses');
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
      showToast('Address removed');
    } catch (err) {
      console.error(err);
      showToast(err instanceof Error ? err.message : 'Failed to remove address');
    } finally {
      setRemoveAddressLoading(null);
    }
  };

  const handleSignInForDelivery = async () => {
    await signIn();
    showToast('Signed in. Saved addresses loaded.');
  };

  const handleRequestDelivery = async (addressId: string | null) => {
    if (!publicKey) throw new Error('Connect wallet first');
    if (!addressId) throw new Error('Select a shipping address');
    const itemIds = Array.from(selected);
    if (!itemIds.length) throw new Error('Select items to ship');
    const addr = savedAddresses.find((a) => a.id === addressId);
    if (!addr) throw new Error('Select a shipping address');
    // Ensure wallet session exists for authenticated callable.
    if (!token) {
      await signIn();
    }
    const deliverableIds = itemIds.filter((id) => {
      const item = inventory.find((entry) => entry.id === id);
      return item && item.kind !== 'certificate' && !pendingRevealIds.has(id);
    });
    if (!deliverableIds.length) throw new Error('Select boxes or figures to ship');
    if (deliverableIds.length !== itemIds.length) {
      setSelected(new Set(deliverableIds));
    }

    setDeliveryLoading(true);
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
        showToast('Prepared transaction expired before you approved it. Preparing a fresh one…');
        resp = await requestTx();
        setDeliveryCost(typeof resp.deliveryLamports === 'number' ? resp.deliveryLamports : undefined);
        sig = await sendPreparedTransaction(resp.encodedTx, connection, signAndSendViaConnection);
      }
      const idSuffix = resp.deliveryId ? ` · id ${resp.deliveryId}` : '';
      showToast(`Shipment submitted${idSuffix} · ${sig}`);
      // Delivery transfers the selected assets to the vault; hide them immediately once confirmed.
      markAssetsHidden(deliverableIds);
      setSelected(new Set());
      await refetchInventory();
      if (resp.deliveryId) {
        try {
          showToast(`Shipment submitted${idSuffix} · ${sig} · issuing receipts…`);
          const issued = await issueReceipts(publicKey.toBase58(), resp.deliveryId, sig);
          const minted = Number(issued?.receiptsMinted || 0);
          showToast(`Shipment submitted${idSuffix} · ${sig} · receipts issued (${minted})`);
          await refetchInventory();
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Failed to issue receipts';
          showToast(`Shipment submitted${idSuffix} · ${sig} (receipt warning: ${msg})`);
        }
      }
    } catch (err) {
      console.error(err);
      showToast(err instanceof Error ? err.message : 'Failed to request shipment');
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
    const requestTx = () => requestClaimTx(publicKey.toBase58(), code);
    let resp = await requestTx();
    let sig: string;
    try {
      sig = await sendPreparedTransaction(resp.encodedTx, connection, signAndSendViaConnection);
    } catch (err) {
      if (!isBlockhashExpiredError(err)) throw err;
      showToast('Prepared transaction expired before you approved it. Preparing a fresh one…');
      resp = await requestTx();
      sig = await sendPreparedTransaction(resp.encodedTx, connection, signAndSendViaConnection);
    }
    showToast(`Claimed certificates · ${sig}`);
    await refetchInventory();
  };

  const secondaryLinks = [
    { label: 'Tensor', href: 'https://www.tensor.trade/trade/mons' },
    { label: 'Magic Eden', href: 'https://magiceden.io/' },
  ];

  const savedAddresses = profile?.addresses || [];
  const formattedAddresses = useMemo(
    () => savedAddresses.map((addr) => ({ ...addr, hint: addr.hint || addr.id.slice(0, 4) })),
    [savedAddresses],
  );
  const deliveryOrders = profile?.orders || [];
  const formatCountry = (addr: ProfileAddress) => {
    const code = addr.countryCode || normalizeCountryCode(addr.country);
    const option = findCountryByCode(code);
    if (option) return countryLabel(option);
    return addr.country || code || 'Unknown';
  };

  useEffect(() => {
    if (!deliveryOrders.length) {
      setClaimOpen(false);
    }
  }, [deliveryOrders.length]);

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
      {toast ? (
        <div className={`toast${toastVisible ? '' : ' toast--hidden'}`} role="status" aria-live="polite">
          {toast}
        </div>
      ) : null}
      <header className="top">
        <div className="brand">
          <h1>
            <img src="https://assets.mons.link/shop/logo.webp" alt="" className="brand-icon" />
            <span>mons.shop</span>
          </h1>
        </div>
      </header>

      <MintPanel stats={mintStats} onMint={handleMint} busy={minting} onError={showToast} />

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
        <div className="card__title">Inventory</div>
        <InventoryGrid
          items={inventoryItems}
          selected={selected}
          onToggle={toggleSelected}
          pendingRevealIds={pendingRevealIds}
          onReveal={handleRevealDudes}
          revealLoadingId={revealLoading}
          revealDisabled={Boolean(revealLoading) || Boolean(startOpenLoading)}
        />
        {startOpenLoading ? <div className="muted">Sending {shortAddress(startOpenLoading)} to the vault…</div> : null}
      </section>

      {lastReveal ? (
        <section className="card subtle">
          <div className="card__title">Revealed figures</div>
          <p className="muted small">
            Box {shortAddress(lastReveal.boxId)} revealed:
          </p>
          <div className="row">
            {lastReveal.dudeIds.map((id) => (
              <span key={id} className="pill">
                Figure #{id}
              </span>
            ))}
          </div>
          <p className="muted small">Tx {shortAddress(lastReveal.signature)}</p>
        </section>
      ) : null}

      <Modal
        open={deliveryOpen}
        title="Shipment"
        onClose={() => {
          setDeliveryOpen(false);
          setDeliveryAddOpen(false);
        }}
      >
        <div className="modal-form delivery-modal">
          <div className="delivery-modal__summary">
            <div>
              <div className="card__title">{selectedCount} selected</div>
              <div className="muted small">Choose a saved address or add a new one.</div>
            </div>
            {selectedCount && addressId ? (
              <div className="pill-row">
                {typeof deliveryCost === 'number' ? (
                  <span className="pill">Ship: {lamportsToSol(deliveryCost)} ◎</span>
                ) : deliveryLoading ? (
                  <span className="pill">Ship: calculating…</span>
                ) : (
                  <span className="pill">Ship: calculated on request</span>
                )}
              </div>
            ) : null}
          </div>

          {!publicKey ? <div className="muted small">Connect a wallet to manage shipping addresses.</div> : null}
          {publicKey && !profile && !authLoading ? (
            <div className="muted small">
              Sign in once to load saved addresses on this device. Afterwards you can reload and still see them.
            </div>
          ) : null}

          <div className="card__head">
            <div>
              <div className="card__title">Shipping address</div>
              <div className="muted small">Select a saved address or add a new one.</div>
            </div>
            <div className="card__actions">
              {!profile ? (
                <button type="button" className="ghost" onClick={handleSignInForDelivery} disabled={!publicKey || authLoading}>
                  {authLoading ? 'Loading…' : 'Sign in to load addresses'}
                </button>
              ) : null}
              <button
                type="button"
                className="ghost"
                onClick={() => setDeliveryAddOpen((prev) => !prev)}
                disabled={!publicKey || authLoading}
              >
                {deliveryAddOpen ? 'Hide address form' : 'Add new address'}
              </button>
            </div>
          </div>

          <label>
            <span className="muted">Send to</span>
            <select
              value={addressId || ''}
              onChange={(evt) => setAddressId(evt.target.value)}
              disabled={!formattedAddresses.length}
            >
              <option value="" disabled>
                {formattedAddresses.length
                  ? 'Choose saved address'
                  : profile
                    ? 'No saved addresses yet'
                    : 'Sign in to load addresses'}
              </option>
              {formattedAddresses.map((addr) => (
                <option key={addr.id} value={addr.id}>
                  {addr.label} · {formatCountry(addr)} · {addr.hint}
                </option>
              ))}
            </select>
          </label>

          {formattedAddresses.length ? (
            <>
              <div className="muted small">Saved addresses</div>
              <div className="grid">
                {formattedAddresses.map((addr) => {
                  const isSelected = addr.id === addressId;
                  return (
                    <div key={addr.id} className="card subtle">
                      <div className="card__head">
                        <div>
                          <div className="card__title">{addr.label}</div>
                          <div className="muted small">
                            {formatCountry(addr)} · {addr.hint}
                          </div>
                        </div>
                        <div className="card__actions">
                          {isSelected ? <span className="pill">Selected</span> : null}
                          <button
                            type="button"
                            className="ghost"
                            onClick={() => {
                              void handleRemoveAddress(addr.id);
                            }}
                            disabled={!profile || Boolean(removeAddressLoading)}
                          >
                            {removeAddressLoading === addr.id ? 'Removing…' : 'Remove'}
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          ) : null}

          {deliveryAddOpen ? (
            <div className="card subtle">
              <div className="card__title">Add a new address</div>
              <DeliveryForm
                mode="modal"
                onSave={handleSaveAddress}
                defaultEmail={profile?.email || ''}
                onCancel={() => setDeliveryAddOpen(false)}
              />
            </div>
          ) : null}

          <div className="row">
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setDeliveryOpen(false);
                setDeliveryAddOpen(false);
              }}
            >
              Close
            </button>
            <button onClick={() => handleRequestDelivery(addressId)} disabled={!selectedCount || !addressId || deliveryLoading}>
              {deliveryLoading ? 'Preparing tx…' : 'Request shipment tx'}
            </button>
          </div>
        </div>
      </Modal>

      <Modal open={claimOpen} title="Secret Code" onClose={() => setClaimOpen(false)}>
        <ClaimForm onClaim={handleClaim} mode="modal" showTitle={false} />
      </Modal>

      {authError ? <div className="error">{authError}</div> : null}
      <section className="card">
        <div className="card__head">
          <div className="card__title">Shipments</div>
        </div>
        {!profile ? (
          <div className="muted small">Sign in to view your shipments.</div>
        ) : deliveryOrders.length ? (
          <div className="delivery-list">
            {deliveryOrders.map((order) => (
              <div key={order.deliveryId} className="delivery-row">
                <div className="card__head">
                  <div>
                    <div className="card__title">{order.deliveryId}</div>
                    <div className="muted small">{formatOrderDate(order)}</div>
                  </div>
                  <div className="delivery-status">Preparing</div>
                </div>
                {order.items.length ? (
                  <div className="muted small">
                    {order.items
                      .map((item) => `${item.kind === 'box' ? 'Box' : 'Figure'} ${item.refId}`)
                      .join(', ')}
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
          <div className="muted small">No shipments yet.</div>
        )}
      </section>

      {receiptItems.length ? (
        <section className="card">
          <div className="card__head">
            <div className="card__title">Receipts</div>
            <div className="card__actions">
              <button type="button" className="ghost" onClick={() => setClaimOpen(true)}>
                Enter code
              </button>
            </div>
          </div>
          <InventoryGrid items={receiptItems} selected={selected} onToggle={toggleSelected} className="inventory--receipts" />
        </section>
      ) : null}

      {selectedCount ? (
        <div className="selection-panel">
          <div className="selection-panel__left">
            <div className="selection-panel__preview">
              {selectedPreview.map(({ item, previewImage }, idx) => {
                return previewImage ? (
                  <div
                    key={item.id}
                    className="selection-panel__thumb"
                    style={{ backgroundImage: `url(${previewImage})`, zIndex: idx + 1 }}
                    aria-hidden="true"
                  />
                ) : (
                  <div
                    key={item.id}
                    className="selection-panel__thumb selection-panel__thumb--empty"
                    style={{ zIndex: idx + 1 }}
                    aria-hidden="true"
                  >
                    <span>#</span>
                  </div>
                );
              })}
              {selectedOverflow ? (
                <div className="selection-panel__more" style={{ zIndex: selectedPreview.length + 2 }}>
                  +{selectedOverflow}
                </div>
              ) : null}
            </div>
          </div>
          <div className="selection-panel__actions">
            <button type="button" className="quiet" onClick={() => setSelected(new Set())}>
              Cancel
            </button>
            {canOpenSelected ? (
              <button type="button" onClick={handleOpenSelectedBox} disabled={Boolean(startOpenLoading)}>
                {startOpenLoading === selectedBox?.id ? 'Opening…' : 'Open Box'}
              </button>
            ) : null}
            <button
              type="button"
              className="selection-panel__ship"
              onClick={() => {
                setDeliveryOpen(true);
                setDeliveryAddOpen(false);
              }}
            >
              <FaPlane aria-hidden="true" focusable="false" size={16} />
              <span>Ship</span>
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default App;
