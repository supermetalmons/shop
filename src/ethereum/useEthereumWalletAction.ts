import { useCallback, useEffect, useRef, useState } from 'react';
import type { Ethereum111kConfig } from '../../shared/ethereum/config';
import type { EthereumWallet } from './useEthereum111k';

type WalletActionOptions = {
  wallet: EthereumWallet;
  config?: Pick<Ethereum111kConfig, 'enabled' | 'chainId' | 'contractAddress'>;
  loadError?: string | null;
  blocked: boolean;
  suspended: boolean;
};

type EthereumWalletActionAttempt<T> = {
  data: T;
  config: { chainId: number; contractAddress: string } | null;
  wallet: { address: string; provider: NonNullable<EthereumWallet['provider']> } | null;
  connectionStarted: boolean;
  stage: 'connecting' | 'submitting';
};

type WalletActionPolicy<Options extends WalletActionOptions, Data> = {
  canStart?: (options: Options) => boolean;
  capture: (options: Options) => { data: Data } | { error: string };
  isCurrent: (data: Data, options: Options) => boolean;
  validate: (attempt: EthereumWalletActionAttempt<Data>, options: Options) => string | null;
  ready: (attempt: EthereumWalletActionAttempt<Data>, options: Options) => boolean | string;
  submit: (data: Data, options: Options) => Promise<boolean>;
  connectionError: string;
};

export function captureEthereumWalletActionConfig(
  attempt: Pick<EthereumWalletActionAttempt<unknown>, 'config'>,
  config: WalletActionOptions['config'],
  changedMessage: string,
  unavailableMessage: string,
): string | null {
  if (!config) return null;
  if (attempt.config && (config.chainId !== attempt.config.chainId || config.contractAddress !== attempt.config.contractAddress)) {
    return changedMessage;
  }
  if (!config.enabled || !config.contractAddress) return unavailableMessage;
  attempt.config ??= { chainId: config.chainId, contractAddress: config.contractAddress };
  return null;
}

export function ethereumWalletActionChanged(
  attempt: Pick<EthereumWalletActionAttempt<unknown>, 'wallet'>,
  wallet: EthereumWallet,
): boolean {
  return Boolean(attempt.wallet && (wallet.address !== attempt.wallet.address ||
    wallet.provider !== attempt.wallet.provider || wallet.status === 'disconnected'));
}

export function useEthereumWalletAction<Options extends WalletActionOptions, Data>(
  options: Options,
  policy: WalletActionPolicy<Options, Data>,
) {
  const latest = useRef({ options, policy });
  latest.current = { options, policy };
  const mounted = useRef(false);
  const active = useRef<EthereumWalletActionAttempt<Data> | null>(null);
  const [stage, setStage] = useState<EthereumWalletActionAttempt<Data>['stage'] | null>(null);
  const [error, setError] = useState<{ message: string; loadError: boolean } | null>(null);

  useEffect(() => {
    setError(current => current?.loadError && current.message !== options.loadError ? null : current);
  }, [options.loadError]);

  const release = useCallback((attempt: EthereumWalletActionAttempt<Data>) => {
    if (active.current !== attempt) return;
    active.current = null;
    if (mounted.current) setStage(null);
  }, []);

  const cancel = useCallback(() => {
    const attempt = active.current;
    if (!attempt || attempt.stage === 'submitting') return;
    release(attempt);
    if (attempt.connectionStarted && !attempt.wallet) latest.current.options.wallet.cancel();
  }, [release]);

  const advance = useCallback((attempt: EthereumWalletActionAttempt<Data>) => {
    if (!mounted.current || active.current !== attempt || attempt.stage !== 'connecting') return;
    const { options: current, policy } = latest.current;
    const fail = (message: string, loadError = false) => { setError({ message, loadError }); cancel(); };
    if (current.suspended || current.blocked || !policy.isCurrent(attempt.data, current)) { cancel(); return; }
    if (current.loadError) { fail(current.loadError, true); return; }
    const invalid = policy.validate(attempt, current);
    if (invalid) { fail(invalid); return; }

    const wallet = current.wallet;
    if (wallet.status === 'connected' && wallet.address && wallet.provider) {
      attempt.wallet ??= { address: wallet.address, provider: wallet.provider };
    } else if (wallet.status === 'connecting' || wallet.status === 'choosing') attempt.connectionStarted = true;
    if (!wallet.ready || wallet.status === 'restoring') return;
    if (wallet.status === 'disconnected') {
      if (attempt.connectionStarted) fail(wallet.error ?? 'Wallet connection was cancelled. Try again when you’re ready.');
      else {
        attempt.connectionStarted = true;
        try { wallet.connect(); }
        catch (cause) { fail(cause instanceof Error ? cause.message : policy.connectionError); }
      }
      return;
    }
    if (wallet.status !== 'connected' || !attempt.wallet || !current.config) return;
    const ready = policy.ready(attempt, current);
    if (typeof ready === 'string') { fail(ready); return; }
    if (!ready) return;
    attempt.stage = 'submitting';
    setStage('submitting');
    try { void policy.submit(attempt.data, current).then(() => release(attempt), () => release(attempt)); }
    catch { release(attempt); }
  }, [cancel, release]);

  useEffect(() => {
    mounted.current = true;
    window.addEventListener('pagehide', cancel);
    return () => {
      mounted.current = false;
      window.removeEventListener('pagehide', cancel);
      cancel();
      active.current = null;
    };
  }, [cancel]);
  useEffect(() => { if (active.current) advance(active.current); });

  const start = useCallback(() => {
    const { options: current, policy } = latest.current;
    if (!mounted.current || active.current || current.blocked || current.suspended || policy.canStart?.(current) === false) return;
    setError(null);
    const captured = policy.capture(current);
    if ('error' in captured) { setError({ message: captured.error, loadError: false }); return; }
    const attempt: EthereumWalletActionAttempt<Data> = {
      data: captured.data, config: null, wallet: null, connectionStarted: false, stage: 'connecting',
    };
    active.current = attempt;
    setStage('connecting');
    advance(attempt);
  }, [advance]);

  const clearError = useCallback(() => setError(null), []);
  return { start, cancel, connecting: stage === 'connecting', pending: stage !== null,
    error: error && (!error.loadError || error.message === options.loadError) ? error.message : null, clearError };
}
