import { useCallback, useEffect, useRef, useState } from 'react';
import type { Ethereum111kConfig } from '../../shared/ethereum/config';
import type { EthereumRelicStatus } from '../../shared/ethereum/api';
import type { EthereumWallet } from './useEthereum111k';

type Options = {
  wallet: EthereumWallet;
  config?: Pick<Ethereum111kConfig, 'enabled' | 'chainId' | 'contractAddress'>;
  active: boolean;
  selectedId: number | null;
  status?: EthereumRelicStatus;
  loadError?: string | null;
  blocked: boolean;
  suspended: boolean;
  onClaim: (id: number) => Promise<boolean>;
};

type Attempt = {
  id: number;
  config: { chainId: number; contractAddress: string } | null;
  wallet: { address: string; provider: NonNullable<EthereumWallet['provider']> } | null;
  connectionStarted: boolean;
  stage: 'connecting' | 'claiming';
};

export function useEthereumRelicClaimAction(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const mounted = useRef(false);
  const active = useRef<Attempt | null>(null);
  const [stage, setStage] = useState<Attempt['stage'] | null>(null);
  const [error, setError] = useState<{ message: string; loadError: boolean } | null>(null);

  useEffect(() => {
    setError(current => current?.loadError && current.message !== options.loadError ? null : current);
  }, [options.loadError]);
  const release = useCallback((attempt: Attempt) => {
    if (active.current !== attempt) return;
    active.current = null;
    if (mounted.current) setStage(null);
  }, []);
  const cancel = useCallback(() => {
    const attempt = active.current;
    if (!attempt || attempt.stage === 'claiming') return;
    release(attempt);
    if (attempt.connectionStarted && !attempt.wallet) latest.current.wallet.cancel();
  }, [release]);

  const advance = useCallback((attempt: Attempt) => {
    if (!mounted.current || active.current !== attempt || attempt.stage !== 'connecting') return;
    const current = latest.current;
    const fail = (message: string, loadError = false) => { setError({ message, loadError }); cancel(); };
    if (!current.active || current.suspended || current.blocked || current.selectedId !== attempt.id) { cancel(); return; }
    if (current.loadError) { fail(current.loadError, true); return; }
    if (current.config) {
      if (attempt.config && (current.config.chainId !== attempt.config.chainId || current.config.contractAddress !== attempt.config.contractAddress)) {
        fail('This drop changed. Please try claiming again.'); return;
      }
      if (!current.config.enabled || !current.config.contractAddress) { fail('Relic claims are unavailable.'); return; }
      attempt.config ??= { chainId: current.config.chainId, contractAddress: current.config.contractAddress };
    }
    const wallet = current.wallet;
    if (attempt.wallet && (wallet.address !== attempt.wallet.address || wallet.provider !== attempt.wallet.provider || wallet.status === 'disconnected')) {
      fail('Your Ethereum wallet changed. Please try claiming again.'); return;
    }
    const status = current.status;
    if (status) {
      if (!status.saleActive) { fail('Relic claims are paused.'); return; }
      if (status.remainingRelics === 0) { fail('All allocated relics have been claimed.'); return; }
      if ((status.claimedMask & (1 << (attempt.id - 1))) !== 0) { fail('That relic was already claimed. Choose another one.'); return; }
    }
    if (wallet.status === 'connected' && wallet.address && wallet.provider) {
      attempt.wallet ??= { address: wallet.address, provider: wallet.provider };
    } else if (wallet.status === 'connecting' || wallet.status === 'choosing') attempt.connectionStarted = true;
    if (!wallet.ready || wallet.status === 'restoring') return;
    if (wallet.status === 'disconnected') {
      if (attempt.connectionStarted) fail(wallet.error ?? 'Wallet connection was cancelled. Try again when you’re ready.');
      else {
        attempt.connectionStarted = true;
        try { wallet.connect(); } catch (cause) { fail(cause instanceof Error ? cause.message : 'Unable to connect your Ethereum wallet.'); }
      }
      return;
    }
    if (wallet.status !== 'connected' || !wallet.address || !attempt.wallet || !current.config || !status ||
      status.owner !== wallet.address.toLowerCase() || status.chainId !== current.config.chainId || status.contractAddress !== current.config.contractAddress) return;
    if (status.remainingAllowance === 0) {
      fail(status.relicLimit === 0 ? 'This wallet is not eligible to claim a relic.' : 'You have claimed your relic allowance.'); return;
    }
    attempt.stage = 'claiming';
    setStage('claiming');
    try { void current.onClaim(attempt.id).then(() => release(attempt), () => release(attempt)); }
    catch { release(attempt); }
  }, [cancel, release]);

  useEffect(() => {
    mounted.current = true;
    window.addEventListener('pagehide', cancel);
    return () => { mounted.current = false; window.removeEventListener('pagehide', cancel); cancel(); active.current = null; };
  }, [cancel]);
  useEffect(() => { if (active.current) advance(active.current); });

  const claim = useCallback(() => {
    const current = latest.current;
    if (!mounted.current || active.current || !current.active || current.blocked || current.suspended) return;
    setError(null);
    if (current.selectedId === null || !Number.isInteger(current.selectedId) || current.selectedId < 1 || current.selectedId > 18) {
      setError({ message: 'Choose an available relic first.', loadError: false }); return;
    }
    const attempt: Attempt = { id: current.selectedId, config: null, wallet: null, connectionStarted: false, stage: 'connecting' };
    active.current = attempt;
    setStage('connecting');
    advance(attempt);
  }, [advance]);
  const clearError = useCallback(() => setError(null), []);
  return { claim, cancel, connecting: stage === 'connecting', pending: stage !== null,
    error: error && (!error.loadError || error.message === options.loadError) ? error.message : null, clearError };
}
