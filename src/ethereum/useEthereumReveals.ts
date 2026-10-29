import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { focusManager, useQueries, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { Ethereum111kConfig } from '../../shared/ethereum/config';
import type { EthereumInventoryItem } from '../../shared/ethereum/protocol';
import { ETHEREUM_REVEAL_MAX_TOKEN_IDS, ETHEREUM_REVEAL_RETRY_MS, type EthereumRevealedArtwork, type EthereumRevealTokensResponse, type EthereumRevealTransactionResponse } from '../../shared/ethereum/reveal';
import { ethereumRevealApi, EthereumRevealApiError } from './revealApi';
import {
  forgetEthereumRevealJob, isEthereumCrateUnpack, readEthereumRevealJobs, restorePendingEthereumRevealJob,
  subscribeEthereumRevealJobs, type EthereumPendingTransaction, type EthereumRevealJob,
} from './state';

type ArtworkDisplay = Pick<EthereumInventoryItem,
  'tokenId' | 'name' | 'description' | 'image' | 'animation_url' | 'aspectRatio' | 'category' | 'attributes'>;
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
  onRevealed: (transactionHash: string, artworks: EthereumRevealedArtwork[], submittedAt: number) => void) {
  const client = useQueryClient();
  const attemptedTransactions = useRef(new Set<string>());
  const transactionIdentity = useCallback((job: EthereumRevealJob) => `${config.chainId}:${config.contractAddress}:${job.transactionHash}:${job.trackingId}`,
    [config.chainId, config.contractAddress]);
  const mediaKey = useMemo(() => ['ethereum111k', 'revealed-artworks', config.chainId, config.contractAddress] as const,
    [config.chainId, config.contractAddress]);
  const mediaQuery = useQuery({ queryKey: mediaKey, queryFn: async () => emptyArtworks, enabled: false, staleTime: Infinity });
  const media = mediaQuery.data ?? emptyArtworks;
  const rememberArtworks = useCallback((artworks: readonly ArtworkDisplay[]) => {
    if (!artworks.length) return;
    client.setQueryData<ArtworkDisplayCache>(mediaKey, current => {
      const additions = artworks.filter(item => !current?.[item.tokenId]);
      return additions.length ? { ...current, ...Object.fromEntries(additions.map(item => [item.tokenId, {
        tokenId: item.tokenId, name: item.name, description: item.description, image: item.image,
        animation_url: item.animation_url, aspectRatio: item.aspectRatio, category: item.category, attributes: item.attributes,
      }])) } : current;
    });
  }, [client, mediaKey]);
  useEffect(() => {
    if (!scope || !config.enabled || config.chainId === 31337) return;
    rememberArtworks(inventory.filter(item => item.kind === 'artwork' && item.revealStatus === 'revealed' &&
      item.chainId === config.chainId && item.contractAddress === config.contractAddress));
  }, [scope, config.enabled, config.chainId, config.contractAddress, inventory, rememberArtworks]);
  const [jobState, setJobState] = useState<{ scope: string | null; jobs: EthereumRevealJob[] }>({ scope: null, jobs: [] });
  const jobs = jobState.scope === scope ? jobState.jobs : [];
  const [activeState, setActiveState] = useState<{ scope: string | null; jobs: EthereumRevealJob[] }>({ scope: null, jobs: [] });
  const activeJobs = activeState.scope === scope ? activeState.jobs.filter(job => jobs.some(value => sameRevealJob(value, job))) : [];
  useEffect(() => {
    if (!scope) { setJobState({ scope: null, jobs: [] }); return; }
    const update = () => setJobState({ scope, jobs: readEthereumRevealJobs(scope) });
    update();
    return subscribeEthereumRevealJobs(scope, update);
  }, [scope]);
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
      const identity = `${scope}:${job.transactionHash}`;
      const previous = generations.get(identity);
      if (previous === job.trackingId) continue;
      generations.set(identity, job.trackingId);
      const queryKey = ['ethereum111k', 'reveal-transaction', config.chainId, config.contractAddress, job.transactionHash];
      const query = client.getQueryState<EthereumRevealTransactionResponse>(queryKey);
      if (query) client.removeQueries({ queryKey, exact: true });
      if (previous !== undefined) client.removeQueries({ queryKey: ['ethereum111k', 'transaction', scope, job.transactionHash], exact: true });
    }
  }, [client, scope, config.chainId, config.contractAddress, jobs]);
  useEffect(() => {
    const schedule = () => setActiveState(current => {
      if (!scope || !config.enabled) return current.jobs.length || current.scope !== scope ? { scope, jobs: [] } : current;
      const state = (hash: string) => client.getQueryState<EthereumRevealTransactionResponse>(
        ['ethereum111k', 'reveal-transaction', config.chainId, config.contractAddress, hash]);
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
  }, [scope, config.enabled, config.chainId, config.contractAddress, jobs, pending?.hash, client, transactionIdentity]);
  const transactions = useQueries({ queries: activeJobs.map(job => ({
    queryKey: ['ethereum111k', 'reveal-transaction', config.chainId, config.contractAddress, job.transactionHash],
    queryFn: ({ signal }: { signal: AbortSignal }) => {
      attemptedTransactions.current.add(transactionIdentity(job));
      return ethereumRevealApi.transaction(config, job.transactionHash, signal);
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
    queryKey: ['ethereum111k', 'reveal-tokens', config.chainId, config.contractAddress, tokenBatches],
    queryFn: async ({ signal }) => {
      const result: Pick<EthereumRevealTokensResponse, 'artworks' | 'unresolved' | 'retryAfterMs'> = {
        artworks: [], unresolved: [], retryAfterMs: ETHEREUM_REVEAL_RETRY_MS,
      };
      const current = client.getQueryData<ArtworkDisplayCache>(mediaKey);
      const missing = tokenBatches.map(ids => ids.filter(id => !current?.[id])).filter(ids => ids.length);
      const failures: unknown[] = [];
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
    const tracked = new Map(readEthereumRevealJobs(scope).map(job => [job.transactionHash, job]));
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
      if (query.data.status === 'revealed' && artworks.length) onRevealed(hash, artworks, activeJobs[index].submittedAt);
      forgetEthereumRevealJob(scope, hash, activeJobs[index].trackingId);
    });
  }, [scope, config.enabled, transactions, tokens, activeJobs, rememberArtworks, onRevealed]);
  const applyArtwork = useCallback((item: EthereumInventoryItem): EthereumInventoryItem => {
    const artwork = item.kind === 'artwork' && item.chainId === config.chainId && item.contractAddress === config.contractAddress ? media[item.tokenId] : undefined;
    if (!artwork) return item;
    return { ...item, name: artwork.name, description: artwork.description, image: artwork.image,
      animation_url: artwork.animation_url, aspectRatio: artwork.aspectRatio, category: artwork.category,
      attributes: artwork.attributes, revealStatus: 'revealed' };
  }, [media, config.chainId, config.contractAddress]);
  return { applyArtwork };
}
