import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { WalletReadyState } from '@solana/wallet-adapter-base';
import { useWallet } from '@solana/wallet-adapter-react';
import { listFulfillmentOrders, updateFulfillmentStatus } from './lib/api';
import { FulfillmentOrder, FulfillmentOrdersCursor, FulfillmentStatus } from './types';
import { useSolanaAuth } from './hooks/useSolanaAuth';
import { getMediaIdForFigureId } from './lib/figureMediaMap';
import { Modal } from './components/Modal';
import { FRONTEND_DEPLOYMENT, listFrontendDrops, type FigureMediaConfig } from './config/deployment';

const FULFILLMENT_WALLETS = new Set<string>([
  'kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx',
  'A87Upx1f1whNV5P8xQCK2YUTwE3uMYigjoKJAF3jiNpz',
  '8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM',
]);

const PAGE_SIZE = 20;
const FULFILLMENT_STATUS_OPTIONS = ['Preparing', 'Shipped'] as const;

function normalizeFulfillmentStatus(value: unknown): FulfillmentStatus | '' {
  return value === 'Preparing' || value === 'Shipped' ? value : '';
}

function formatOrderDate(ts?: number) {
  if (!ts) return 'Date pending';
  return new Date(ts).toLocaleString(undefined, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function formatOrderStatus(status: string) {
  const normalized = String(status || '').replace(/_/g, ' ').trim();
  if (!normalized) return 'Unknown';
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function renderFigureMediaTiles(
  figureIds: number[],
  keyPrefix: string,
  figureMediaBase: string,
  figureMedia?: FigureMediaConfig,
) {
  return (
    <div className="figure-grid">
      {figureIds.map((figureId, index) => {
        const mediaId = getMediaIdForFigureId(figureId, figureMedia);
        if (!mediaId) return null;
        const src = `${figureMediaBase}/${mediaId}.webp`;
        return (
          <div key={`${keyPrefix}:${figureId}:${index}`} className="figure-tile">
            <img src={src} alt={`Media ${mediaId}`} loading="lazy" className="figure-image" />
            <div className="muted small">{mediaId}</div>
          </div>
        );
      })}
    </div>
  );
}

export default function FulfillmentApp() {
  const drops = useMemo(() => listFrontendDrops(), []);
  const [selectedDropId, setSelectedDropId] = useState(FRONTEND_DEPLOYMENT.dropId);
  const selectedDrop = useMemo(
    () => drops.find((drop) => drop.dropId === selectedDropId) || FRONTEND_DEPLOYMENT,
    [drops, selectedDropId],
  );
  const figureMediaBase = `${selectedDrop.paths.base}/figures/clean`;
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
  const [statusEdits, setStatusEdits] = useState<Record<number, FulfillmentStatus | ''>>({});
  const [statusSaving, setStatusSaving] = useState<Record<number, boolean>>({});
  const [pendingSignIn, setPendingSignIn] = useState(false);
  const [activeUpdateOrderId, setActiveUpdateOrderId] = useState<number | null>(null);
  const walletConnectingSeenRef = useRef(false);
  const [walletReady, setWalletReady] = useState(() => !walletAdapter.wallet || !autoConnectPossible);
  const authLoadingSeenRef = useRef(false);
  const [authReady, setAuthReady] = useState(() => !walletAddress);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const orderRequestEpochRef = useRef(0);

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
          next[order.deliveryId] = normalizeFulfillmentStatus(order.fulfillmentStatus);
        }
      });
      return next;
    });
  }, []);

  const loadInitial = useCallback(async () => {
    if (!allowed || !signedIn) return;
    const requestEpoch = orderRequestEpochRef.current + 1;
    orderRequestEpochRef.current = requestEpoch;
    setLoading(true);
    setLoadingMore(false);
    setOrdersError(null);
    setHasMore(true);
    setCursor(null);
    setOrders([]);
    setStatusEdits({});
    setStatusSaving({});
    setActiveUpdateOrderId(null);
    try {
      const resp = await listFulfillmentOrders({ limit: PAGE_SIZE, cursor: null, dropId: selectedDrop.dropId });
      if (orderRequestEpochRef.current !== requestEpoch) return;
      const nextOrders = Array.isArray(resp.orders) ? resp.orders : [];
      setOrders(nextOrders);
      mergeStatusEdits(nextOrders);
      setCursor(resp.nextCursor || null);
      setHasMore(Boolean(resp.nextCursor));
    } catch (err) {
      if (orderRequestEpochRef.current !== requestEpoch) return;
      console.error(err);
      setOrdersError(err instanceof Error ? err.message : 'Failed to load orders');
    } finally {
      if (orderRequestEpochRef.current === requestEpoch) {
        setLoading(false);
      }
    }
  }, [allowed, signedIn, mergeStatusEdits, selectedDrop.dropId]);

  const loadMore = useCallback(async () => {
    if (!allowed || !signedIn || loadingMore || loading || !hasMore) return;
    const requestEpoch = orderRequestEpochRef.current;
    setLoadingMore(true);
    setOrdersError(null);
    try {
      const resp = await listFulfillmentOrders({ limit: PAGE_SIZE, cursor, dropId: selectedDrop.dropId });
      if (orderRequestEpochRef.current !== requestEpoch) return;
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
      if (orderRequestEpochRef.current !== requestEpoch) return;
      console.error(err);
      setOrdersError(err instanceof Error ? err.message : 'Failed to load more orders');
    } finally {
      if (orderRequestEpochRef.current === requestEpoch) {
        setLoadingMore(false);
      }
    }
  }, [allowed, signedIn, loadingMore, loading, hasMore, cursor, mergeStatusEdits, selectedDrop.dropId]);

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
      if (!allowed || !signedIn) return false;
      const requestEpoch = orderRequestEpochRef.current;
      setStatusSaving((prev) => ({ ...prev, [deliveryId]: true }));
      setOrdersError(null);
      try {
        const nextStatus = normalizeFulfillmentStatus(statusEdits[deliveryId]);
        const resp = await updateFulfillmentStatus(deliveryId, nextStatus, selectedDrop.dropId);
        if (orderRequestEpochRef.current !== requestEpoch) return false;
        const normalized = normalizeFulfillmentStatus(resp.fulfillmentStatus || nextStatus);
        setOrders((prev) =>
          prev.map((order) =>
            order.deliveryId === deliveryId ? { ...order, fulfillmentStatus: normalized || undefined } : order,
          ),
        );
        setStatusEdits((prev) => ({ ...prev, [deliveryId]: normalized }));
        return true;
      } catch (err) {
        if (orderRequestEpochRef.current !== requestEpoch) return false;
        console.error(err);
        setOrdersError(err instanceof Error ? err.message : 'Failed to update status');
        return false;
      } finally {
        if (orderRequestEpochRef.current === requestEpoch) {
          setStatusSaving((prev) => ({ ...prev, [deliveryId]: false }));
        }
      }
    },
    [allowed, signedIn, statusEdits, selectedDrop.dropId],
  );

  const statusDirty = useMemo(() => {
    const dirty = new Set<number>();
    orders.forEach((order) => {
      const current = normalizeFulfillmentStatus(order.fulfillmentStatus);
      const edited = statusEdits[order.deliveryId] ?? '';
      if (current !== edited) dirty.add(order.deliveryId);
    });
    return dirty;
  }, [orders, statusEdits]);

  const activeUpdateOrder = useMemo(
    () => orders.find((order) => order.deliveryId === activeUpdateOrderId) ?? null,
    [activeUpdateOrderId, orders],
  );
  const activeUpdateText = activeUpdateOrder
    ? statusEdits[activeUpdateOrder.deliveryId] ?? normalizeFulfillmentStatus(activeUpdateOrder.fulfillmentStatus)
    : '';
  const activeUpdateDirty = activeUpdateOrder ? statusDirty.has(activeUpdateOrder.deliveryId) : false;
  const activeUpdateSaving = activeUpdateOrder ? Boolean(statusSaving[activeUpdateOrder.deliveryId]) : false;

  const handleOpenUpdateModal = useCallback((deliveryId: number) => {
    setActiveUpdateOrderId(deliveryId);
  }, []);

  const handleCancelUpdate = useCallback(() => {
    if (!activeUpdateOrder) {
      setActiveUpdateOrderId(null);
      return;
    }
    setStatusEdits((prev) => ({
      ...prev,
      [activeUpdateOrder.deliveryId]: normalizeFulfillmentStatus(activeUpdateOrder.fulfillmentStatus),
    }));
    setActiveUpdateOrderId(null);
  }, [activeUpdateOrder]);

  const handleSaveActiveUpdate = useCallback(async () => {
    if (!activeUpdateOrder) return;
    if (!activeUpdateDirty) {
      setActiveUpdateOrderId(null);
      return;
    }
    const ok = await handleSaveStatus(activeUpdateOrder.deliveryId);
    if (ok) setActiveUpdateOrderId(null);
  }, [activeUpdateDirty, activeUpdateOrder, handleSaveStatus]);

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
          <a
            href="/"
            className="brand__home-link"
            aria-label="Go to mons.shop home"
            draggable={false}
            onDragStart={(evt) => {
              evt.preventDefault();
            }}
          >
            <h1>
              <img src="https://assets.mons.link/shop/logo.webp" alt="" className="brand-icon" draggable={false} />
              <span>mons.shop</span>
            </h1>
          </a>
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
          <section className="orders">
            <div className="row">
              <label className="muted small" htmlFor="fulfillment-drop-picker">
                Drop
              </label>
              <select
                id="fulfillment-drop-picker"
                value={selectedDrop.dropId}
                onChange={(evt) => {
                  setSelectedDropId(evt.target.value);
                }}
              >
                {drops.map((drop) => (
                  <option key={drop.dropId} value={drop.dropId}>
                    {drop.collectionName} ({drop.dropId})
                  </option>
                ))}
              </select>
            </div>
            {loading && !orders.length ? <div className="muted small">Loading orders…</div> : null}
            {ordersError ? <div className="error">{ordersError}</div> : null}
            {orders.length ? (
              <div className="order-list">
                {orders.map((order) => (
                  <div key={`${selectedDrop.dropId}:${order.deliveryId}`} className="card subtle">
                    <div className="card__head">
                      <div>
                        <div className="card__title">Order {order.deliveryId}</div>
                        <div className="muted small">
                          {formatOrderDate(order.processedAt || order.createdAt)}
                        </div>
                        {order.address.full !== '***' && order.address.email ? (
                          <div className="muted small">{order.address.email}</div>
                        ) : null}
                      </div>
                      <div className="order-update">
                        {(() => {
                          const statusText = normalizeFulfillmentStatus(order.fulfillmentStatus);
                          return statusText ? (
                            <div className="status-readout small">{statusText}</div>
                          ) : (
                            <em className="muted small">Not set</em>
                          );
                        })()}
                        <button
                          type="button"
                          className="link small"
                          onClick={() => handleOpenUpdateModal(order.deliveryId)}
                        >
                          {normalizeFulfillmentStatus(order.fulfillmentStatus) ? 'Edit status' : 'Set status'}
                        </button>
                      </div>
                    </div>

                    <div className="order-items">
                      <div className="address-lines">
                        {order.address.full ? (
                          <div className="address-text">
                            {order.address.full === '***'
                              ? order.address.country || order.address.countryCode || '***'
                              : order.address.full}
                          </div>
                        ) : (
                          <>
                            <div className="muted small">Encrypted address payload</div>
                            <div className="mono small">{order.address.encrypted || 'Unavailable'}</div>
                          </>
                        )}
                      </div>

                      {order.boxes.length ? (
                        <div className="grid">
                          {order.boxes.map((box) => (
                            <div key={`${order.deliveryId}:${box.boxId}`} className="card subtle box-contents">
                              <div className="card__title">Box Secret {box.claimCode}</div>
                              {box.dudeIds.length ? (
                                renderFigureMediaTiles(
                                  box.dudeIds,
                                  `${order.deliveryId}:${box.boxId}`,
                                  figureMediaBase,
                                  selectedDrop.figureMedia,
                                )
                              ) : (
                                <div className="muted small">Assigned figures pending</div>
                              )}
                            </div>
                          ))}
                        </div>
                      ) : null}

                      {order.looseDudes.length
                        ? renderFigureMediaTiles(
                            order.looseDudes,
                            `${order.deliveryId}:dude`,
                            figureMediaBase,
                            selectedDrop.figureMedia,
                          )
                        : null}
                    </div>
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

      <Modal
        open={activeUpdateOrderId !== null}
        title="Fulfillment status"
        onClose={handleCancelUpdate}
      >
        <div className="modal-form">
          <select
            className="status-input"
            value={activeUpdateText}
            onChange={(evt) => {
              if (!activeUpdateOrder) return;
              const nextStatus = normalizeFulfillmentStatus(evt.target.value);
              setStatusEdits((prev) => ({ ...prev, [activeUpdateOrder.deliveryId]: nextStatus }));
            }}
            aria-label="Fulfillment status"
          >
            <option value="">Not set</option>
            {FULFILLMENT_STATUS_OPTIONS.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
          <div className="row row--end">
            <button type="button" className="ghost" onClick={handleCancelUpdate}>
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleSaveActiveUpdate()}
              disabled={!activeUpdateOrder || activeUpdateSaving || !activeUpdateDirty}
            >
              {activeUpdateSaving ? 'Saving…' : activeUpdateDirty ? 'Save status' : 'Saved'}
            </button>
          </div>
        </div>
      </Modal>

      {authError ? <div className="error">{authError}</div> : null}
    </div>
  );
}
