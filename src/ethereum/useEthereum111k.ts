import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { EthereumInventoryItem, EthereumInventoryResponse, EthereumPreparedTransaction, EthereumRelicStatus, EthereumStats, EthereumTransactionConfirmResponse } from '../../shared/ethereum/api';
import { DEFAULT_ETHEREUM_111K_CONFIG } from '../../shared/ethereum/config';
import { encodeCall } from '../../shared/ethereum/abi';
import { ETHEREUM_FUNCTIONS, ETHEREUM_MINT_KINDS, ETHEREUM_MAX_EXPECTED_IDS, ETHEREUM_MAX_RELICS, ethereumAssetId, ethereumHexQuantity, type EthereumContainerKind, type EthereumMintKind } from '../../shared/ethereum/protocol';
import type { EthereumRevealedArtwork } from '../../shared/ethereum/reveal';
import type { useMiNoteEthereumWallet } from '../hooks/useMiNoteEthereumWallet';
import { ethereumApi, EthereumApiError } from './api';
import { ethereumMintRemaining } from './mint';
import { ethereumInventoryQueryKey, ethereumInventoryScope, readEthereumExpected, writeEthereumExpected, forgetEthereumRevealJob, isEthereumCrateUnpack, rememberEthereumRevealJob, type EthereumRevealJob } from './state';
import { ethereumAddress, ethereumChainId, ethereumOperation, ethereumWalletError } from './wallet';
import { readEthereumSubmittedTransaction, ethereumSubmittedNonceConsumed } from './recovery';
import { EMPTY_ETHEREUM_DISCOUNT_ROOT, ethereumDiscountRemaining, ethereumDiscounts, ethereumMintQuote, type EthereumMintQuote } from './discounts';
import { useEthereumReveals } from './useEthereumReveals';
import { useEthereumInventory } from './useEthereumInventory';
import type { EthereumPendingMint } from './inventory';
import { hasEthereumConfirmedInventory, readEthereumConfirmedInventory, rememberEthereumConfirmedInventory } from './confirmedInventory';
import { ETHEREUM_DROP_OPERATION_TTL, definiteEthereumSubmissionRejection, migrateEthereumDropOperation, readEthereumDropBusy, readEthereumDropOperations, runEthereumDropRequest, subscribeEthereumDropOperations, writeEthereumDropOperation, type EthereumDropOperation } from './dropOperations';

export type EthereumWallet = ReturnType<typeof useMiNoteEthereumWallet>;

function subscribeVisibility(listener: () => void): () => void {
  document.addEventListener('visibilitychange', listener);
  return () => document.removeEventListener('visibilitychange', listener);
}

function reserveDiscounts(stats: EthereumStats, operations: readonly EthereumDropOperation[]): EthereumStats {
  const reserved = operations.filter(item => item.intent && item.discountedQuantity > 0).reduce((sum, item) => sum + item.discountedQuantity, 0);
  return { ...stats, discountUsed: stats.discountUsed + reserved,
    ...(stats.totalDiscountedMints !== undefined ? { totalDiscountedMints: stats.totalDiscountedMints + reserved } : {}) };
}

function reserveMintSupply(stats: EthereumStats, operations: readonly EthereumDropOperation[]): EthereumStats {
  const reserved = operations.filter(item => item.action === 'mint')
    .reduce((sum, item) => sum + item.quantity * (item.kind === 'warehouse' ? 11 : item.kind === 'crate' ? 1 : 0), 0);
  if (!reserved) return stats;
  const remainingCrates = Math.max(0, stats.remainingCrates - reserved);
  return { ...stats, remainingCrates, remainingWarehouses: Math.min(stats.remainingWarehouses, Math.floor(remainingCrates / 11)) };
}

function reserveRelics(status: EthereumRelicStatus, operations: readonly EthereumDropOperation[]): EthereumRelicStatus {
  const ids = operations.flatMap(item => item.relicId && !(status.claimedMask & (1 << (item.relicId - 1))) ? [item.relicId] : []);
  return { ...status, claimedMask: ids.reduce((mask, id) => mask | (1 << (id - 1)), status.claimedMask),
    remainingRelics: Math.max(0, status.remainingRelics - ids.length), remainingAllowance: Math.max(0, status.remainingAllowance - ids.length) };
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort();
  });
}

