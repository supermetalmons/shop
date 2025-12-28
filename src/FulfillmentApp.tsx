import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { WalletReadyState } from '@solana/wallet-adapter-base';
import { useWallet } from '@solana/wallet-adapter-react';
import { listFulfillmentOrders, updateFulfillmentStatus } from './lib/api';
import { FulfillmentOrder, FulfillmentOrdersCursor } from './types';
import { useSolanaAuth } from './hooks/useSolanaAuth';
import { shortAddress } from './lib/solana';

const FULFILLMENT_WALLETS = new Set<string>([
  'kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx',
  'A87Upx1f1whNV5P8xQCK2YUTwE3uMYigjoKJAF3jiNpz',
  '8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM',
]);

const PAGE_SIZE = 20;

function formatOrderDate(ts?: number) {
  if (!ts) return 'Date pending';
  return new Date(ts).toLocaleString(undefined, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function formatOrderStatus(status: string) {
  const normalized = String(status || '').replace(/_/g, ' ').trim();
  if (!normalized) return 'Unknown';
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

export default function FulfillmentApp() {
  const walletAdapter = useWallet();
  const { publicKey } = walletAdapter;
  const { visible: walletModalVisible, setVisible: setWalletModalVisible } = useWalletModal();
  const { profile, signIn, loading: authLoading, error: authError } = useSolanaAuth();
  const walletAddress = publicKey?.toBase58() || '';
  const allowed = walletAddress ? FULFILLMENT_WALLETS.has(walletAddress) : false;
  const signedIn = Boolean(profile && profile.wallet === walletAddress);
  const walletBusy = walletAdapter.connecting || walletAdapter.disconnecting;
  const walletReadyState = walletAdapter.wallet?.readyState;
  const autoConnectPossible =
    Boolean(walletAdapter.wallet) &&
    walletAdapter.autoConnect &&
    (walletReadyState === WalletReadyState.Installed || walletReadyState === WalletReadyState.Loadable);

  const [orders, setOrders] = useState<FulfillmentOrder[]>([]);
  const [cursor, setCursor] = useState<FulfillmentOrdersCursor | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [ordersError, setOrdersError] = useState<string | null>(null);
  const [statusEdits, setStatusEdits] = useState<Record<number, string>>({});
  const [statusSaving, setStatusSaving] = useState<Record<number, boolean>>({});
  const [pendingSignIn, setPendingSignIn] = useState(false);
  const walletConnectingSeenRef = useRef(false);
  const [walletReady, setWalletReady] = useState(() => !walletAdapter.wallet || !autoConnectPossible);
  const authLoadingSeenRef = useRef(false);
  const [authReady, setAuthReady] = useState(() => !walletAddress);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    walletConnectingSeenRef.current = false;
    setWalletReady(!walletAdapter.wallet || !autoConnectPossible);
  }, [autoConnectPossible, walletAdapter.wallet]);

  useEffect(() => {
    if (!walletAdapter.wallet) return;
    if (!autoConnectPossible) {
      setWalletReady(true);
      return;
    }
    if (walletAdapter.connecting) {
      walletConnectingSeenRef.current = true;
      return;
    }
    if (publicKey || walletConnectingSeenRef.current) {
      setWalletReady(true);
    }
  }, [autoConnectPossible, publicKey, walletAdapter.connecting, walletAdapter.wallet]);

  useEffect(() => {
    authLoadingSeenRef.current = false;
    setAuthReady(!walletAddress);
  }, [walletAddress]);

  useEffect(() => {
    if (!walletAddress) return;
    if (authLoading) {
      authLoadingSeenRef.current = true;
      return;
    }
    if (profile?.wallet === walletAddress || authLoadingSeenRef.current) {
      setAuthReady(true);
    }
  }, [authLoading, profile?.wallet, walletAddress]);

  const mergeStatusEdits = useCallback((incoming: FulfillmentOrder[]) => {
    setStatusEdits((prev) => {
      const next = { ...prev };
      incoming.forEach((order) => {
        if (!(order.deliveryId in next)) {
          next[order.deliveryId] = order.fulfillmentStatus || '';
        }
      });
      return next;
    });
  }, []);

  const loadInitial = useCallback(async () => {
    if (!allowed || !signedIn) return;
    setLoading(true);
    setOrdersError(null);
    setHasMore(true);
    setCursor(null);
    setOrders([]);
    try {
      const resp = await listFulfillmentOrders({ limit: PAGE_SIZE, cursor: null });
      const nextOrders = Array.isArray(resp.orders) ? resp.orders : [];
      setOrders(nextOrders);
      mergeStatusEdits(nextOrders);
      setCursor(resp.nextCursor || null);
      setHasMore(Boolean(resp.nextCursor));
    } catch (err) {
      console.error(err);
      setOrdersError(err instanceof Error ? err.message : 'Failed to load orders');
    } finally {
      setLoading(false);
    }
  }, [allowed, signedIn, mergeStatusEdits]);

  const loadMore = useCallback(async () => {
    if (!allowed || !signedIn || loadingMore || loading || !hasMore) return;
    setLoadingMore(true);
    setOrdersError(null);
    try {
      const resp = await listFulfillmentOrders({ limit: PAGE_SIZE, cursor });
      const nextOrders = Array.isArray(resp.orders) ? resp.orders : [];
      setOrders((prev) => {
        if (!nextOrders.length) return prev;
        const existing = new Set(prev.map((order) => order.deliveryId));
        const deduped = nextOrders.filter((order) => !existing.has(order.deliveryId));
        return prev.concat(deduped);
      });
      mergeStatusEdits(nextOrders);
      setCursor(resp.nextCursor || null);
      setHasMore(Boolean(resp.nextCursor));
    } catch (err) {
      console.error(err);
      setOrdersError(err instanceof Error ? err.message : 'Failed to load more orders');
    } finally {
      setLoadingMore(false);
    }
  }, [allowed, signedIn, loadingMore, loading, hasMore, cursor, mergeStatusEdits]);

  useEffect(() => {
    void loadInitial();
  }, [loadInitial]);

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !allowed || !signedIn) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void loadMore();
        }
      },
      { rootMargin: '240px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [allowed, signedIn, loadMore]);

  const handleSaveStatus = useCallback(
    async (deliveryId: number) => {
      if (!allowed || !signedIn) return;
      setStatusSaving((prev) => ({ ...prev, [deliveryId]: true }));
      setOrdersError(null);
      try {
        const raw = statusEdits[deliveryId] ?? '';
        const trimmed = raw.trim();
        const resp = await updateFulfillmentStatus(deliveryId, trimmed);
        setOrders((prev) =>
          prev.map((order) =>
            order.deliveryId === deliveryId ? { ...order, fulfillmentStatus: resp.fulfillmentStatus || trimmed } : order,
          ),
        );
        setStatusEdits((prev) => ({ ...prev, [deliveryId]: resp.fulfillmentStatus || trimmed }));
      } catch (err) {
        console.error(err);
        setOrdersError(err instanceof Error ? err.message : 'Failed to update status');
      } finally {
        setStatusSaving((prev) => ({ ...prev, [deliveryId]: false }));
      }
    },
    [allowed, signedIn, statusEdits],
  );

  const statusDirty = useMemo(() => {
    const dirty = new Set<number>();
    orders.forEach((order) => {
      const current = order.fulfillmentStatus || '';
      const edited = statusEdits[order.deliveryId] ?? '';
      if (current.trim() !== edited.trim()) dirty.add(order.deliveryId);
    });
    return dirty;
  }, [orders, statusEdits]);

  const handleSolanaSignIn = useCallback(() => {
    if (authLoading) return;
    if (!publicKey) {
      setPendingSignIn(true);
      setWalletModalVisible(true);
      return;
    }
    if (!allowed || signedIn) return;
    void signIn();
  }, [allowed, authLoading, publicKey, setWalletModalVisible, signIn, signedIn]);

  useEffect(() => {
    if (!pendingSignIn || !publicKey) return;
    if (!allowed || signedIn) {
      setPendingSignIn(false);
      return;
    }
    if (authLoading) return;
    setPendingSignIn(false);
    void signIn();
  }, [allowed, authLoading, pendingSignIn, publicKey, signIn, signedIn]);

  useEffect(() => {
    if (!pendingSignIn || walletModalVisible || publicKey) return;
    setPendingSignIn(false);
  }, [pendingSignIn, publicKey, walletModalVisible]);

  return (
    <div className="page">
      <header className="top">
        <div className="brand">
          <h1>
            <img src="https://assets.mons.link/shop/logo.webp" alt="" className="brand-icon" />
            <span>mons.shop</span>
          </h1>
        </div>
      </header>

      {!walletBusy && walletReady && (walletAddress ? (!allowed || authReady) : true) ? (
        !walletAddress ? (
          <section className="card">
            <button type="button" onClick={handleSolanaSignIn} disabled={authLoading}>
              {authLoading ? 'Signing in…' : 'Sign in with Solana'}
            </button>
          </section>
        ) : !allowed ? (
          <section className="card">
            <div className="card__title">Access denied</div>
            <p className="muted small">This wallet is not authorized for fulfillment.</p>
          </section>
        ) : !signedIn ? (
          <section className="card">
            <button type="button" onClick={handleSolanaSignIn} disabled={authLoading}>
              {authLoading ? 'Signing in…' : 'Sign in with Solana'}
            </button>
          </section>
        ) : (
          <section className="card">
            {loading && !orders.length ? <div className="muted small">Loading orders…</div> : null}
            {ordersError ? <div className="error">{ordersError}</div> : null}
            {orders.length ? (
              <div className="order-list">
                {orders.map((order) => (
                  <div key={order.deliveryId} className="card subtle">
                    <div className="card__head">
                      <div>
                        <div className="card__title">Order {order.deliveryId}</div>
                        <div className="muted small">
                          {formatOrderDate(order.processedAt || order.createdAt)}
                        </div>
                      </div>
                    </div>

                    <div className="grid">
                      <div className="card subtle">
                        {order.address.full ? (
                          <div className="address-block">{order.address.full}</div>
                        ) : (
                          <div className="address-block">
                            <div className="muted small">Encrypted address payload</div>
                            <div className="mono small">{order.address.encrypted || 'Unavailable'}</div>
                          </div>
                        )}
                        {order.address.email ? <div className="muted small">{order.address.email}</div> : null}
                      </div>

                      <div className="card subtle">
                        <div className="card__title">Fulfillment update</div>
                        <textarea
                          className="status-input"
                          value={statusEdits[order.deliveryId] ?? ''}
                          onChange={(evt) =>
                            setStatusEdits((prev) => ({ ...prev, [order.deliveryId]: evt.target.value }))
                          }
                          placeholder="Type a status update for the buyer…"
                        />
                        <div className="row">
                          <button
                            type="button"
                            onClick={() => void handleSaveStatus(order.deliveryId)}
                            disabled={statusSaving[order.deliveryId]}
                          >
                            {statusSaving[order.deliveryId] ? 'Saving…' : statusDirty.has(order.deliveryId) ? 'Save update' : 'Saved'}
                          </button>
                          {statusDirty.has(order.deliveryId) ? <span className="muted small">Unsaved changes</span> : null}
                        </div>
                      </div>
                    </div>

                    {order.boxes.length ? (
                      <>
                        <div className="muted small">Boxes</div>
                        <div className="grid">
                          {order.boxes.map((box) => (
                            <div key={`${order.deliveryId}:${box.boxId}`} className="card subtle">
                              <div className="card__title">Box #{box.boxId}</div>
                              {box.claimCode ? <div className="pill">Claim code {box.claimCode}</div> : <div className="muted small">Claim code pending</div>}
                              {box.dudeIds.length ? (
                                <div className="pill-row">
                                  {box.dudeIds.map((id) => (
                                    <span key={`${order.deliveryId}:${box.boxId}:${id}`} className="pill">
                                      Figure #{id}
                                    </span>
                                  ))}
                                </div>
                              ) : (
                                <div className="muted small">Assigned figures pending</div>
                              )}
                            </div>
                          ))}
                        </div>
                      </>
                    ) : null}

                    {order.looseDudes.length ? (
                      <>
                        <div className="muted small">Unboxed</div>
                        <div className="pill-row">
                          {order.looseDudes.map((id) => (
                            <span key={`${order.deliveryId}:dude:${id}`} className="pill">
                              Figure #{id}
                            </span>
                          ))}
                        </div>
                      </>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : loading ? null : (
              <div className="muted small">No orders ready for fulfillment.</div>
            )}

            {loadingMore ? <div className="muted small">Loading more…</div> : null}
            <div ref={sentinelRef} />
          </section>
        )
      ) : null}

      {authError ? <div className="error">{authError}</div> : null}
    </div>
  );
}
