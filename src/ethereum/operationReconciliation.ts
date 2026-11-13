import type { QueryClient } from '@tanstack/react-query';
import type { EthereumInventoryItem, EthereumInventoryResponse, EthereumTransactionConfirmResponse } from '../../shared/ethereum/api';
import type { Ethereum111kConfig } from '../../shared/ethereum/config';
import { ETHEREUM_MAX_EXPECTED_IDS } from '../../shared/ethereum/protocol';
import { ethereumApi, EthereumApiError } from './api';
import { retainEthereumMetadata } from './catalogRevision';
import { hasEthereumConfirmedInventory, readEthereumConfirmedInventory, rememberEthereumConfirmedInventory } from './confirmedInventory';
import { ETHEREUM_DROP_OPERATION_TTL, readEthereumDropOperations, subscribeEthereumDropOperations, writeEthereumDropOperation, type EthereumDropOperation } from './dropOperations';
import { readEthereumSubmittedTransaction, ethereumSubmittedNonceConsumed } from './recovery';
import { ethereumInventoryQueryKey, readEthereumExpected, writeEthereumExpected, forgetEthereumRevealJob, isEthereumCrateUnpack, rememberEthereumRevealJob, type EthereumRevealJob } from './state';
import type { EthereumWallet } from './useEthereum111k';
import { ethereumAddress, ethereumChainId, ethereumOperation } from './wallet';

type ReconciliationContext = {
  client: QueryClient;
  scope: string;
  owner: string;
  config: Ethereum111kConfig;
  currentWallet: () => EthereumWallet | null;
  isCurrent: () => boolean;
  isTrackingReveal: (hash: string) => boolean;
  publishUnpack: (hash: string, items: EthereumInventoryItem[]) => void;
  publishUnpackError: (hash: string, message: string) => void;
  setError: (message: string) => void;
  refresh: () => void;
};

export function abortableEthereumOperation<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort();
  });
}

