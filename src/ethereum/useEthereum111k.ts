import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import type { EthereumInventoryItem, EthereumInventoryResponse, EthereumPreparedTransaction, EthereumSession, EthereumTransactionConfirmResponse } from '../../shared/ethereum/api';
import { DEFAULT_ETHEREUM_111K_CONFIG } from '../../shared/ethereum/config';
import { encodeCall } from '../../shared/ethereum/abi';
import { ETHEREUM_FUNCTIONS, ETHEREUM_MAX_EXPECTED_IDS, ethereumAssetId, ethereumHexQuantity } from '../../shared/ethereum/protocol';
import type { EthereumRevealedArtwork } from '../../shared/ethereum/reveal';
import type { useMiNoteEthereumWallet } from '../hooks/useMiNoteEthereumWallet';
import { encryptAddressPayload } from '../lib/solana';
import { ethereumApi, EthereumApiError } from './api';
import { authenticateEthereumWallet } from './auth';
import {
  clearEthereumInventoryRecovery, clearEthereumSession, ethereumInventoryQueryKey, ethereumInventoryScope, isEthereumPendingSaved, readEthereumExpected, readEthereumInventoryExpected, readEthereumOperation, readEthereumPending,
  readEthereumSession, readEthereumSubmission, replaceEthereumInventoryRecovery, reserveEthereumSubmission, restoreEthereumExpected, runEthereumOperation, saveEthereumSession, subscribeEthereumOperation, subscribeEthereumPending, withEthereumSubmissionLock, writeEthereumExpected, writeEthereumStorage, type EthereumAction, type EthereumPendingTransaction, type EthereumSubmission,
  forgetEthereumRevealJob, isEthereumCrateUnpack, readEthereumRevealJobs, rememberEthereumRevealJob,
} from './state';
import { ethereumAddress, ethereumChainId, ethereumOperation, ethereumWalletError } from './wallet';
import { checkedEthereumClaim, checkedEthereumDelivery } from './prepared';
import { recoverEthereumTransaction, readEthereumSubmittedTransaction } from './recovery';
import { ethereumAddressEncryptionKey } from './addressEncryption';
import { EMPTY_ETHEREUM_DISCOUNT_ROOT, ethereumDiscounts, ethereumMintQuote, type EthereumMintQuote } from './discounts';
import { checkoutReservesItems } from './checkoutReservations';
import { useEthereumReveals } from './useEthereumReveals';

export type EthereumWallet = ReturnType<typeof useMiNoteEthereumWallet>;
export type EthereumDeliveryAddress = { formatted: string; country: string; countryCode: string; email: string };

function isTransactionFailure(error: unknown): error is EthereumApiError {
  return error instanceof EthereumApiError && (error.code === 'transaction-reverted' || error.code === 'operation-failed');
}

