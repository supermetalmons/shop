import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { EthereumSession } from '../../shared/ethereum/api';
import { ETHEREUM_CHECKOUT_ID, parseCheckoutEntry, type EthereumCheckoutStatusResponse } from '../../shared/ethereum/checkout';
import { ADDRESS_ENCRYPTION_PUBLIC_KEY } from '../config/addressEncryption';
import { ethereumApi, EthereumApiError } from '../ethereum/api';
import { authenticateEthereumWallet } from '../ethereum/auth';
import { ethereumAddressEncryptionKey } from '../ethereum/addressEncryption';
import { checkedEthereumDelivery } from '../ethereum/prepared';
import { clearEthereumSession, ethereumInventoryScope, readEthereumPending, readEthereumSubmission, runEthereumOperation } from '../ethereum/state';
import { ethereumAddress, ethereumChainId, ethereumOperation, ethereumWalletError } from '../ethereum/wallet';
import type { EthereumProviderListener } from '../wallet/injectedEthereumProviders';
import type { EthereumDeliveryAddress, EthereumWallet } from '../ethereum/useEthereum111k';
import { encryptAddressPayload } from '../lib/solana';
import { navigate } from '../navigation';
import { checkoutApi, CheckoutApiError } from './api';
import { checkoutEntryRequestId, clearCheckoutEntryRequest } from './entry';
import { rememberCheckoutReservation, observeCheckoutReservation, persistCheckoutReservation, useCheckoutReservations } from '../ethereum/checkoutReservations';

export type CheckoutLocation = { checkoutId?: string; search: string };
const checkoutQueryKey = (id: string) => ['ethereumCheckout', id] as const;

function walletRequestRejected(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 4001);
}

function rememberHash(checkout: EthereumCheckoutStatusResponse, hash: string): EthereumCheckoutStatusResponse {
  if (checkout.transactionHash || checkout.status === 'success' || checkout.status === 'failed') return checkout;
  const returnUrl = checkout.returnUrl ? new URL(checkout.returnUrl) : null;
  returnUrl?.searchParams.set('result', 'pending');
  returnUrl?.searchParams.set('tx_hash', hash);
  return { ...checkout, status: 'pending', transactionHash: hash, ...(returnUrl ? { returnUrl: returnUrl.href } : {}) };
}