export function createEthereumOperationReconciliation() {
  const initiated = new Set<string>();
  const localOperations = new Map<string, EthereumDropOperation>();
  const confirmedUnpacks = new Set<string>();
  const revealedUnpacks = new Set<string>();
  const retiredHere = new Set<string>();
  let reconcilePending: ((operation: EthereumDropOperation, result: EthereumTransactionConfirmResponse) => Promise<void>) | null = null;

  const retireOperation = (operation: EthereumDropOperation) => {
    retiredHere.add(operation.id);
    writeEthereumDropOperation(operation.scope, operation.id, null);
  };
  const forgetLocal = (hash: string) => {
    localOperations.delete(hash);
    confirmedUnpacks.delete(hash);
    revealedUnpacks.delete(hash);
  };
  const readPending = (scope: string) => [...new Map([
    ...[...localOperations.values()].filter(operation => operation.scope === scope &&
      operation.submittedAt + ETHEREUM_DROP_OPERATION_TTL > Date.now() && !confirmedUnpacks.has(operation.hash!)),
    ...readEthereumDropOperations(scope),
  ].map(operation => [operation.id, operation])).values()];
  const revealCompleted = (hash: string) => {
    if (!localOperations.has(hash)) return;
    if (confirmedUnpacks.delete(hash)) localOperations.delete(hash);
    else revealedUnpacks.add(hash);
  };
  const revealFailed = (scope: string, hash: string, client: QueryClient) => {
    forgetLocal(hash);
    for (const operation of readEthereumDropOperations(scope)) {
      if (operation.action === 'unbox' && operation.hash === hash) retireOperation(operation);
    }
    void client.invalidateQueries({ queryKey: ethereumInventoryQueryKey(scope) });
  };
  const retainReveal = (scope: string | null, job: EthereumRevealJob) => {
    const operation = localOperations.get(job.transactionHash);
    return Boolean(operation?.scope === scope && operation.submittedAt + ETHEREUM_DROP_OPERATION_TTL > Date.now() &&
      !revealedUnpacks.has(job.transactionHash) && isEthereumCrateUnpack(operation));
  };
  const reserve = (operation: EthereumDropOperation) => {
    initiated.add(operation.id);
    writeEthereumDropOperation(operation.scope, operation.id, operation);
  };
  const submitted = (operation: EthereumDropOperation & { hash: string }) => {
    localOperations.set(operation.hash, operation);
    writeEthereumDropOperation(operation.scope, operation.id, operation);
    if (isEthereumCrateUnpack(operation)) rememberEthereumRevealJob(operation.scope, operation.hash, operation.submittedAt, operation);
  };

  const watch = ({ client, scope, owner, config, currentWallet, isCurrent, isTrackingReveal,
    publishUnpack, publishUnpackError, setError, refresh }: ReconciliationContext) => {
    const controller = new AbortController();
    let running = false;
    let sweeping = false;
    const exists = (operation: EthereumDropOperation) => !controller.signal.aborted && operation.submittedAt + ETHEREUM_DROP_OPERATION_TTL > Date.now() &&
      (readEthereumDropOperations(scope).some(item => item.id === operation.id && item.hash === operation.hash) ||
        operation.hash !== undefined && localOperations.get(operation.hash)?.id === operation.id);
    const remove = (operation: EthereumDropOperation, message?: string) => {
      if (operation.hash) forgetLocal(operation.hash);
      retireOperation(operation);
      if (operation.hash) forgetEthereumRevealJob(scope, operation.hash);
      if (!message && operation.action === 'unbox' && operation.hash && isCurrent()) {
        publishUnpackError(operation.hash, 'Couldn’t confirm this opening. Check your inventory or wallet.');
      }
      if (message && isCurrent()) {
        if (operation.action === 'unbox' && operation.hash) publishUnpackError(operation.hash, message);
        if (operation.action !== 'unbox' && initiated.has(operation.id)) setError(message);
      }
      refresh();
    };
    const reconcile = async (operation: EthereumDropOperation, result: EthereumTransactionConfirmResponse) => {
      if (!exists(operation) || operation.hash && confirmedUnpacks.has(operation.hash)) return;
      await client.cancelQueries({ queryKey: ethereumInventoryQueryKey(scope) });
      if (!exists(operation) || operation.hash && confirmedUnpacks.has(operation.hash)) return;
      rememberEthereumConfirmedInventory(scope, operation.id, result.items.map(item => item.tokenId), result.burnedTokenIds, operation.submittedAt);
      const burned = new Set(readEthereumConfirmedInventory(scope).burnedTokenIds);
      const accepted = result.items.filter(item => !burned.has(item.tokenId));
      const added = new Set(accepted.map(item => item.tokenId));
      writeEthereumExpected(scope, [...new Set([...readEthereumExpected(scope).filter(id => !burned.has(id)), ...added])].slice(-ETHEREUM_MAX_EXPECTED_IDS));
      client.setQueryData<EthereumInventoryResponse>(ethereumInventoryQueryKey(scope, config), previous => ({ nextCursor: null,
        ...(config.catalogRevision !== undefined || previous?.catalogRevision !== undefined
          ? { catalogRevision: Math.max(config.catalogRevision ?? 0, previous?.catalogRevision ?? 0) } : {}),
        ...(config.deploymentId !== undefined && { deploymentId: config.deploymentId }),
        observedBlock: previous?.observedBlock ?? 0, items: [...accepted.map(item => retainEthereumMetadata(previous?.items.find(value => value.id === item.id), item)), ...(previous?.items ?? []).filter(item => !burned.has(item.tokenId) && !added.has(item.tokenId))] }));
      if (operation.action === 'unbox') {
        if (operation.hash && localOperations.has(operation.hash)) confirmedUnpacks.add(operation.hash);
        if (!isEthereumCrateUnpack(operation)) publishUnpack(operation.hash!, result.items);
        else if (operation.hash && revealedUnpacks.delete(operation.hash)) {
          localOperations.delete(operation.hash);
          confirmedUnpacks.delete(operation.hash);
        }
      } else if (operation.hash) localOperations.delete(operation.hash);
      retireOperation(operation);
      refresh();
    };
    reconcilePending = reconcile;
    const check = async (operation: EthereumDropOperation) => {
      if (!operation.hash || !exists(operation)) return;
      if (isEthereumCrateUnpack(operation)) {
        if (!revealedUnpacks.has(operation.hash) && !isTrackingReveal(operation.hash)) rememberEthereumRevealJob(scope, operation.hash, operation.submittedAt, operation);
        if (confirmedUnpacks.has(operation.hash)) return;
      }
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
      try {
        const result = await abortableEthereumOperation(ethereumApi.confirm(operation.hash, config, owner, signal, operation), signal);
        if (!exists(operation) || confirmedUnpacks.has(operation.hash)) return;
        if (result.status === 'confirmed' && result.confirmations >= 1) { await reconcile(operation, result); return; }
        const wallet = currentWallet();
        if (!wallet?.provider || ethereumAddress(wallet.address) !== owner) return;
        const background = ethereumOperation(() => currentWallet() ?? { address: null, provider: null }, config);
        const backgroundSignal = AbortSignal.any([signal, background.signal]);
        const provider = { ...wallet.provider, request: (request: Parameters<NonNullable<EthereumWallet['provider']>['request']>[0]) => abortableEthereumOperation(wallet.provider!.request(request), backgroundSignal) };
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
              localOperations.set(operation.hash, observed);
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
      const records = [...new Map([...[...localOperations.values()].filter(operation => operation.scope === scope),
        ...readEthereumDropOperations(scope, Date.now(), true)].map(operation => [operation.id, operation])).values()];
      const pending: EthereumDropOperation[] = [];
      sweeping = true;
      try {
        for (const operation of records) {
          if (operation.submittedAt + ETHEREUM_DROP_OPERATION_TTL <= Date.now()) remove(operation);
          else {
            if (operation.hash) localOperations.set(operation.hash, operation);
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
        if (!next.has(id) && !retiredHere.delete(id)) {
          externallyRetired = true;
          const operation = [...localOperations.values()].find(item => item.scope === scope && item.id === id);
          if (operation?.hash && hasEthereumConfirmedInventory(scope, id)) {
            if (operation.action !== 'unbox' || isEthereumCrateUnpack(operation) && revealedUnpacks.delete(operation.hash)) {
              localOperations.delete(operation.hash);
              confirmedUnpacks.delete(operation.hash);
            } else if (isEthereumCrateUnpack(operation)) confirmedUnpacks.add(operation.hash);
          }
        }
      }
      observed = next;
      if (externallyRetired) void client.cancelQueries({ queryKey: ethereumInventoryQueryKey(scope) }).then(() => {
        if (!controller.signal.aborted && isCurrent()) refresh();
      });
      void tick();
    });
    void tick();
    const interval = setInterval(() => { void tick(); }, 4_000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      controller.abort(); clearInterval(interval); unsubscribe(); document.removeEventListener('visibilitychange', tick);
      if (reconcilePending === reconcile) reconcilePending = null;
    };
  };
  const reconcile = async (operation: EthereumDropOperation, result: EthereumTransactionConfirmResponse) => {
    await reconcilePending?.(operation, result);
  };
  return { reserve, submitted, reject: retireOperation, readPending, revealCompleted, revealFailed, retainReveal, reconcile, watch };
}
