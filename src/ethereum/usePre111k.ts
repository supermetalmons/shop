import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Pre111kNetwork } from '../../shared/ethereum/pre111k';
import { useMiNoteEthereumWallet } from '../hooks/useMiNoteEthereumWallet';
import { checkedPre111kReservation, pre111kApi, Pre111kPriceChanged } from './pre111kApi';
import { ethereumOperation, ethereumWalletError } from './wallet';
import { EthereumApiError } from './api';
import { ethereumReadCanRefetch, ethereumReadRefetchInterval, ethereumReadRetry, ethereumReadRetryOptions, runEthereumRead } from './readRetry';

type Attempt = {
  scope: string;
  nonce: number | null;
  controller: AbortController;
  operation?: ReturnType<typeof ethereumOperation>;
};

export function usePre111k(network: Pre111kNetwork, accessCode: string | null, onAccessRejected: (code: string) => void) {
  const wallet = useMiNoteEthereumWallet(true);
  const latestWallet = useRef(wallet);
  latestWallet.current = wallet;
  const latestAccess = useRef({ code: accessCode, reject: onAccessRejected });
  latestAccess.current = { code: accessCode, reject: onAccessRejected };
  const mounted = useRef(false);
  const attempt = useRef<Attempt | null>(null);
  const latestAttempt = useRef<Attempt | null>(null);
  const queryClient = useQueryClient();
  const queryKey = ['pre111k', network, wallet.address] as const;
  const approved = Boolean(accessCode);
  const previouslyApproved = useRef(approved);
  const statusQuery = useQuery({ queryKey, queryFn: context => runEthereumRead(context, signal => pre111kApi.status(network, wallet.address, signal)),
    ...ethereumReadRetryOptions,
    refetchInterval: query => approved ? ethereumReadRefetchInterval(query, wallet.address ? 3_000 : 10_000) : false,
    refetchOnWindowFocus: query => approved && ethereumReadCanRefetch(query),
    refetchOnReconnect: query => approved && ethereumReadCanRefetch(query),
    staleTime: 5_000, retry: (failures, error) => approved && ethereumReadRetry(failures, error) });
  const status = statusQuery.data;
  const config = status?.config;
  const scope = config?.contractAddress && wallet.address ? `${config.chainId}:${config.contractAddress}:${wallet.address}` : null;
  const latestScope = useRef(scope);
  latestScope.current = scope;
  const [pendingTransaction, setPendingTransaction] = useState<{ scope: string; hash: string } | null>(null);
  const transactionHash = pendingTransaction?.scope === scope ? pendingTransaction.hash : null;
  const confirmation = useQuery({ queryKey: ['pre111k-confirmation', network, scope, transactionHash],
    queryFn: ({ signal }) => pre111kApi.confirm(network, wallet.address!, transactionHash!, signal),
    enabled: approved && Boolean(transactionHash), refetchInterval: 3_000, retry: 1 });
  const [inFlight, setInFlight] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [error, setError] = useState<{ scope: string; message: string } | null>(null);

  const finish = useCallback((current: Attempt) => {
    if (attempt.current !== current) return;
    attempt.current = null;
    current.controller.abort();
    current.operation?.dispose();
    if (mounted.current) { setInFlight(false); setStage(null); }
  }, []);

  useEffect(() => {
    const opened = approved && !previouslyApproved.current;
    previouslyApproved.current = approved;
    if (opened && statusQuery.isStale) void statusQuery.refetch();
  }, [approved, statusQuery.isStale, statusQuery.refetch]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      latestAttempt.current = null;
      if (attempt.current) finish(attempt.current);
    };
  }, [finish]);

  useEffect(() => {
    setError(null);
    setPendingTransaction(null);
    return () => {
      latestAttempt.current = null;
      if (attempt.current) finish(attempt.current);
    };
  }, [network, scope, wallet.address, wallet.provider, accessCode, finish]);

  useEffect(() => {
    if (confirmation.data?.transactionHash === transactionHash && confirmation.data.status !== 'pending') setPendingTransaction(null);
  }, [confirmation.data, transactionHash]);

  useEffect(() => {
    if (!statusQuery.isSuccess || statusQuery.isStale || status?.wallet !== wallet.address || status.reservedRelics === null) return;
    const current = attempt.current;
    if (!current || current.scope !== scope || current.nonce === null || status.reservedRelics <= current.nonce) return;
    finish(current);
  }, [scope, status, statusQuery.isSuccess, statusQuery.isStale, wallet.address, stage, finish]);

  const reserve = async () => {
    if (!mounted.current || !accessCode || attempt.current || !scope || !config?.enabled || !wallet.address || !wallet.provider ||
      !wallet.ready || wallet.status !== 'connected') return;
    const savedWallet = wallet.address;
    const savedProvider = wallet.provider;
    const current: Attempt = { scope, nonce: null, controller: new AbortController() };
    attempt.current = current;
    latestAttempt.current = current;
    setInFlight(true);
    setError(null);
    setStage('Preparing reservation…');
    const isLatest = () => mounted.current && latestAttempt.current === current &&
      latestScope.current === current.scope && latestWallet.current.address === savedWallet &&
      latestWallet.current.provider === savedProvider && latestAccess.current.code === accessCode;
    const isCurrent = () => isLatest() && attempt.current === current && !current.controller.signal.aborted;
    try {
      const operation = ethereumOperation(() => isCurrent() ? latestWallet.current : { address: null, provider: null }, config);
      current.operation = operation;
      operation.signal.addEventListener('abort', () => finish(current), { once: true, signal: current.controller.signal });
      const assertCurrent = () => {
        current.controller.signal.throwIfAborted();
        operation.assertCurrent();
        if (!isCurrent()) throw new Error('Your reservation request changed. Please try again.');
      };
      const signal = AbortSignal.any([current.controller.signal, operation.signal]);
      const fresh = await runEthereumRead({ client: queryClient, queryKey, signal },
        readSignal => pre111kApi.status(network, savedWallet, readSignal));
      assertCurrent();
      if (!fresh.config.enabled || fresh.config.contractAddress !== config.contractAddress || fresh.config.chainId !== config.chainId ||
        fresh.reservedRelics === null || fresh.remainingRelics === null) {
        throw new Error('Reservations are unavailable. Please refresh and try again.');
      }
      queryClient.setQueryData(queryKey, fresh);
      if (fresh.config.priceWei !== config.priceWei) throw new Pre111kPriceChanged();
      if (fresh.remainingRelics === 0) throw new Error('Preorders ended');
      const prepared = await pre111kApi.prepare(network, savedWallet, accessCode, signal);
      assertCurrent();
      const transaction = checkedPre111kReservation(prepared, fresh.config, savedWallet, fresh.reservedRelics);
      const transactionHash = await operation.send(transaction, () => {
        assertCurrent();
        if (queryClient.getQueryData<typeof fresh>(queryKey)?.config.priceWei !== config.priceWei) throw new Pre111kPriceChanged();
        checkedPre111kReservation(prepared, fresh.config, savedWallet, fresh.reservedRelics!);
        current.nonce = prepared.nonce;
        setStage('Confirm in your wallet…');
      });
      if (!isLatest()) return;
      setPendingTransaction({ scope: current.scope, hash: transactionHash });
      void queryClient.invalidateQueries({ queryKey: ['pre111k', network] });
    } catch (cause) {
      if (!isCurrent()) return;
      if (cause instanceof Pre111kPriceChanged) void queryClient.invalidateQueries({ queryKey });
      if (cause instanceof EthereumApiError && cause.code === 'unauthenticated') latestAccess.current.reject(accessCode);
      else setError({ scope: current.scope, message: ethereumWalletError(cause) });
    } finally {
      finish(current);
    }
  };

  return { wallet, status, statusQuery, inFlight, stage, reserve, transactionHash,
    error: wallet.error || (error?.scope === scope ? error.message : null) };
}
