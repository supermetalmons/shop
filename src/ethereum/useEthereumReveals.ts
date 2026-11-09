import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { focusManager, useQueries, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { Ethereum111kConfig } from '../../shared/ethereum/config';
import type { EthereumInventoryItem } from '../../shared/ethereum/protocol';
import { ETHEREUM_REVEAL_MAX_TOKEN_IDS, ETHEREUM_REVEAL_RETRY_MS, type EthereumRevealedArtwork, type EthereumRevealTokensResponse, type EthereumRevealTransactionResponse } from '../../shared/ethereum/reveal';
import { ethereumRevealApi, EthereumRevealApiError } from './revealApi';
import { ETHEREUM_DROP_OPERATION_TTL } from './dropOperations';
import { assertEthereumCatalog, assertSameEthereumCatalog, ethereumCatalogKey, EthereumCatalogChangedError, refreshEthereumCatalog } from './catalogRevision';
import {
  forgetEthereumRevealJob, isEthereumCrateUnpack, isEthereumRevealJobCompleted, readEthereumRevealJobs, restorePendingEthereumRevealJob,
  subscribeEthereumRevealJobs, type EthereumPendingTransaction, type EthereumRevealJob,
} from './state';

type ArtworkDisplay = Pick<EthereumInventoryItem,
  'tokenId' | 'name' | 'description' | 'image' | 'animation_url' | 'aspectRatio' | 'category' | 'attributes' | 'metadataRevision'>;
type ArtworkDisplayCache = Readonly<Record<string, ArtworkDisplay>>;
const emptyArtworks: ArtworkDisplayCache = Object.freeze({});
const tokenCooldowns = new WeakMap<QueryClient, { until: number; message: string }>();
const transactionGenerations = new WeakMap<QueryClient, Map<string, string>>();
const sameRevealJob = (a: EthereumRevealJob, b: EthereumRevealJob) => a.transactionHash === b.transactionHash && a.trackingId === b.trackingId;

function tokenCooldown(client: QueryClient, error?: unknown): EthereumRevealApiError | null {
  const now = Date.now();
  if (error instanceof EthereumRevealApiError && error.status === 429) {
    const until = now + (error.retryAfterMs || 60_000);
    if (until > (tokenCooldowns.get(client)?.until ?? 0)) tokenCooldowns.set(client, { until, message: error.message });
  }
  const cooldown = tokenCooldowns.get(client);
  return cooldown && cooldown.until > now ? new EthereumRevealApiError(429, cooldown.message, cooldown.until - now) : null;
}

function retryInterval(value?: number, error?: unknown, failureCount = 0): number {
  if (error instanceof EthereumRevealApiError && error.retryAfterMs) return Math.max(1000, error.retryAfterMs);
  if (error) return Math.min(30_000, ETHEREUM_REVEAL_RETRY_MS * 2 ** Math.min(4, Math.max(0, failureCount - 1)));
  return Math.max(1_000, Math.min(30_000, value || ETHEREUM_REVEAL_RETRY_MS));
}

type TokenQuery = { state: {
  data?: Pick<EthereumRevealTokensResponse, 'artworks' | 'unresolved' | 'retryAfterMs'>;
  error: unknown; errorUpdateCount: number; dataUpdatedAt: number; errorUpdatedAt: number;
} };

function tokenRetryInterval({ state }: TokenQuery): number | false {
  if (state.error) return retryInterval(undefined, state.error, state.errorUpdateCount);
  if (state.data && !state.data.unresolved.length) return false;
  return state.data?.unresolved.every(item => item.status === 'unminted') ? 30_000 : retryInterval(state.data?.retryAfterMs);
}

function refetchTokensWhenDue(query: TokenQuery): boolean {
  const interval = tokenRetryInterval(query);
  return focusManager.isFocused() && interval !== false &&
    Math.max(query.state.dataUpdatedAt, query.state.errorUpdatedAt) + interval <= Date.now();
}

export function useEthereumReveals(config: Ethereum111kConfig, scope: string | null,
  inventory: readonly EthereumInventoryItem[], pending: EthereumPendingTransaction | null,
  onRevealed: (transactionHash: string, artworks: EthereumRevealedArtwork[], submittedAt: number) => void,
  onFailed?: (transactionHash: string, message: string) => void,
  retainLocalJob?: (job: EthereumRevealJob) => boolean) {
  const client = useQueryClient();
  const catalogKey = useMemo(() => ethereumCatalogKey(config), [config.catalogRevision, config.deploymentId]);
  const catalogIdentity = JSON.stringify(catalogKey);
  const activeCatalog = useRef(catalogIdentity);
  activeCatalog.current = catalogIdentity;
  const transactionKey = useCallback((hash: string) => ['ethereum111k', 'reveal-transaction', config.chainId, config.contractAddress,
    ...catalogKey, hash] as const, [config.chainId, config.contractAddress, catalogKey]);
  const attemptedTransactions = useRef(new Set<string>());
  const transactionIdentity = useCallback((job: EthereumRevealJob) => `${config.chainId}:${config.contractAddress}:${catalogIdentity}:${job.transactionHash}:${job.trackingId}`,
    [config.chainId, config.contractAddress, catalogIdentity]);
  const mediaKey = useMemo(() => ['ethereum111k', 'revealed-artworks', config.chainId, config.contractAddress, ...catalogKey] as const,
    [config.chainId, config.contractAddress, catalogKey]);
  const mediaQuery = useQuery({ queryKey: mediaKey, queryFn: async () => emptyArtworks, enabled: false, staleTime: Infinity });
  const media = mediaQuery.data ?? emptyArtworks;
  const rememberArtworks = useCallback((artworks: readonly ArtworkDisplay[]) => {
    if (!artworks.length || activeCatalog.current !== catalogIdentity) return;
    client.setQueryData<ArtworkDisplayCache>(mediaKey, current => {
      const additions = artworks.filter(item => !current?.[item.tokenId] ||
        (item.metadataRevision ?? 0) > (current[item.tokenId].metadataRevision ?? 0));
      return additions.length ? { ...current, ...Object.fromEntries(additions.map(item => [item.tokenId, {
        tokenId: item.tokenId, name: item.name, description: item.description, image: item.image,
        animation_url: item.animation_url, aspectRatio: item.aspectRatio, category: item.category, attributes: item.attributes, metadataRevision: item.metadataRevision,
      }])) } : current;
    });
  }, [client, mediaKey, catalogIdentity]);
  useEffect(() => {
    if (!scope || !config.enabled || config.chainId === 31337) return;
    rememberArtworks(inventory.filter(item => item.kind === 'artwork' && item.revealStatus === 'revealed' &&
      item.chainId === config.chainId && item.contractAddress === config.contractAddress));
  }, [scope, config.enabled, config.chainId, config.contractAddress, inventory, rememberArtworks]);
  const observedJobs = useRef<{ scope: string | null; jobs: EthereumRevealJob[] }>({ scope: null, jobs: [] });
  const readJobs = useCallback(() => {
    if (!scope) return [];
    const shared = new Map(readEthereumRevealJobs(scope).map(job => [job.transactionHash, job]));
    if (observedJobs.current.scope === scope) {
      for (const job of observedJobs.current.jobs) {
        if (!shared.has(job.transactionHash) && retainLocalJob?.(job) && isEthereumRevealJobCompleted(scope, job)) {
          shared.set(job.transactionHash, job);
        }
      }
    }
    return [...shared.values()];
  }, [scope, retainLocalJob]);
  const isTracking = useCallback((hash: string) => readJobs().some(job => job.transactionHash === hash &&
    job.submittedAt + ETHEREUM_DROP_OPERATION_TTL > Date.now()), [readJobs]);
  const [jobState, setJobState] = useState<{ scope: string | null; jobs: EthereumRevealJob[] }>({ scope: null, jobs: [] });
  const jobs = jobState.scope === scope ? jobState.jobs : [];
  const [activeState, setActiveState] = useState<{ scope: string | null; jobs: EthereumRevealJob[] }>({ scope: null, jobs: [] });
  const activeJobs = activeState.scope === scope ? activeState.jobs.filter(job => jobs.some(value => sameRevealJob(value, job))) : [];
  useEffect(() => {
    if (!scope) { observedJobs.current = { scope: null, jobs: [] }; setJobState(observedJobs.current); return; }
    const update = () => {
      const jobs = readJobs();
      observedJobs.current = { scope, jobs: jobs.filter(job => job.submittedAt + ETHEREUM_DROP_OPERATION_TTL > Date.now()) };
      for (const job of jobs) {
        if (job.submittedAt + ETHEREUM_DROP_OPERATION_TTL <= Date.now()) {
          forgetEthereumRevealJob(scope, job.transactionHash, job.trackingId);
          onFailed?.(job.transactionHash, 'Your artworks are still being prepared. Check your inventory for updates.');
        }
      }
      setJobState(observedJobs.current);
    };
    update();
    const unsubscribe = subscribeEthereumRevealJobs(scope, update);
    const timer = setInterval(update, 4_000);
    return () => { clearInterval(timer); unsubscribe(); };
  }, [scope, onFailed, readJobs]);
  useEffect(() => {
    if (scope && pending && isEthereumCrateUnpack(pending)) {
      void restorePendingEthereumRevealJob(scope, pending.hash).catch(() => {});
    }
  }, [scope, pending]);
  useEffect(() => {
    if (!scope) return;
    let generations = transactionGenerations.get(client);
    if (!generations) transactionGenerations.set(client, generations = new Map());
    for (const job of jobs) {
      const identity = `${scope}:${catalogIdentity}:${job.transactionHash}`;
      const previous = generations.get(identity);
      if (previous === job.trackingId) continue;
      generations.set(identity, job.trackingId);
      const queryKey = transactionKey(job.transactionHash);
      const query = client.getQueryState<EthereumRevealTransactionResponse>(queryKey);
      if (query) client.removeQueries({ queryKey, exact: true });
      if (previous !== undefined) client.removeQueries({ queryKey: ['ethereum111k', 'transaction', scope, job.transactionHash], exact: true });
    }
  }, [client, scope, catalogIdentity, transactionKey, jobs]);
  useEffect(() => {
    const schedule = () => setActiveState(current => {
      if (!scope || !config.enabled) return current.jobs.length || current.scope !== scope ? { scope, jobs: [] } : current;
      const state = (hash: string) => client.getQueryState<EthereumRevealTransactionResponse>(transactionKey(hash));
      const running = current.scope === scope ? current.jobs.filter(job => jobs.some(value => sameRevealJob(value, job)) &&
        state(job.transactionHash)?.fetchStatus === 'fetching') : [];
      const nextCheck = (job: EthereumRevealJob) => {
        const query = state(job.transactionHash);
        if (!query || query.status === 'success' && query.data && query.data.status !== 'pending') return 0;
        return Math.max(query.dataUpdatedAt, query.errorUpdatedAt) + retryInterval(query.data?.retryAfterMs, query.error, query.errorUpdateCount);
      };
      const due = jobs.filter(job => {
        const query = state(job.transactionHash);
        const identity = transactionIdentity(job);
        if (query && query.status !== 'pending') attemptedTransactions.current.add(identity);
        const initial = !attemptedTransactions.current.has(identity);
        const complete = query?.status === 'success' && query.data?.status !== 'pending';
        return (focusManager.isFocused() || initial || complete) &&
          !running.some(value => value.transactionHash === job.transactionHash) && nextCheck(job) <= Date.now();
      })
        .sort((a, b) => a.transactionHash === pending?.hash ? -1 : b.transactionHash === pending?.hash ? 1 :
          nextCheck(a) - nextCheck(b) || a.submittedAt - b.submittedAt);
      const next = [...running, ...due.slice(0, Math.max(0, 4 - running.length))];
      return current.scope === scope && current.jobs.length === next.length && current.jobs.every((job, index) => sameRevealJob(job, next[index]))
        ? current : { scope, jobs: next };
    });
    schedule();
    const timer = setInterval(schedule, 250);
    const unsubscribe = focusManager.subscribe(schedule);
    return () => { clearInterval(timer); unsubscribe(); };
  }, [scope, config.enabled, transactionKey, jobs, pending?.hash, client, transactionIdentity]);
  const transactions = useQueries({ queries: activeJobs.map(job => ({
    queryKey: transactionKey(job.transactionHash),
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      attemptedTransactions.current.add(transactionIdentity(job));
      try {
        const response = await ethereumRevealApi.transaction(config, job.transactionHash, signal);
        signal.throwIfAborted();
        assertEthereumCatalog(config, response);
        if ((response.catalogRevision ?? 0) > (config.catalogRevision ?? 0)) {
          void client.invalidateQueries({ queryKey: ['ethereum111k', 'config'] }, { cancelRefetch: false });
        }
        return response;
      } catch (error) { await refreshEthereumCatalog(client, error); throw error; }
    },
    enabled: Boolean(scope && config.enabled), retry: false, staleTime: 0,
    refetchOnWindowFocus: false, refetchOnReconnect: false,
    refetchOnMount: (query: { state: { status: string; data?: EthereumRevealTransactionResponse } }) =>
      query.state.status !== 'success' || !query.state.data || query.state.data.status === 'pending',
  })) });
  const tokenBatches = useMemo(() => {
    const ids = [...new Set(inventory.filter(item => item.kind === 'artwork' && (item.revealStatus !== 'revealed' || config.chainId === 31337))
      .map(item => item.tokenId))].sort((a, b) => Number(a) - Number(b));
    const batches: string[][] = [];
    for (let offset = 0; offset < ids.length; offset += ETHEREUM_REVEAL_MAX_TOKEN_IDS) batches.push(ids.slice(offset, offset + ETHEREUM_REVEAL_MAX_TOKEN_IDS));
    return batches;
  }, [inventory, config.chainId]);
  const tokens = useQuery({
    queryKey: ['ethereum111k', 'reveal-tokens', config.chainId, config.contractAddress, ...catalogKey, tokenBatches],
    queryFn: async ({ signal }) => {
      const result: Pick<EthereumRevealTokensResponse, 'artworks' | 'unresolved' | 'retryAfterMs'> = {
        artworks: [], unresolved: [], retryAfterMs: ETHEREUM_REVEAL_RETRY_MS,
      };
      const current = client.getQueryData<ArtworkDisplayCache>(mediaKey);
      const missing = tokenBatches.map(ids => ids.filter(id => !current?.[id])).filter(ids => ids.length);
      const failures: unknown[] = [];
      let catalog: EthereumRevealTokensResponse | undefined;
      for (let offset = 0; offset < missing.length; offset += 2) {
        signal.throwIfAborted();
        const responses = await Promise.allSettled(missing.slice(offset, offset + 2).map(async ids => {
          const cooldown = tokenCooldown(client);
          if (cooldown) throw cooldown;
          const response = await ethereumRevealApi.tokens(config, ids, signal).catch(error => {
            tokenCooldown(client, error);
            throw error;
          });
          signal.throwIfAborted();
          assertEthereumCatalog(config, response);
          if (catalog) assertSameEthereumCatalog(catalog, response);
          else catalog = response;
          if ((response.catalogRevision ?? 0) > (config.catalogRevision ?? 0)) {
            void client.invalidateQueries({ queryKey: ['ethereum111k', 'config'] }, { cancelRefetch: false });
          }
          rememberArtworks(response.artworks);
          return response;
        }));
        signal.throwIfAborted();
        for (const responseResult of responses) {
          if (responseResult.status === 'rejected') { failures.push(responseResult.reason); continue; }
          const response = responseResult.value;
          result.artworks.push(...response.artworks);
          result.unresolved.push(...response.unresolved);
          result.retryAfterMs = Math.max(result.retryAfterMs, response.retryAfterMs);
        }
        const changed = failures.find(error => error instanceof EthereumCatalogChangedError);
        if (changed) { await refreshEthereumCatalog(client, changed); throw changed; }
        const cooldown = tokenCooldown(client);
        if (cooldown) throw cooldown;
      }
      if (failures.length) {
        const failure = failures.sort((a, b) => retryInterval(undefined, b) - retryInterval(undefined, a))[0];
        throw failure instanceof EthereumRevealApiError && failure.status === 429
          ? new EthereumRevealApiError(429, failure.message, ETHEREUM_REVEAL_RETRY_MS) : failure;
      }
      return result;
    },
    enabled: Boolean(scope && config.enabled && tokenBatches.some(ids => ids.some(id => !media[id]))), retry: false,
    refetchInterval: tokenRetryInterval,
    refetchOnWindowFocus: refetchTokensWhenDue, refetchOnReconnect: refetchTokensWhenDue,
  });
  useEffect(() => {
    if (!scope || !config.enabled) return;
    const tracked = new Map(readJobs().filter(job => job.submittedAt + ETHEREUM_DROP_OPERATION_TTL > Date.now())
      .map(job => [job.transactionHash, job]));
    const isTracked = (index: number) => tracked.get(activeJobs[index].transactionHash)?.trackingId === activeJobs[index].trackingId;
    const results = [
      ...transactions.filter((query, index) => isTracked(index) && query.isSuccess && query.data.status === 'revealed').flatMap(query => query.data!.artworks),
      ...(tokens.isSuccess ? tokens.data.artworks : []),
    ];
    rememberArtworks(results);
    transactions.forEach((query, index) => {
      if (!query.isSuccess || query.data.status === 'pending' || !isTracked(index)) return;
      const hash = activeJobs[index].transactionHash;
      const crates = new Set(tracked.get(hash)?.crateTokenIds);
      const artworks = query.data.artworks.filter(artwork => crates.has(artwork.crateTokenId));
      observedJobs.current = { scope, jobs: observedJobs.current.jobs.filter(job => !sameRevealJob(job, activeJobs[index])) };
      setJobState(previous => previous.scope === scope
        ? { scope, jobs: previous.jobs.filter(job => !sameRevealJob(job, activeJobs[index])) } : previous);
      if (query.data.status === 'revealed' && artworks.length) onRevealed(hash, artworks, activeJobs[index].submittedAt);
      else if (query.data.status !== 'revealed') onFailed?.(hash, query.data.status === 'reverted' ? 'The opening transaction reverted. You can try again.' : 'This transaction did not open the selected containers.');
      else onFailed?.(hash, 'Couldn’t match the revealed artworks to your containers. Check your inventory.');
      forgetEthereumRevealJob(scope, hash, activeJobs[index].trackingId, query.data.status === 'revealed' && artworks.length > 0);
    });
  }, [scope, config.enabled, transactions, tokens, activeJobs, rememberArtworks, onRevealed, onFailed, readJobs]);
  const applyArtwork = useCallback((item: EthereumInventoryItem): EthereumInventoryItem => {
    const artwork = item.kind === 'artwork' && item.chainId === config.chainId && item.contractAddress === config.contractAddress ? media[item.tokenId] : undefined;
    if (!artwork || (item.metadataRevision ?? 0) > (artwork.metadataRevision ?? 0)) return item;
    return { ...item, ...(artwork.metadataRevision !== undefined && { metadataRevision: artwork.metadataRevision }),
      name: artwork.name, description: artwork.description, image: artwork.image,
      animation_url: artwork.animation_url, aspectRatio: artwork.aspectRatio, category: artwork.category,
      attributes: config.chainId !== 31337 && item.revealStatus === 'revealed' &&
        (item.metadataRevision ?? 0) === (artwork.metadataRevision ?? 0) ? item.attributes ?? artwork.attributes : artwork.attributes,
      revealStatus: 'revealed' };
  }, [media, config.chainId, config.contractAddress]);
  return { applyArtwork, isTracking };
}