export function useEthereum111k(wallet: EthereumWallet, encryptionKey: string, mintKind: 'crate' | 'warehouse' = 'crate') {
  const queryClient = useQueryClient();
  const configQuery = useQuery({ queryKey: ['ethereum111k', 'config'], queryFn: ({ signal }) => ethereumApi.config(signal), retry: false, refetchInterval: 60_000 });
  const config = configQuery.data ?? DEFAULT_ETHEREUM_111K_CONFIG;
  const owner = ethereumAddress(wallet.address);
  const scope = ethereumInventoryScope(config, owner);
  const walletRef = useRef(wallet);
  const scopeRef = useRef(scope);
  walletRef.current = wallet;
  scopeRef.current = scope;
  const mounted = useRef(false);
  const busy = useSyncExternalStore(
    useCallback(listener => scope ? subscribeEthereumOperation(scope, listener) : () => {}, [scope]),
    useCallback(() => scope ? readEthereumOperation(scope) : null, [scope]),
    () => null,
  );
  const [error, setError] = useState<string | null>(null);
  const [dismissedConfirmationError, setDismissedConfirmationError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [sessionState, setSessionState] = useState<EthereumSession | null>(null);
  const sessionRef = useRef<EthereumSession | null>(null);
  const setSession = useCallback((next: EthereumSession | null) => {
    sessionRef.current = next;
    setSessionState(next);
  }, []);
  const invalidateSession = useCallback((capturedScope: string, rejectedToken: string) => {
    clearEthereumSession(capturedScope, rejectedToken);
    if (!mounted.current || scopeRef.current !== capturedScope || sessionRef.current?.token !== rejectedToken) return false;
    sessionRef.current = null;
    setSessionState(current => current?.token === rejectedToken ? null : current);
    return true;
  }, []);
  const [pendingState, setPending] = useState<EthereumPendingTransaction | null>(null);
  const [submissionState, setSubmission] = useState<EthereumSubmission | null>(null);
  const [revealed, setRevealed] = useState<{ scope: string; transactionHash: string; submittedAt: number; items: EthereumInventoryItem[] } | null>(null);
  const announcedReveals = useRef(new Set<string>());
  const session = sessionState?.address === owner && sessionState.chainId === config.chainId && sessionState.expiresAtMs > Date.now() ? sessionState : null;
  const pending = pendingState?.scope === scope ? pendingState : null;
  const submission = submissionState?.scope === scope ? submissionState : null;
  const storageWarning = pending && scope && !isEthereumPendingSaved(scope, pending.hash)
    ? `Transaction sent: ${pending.hash}. Browser storage failed. Keep this tab open and save this hash to recover it after a reload.` : null;
  const requiredConfirmations = pending && ['delivery', 'claim', 'cancel'].includes(pending.action) ? config.confirmationBlocks : 1;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    setSession(scope && owner ? readEthereumSession(scope, config, owner) : null);
    setPending(scope ? readEthereumPending(scope) : null);
    setSubmission(scope ? readEthereumSubmission(scope) : null);
    setError(null);
    setNotice(null);
    setRevealed(null);
    if (scope) return subscribeEthereumPending(scope, () => {
      const current = readEthereumPending(scope);
      setPending(current);
      const currentSubmission = readEthereumSubmission(scope);
      setSubmission(currentSubmission);
      if (!current && !currentSubmission) {
        void queryClient.invalidateQueries({ queryKey: ethereumInventoryQueryKey(scope) });
        void queryClient.invalidateQueries({ queryKey: ['ethereum111k', 'stats'] });
        void queryClient.invalidateQueries({ queryKey: ['ethereum111k', 'shipments', scope] });
      }
    });
  }, [scope, owner, config.chainId, config.dropId, queryClient, setSession]);
  useEffect(() => {
    const provider = wallet.provider;
    setChainId(null);
    if (!provider) return;
    let current = true;
    let revision = 0;
    const changed = (value: unknown) => { revision++; if (current) setChainId(ethereumChainId(value)); };
    const captured = revision;
    void provider.request({ method: 'eth_chainId' }).then(value => {
      if (current && revision === captured) setChainId(ethereumChainId(value));
    }).catch(() => {});
    provider.on?.('chainChanged', changed);
    return () => { current = false; provider.removeListener?.('chainChanged', changed); };
  }, [wallet.provider]);
  useEffect(() => {
    const provider = wallet.provider;
    const intent = pending?.intent;
    if (!provider || !pending || pending.nonce || !intent || !scope || !owner) return;
    let active = true;
    let fetching = false;
    const captureNonce = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const network = await provider.request({ method: 'eth_chainId' });
        if (!active || ethereumChainId(network) !== config.chainId) return;
        const actual = await readEthereumSubmittedTransaction(provider, pending.hash, config.chainId, owner, intent);
        if (!active || !actual) return;
        await withEthereumSubmissionLock(scope, () => {
          const current = readEthereumPending(scope);
          if (active && current?.hash === pending.hash && !current.nonce) {
            writeEthereumStorage(`${scope}:pending`, { ...current, ...actual });
          }
        });
      } catch {} finally { fetching = false; }
    };
    void captureNonce();
    const interval = setInterval(() => { void captureNonce(); }, 4_000);
    return () => { active = false; clearInterval(interval); };
  }, [wallet.provider, pending, scope, owner, config.chainId]);
  const statsKey = ['ethereum111k', 'stats', config.chainId, config.contractAddress, owner];
  const stats = useQuery({ queryKey: statsKey,
    queryFn: ({ signal }) => ethereumApi.stats(config, owner, signal), enabled: config.enabled, retry: false, refetchInterval: 30_000 });
  const discountRoot = stats.data?.discountMerkleRoot;
  const discountRemaining = Math.max(0, (stats.data?.discountAllowance ?? 0) - (stats.data?.discountUsed ?? 0));
  const discountCheckRequired = Boolean(config.enabled && owner && discountRoot &&
    discountRoot !== EMPTY_ETHEREUM_DISCOUNT_ROOT && discountRemaining > 0);
  const discountProof = useQuery({
    queryKey: ['ethereum111k', 'discountProof', config.chainId, config.contractAddress, discountRoot, owner],
    queryFn: () => ethereumDiscounts.proof(owner!, discountRoot!),
    enabled: mintKind === 'crate' && discountCheckRequired,
    retry: false, staleTime: Infinity,
  });
  const mintQuote = (kind: 'crate' | 'warehouse', quantity: number): EthereumMintQuote | null => {
    if (!owner || !stats.data) return null;
    if (kind === 'crate' && discountCheckRequired && !discountProof.isSuccess) return null;
    return ethereumMintQuote(kind, quantity, stats.data, discountProof.data != null);
  };
  const inventory = useInfiniteQuery({
    queryKey: ethereumInventoryQueryKey(scope), enabled: Boolean(scope && config.enabled),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => ethereumApi.inventory(config, owner!, pageParam, signal, readEthereumInventoryExpected(scope!)),
    getNextPageParam: page => page.nextCursor,
    retry: false, refetchInterval: 30_000,
  });
  const rawItems = useMemo(() => owner && scope ? [...new Map((inventory.data?.pages.flatMap(page => page.items) ?? []).map(item => [item.id, item])).values()] : [], [inventory.data, owner, scope]);
  const onArtworksRevealed = useCallback((transactionHash: string, artworks: EthereumRevealedArtwork[], submittedAt: number) => {
    if (!scope || !owner || !config.contractAddress || !mounted.current || scopeRef.current !== scope) return;
    const key = `${scope}:${transactionHash}`;
    const announced = announcedReveals.current.has(key);
    announcedReveals.current.add(key);
    setRevealed(current => {
      const matching = current?.scope === scope && current.transactionHash === transactionHash;
      if (!matching && (announced || current?.scope === scope && current.submittedAt > submittedAt)) return current;
      return { scope, transactionHash, submittedAt, items: artworks.map(artwork => ({
        ...artwork, id: ethereumAssetId(config.chainId, config.contractAddress!, artwork.tokenId),
        chainId: config.chainId, contractAddress: config.contractAddress!, owner,
        kind: 'artwork', displayId: Number(artwork.tokenId), revealStatus: 'revealed',
      })) };
    });
  }, [scope, owner, config.chainId, config.contractAddress]);
  const { applyArtwork } = useEthereumReveals(config, scope, rawItems, pending, onArtworksRevealed);
  const items = useMemo(() => rawItems.map(applyArtwork), [rawItems, applyArtwork]);
  const profile = useQuery({ queryKey: ['ethereum111k', 'profile', scope, session?.token],
    queryFn: ({ signal }) => ethereumApi.profile(session!, signal), enabled: Boolean(session), retry: false });
  const shipments = useQuery({ queryKey: ['ethereum111k', 'shipments', scope, session?.token],
    queryFn: ({ signal }) => ethereumApi.shipments(session!, signal), enabled: Boolean(session), retry: false, refetchInterval: 30_000 });
  useEffect(() => {
    if (!scope) return;
    for (const cause of [profile.error, shipments.error]) {
      if (cause instanceof EthereumApiError && cause.status === 401 && cause.rejectedSessionToken) invalidateSession(scope, cause.rejectedSessionToken);
    }
  }, [profile.error, shipments.error, scope, invalidateSession]);
  const confirmation = useQuery({ queryKey: ['ethereum111k', 'transaction', scope, pending?.hash],
    queryFn: ({ signal }) => ethereumApi.confirm(pending!.hash, config, owner!, signal, pending!),
    enabled: Boolean(pending && owner && config.enabled), retry: false,
    refetchInterval: 4_000,
  });
  const confirmationErrorKey = confirmation.error ? `${scope}:${pending?.hash}:${confirmation.errorUpdatedAt}` : null;
  const finishing = useRef(new Set<string>());
  const reverting = useRef(new Set<string>());
  const inclusions = useRef(new Map<string, { applied: boolean }>());
  useEffect(() => {
    const result = confirmation.data;
    if (!pending || !scope || !owner) return;
    const transactionKey = `${scope}:${pending.hash}`;
    if (confirmation.isSuccess && result?.status === 'pending') {
      if (inclusions.current.delete(transactionKey)) {
        void queryClient.invalidateQueries({ queryKey: ethereumInventoryQueryKey(scope) });
      }
      return;
    }
    if (!confirmation.isSuccess || result?.status !== 'confirmed' || result.confirmations < 1 || finishing.current.has(pending.hash)) return;
    const inclusion = inclusions.current.get(transactionKey) ?? { applied: false };
    inclusions.current.set(transactionKey, inclusion);
    const confirmationKey = ['ethereum111k', 'transaction', scope, pending.hash];
    const isCurrentInclusion = (minimumConfirmations = 1, allowCleared = false) => {
      const latest = queryClient.getQueryState<EthereumTransactionConfirmResponse>(confirmationKey);
      const current = readEthereumPending(scope);
      return inclusions.current.get(transactionKey) === inclusion && latest?.status === 'success' && latest.data?.status === 'confirmed' && latest.data.confirmations >= minimumConfirmations &&
        !readEthereumSubmission(scope) && (current?.hash === pending.hash || allowCleared && !current);
    };
    const release = () => {
      finishing.current.delete(pending.hash);
      if (inclusions.current.get(transactionKey) !== inclusion) void queryClient.invalidateQueries({ queryKey: confirmationKey });
    };
    const requiresFinalization = pending.action === 'delivery' || pending.action === 'claim';
    const readyToFinish = result.confirmations >= requiredConfirmations && (!requiresFinalization || Boolean(session));
    if (!readyToFinish && (!requiresFinalization || inclusion.applied)) return;
    finishing.current.add(pending.hash);
    const updateExpected = (retainSources: boolean) => {
      const mintedIds = result.items.map(item => item.tokenId);
      const changed = new Set([...result.burnedTokenIds, ...mintedIds]);
      const previous = readEthereumExpected(scope);
      const expected = [...new Set([...previous.filter(id => !changed.has(id)), ...mintedIds])].slice(-ETHEREUM_MAX_EXPECTED_IDS);
      if (retainSources) writeEthereumExpected(scope, expected,
        { hash: pending.hash, sourceIds: [...new Set([...previous.filter(id => !expected.includes(id)), ...result.burnedTokenIds])], mintedIds });
      else {
        writeEthereumExpected(scope, expected);
        clearEthereumInventoryRecovery(scope, pending.hash);
      }
    };
    const updateInventory = () => {
      const burned = new Set(result.burnedTokenIds);
      updateExpected(requiresFinalization);
      queryClient.setQueryData<InfiniteData<EthereumInventoryResponse>>(ethereumInventoryQueryKey(scope), previous => {
        if (!previous) return { pageParams: [null], pages: [{ items: result.items, nextCursor: null, observedBlock: 0 }] };
        const added = new Set(result.items.map(item => item.id));
        return { ...previous, pages: previous.pages.map((page, index) => ({ ...page,
          items: [...(index === 0 ? result.items : []), ...page.items.filter(item => !burned.has(item.tokenId) && !added.has(item.id))],
        })) };
      });
      inclusion.applied = true;
    };
    void (async () => {
      try {
        if (requiresFinalization && !inclusion.applied) {
          const updated = await withEthereumSubmissionLock(scope, async () => {
            if (!isCurrentInclusion()) return false;
            const interruptedInventory = queryClient.getQueryState(ethereumInventoryQueryKey(scope))?.fetchStatus === 'fetching';
            await queryClient.cancelQueries({ queryKey: ethereumInventoryQueryKey(scope) });
            if (!isCurrentInclusion()) return false;
            updateInventory();
            if (interruptedInventory) void queryClient.invalidateQueries({ queryKey: ethereumInventoryQueryKey(scope) });
            return true;
          });
          if (!updated) { release(); return; }
        }
        if (!readyToFinish) { release(); return; }
        if (pending.action === 'delivery' && pending.orderId !== undefined) {
          const finalized = await ethereumApi.confirmDelivery(pending.orderId, pending.hash, session!);
          if (finalized.status !== 'confirmed') { release(); return; }
        }
        if (pending.action === 'claim' && pending.claimId) {
          const finalized = await ethereumApi.confirmClaim(pending.claimId, pending.hash, session!);
          if (finalized.status !== 'confirmed') { release(); return; }
        }
        const cleared = await withEthereumSubmissionLock(scope, () => {
          if (!isCurrentInclusion(requiredConfirmations, true)) return false;
          if (pending.action === 'cancel') restoreEthereumExpected(scope, pending.hash);
          if (!inclusion.applied) updateInventory();
          if (requiresFinalization) updateExpected(false);
          if (isEthereumCrateUnpack(pending) && readEthereumRevealJobs(scope).some(job => job.transactionHash === pending.hash.toLowerCase())) {
            rememberEthereumRevealJob(scope, pending.hash, pending.submittedAt, pending);
          }
          writeEthereumStorage(`${scope}:pending`, null);
          return true;
        });
        if (!cleared) { release(); return; }
        if (mounted.current && scopeRef.current === scope) {
          if (pending.action === 'unbox' && result.items.length && !announcedReveals.current.has(transactionKey)) {
            announcedReveals.current.add(transactionKey);
            setRevealed({ scope, transactionHash: pending.hash, submittedAt: pending.submittedAt, items: result.items });
          }
          if (pending.action === 'cancel') setNotice('Your wallet cancellation is confirmed.');
          setError(null);
        }
        void queryClient.invalidateQueries({ queryKey: ['ethereum111k', 'stats'] });
        void queryClient.invalidateQueries({ queryKey: ethereumInventoryQueryKey(scope) });
        void queryClient.invalidateQueries({ queryKey: ['ethereum111k', 'shipments', scope] });
      } catch (cause) {
        release();
        if (cause instanceof EthereumApiError && cause.status === 401 && cause.rejectedSessionToken && !invalidateSession(scope, cause.rejectedSessionToken)) return;
        if (mounted.current && scopeRef.current === scope) setError(ethereumWalletError(cause));
      }
    })();
  }, [confirmation.data, confirmation.dataUpdatedAt, confirmation.isSuccess, requiredConfirmations, pending, scope, owner, session, queryClient, invalidateSession]);
  useEffect(() => {
    if (!pending || !scope || !isTransactionFailure(confirmation.error) || reverting.current.has(pending.hash)) return;
    const failure = confirmation.error;
    reverting.current.add(pending.hash);
    inclusions.current.delete(`${scope}:${pending.hash}`);
    void withEthereumSubmissionLock(scope, () => {
      const latest = queryClient.getQueryState(['ethereum111k', 'transaction', scope, pending.hash]);
      if (latest?.status !== 'error' || !isTransactionFailure(latest.error)) return false;
      const current = readEthereumPending(scope);
      if (readEthereumSubmission(scope) || current && current.hash !== pending.hash) return false;
      restoreEthereumExpected(scope, pending.hash);
      writeEthereumStorage(`${scope}:pending`, null);
      return true;
    }).then(cleared => {
      if (!cleared) { reverting.current.delete(pending.hash); return; }
      if (mounted.current && scopeRef.current === scope) setError(failure.code === 'operation-failed' ? failure.message : 'The transaction reverted. Your NFTs are unchanged; you can try again.');
    }).catch(cause => {
      reverting.current.delete(pending.hash);
      if (mounted.current && scopeRef.current === scope) setError(ethereumWalletError(cause));
    });
  }, [confirmation.error, pending, scope, queryClient]);
  const run = async (label: string, action: (operation: ReturnType<typeof ethereumOperation>, capturedScope: string) => Promise<void>, allowPending = false): Promise<boolean> => {
    if (scope && readEthereumOperation(scope)) return false;
    if (!config.enabled || !scope || !owner) { setError(config.enabled ? 'Connect your Ethereum wallet first.' : 'The testnet contract is not deployed yet.'); return false; }
    if (readEthereumPending(scope) && !allowPending) { setError('Wait for your pending Ethereum transaction to finish.'); return false; }
    if (readEthereumSubmission(scope) && !allowPending) { setError('Check your wallet and recover the previous Ethereum transaction before submitting again.'); return false; }
    const capturedWallet = walletRef.current;
    setError(null);
    setNotice(null);
    try {
      await runEthereumOperation(scope, label, async () => {
        if (readEthereumPending(scope) && !allowPending) throw new Error('Wait for your pending Ethereum transaction to finish.');
        if (readEthereumSubmission(scope) && !allowPending) throw new Error('Check your wallet and recover the previous Ethereum transaction before submitting again.');
        if (!mounted.current || scopeRef.current !== scope || walletRef.current.provider !== capturedWallet.provider || walletRef.current.address !== capturedWallet.address) {
          throw new Error('Your Ethereum wallet changed. Please try again.');
        }
        const operation = ethereumOperation(() => mounted.current && scopeRef.current === scope ? walletRef.current : { address: null, provider: null }, config);
        try { await action(operation, scope); }
        finally { operation.dispose(); }
      });
      return true;
    } catch (cause) {
      if (cause instanceof EthereumApiError && cause.status === 401 && cause.rejectedSessionToken && !invalidateSession(scope, cause.rejectedSessionToken)) return false;
      if (mounted.current && scopeRef.current === scope) setError(ethereumWalletError(cause));
      return false;
    }
  };
  const authenticate = (operation: ReturnType<typeof ethereumOperation>, capturedScope: string) =>
    authenticateEthereumWallet(operation, config, capturedScope, verified => {
      if (mounted.current && scopeRef.current === capturedScope) setSession(verified);
    });
  const submit = async (operation: ReturnType<typeof ethereumOperation>, capturedScope: string, action: EthereumAction,
    transaction: EthereumPreparedTransaction, details: { orderId?: number; claimId?: string } = {}, beforeSend?: () => void) => {
    if (ethereumAddress(transaction.to) !== config.contractAddress || transaction.chainId !== config.chainId) throw new Error('The transaction targets a different collection.');
    await operation.ensureNetwork();
    const nonce = await operation.provider.request({ method: 'eth_getTransactionCount', params: [operation.address, 'pending'] });
    operation.assertCurrent();
    if (typeof nonce !== 'string' || !/^0x[0-9a-fA-F]+$/.test(nonce)) throw new Error('Your wallet did not return a valid transaction nonce. Try again.');
    const submission: EthereumSubmission = { scope: capturedScope, action, submittedAt: Date.now(), nonce: `0x${BigInt(nonce).toString(16)}`,
      intent: { to: transaction.to, data: transaction.data, value: transaction.value }, ...details };
    let reserved = false;
    let hash: string;
    try { hash = await operation.send(transaction, () => { beforeSend?.(); reserveEthereumSubmission(submission); reserved = true; }); }
    catch (cause) {
      if (reserved && cause && typeof cause === 'object' && 'code' in cause && cause.code === 4001) writeEthereumStorage(`${capturedScope}:pending`, null);
      throw cause;
    }
    const { nonce: _reservedNonce, ...submitted } = submission;
    const record: EthereumPendingTransaction = { ...submitted, hash };
    writeEthereumStorage(`${capturedScope}:pending`, record);
    if (isEthereumCrateUnpack(record)) rememberEthereumRevealJob(capturedScope, hash, record.submittedAt, record);
    void readEthereumSubmittedTransaction(operation.provider, hash, config.chainId, operation.address, transaction).then(async actual => {
      if (!actual) return;
      await withEthereumSubmissionLock(capturedScope, () => {
        const current = readEthereumPending(capturedScope);
        if (current?.hash === hash && !current.nonce) writeEthereumStorage(`${capturedScope}:pending`, { ...current, ...actual });
      });
    }).catch(() => {});
  };
  const transaction = (data: string, value = '0x0'): EthereumPreparedTransaction => ({ to: config.contractAddress!, data, value, chainId: config.chainId });
  const mint = (kind: 'crate' | 'warehouse', quantity: number, quote?: EthereumMintQuote) => {
    const expected = quote ?? mintQuote(kind, quantity);
    return run('Confirm mint in your wallet…', async (operation, capturedScope) => {
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > config.maxMintQuantity) throw new Error('Choose a quantity from 1 to 15.');
      if (!expected) throw new Error('Wait for your mint price to load and try again.');
      const current = await queryClient.fetchQuery({
        queryKey: ['ethereum111k', 'stats', config.chainId, config.contractAddress, operation.address],
        queryFn: ({ signal }) => ethereumApi.stats(config, operation.address, AbortSignal.any([signal, operation.signal])),
        staleTime: 0,
      });
      operation.assertCurrent();
      if (!current.saleActive) throw new Error('Minting is not open yet.');
      if (quantity > (kind === 'crate' ? current.remainingCrates : current.remainingWarehouses)) throw new Error('That quantity is no longer available. Choose fewer containers.');
      if (kind === 'crate' && current.discountMerkleRoot !== expected.discountMerkleRoot) {
        throw new Error('Your mint terms changed. Check the updated price and try again.');
      }
      const proof = kind === 'crate' && current.discountMerkleRoot !== EMPTY_ETHEREUM_DISCOUNT_ROOT &&
        current.discountAllowance > current.discountUsed ? await ethereumDiscounts.proof(operation.address, current.discountMerkleRoot) : null;
      operation.assertCurrent();
      const latest = ethereumMintQuote(kind, quantity, current, proof !== null);
      if (latest.discounted !== expected.discounted || latest.unitPriceWei !== expected.unitPriceWei) {
        throw new Error('Your mint terms changed. Check the updated price and try again.');
      }
      const data = latest.discounted
        ? encodeCall(ETHEREUM_FUNCTIONS.mintCratesDiscounted, ['uint256', 'bytes32[]'], [quantity, proof!])
        : encodeCall(kind === 'crate' ? ETHEREUM_FUNCTIONS.mintCrates : ETHEREUM_FUNCTIONS.mintWarehouses, ['uint256'], [quantity]);
      await submit(operation, capturedScope, 'mint', transaction(data, ethereumHexQuantity(BigInt(expected.unitPriceWei) * BigInt(quantity))));
    });
  };
  const unbox = (selected: EthereumInventoryItem | readonly EthereumInventoryItem[], canOpen?: () => boolean) => run('Confirm opening in your wallet…', async (operation, capturedScope) => {
    const items: readonly EthereumInventoryItem[] = Array.isArray(selected) ? selected : [selected as EthereumInventoryItem];
    if (!items.length || items.length > config.maxUnboxQuantity || new Set(items.map(item => item.tokenId)).size !== items.length ||
      items.some(item => item.owner !== operation.address || item.chainId !== config.chainId || item.contractAddress !== config.contractAddress ||
        (item.kind !== 'crate' && !(items.length === 1 && item.kind === 'warehouse')))) {
      throw new Error(`Select up to ${config.maxUnboxQuantity} of your crates, or one warehouse.`);
    }
    const assertAvailable = () => {
      if (checkoutReservesItems(items) || canOpen?.() === false) throw new Error('Check the redemption status of your selected items before opening them.');
    };
    assertAvailable();
    const data = items.length === 1
      ? encodeCall(items[0].kind === 'crate' ? ETHEREUM_FUNCTIONS.unboxCrate : ETHEREUM_FUNCTIONS.unboxWarehouse, ['uint256'], [items[0].tokenId])
      : encodeCall(ETHEREUM_FUNCTIONS.unboxCrates, ['uint256[]'], [items.map(item => item.tokenId)]);
    await submit(operation, capturedScope, 'unbox', transaction(data), {}, assertAvailable);
  });
  const deliver = (selected: EthereumInventoryItem[], address: EthereumDeliveryAddress) => run('Confirm delivery in your wallet…', async (operation, capturedScope) => {
    if (!selected.length || selected.length > config.maxDeliveryItems || selected.some(item => item.owner !== operation.address || !['artwork', 'crate'].includes(item.kind))) throw new Error('Choose up to 50 artworks or crates for delivery.');
    const orderedItems = [...selected].sort((left, right) => {
      const leftId = BigInt(left.tokenId), rightId = BigInt(right.tokenId);
      return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
    });
    const signedIn = await authenticate(operation, capturedScope);
    operation.assertCurrent();
    const addressKey = ethereumAddressEncryptionKey(encryptionKey, config.chainId, import.meta.env?.DEV === true, import.meta.env?.VITE_111K_LOCAL_ADDRESS_PUBLIC_KEY);
    const encrypted = encryptAddressPayload(address.formatted, addressKey);
    const saved = await ethereumApi.saveAddress({ encrypted: encrypted.cipherText, hint: encrypted.hint, country: address.country, countryCode: address.countryCode, email: address.email }, signedIn);
    operation.assertCurrent();
    const prepared = await ethereumApi.prepareDelivery(orderedItems.map(item => item.tokenId), saved.address.id, crypto.randomUUID(), signedIn, operation.signal);
    operation.assertCurrent();
    const request = checkedEthereumDelivery(prepared, config, operation.address, orderedItems);
    await submit(operation, capturedScope, 'delivery', request, { orderId: prepared.orderId });
  });
  const transfer = (item: EthereumInventoryItem, destination: string) => run('Confirm transfer in your wallet…', async (operation, capturedScope) => {
    const recipient = ethereumAddress(destination.trim());
    if (!recipient || recipient === operation.address || /^0x0{40}$/.test(recipient)) throw new Error('Enter another valid Ethereum wallet address.');
    if (item.owner !== operation.address || !item.kind.endsWith('_receipt')) throw new Error('Select a receipt you own.');
    await submit(operation, capturedScope, 'transfer', transaction(encodeCall(ETHEREUM_FUNCTIONS.transfer, ['address', 'address', 'uint256'], [operation.address, recipient, item.tokenId])));
  });
  const claim = (item: EthereumInventoryItem, code: string) => run('Confirm claim in your wallet…', async (operation, capturedScope) => {
    if (item.kind !== 'crate_receipt' || item.owner !== operation.address || !code.trim()) throw new Error('Enter the code for a crate receipt you own.');
    const signedIn = await authenticate(operation, capturedScope);
    const prepared = await ethereumApi.prepareClaim(item.tokenId, code.trim(), signedIn, operation.signal);
    operation.assertCurrent();
    await submit(operation, capturedScope, 'claim', checkedEthereumClaim(prepared, config, item.tokenId), { claimId: prepared.claimId });
  });
  const signIn = () => run('Sign in with Ethereum…', async (operation, capturedScope) => { await authenticate(operation, capturedScope); }, true);
  const replacePending = (replacementHash: string) => run('Checking replacement transaction…', async (operation, capturedScope) => {
    const captured = readEthereumPending(capturedScope);
    const submission = readEthereumSubmission(capturedScope);
    if (!captured && !submission) throw new Error('This transaction is no longer pending.');
    await operation.ensureNetwork();
    const replacement = await recoverEthereumTransaction({ provider: operation.provider, config, owner: operation.address,
      pending: captured ?? submission!, transactionHash: replacementHash, assertCurrent: operation.assertCurrent });
    operation.assertCurrent();
    if (captured ? readEthereumPending(capturedScope)?.hash !== captured.hash :
      readEthereumPending(capturedScope) || readEthereumSubmission(capturedScope)?.submittedAt !== submission!.submittedAt) {
      throw new Error('The pending transaction changed. Refresh and try again.');
    }
    if (captured) replaceEthereumInventoryRecovery(capturedScope, captured.hash, replacement.hash);
    if (isEthereumCrateUnpack(replacement)) rememberEthereumRevealJob(capturedScope, replacement.hash, replacement.submittedAt, replacement);
    if (captured && captured.hash !== replacement.hash) forgetEthereumRevealJob(capturedScope, captured.hash);
    writeEthereumStorage(`${capturedScope}:pending`, replacement);
  }, true);
  const dismissPending = async () => {
    if (!scope || readEthereumOperation(scope) || !pending && !submission) return;
    try {
      const cleared = await withEthereumSubmissionLock(scope, () => {
        const current = readEthereumPending(scope);
        const currentSubmission = readEthereumSubmission(scope);
        if (pending ? current?.hash !== pending.hash : current || currentSubmission?.submittedAt !== submission?.submittedAt) return false;
        writeEthereumStorage(`${scope}:pending`, null);
        if (current) {
          forgetEthereumRevealJob(scope, current.hash);
          queryClient.removeQueries({ queryKey: ['ethereum111k', 'reveal-transaction', config.chainId, config.contractAddress, current.hash.toLowerCase()], exact: true });
          queryClient.removeQueries({ queryKey: ['ethereum111k', 'transaction', scope, current.hash], exact: true });
        }
        return true;
      });
      if (!cleared || !mounted.current || scopeRef.current !== scope) return;
      setError(null);
      setNotice('Stopped tracking. The original transaction may still execute; check your wallet before submitting again.');
    } catch (cause) {
      if (mounted.current && scopeRef.current === scope) setError(ethereumWalletError(cause));
    }
  };
  const disconnect = () => {
    if (scope) saveEthereumSession(scope, null);
    if (session) void ethereumApi.logout(session).catch(() => {});
    setSession(null);
    wallet.disconnect();
  };
  const refresh = useCallback(() => {
    if (scope) void queryClient.invalidateQueries({ queryKey: ethereumInventoryQueryKey(scope) });
    void queryClient.invalidateQueries({ queryKey: ['ethereum111k', 'stats'] });
    void queryClient.invalidateQueries({ queryKey: ['ethereum111k', 'discountProof'] });
    void queryClient.invalidateQueries({ queryKey: ['ethereum111k', 'shipments'] });
    void queryClient.invalidateQueries({ queryKey: ['ethereum111k', 'transaction'] });
    void queryClient.invalidateQueries({ queryKey: ['ethereum111k', 'reveal-transaction'] });
    void queryClient.invalidateQueries({ queryKey: ['ethereum111k', 'reveal-tokens'] });
  }, [scope, queryClient]);
  return {
    config, configQuery, stats, discountProof, discountCheckRequired, mintQuote, inventory, items, scope, owner, chainId, profile, shipments, session,
    pending, submission, storageWarning, requiredConfirmations, confirmations: confirmation.data?.confirmations ?? 0, busy, notice, error: error ?? (confirmation.error && confirmationErrorKey !== dismissedConfirmationError ? ethereumWalletError(confirmation.error) : null),
    revealed: revealed?.scope === scope ? revealed.items.map(applyArtwork) : null,
    applyArtwork,
    closeReveal: () => setRevealed(null), clearError: () => { setError(null); setDismissedConfirmationError(confirmationErrorKey); },
    mint, unbox, deliver, transfer, claim, signIn, disconnect, refresh, replacePending, dismissPending,
  };
}