export function useEthereumCheckout({ checkoutId, search }: CheckoutLocation, wallet: EthereumWallet) {
  const queryClient = useQueryClient();
  const entry = useMemo(() => {
    try {
      if (checkoutId) {
        if (!ETHEREUM_CHECKOUT_ID.test(checkoutId)) throw new Error('This checkout link is invalid.');
        return { request: null, error: null };
      }
      return { request: parseCheckoutEntry(search, window.location.origin), error: null };
    } catch (cause) { return { request: null, error: ethereumWalletError(cause) }; }
  }, [checkoutId, search]);
  const requestId = useMemo(() => entry.request ? checkoutEntryRequestId(entry.request) : '', [entry.request]);
  const creationKey = ['ethereumCheckout', 'create', requestId];
  const creation = useQuery({ queryKey: creationKey,
    queryFn: async ({ signal }) => {
      const checkout = await checkoutApi.create({ ...entry.request!, requestId }, signal);
      rememberCheckoutReservation(checkout, true);
      return checkout;
    },
    enabled: Boolean(!checkoutId && entry.request), retry: false, staleTime: Infinity,
  });
  const status = useQuery({ queryKey: checkoutQueryKey(checkoutId ?? ''),
    queryFn: async ({ signal }) => {
      const observe = observeCheckoutReservation(checkoutId!);
      const cached = queryClient.getQueryData<EthereumCheckoutStatusResponse>(checkoutQueryKey(checkoutId!));
      const checkout = await (cached && ['prepared', 'submitting', 'pending'].includes(cached.status)
        ? checkoutApi.refresh(checkoutId!, signal) : checkoutApi.status(checkoutId!, signal));
      observe(checkout);
      return checkout;
    },
    enabled: Boolean(checkoutId && !entry.error), retry: false,
    refetchInterval: query => ['success', 'failed'].includes(query.state.data?.status ?? '') ? false : 4_000,
  });
  const serverCheckout = checkoutId ? status.data : creation.data;
  const [acknowledgedAttempt, setAcknowledgedAttempt] = useState<EthereumCheckoutStatusResponse | null>(null);
  const [knownHash, setKnownHash] = useState<{ checkoutId: string; hash: string } | null>(null);
  const hasAcknowledgedSubmission = serverCheckout && acknowledgedAttempt?.checkoutId === serverCheckout.checkoutId &&
    ['submitting', 'pending'].includes(acknowledgedAttempt.status) && ['ready', 'prepared'].includes(serverCheckout.status) &&
    !(serverCheckout.attempt?.attemptId === acknowledgedAttempt.attempt?.attemptId && serverCheckout.attempt?.status === 'rejected');
  const trackedCheckout = hasAcknowledgedSubmission ? acknowledgedAttempt! : serverCheckout;
  const checkout = trackedCheckout && knownHash?.checkoutId === trackedCheckout.checkoutId
    ? rememberHash(trackedCheckout, knownHash.hash) : trackedCheckout;
  useCheckoutReservations(ethereumAddress(wallet.address), checkout?.chainId ?? 0, checkout?.contractAddress ?? null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [blockingCheckoutId, setBlockingCheckoutId] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [chainId, setChainId] = useState<number | null>(null);
  const mounted = useRef(false);
  const sending = useRef(false);
  const recoveryAttempts = useRef(new Map<string, string>());
  const walletRef = useRef(wallet);
  const checkoutRef = useRef(checkout);
  walletRef.current = wallet;
  checkoutRef.current = checkout;
  const update = useCallback(async (next: EthereumCheckoutStatusResponse) => {
    await queryClient.cancelQueries({ queryKey: checkoutQueryKey(next.checkoutId), exact: true });
    queryClient.setQueryData(checkoutQueryKey(next.checkoutId), next);
    if (!checkoutId) queryClient.setQueryData(creationKey, next);
  }, [queryClient, checkoutId, requestId]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const provider = wallet.provider;
    setChainId(null);
    if (!provider) return;
    let active = true;
    let revision = 0;
    const changed: EthereumProviderListener = value => { revision++; if (active) setChainId(ethereumChainId(value)); };
    const captured = revision;
    void provider.request({ method: 'eth_chainId' }).then(value => {
      if (active && revision === captured) setChainId(ethereumChainId(value));
    }).catch(() => {});
    provider.on?.('chainChanged', changed);
    return () => { active = false; provider.removeListener?.('chainChanged', changed); };
  }, [wallet.provider]);
  useEffect(() => {
    if (checkoutId || !creation.data) return;
    queryClient.setQueryData(checkoutQueryKey(creation.data.checkoutId), creation.data);
    navigate(`/checkout/${creation.data.checkoutId}`, { replace: true });
    if (entry.request) clearCheckoutEntryRequest(entry.request);
  }, [checkoutId, creation.data?.checkoutId, queryClient]);
  useEffect(() => {
    if (checkoutId) void queryClient.invalidateQueries({ queryKey: checkoutQueryKey(checkoutId) });
  }, [wallet.address, wallet.provider, checkoutId, queryClient]);
  useEffect(() => {
    setError(null);
    setUncertain(false);
    setBlockingCheckoutId(null);
  }, [checkoutId, search]);
  useEffect(() => {
    if (serverCheckout && ['submitting', 'pending', 'success', 'failed'].includes(serverCheckout.status)) setUncertain(false);
    if (serverCheckout) {
      if (serverCheckout.status === 'submitting' || serverCheckout.status === 'pending') rememberCheckoutReservation(serverCheckout);
    }
  }, [serverCheckout]);

  const refresh = async () => {
    const current = checkoutRef.current;
    if (!current || refreshing) return;
    setRefreshing(true);
    try {
      const observe = observeCheckoutReservation(current.checkoutId);
      const next = await checkoutApi.refresh(current.checkoutId);
      observe(next);
      await update(next);
      if (mounted.current && ['ready', 'prepared'].includes(next.status) && (!next.attempt || next.attempt.status === 'rejected')) setUncertain(false);
      if (mounted.current) setError(null);
    } catch (cause) { if (mounted.current) setError(ethereumWalletError(cause)); }
    finally { if (mounted.current) setRefreshing(false); }
  };
  const switchNetwork = async () => {
    const current = checkoutRef.current;
    if (!current || sending.current || !walletRef.current.address || !walletRef.current.provider) return;
    sending.current = true;
    setBusy(`Switching to ${current.config.chainName}…`);
    setError(null);
    const operation = ethereumOperation(() => mounted.current ? walletRef.current : { address: null, provider: null }, current.config);
    try {
      await operation.ensureNetwork();
      if (mounted.current) setChainId(current.chainId);
    } catch (cause) { if (mounted.current) setError(ethereumWalletError(cause)); }
    finally { operation.dispose(); sending.current = false; if (mounted.current) setBusy(null); }
  };
  const submit = async (address?: EthereumDeliveryAddress) => {
    const current = checkoutRef.current;
    const capturedWallet = walletRef.current;
    const owner = ethereumAddress(capturedWallet.address);
    if (sending.current || !current || !owner || !capturedWallet.provider || uncertain ||
      !['ready', 'prepared'].includes(current.status) || capturedWallet.status !== 'connected') return;
    const scope = ethereumInventoryScope(current.config, owner);
    if (!scope) return;
    const selected = [...current.items].sort((left, right) => BigInt(left.tokenId) < BigInt(right.tokenId) ? -1 : 1);
    if (current.unavailableTokenIds.length || selected.length !== current.tokenIds.length || selected.some(item => item.owner !== owner)) {
      setError('Connect the wallet that owns every selected item.');
      return;
    }
    if (current.wallet && current.wallet !== owner) {
      setError('Switch back to the wallet used for this checkout.');
      return;
    }
    sending.current = true;
    setError(null);
    setBlockingCheckoutId(null);
    setBusy('Confirm wallet ownership…');
    let session: EthereumSession | null = null;
    let attemptId: string | null = null;
    let markerStarted = false;
    let walletInvoked = false;
    const active = () => mounted.current && checkoutRef.current?.checkoutId === current.checkoutId;
    try {
      await runEthereumOperation(scope, 'Complete shipping checkout…', async () => {
        if (readEthereumPending(scope) || readEthereumSubmission(scope)) throw new Error('Finish or recover your previous Ethereum transaction before continuing.');
        const operation = ethereumOperation(() => active() ? walletRef.current : { address: null, provider: null }, current.config);
        try {
          if (walletRef.current.provider !== capturedWallet.provider || ethereumAddress(walletRef.current.address) !== owner) {
            throw new Error('Your Ethereum wallet changed. Please try again.');
          }
          session = await authenticateEthereumWallet(operation, current.config, scope);
          operation.assertCurrent();
          let addressId: string | undefined;
          if (current.status === 'ready') {
            if (!address) throw new Error('Enter your shipping address first.');
            const publicKey = ethereumAddressEncryptionKey(ADDRESS_ENCRYPTION_PUBLIC_KEY, current.chainId,
              import.meta.env?.DEV === true, import.meta.env?.VITE_111K_LOCAL_ADDRESS_PUBLIC_KEY);
            const encrypted = encryptAddressPayload(address.formatted, publicKey);
            const saved = await ethereumApi.saveAddress({ encrypted: encrypted.cipherText, hint: encrypted.hint,
              country: address.country, countryCode: address.countryCode, email: address.email }, session);
            operation.assertCurrent();
            addressId = saved.address.id;
          }
          if (active()) setBusy('Preparing your delivery…');
          const prepared = await checkoutApi.prepare({ checkoutId: current.checkoutId, ...(addressId ? { addressId } : {}) }, session, operation.signal);
          operation.assertCurrent();
          const transaction = checkedEthereumDelivery(prepared, current.config, owner, selected);
          await operation.ensureNetwork();
          attemptId = crypto.randomUUID();
          if (active()) setUncertain(true);
          const observeStart = observeCheckoutReservation(current.checkoutId);
          const started = await checkoutApi.submission({ checkoutId: current.checkoutId, attemptId, action: 'start',
            quoteDeadline: prepared.quote.deadline }, session);
          observeStart(started.checkout);
          await update(started.checkout);
          if (active() && ['submitting', 'pending'].includes(started.checkout.status)) setAcknowledgedAttempt(started.checkout);
          if (!started.canSend) {
            if (active()) setError('This checkout already has a transaction in progress. Its status will update here.');
            return;
          }
          markerStarted = true;
          if (!rememberCheckoutReservation(started.checkout)) throw new Error('Check your earlier pending checkouts before starting another redemption.');
          if (active()) { setUncertain(false); setBusy('Confirm delivery in your wallet…'); }
          operation.assertCurrent();
          const hash = await operation.send(transaction, () => {
            checkedEthereumDelivery(prepared, current.config, owner, selected);
            if (!persistCheckoutReservation(started.checkout)) throw new Error('Browser storage is unavailable. Enable storage or free up space before submitting an Ethereum transaction.');
            walletInvoked = true;
          });
          if (active()) setKnownHash({ checkoutId: current.checkoutId, hash });
          await update(rememberHash(started.checkout, hash));
          const observeReport = observeCheckoutReservation(current.checkoutId);
          const reported = await checkoutApi.submission({ checkoutId: current.checkoutId, attemptId, action: 'report', transactionHash: hash }, session);
          observeReport(reported.checkout);
          await update(reported.checkout);
        } finally { operation.dispose(); }
      });
    } catch (cause) {
      if (active() && !markerStarted && !walletInvoked && cause instanceof EthereumApiError && cause.status >= 400 && cause.status < 500) {
        setUncertain(false);
      }
      if (active() && cause instanceof CheckoutApiError) setBlockingCheckoutId(cause.blockingCheckoutId);
      if (markerStarted && attemptId && session && (!walletInvoked || walletRequestRejected(cause))) {
        if (active()) setAcknowledgedAttempt(null);
        try {
          const observe = observeCheckoutReservation(current.checkoutId);
          const rejected = await checkoutApi.submission({ checkoutId: current.checkoutId, attemptId, action: 'reject' }, session);
          observe(rejected.checkout);
          await update(rejected.checkout);
          if (active()) setUncertain(false);
        } catch {
          if (active()) setUncertain(true);
        }
      }
      if (cause instanceof EthereumApiError && cause.status === 401 && cause.rejectedSessionToken) clearEthereumSession(scope, cause.rejectedSessionToken);
      if (active()) setError(walletInvoked && !walletRequestRejected(cause)
        ? 'Your transaction may have been sent. We’re checking its status; do not submit it again.'
        : ethereumWalletError(cause));
      void queryClient.invalidateQueries({ queryKey: checkoutQueryKey(current.checkoutId) });
    } finally {
      sending.current = false;
      if (active()) setBusy(null);
    }
  };

  const recover = async (transactionHash: string) => {
    const current = checkoutRef.current;
    if (sending.current || !current?.attempt || !walletRef.current.address || !walletRef.current.provider || !current.wallet) return;
    const owner = ethereumAddress(walletRef.current.address);
    if (owner !== current.wallet) { setError('Connect the wallet used for this checkout to recover its transaction.'); return; }
    if (!/^0x[0-9a-fA-F]{64}$/.test(transactionHash.trim())) { setError('Enter the transaction hash from your wallet.'); return; }
    const scope = ethereumInventoryScope(current.config, owner)!;
    sending.current = true;
    setBusy('Checking transaction…');
    setError(null);
    const operation = ethereumOperation(() => mounted.current ? walletRef.current : { address: null, provider: null }, current.config);
    try {
      const session = await authenticateEthereumWallet(operation, current.config, scope);
      operation.assertCurrent();
      const hash = transactionHash.trim().toLowerCase();
      const recoveryKey = `${current.checkoutId}:${hash}`;
      const attemptId = recoveryAttempts.current.get(recoveryKey) ?? crypto.randomUUID();
      recoveryAttempts.current.set(recoveryKey, attemptId);
      const observe = observeCheckoutReservation(current.checkoutId);
      const recovered = await checkoutApi.submission({ checkoutId: current.checkoutId, attemptId,
        action: 'recover', transactionHash: hash }, session);
      observe(recovered.checkout);
      await update(recovered.checkout);
      if (mounted.current) { setKnownHash(null); setUncertain(false); setAcknowledgedAttempt(recovered.checkout); }
    } catch (cause) {
      if (cause instanceof EthereumApiError && cause.status === 401 && cause.rejectedSessionToken) clearEthereumSession(scope, cause.rejectedSessionToken);
      if (mounted.current) setError(ethereumWalletError(cause));
    }
    finally { operation.dispose(); sending.current = false; if (mounted.current) setBusy(null); }
  };
  return { checkout, busy, chainId, switchNetwork, blockingCheckoutId, error: entry.error ?? error, loadError: checkoutId ? status.error : creation.error,
    loading: !entry.error && !checkout && !(checkoutId ? status.error : creation.error), refreshing, uncertain, submit, recover, refresh,
    retry: () => { if (checkoutId) void status.refetch(); else void creation.refetch(); },
  };
}
