import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
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
  return new Date(ts).toLocaleString(undefined, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function formatOrderStatus(status: string) {
  const normalized = String(status || '').replace(/_/g, ' ').trim();
  if (!normalized) return 'Unknown';
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

export default function FulfillmentApp() {
  const { publicKey } = useWallet();
  const { profile, signIn, loading: authLoading, error: authError } = useSolanaAuth();
  const wallet = publicKey?.toBase58() || '';
  const allowed = wallet ? FULFILLMENT_WALLETS.has(wallet) : false;
  const signedIn = Boolean(profile && profile.wallet === wallet);

  const [orders, setOrders] = useState<FulfillmentOrder[]>([]);
  const [cursor, setCursor] = useState<FulfillmentOrdersCursor | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [ordersError, setOrdersError] = useState<string | null>(null);
  const [statusEdits, setStatusEdits] = useState<Record<number, string>>({});
  const [statusSaving, setStatusSaving] = useState<Record<number, boolean>>({});
  const sentinelRef = useRef<HTMLDivElement | null>(null);

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

  return (
    <div className="page">
      <header className="top">
        <div className="brand">
          <h1><img src="/favicon.svg" alt="" className="brand-icon" />mons.fulfillment</h1>
          <p className="sub">Private fulfillment dashboard for delivery orders.</p>
        </div>
        <WalletMultiButton />
      </header>

      {!publicKey ? (
        <section className="card">
          <div className="card__title">Connect wallet</div>
          <p className="muted small">Connect an approved Solana wallet to access fulfillment orders.</p>
        </section>
      ) : !allowed ? (
        <section className="card">
          <div className="card__title">Access denied</div>
          <p className="muted small">This wallet is not authorized for fulfillment.</p>
          <div className="pill">Wallet {shortAddress(wallet)}</div>
        </section>
      ) : !signedIn ? (
        <section className="card">
          <div className="card__title">Sign in for fulfillment</div>
          <p className="muted small">Approve a one-time signature to access the fulfillment queue.</p>
          <button type="button" onClick={() => void signIn()} disabled={authLoading}>
            {authLoading ? 'Signing in…' : 'Sign in'}
          </button>
        </section>
      ) : (
        <section className="card">
          <div className="card__title">Orders</div>
          <p className="muted small">Newest first. Scroll to load more automatically.</p>
          {loading && !orders.length ? <div className="muted small">Loading orders…</div> : null}
          {ordersError ? <div className="error">{ordersError}</div> : null}
          {orders.length ? (
            <div className="order-list">
              {orders.map((order) => (
                <div key={order.deliveryId} className="card subtle">
                  <div className="card__head">
                    <div>
                      <div className="card__title">Order #{order.deliveryId}</div>
                      <div className="muted small">
                        {formatOrderDate(order.processedAt || order.createdAt)} · {shortAddress(order.owner)}
                      </div>
                    </div>
                    <div className="pill">{formatOrderStatus(order.status)}</div>
                  </div>

                  <div className="grid">
                    <div className="card subtle">
                      <div className="card__title">Destination</div>
                      <div className="muted small">{order.address.label || 'Address'}</div>
                      {order.address.full ? (
                        <div className="address-block">{order.address.full}</div>
                      ) : (
                        <div className="address-block">
                          <div className="muted small">Encrypted address payload</div>
                          <div className="mono small">{order.address.encrypted || 'Unavailable'}</div>
                        </div>
                      )}
                      {order.address.email ? <div className="muted small">Email {order.address.email}</div> : null}
                      {order.address.hint ? <div className="muted small">Hint {order.address.hint}</div> : null}
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
                                    Dude #{id}
                                  </span>
                                ))}
                              </div>
                            ) : (
                              <div className="muted small">Assigned dudes pending</div>
                            )}
                          </div>
                        ))}
                      </div>
                    </>
                  ) : null}

                  {order.looseDudes.length ? (
                    <>
                      <div className="muted small">Unboxed dudes</div>
                      <div className="pill-row">
                        {order.looseDudes.map((id) => (
                          <span key={`${order.deliveryId}:dude:${id}`} className="pill">
                            Dude #{id}
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
      )}

      {authError ? <div className="error">{authError}</div> : null}
    </div>
  );
}