export function useEthereum111k(wallet: EthereumWallet, mintKind: EthereumContainerKind = 'crate', suspended = false) {
  const client = useQueryClient();
  const pageVisible = useSyncExternalStore(subscribeVisibility, () => document.visibilityState !== 'hidden', () => true);
  const configQuery = useQuery({ queryKey: ['ethereum111k', 'config'], queryFn: ({ signal }) => ethereumApi.config(signal), retry: false, refetchInterval: 60_000 });
  const config = configQuery.data ?? DEFAULT_ETHEREUM_111K_CONFIG;
  const owner = ethereumAddress(wallet.address);
  const scope = ethereumInventoryScope(config, owner);
  const current = useRef({ wallet, scope, mounted: false });
  const initiated = useRef(new Set<string>());
  const localOperations = useRef(new Map<string, EthereumDropOperation>());
  const confirmedUnpacks = useRef(new Set<string>());
  const revealedUnpacks = useRef(new Set<string>());
  const readPendingOperations = useCallback((capturedScope: string) => [...new Map([
    ...[...localOperations.current.values()].filter(operation => operation.scope === capturedScope &&
      operation.submittedAt + ETHEREUM_DROP_OPERATION_TTL > Date.now() && !confirmedUnpacks.current.has(operation.hash!)),
    ...readEthereumDropOperations(capturedScope),
  ].map(operation => [operation.id, operation])).values()], []);
  const requestLifecycle = useRef<AbortController | null>(null);
  const reconcilePending = useRef<((operation: EthereumDropOperation, result: EthereumTransactionConfirmResponse) => Promise<void>) | null>(null);
  const retiredHere = useRef(new Set<string>());
  const retireOperation = useCallback((operation: EthereumDropOperation) => {
    retiredHere.current.add(operation.id);
    writeEthereumDropOperation(operation.scope, operation.id, null);
  }, []);
  current.current.wallet = wallet;
  current.current.scope = scope;
  useEffect(() => { current.current.mounted = true; return () => { current.current.mounted = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    requestLifecycle.current = controller;
    return () => { controller.abort(new Error('Your wallet changed. Please try again.')); };
  }, [scope, wallet.provider]);
  const busy = useSyncExternalStore(
    useCallback(listener => scope ? subscribeEthereumDropOperations(scope, listener) : () => {}, [scope]),
    useCallback(() => scope ? readEthereumDropBusy(scope) : null, [scope]), () => null);
  const snapshot = useSyncExternalStore(
    useCallback(listener => scope ? subscribeEthereumDropOperations(scope, listener) : () => {}, [scope]),
    useCallback(() => scope ? JSON.stringify(readEthereumDropOperations(scope, Date.now(), true)) : '[]', [scope]), () => '[]');
  const operations = useMemo(() => JSON.parse(snapshot) as EthereumDropOperation[], [snapshot]);
  const [error, setError] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [outcomes, setOutcomes] = useState<{ scope: string | null; results: Record<string, EthereumInventoryItem[]>; errors: Record<string, string> }>({ scope: null, results: {}, errors: {} });
  const unpackResults = outcomes.scope === scope ? outcomes.results : {};
  const unpackErrors = outcomes.scope === scope ? outcomes.errors : {};
  const publishUnpack = useCallback((hash: string, items: EthereumInventoryItem[]) => {
    if (!current.current.mounted || current.current.scope !== scope) return;
    if (localOperations.current.has(hash)) {
      if (confirmedUnpacks.current.delete(hash)) localOperations.current.delete(hash);
      else revealedUnpacks.current.add(hash);
    }
    setOutcomes(previous => ({ scope, results: { ...(previous.scope === scope ? previous.results : {}), [hash]: items }, errors: previous.scope === scope ? previous.errors : {} }));
  }, [scope]);
  useEffect(() => { setError(null); if (scope) migrateEthereumDropOperation(scope); }, [scope]);
  useEffect(() => {
    const provider = wallet.provider;
    setChainId(null);
    if (!provider) return;
    let active = true;
    let revision = 0;
    const changed = (value: unknown) => { revision++; if (active) setChainId(ethereumChainId(value)); };
    const captured = revision;
    void provider.request({ method: 'eth_chainId' }).then(value => {
      if (active && revision === captured) setChainId(ethereumChainId(value));
    }).catch(() => {});
    provider.on?.('chainChanged', changed);
    return () => { active = false; provider.removeListener?.('chainChanged', changed); };
  }, [wallet.provider]);
  const stats = useQuery({ queryKey: ['ethereum111k', 'stats', config.chainId, config.contractAddress, owner],
    queryFn: ({ signal }) => ethereumApi.stats(config, owner, signal), enabled: config.enabled, retry: false, refetchInterval: 30_000 });
  const mintSupply = useMemo(() => stats.data ? reserveMintSupply(stats.data, operations) : undefined, [stats.data, operations]);
  const relicsEnabled = config.enabled && mintKind === 'relic' && pageVisible && !suspended;
  const relicQuery = useQuery({ queryKey: ['ethereum111k', 'relics', config.chainId, config.contractAddress, owner],
    queryFn: ({ signal }) => ethereumApi.relics(config, owner, signal), enabled: relicsEnabled,
    retry: false, staleTime: 0, refetchInterval: 4_000, refetchOnWindowFocus: 'always' });
  const relics = { ...relicQuery, data: useMemo(() => relicQuery.data ? reserveRelics(relicQuery.data, operations) : undefined, [relicQuery.data, operations]) };
  const relicMetadata = useQuery({ queryKey: ['ethereum111k', 'relic-metadata', config.chainId, config.contractAddress, config.metadataBaseUri],
    queryFn: ({ signal }) => ethereumApi.relicMetadata(config, signal), enabled: relicsEnabled, retry: false, staleTime: Infinity, gcTime: Infinity });
  const discountRoot = stats.data?.discountMerkleRoot;
  const discountCheckRequired = Boolean(config.enabled && owner && discountRoot && discountRoot !== EMPTY_ETHEREUM_DISCOUNT_ROOT && stats.data && ethereumDiscountRemaining(stats.data) > 0);
  const discountProof = useQuery({ queryKey: ['ethereum111k', 'discountProof', config.chainId, config.contractAddress, discountRoot, owner],
    queryFn: () => ethereumDiscounts.proof(owner!, discountRoot!), enabled: mintKind === 'crate' && discountCheckRequired, retry: false, staleTime: Infinity });
  const mintQuote = (kind: EthereumMintKind, quantity: number): EthereumMintQuote | null => {
    if (!ETHEREUM_MINT_KINDS.includes(kind) || !owner || !stats.data) return null;
    if (kind === 'crate' && discountCheckRequired && !discountProof.isSuccess) return null;
    return ethereumMintQuote(kind, quantity, reserveDiscounts(stats.data, operations), discountProof.data != null);
  };
  const inventory = useEthereumInventory(config, owner, scope);
  const rawItems = useMemo(() => scope ? inventory.data?.items ?? [] : [], [scope, inventory.data]);
  const onArtworksRevealed = useCallback((hash: string, artworks: EthereumRevealedArtwork[]) => {
    if (!owner || !config.contractAddress) return;
    publishUnpack(hash, artworks.map(artwork => ({ ...artwork, id: ethereumAssetId(config.chainId, config.contractAddress!, artwork.tokenId),
      chainId: config.chainId, contractAddress: config.contractAddress!, owner, kind: 'artwork', displayId: Number(artwork.tokenId), revealStatus: 'revealed' })));
  }, [owner, config.chainId, config.contractAddress, publishUnpack]);
  const onRevealFailed = useCallback((hash: string, message: string) => {
    if (!scope || !current.current.mounted || current.current.scope !== scope) return;
    localOperations.current.delete(hash);
    confirmedUnpacks.current.delete(hash);
    revealedUnpacks.current.delete(hash);
    setOutcomes(previous => ({ scope, results: previous.scope === scope ? previous.results : {},
      errors: { ...(previous.scope === scope ? previous.errors : {}), [hash]: message } }));
    for (const operation of readEthereumDropOperations(scope)) {
      if (operation.action === 'unbox' && operation.hash === hash) retireOperation(operation);
    }
    void client.invalidateQueries({ queryKey: ethereumInventoryQueryKey(scope) });
  }, [scope, client, retireOperation]);
  const retainLocalReveal = useCallback((job: EthereumRevealJob) => {
    const operation = localOperations.current.get(job.transactionHash);
    return Boolean(operation?.scope === scope && operation.submittedAt + ETHEREUM_DROP_OPERATION_TTL > Date.now() &&
      !revealedUnpacks.current.has(job.transactionHash) && isEthereumCrateUnpack(operation));
  }, [scope]);
  const { applyArtwork, isTracking: isTrackingReveal } = useEthereumReveals(config, scope, rawItems, null, onArtworksRevealed, onRevealFailed, retainLocalReveal);
  const items = useMemo(() => rawItems.map(applyArtwork), [rawItems, applyArtwork]);
  const refresh = useCallback(() => {
    if (scope) void client.invalidateQueries({ queryKey: ethereumInventoryQueryKey(scope) });
    void client.invalidateQueries({ queryKey: ['ethereum111k', 'stats'] });
    void client.invalidateQueries({ queryKey: ['ethereum111k', 'relics'] });
    void client.invalidateQueries({ queryKey: ['ethereum111k', 'reveal-tokens'] });
  }, [scope, client]);
  useEffect(() => {
    if (!scope || !owner || !config.enabled) return;
    const controller = new AbortController();
    let running = false;
    let sweeping = false;
    const exists = (operation: EthereumDropOperation) => !controller.signal.aborted && operation.submittedAt + ETHEREUM_DROP_OPERATION_TTL > Date.now() &&
      (readEthereumDropOperations(scope).some(item => item.id === operation.id && item.hash === operation.hash) ||
        operation.hash !== undefined && localOperations.current.get(operation.hash)?.id === operation.id);
    const remove = (operation: EthereumDropOperation, message?: string) => {
      if (operation.hash) {
        localOperations.current.delete(operation.hash);
        confirmedUnpacks.current.delete(operation.hash);
        revealedUnpacks.current.delete(operation.hash);
      }
      retireOperation(operation);
      if (operation.hash) forgetEthereumRevealJob(scope, operation.hash);
      if (!message && operation.action === 'unbox' && operation.hash && current.current.mounted && current.current.scope === scope) {
        setOutcomes(previous => ({ scope, results: previous.scope === scope ? previous.results : {},
          errors: { ...(previous.scope === scope ? previous.errors : {}), [operation.hash!]: 'Couldn’t confirm this opening. Check your inventory or wallet.' } }));
      }
      if (message && current.current.mounted && current.current.scope === scope) {
        if (operation.action === 'unbox' && operation.hash) setOutcomes(previous => ({ scope,
          results: previous.scope === scope ? previous.results : {}, errors: { ...(previous.scope === scope ? previous.errors : {}), [operation.hash!]: message } }));
        if (operation.action !== 'unbox' && initiated.current.has(operation.id)) setError(message);
      }
      refresh();
    };
    const reconcile = async (operation: EthereumDropOperation, result: EthereumTransactionConfirmResponse) => {
      if (!exists(operation) || operation.hash && confirmedUnpacks.current.has(operation.hash)) return;
      await client.cancelQueries({ queryKey: ethereumInventoryQueryKey(scope) });
      if (!exists(operation) || operation.hash && confirmedUnpacks.current.has(operation.hash)) return;
      rememberEthereumConfirmedInventory(scope, operation.id, result.items.map(item => item.tokenId), result.burnedTokenIds, operation.submittedAt);
      const burned = new Set(readEthereumConfirmedInventory(scope).burnedTokenIds);
      const accepted = result.items.filter(item => !burned.has(item.tokenId));
      const added = new Set(accepted.map(item => item.tokenId));
      writeEthereumExpected(scope, [...new Set([...readEthereumExpected(scope).filter(id => !burned.has(id)), ...added])].slice(-ETHEREUM_MAX_EXPECTED_IDS));
      client.setQueryData<EthereumInventoryResponse>(ethereumInventoryQueryKey(scope), previous => ({ nextCursor: null,
        observedBlock: previous?.observedBlock ?? 0, items: [...accepted, ...(previous?.items ?? []).filter(item => !burned.has(item.tokenId) && !added.has(item.tokenId))] }));
      if (operation.action === 'unbox') {
        if (operation.hash && localOperations.current.has(operation.hash)) confirmedUnpacks.current.add(operation.hash);
        if (!isEthereumCrateUnpack(operation)) publishUnpack(operation.hash!, result.items);
        else if (operation.hash && revealedUnpacks.current.delete(operation.hash)) {
          localOperations.current.delete(operation.hash);
          confirmedUnpacks.current.delete(operation.hash);
        }
      } else if (operation.hash) localOperations.current.delete(operation.hash);
      retireOperation(operation);
      refresh();
    };
    reconcilePending.current = reconcile;
    const check = async (operation: EthereumDropOperation) => {
      if (!operation.hash || !exists(operation)) return;
      if (isEthereumCrateUnpack(operation)) {
        if (!revealedUnpacks.current.has(operation.hash) && !isTrackingReveal(operation.hash)) rememberEthereumRevealJob(scope, operation.hash, operation.submittedAt, operation);
        if (confirmedUnpacks.current.has(operation.hash)) return;
      }
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
      try {
        const result = await abortable(ethereumApi.confirm(operation.hash, config, owner, signal, operation), signal);
        if (!exists(operation) || confirmedUnpacks.current.has(operation.hash)) return;
        if (result.status === 'confirmed' && result.confirmations >= 1) { await reconcile(operation, result); return; }
        const wallet = current.current.wallet;
        if (!wallet.provider || ethereumAddress(wallet.address) !== owner || current.current.scope !== scope) return;
        const background = ethereumOperation(() => current.current.scope === scope ? current.current.wallet : { address: null, provider: null }, config);
        const backgroundSignal = AbortSignal.any([signal, background.signal]);
        const provider = { ...wallet.provider, request: (request: Parameters<NonNullable<EthereumWallet['provider']>['request']>[0]) => abortable(wallet.provider!.request(request), backgroundSignal) };
        try {
          if (ethereumChainId(await provider.request({ method: 'eth_chainId' })) !== config.chainId || !exists(operation)) return;
          background.assertCurrent();
          let observed = operation;
          if (!operation.transactionSender && operation.intent) {
            const actual = await readEthereumSubmittedTransaction(provider, operation.hash, config.chainId, owner, operation.intent);
            background.assertCurrent();
            if (!exists(operation)) return;
            if (actual) {
              observed = { ...operation, ...actual };
              localOperations.current.set(operation.hash, observed);
              if (readEthereumDropOperations(scope).some(item => item.id === operation.id && item.hash === operation.hash)) {
                writeEthereumDropOperation(scope, operation.id, observed);
              }
            }
          }
          const consumed = await ethereumSubmittedNonceConsumed(provider, observed, config.chainId);
          background.assertCurrent();
          if (consumed && ethereumChainId(await provider.request({ method: 'eth_chainId' })) === config.chainId && exists(operation)) remove(operation);
        } finally { background.dispose(); }
      } catch (cause) {
        if (!exists(operation)) return;
        if (cause instanceof EthereumApiError && (cause.code === 'transaction-reverted' || cause.code === 'operation-failed')) {
          remove(operation, cause.code === 'transaction-reverted' ? 'The transaction reverted. You can try again.' : cause.message);
        }
      }
    };
    const tick = async () => {
      if (controller.signal.aborted || sweeping) return;
      const records = [...new Map([...[...localOperations.current.values()].filter(operation => operation.scope === scope),
        ...readEthereumDropOperations(scope, Date.now(), true)].map(operation => [operation.id, operation])).values()];
      const pending: EthereumDropOperation[] = [];
      sweeping = true;
      try {
        for (const operation of records) {
          if (operation.submittedAt + ETHEREUM_DROP_OPERATION_TTL <= Date.now()) remove(operation);
          else {
            if (operation.hash) localOperations.current.set(operation.hash, operation);
            pending.push(operation);
          }
        }
      } finally { sweeping = false; }
      if (running) return;
      running = true;
      try {
        if (document.visibilityState === 'hidden') return;
        for (let offset = 0; offset < pending.length && !controller.signal.aborted; offset += 4) await Promise.allSettled(pending.slice(offset, offset + 4).map(check));
      } finally { running = false; }
    };
    let observed = new Set(readEthereumDropOperations(scope, Date.now(), true).map(operation => operation.id));
    const unsubscribe = subscribeEthereumDropOperations(scope, () => {
      const next = new Set(readEthereumDropOperations(scope, Date.now(), true).map(operation => operation.id));
      let externallyRetired = false;
      for (const id of observed) {
        if (!next.has(id) && !retiredHere.current.delete(id)) {
          externallyRetired = true;
          const operation = [...localOperations.current.values()].find(item => item.scope === scope && item.id === id);
          if (operation?.hash && hasEthereumConfirmedInventory(scope, id)) {
            if (operation.action !== 'unbox' || isEthereumCrateUnpack(operation) && revealedUnpacks.current.delete(operation.hash)) {
              localOperations.current.delete(operation.hash);
              confirmedUnpacks.current.delete(operation.hash);
            } else if (isEthereumCrateUnpack(operation)) confirmedUnpacks.current.add(operation.hash);
          }
        }
      }
      observed = next;
      if (externallyRetired) void client.cancelQueries({ queryKey: ethereumInventoryQueryKey(scope) }).then(() => {
        if (!controller.signal.aborted && current.current.scope === scope) refresh();
      });
      void tick();
    });
    void tick();
    const interval = setInterval(() => { void tick(); }, 4_000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      controller.abort(); clearInterval(interval); unsubscribe(); document.removeEventListener('visibilitychange', tick);
      if (reconcilePending.current === reconcile) reconcilePending.current = null;
    };
  }, [scope, owner, config, client, publishUnpack, refresh, retireOperation, isTrackingReveal]);
  const run = async <T,>(label: string, action: (operation: ReturnType<typeof ethereumOperation>, capturedScope: string) => Promise<T>): Promise<T | null> => {
    if (!config.enabled || !scope || !owner) { setError(config.enabled ? 'Connect your wallet first.' : 'Minting is unavailable.'); return null; }
    const capturedWallet = wallet;
    const lifecycle = requestLifecycle.current?.signal;
    setError(null);
    try {
      return await runEthereumDropRequest(scope, label, async () => {
        if (lifecycle?.aborted || !current.current.mounted || current.current.scope !== scope || current.current.wallet.provider !== capturedWallet.provider || current.current.wallet.address !== capturedWallet.address) throw new Error('Your wallet changed. Please try again.');
        const operation = ethereumOperation(() => !lifecycle?.aborted && current.current.mounted && current.current.scope === scope ? current.current.wallet : { address: null, provider: null }, config);
        const signal = AbortSignal.any([operation.signal, ...(lifecycle ? [lifecycle] : [])]);
        try { return await abortable(action(operation, scope), signal); } finally { operation.dispose(); }
      });
    } catch (cause) {
      if (current.current.mounted && current.current.scope === scope) setError(ethereumWalletError(cause));
      return null;
    }
  };
  const submit = async (walletOperation: ReturnType<typeof ethereumOperation>, capturedScope: string,
    details: Pick<EthereumDropOperation, 'action' | 'kind' | 'quantity' | 'sourceTokenIds' | 'discountedQuantity'> & { relicId?: number },
    transaction: EthereumPreparedTransaction, beforeSend?: () => void): Promise<string> => {
    if (ethereumAddress(transaction.to) !== config.contractAddress || transaction.chainId !== config.chainId) throw new Error('The transaction targets a different collection.');
    const operation: EthereumDropOperation = { ...details, id: crypto.randomUUID(), scope: capturedScope, submittedAt: Date.now(), intent: { to: transaction.to, data: transaction.data, value: transaction.value } };
    let reserved = false;
    let hash: string;
    try {
      hash = await walletOperation.send(transaction, () => {
        beforeSend?.();
        operation.submittedAt = Date.now();
        initiated.current.add(operation.id);
        writeEthereumDropOperation(capturedScope, operation.id, operation);
        reserved = true;
      });
    } catch (cause) {
      if (reserved && definiteEthereumSubmissionRejection(cause)) retireOperation(operation);
      throw cause;
    }
    const submitted = { ...operation, hash };
    localOperations.current.set(hash, submitted);
    writeEthereumDropOperation(capturedScope, operation.id, submitted);
    if (isEthereumCrateUnpack(submitted)) rememberEthereumRevealJob(capturedScope, hash, submitted.submittedAt, submitted);
    return hash;
  };
  const transaction = (data: string, value = '0x0'): EthereumPreparedTransaction => ({ to: config.contractAddress!, data, value, chainId: config.chainId });
  const mint = async (kind: EthereumMintKind, quantity: number, quote?: EthereumMintQuote): Promise<boolean> => {
    const expected = quote ?? mintQuote(kind, quantity);
    return await run('Confirm mint in your wallet…', async (operation, capturedScope) => {
      if (!ETHEREUM_MINT_KINDS.includes(kind)) throw new Error('This container cannot be publicly minted.');
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > config.maxMintQuantity) throw new Error(`Choose a quantity from 1 to ${config.maxMintQuantity}.`);
      if (!expected) throw new Error('Wait for your mint price to load and try again.');
      const readTerms = async () => {
        const stats = await client.fetchQuery({ queryKey: ['ethereum111k', 'stats', config.chainId, config.contractAddress, operation.address],
          queryFn: ({ signal }) => ethereumApi.stats(config, operation.address, AbortSignal.any([signal, operation.signal])), staleTime: 0 });
        operation.assertCurrent();
        if (!stats.saleActive) throw new Error('Minting is not open yet.');
        if (quantity > ethereumMintRemaining(kind, stats)) throw new Error('That quantity is no longer available. Choose fewer containers.');
        if (kind === 'crate' && stats.discountMerkleRoot !== expected.discountMerkleRoot) throw new Error('Your mint terms changed. Check the updated price and try again.');
        const proof = kind === 'crate' && stats.discountMerkleRoot !== EMPTY_ETHEREUM_DISCOUNT_ROOT && ethereumDiscountRemaining(stats) > 0 ? await ethereumDiscounts.proof(operation.address, stats.discountMerkleRoot) : null;
        operation.assertCurrent();
        return { stats, proof };
      };
      let terms = await readTerms();
      const reserved = readPendingOperations(capturedScope);
      const onchainQuote = ethereumMintQuote(kind, quantity, terms.stats, terms.proof !== null);
      const reservedQuote = ethereumMintQuote(kind, quantity, reserveDiscounts(terms.stats, reserved), terms.proof !== null);
      const supplyReserved = quantity > ethereumMintRemaining(kind, reserveMintSupply(terms.stats, reserved));
      const discountedReserved = onchainQuote.discounted && !reservedQuote.discounted;
      const affected = reserved.filter(item => item.hash &&
        (supplyReserved && item.action === 'mint' || discountedReserved && item.discountedQuantity > 0));
      if (affected.length) {
        const signal = AbortSignal.any([operation.signal, AbortSignal.timeout(10_000)]);
        for (let offset = 0; offset < affected.length; offset += 4) {
          await Promise.all(affected.slice(offset, offset + 4).map(async pending => {
            const result = await abortable(ethereumApi.confirm(pending.hash!, config, operation.address, signal, pending), signal);
            operation.assertCurrent();
            if (result.status === 'confirmed' && result.confirmations >= 1) await reconcilePending.current?.(pending, result);
          }));
        }
        terms = await readTerms();
      }
      const pending = readPendingOperations(capturedScope);
      const assertSupply = () => {
        if (quantity > ethereumMintRemaining(kind, reserveMintSupply(terms.stats, readPendingOperations(capturedScope)))) {
          throw new Error('That quantity is no longer available. Choose fewer containers.');
        }
      };
      assertSupply();
      const latest = ethereumMintQuote(kind, quantity, reserveDiscounts(terms.stats, pending), terms.proof !== null);
      if (!latest.discounted && pending.some(item => !item.hash && item.discountedQuantity > 0) &&
        ethereumMintQuote(kind, quantity, terms.stats, terms.proof !== null).discounted) {
        throw new Error('Your earlier mint is still being checked. Please try again shortly.');
      }
      if (latest.discounted !== expected.discounted || latest.unitPriceWei !== expected.unitPriceWei) throw new Error('Your mint terms changed. Check the updated price and try again.');
      const data = latest.discounted ? encodeCall(ETHEREUM_FUNCTIONS.mintCratesDiscounted, ['uint256', 'bytes32[]'], [quantity, terms.proof!]) :
        encodeCall({ crate: ETHEREUM_FUNCTIONS.mintCrates, warehouse: ETHEREUM_FUNCTIONS.mintWarehouses }[kind], ['uint256'], [quantity]);
      await submit(operation, capturedScope, { action: 'mint', kind, quantity, sourceTokenIds: [], discountedQuantity: latest.discounted ? quantity : 0 },
        transaction(data, ethereumHexQuantity(BigInt(expected.unitPriceWei) * BigInt(quantity))), assertSupply);
      return true;
    }) === true;
  };
  const claimRelic = async (relicId: number): Promise<boolean> => await run('Confirm relic claim in your wallet…', async (operation, capturedScope) => {
    if (!Number.isInteger(relicId) || relicId < 1 || relicId > ETHEREUM_MAX_RELICS) throw new Error('Choose a relic from 1 to 18.');
    const key = ['ethereum111k', 'relics', config.chainId, config.contractAddress, operation.address];
    await client.cancelQueries({ queryKey: key, exact: true });
    operation.assertCurrent();
    await client.fetchQuery({ queryKey: key, queryFn: ({ signal }) => ethereumApi.relics(config, operation.address, AbortSignal.any([signal, operation.signal])), staleTime: 0 });
    operation.assertCurrent();
    const assertAvailable = () => {
      const state = client.getQueryState<EthereumRelicStatus>(key);
      if (state?.status !== 'success' || !state.data || Date.now() - state.dataUpdatedAt >= 8_000) throw new Error('Relic availability changed. Please try again.');
      const latest = reserveRelics(state.data, readPendingOperations(capturedScope));
      if (!latest.saleActive) throw new Error('Relic availability changed. Please try again.');
      if ((latest.claimedMask & (1 << (relicId - 1))) !== 0) throw new Error('That relic was just claimed. Choose another relic.');
      if (latest.remainingRelics === 0) throw new Error('All allocated relics have been claimed.');
      if (latest.remainingAllowance === 0) throw new Error('This wallet has no relic claims remaining.');
    };
    assertAvailable();
    await submit(operation, capturedScope, { action: 'relic-claim', kind: 'relic', quantity: 1, sourceTokenIds: [], discountedQuantity: 0, relicId },
      transaction(encodeCall(ETHEREUM_FUNCTIONS.claimRelic, ['uint256'], [relicId])), assertAvailable);
    return true;
  }) === true;
  const unbox = (selected: EthereumInventoryItem | readonly EthereumInventoryItem[]): Promise<string | null> => run('Confirm opening in your wallet…', async (operation, capturedScope) => {
    const selectedItems: readonly EthereumInventoryItem[] = Array.isArray(selected) ? selected : [selected as EthereumInventoryItem];
    if (!selectedItems.length || selectedItems.length > config.maxUnboxQuantity || new Set(selectedItems.map(item => item.tokenId)).size !== selectedItems.length ||
      selectedItems.some(item => item.owner !== operation.address || item.chainId !== config.chainId || item.contractAddress !== config.contractAddress ||
        (item.kind !== 'crate' && !(selectedItems.length === 1 && (item.kind === 'warehouse' || item.kind === 'relic'))))) throw new Error(`Select up to ${config.maxUnboxQuantity} of your crates, or one warehouse or relic.`);
    const sourceTokenIds = selectedItems.map(item => item.tokenId);
    const assertAvailable = () => {
      if (readPendingOperations(capturedScope).some(record => record.sourceTokenIds.some(id => sourceTokenIds.includes(id)))) throw new Error('These containers are already opening.');
    };
    assertAvailable();
    const data = selectedItems.length === 1 ? encodeCall(selectedItems[0].kind === 'crate' ? ETHEREUM_FUNCTIONS.unboxCrate : selectedItems[0].kind === 'relic' ? ETHEREUM_FUNCTIONS.unboxRelic : ETHEREUM_FUNCTIONS.unboxWarehouse, ['uint256'], [selectedItems[0].tokenId]) :
      encodeCall(ETHEREUM_FUNCTIONS.unboxCrates, ['uint256[]'], [sourceTokenIds]);
    return submit(operation, capturedScope, { action: 'unbox', kind: selectedItems[0].kind as EthereumContainerKind, quantity: selectedItems.length, sourceTokenIds, discountedQuantity: 0 }, transaction(data), assertAvailable);
  });
  const pendingMints = useMemo<EthereumPendingMint[]>(() => operations.filter(operation => operation.action !== 'unbox').map(operation => ({
    id: operation.id, kind: operation.kind, quantity: operation.quantity, submittedAt: operation.submittedAt,
    ...(operation.relicId ? { image: relicMetadata.data?.[operation.relicId - 1]?.image } : {}),
  })), [operations, relicMetadata.data]);
  const pendingItemIds = useMemo(() => new Set(operations.flatMap(operation => operation.sourceTokenIds.map(id => ethereumAssetId(config.chainId, config.contractAddress!, id)))), [operations, config.chainId, config.contractAddress]);
  const pendingRelicIds = useMemo(() => new Set(operations.flatMap(operation => operation.relicId ? [operation.relicId] : [])), [operations]);
  return { config, configQuery, stats, mintSupply, relics, relicMetadata, discountProof, discountCheckRequired, mintQuote, inventory, items, scope, owner, chainId,
    operations, pendingMints, pendingItemIds, pendingRelicIds, busy, error, unpackResults, unpackErrors, applyArtwork,
    clearError: () => setError(null), mint, claimRelic, unbox, refresh };
}
