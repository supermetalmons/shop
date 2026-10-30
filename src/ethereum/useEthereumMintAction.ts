import { useCallback, useEffect, useRef, useState } from 'react';
import type { Ethereum111kConfig } from '../../shared/ethereum/config';
import type { EthereumMintKind } from '../../shared/ethereum/protocol';
import { ETHEREUM_CONTAINER_MEDIA } from './containerMedia';
import type { EthereumWallet } from './useEthereum111k';
import type { EthereumMintQuote } from './discounts';

type EthereumMintActionOptions = {
  wallet: EthereumWallet;
  config?: Pick<Ethereum111kConfig, 'enabled' | 'chainId' | 'contractAddress'>;
  kind: EthereumMintKind;
  quantity: number;
  remaining: number | undefined;
  saleActive: boolean | undefined;
  loadError?: string | null;
  blocked: boolean;
  suspended: boolean;
  priceKey?: string;
  mintQuote?: (kind: EthereumMintKind, quantity: number) => EthereumMintQuote | null;
  onMint: (kind: EthereumMintKind, quantity: number, quote?: EthereumMintQuote) => Promise<boolean>;
};

type MintAttempt = {
  kind: EthereumMintKind;
  quantity: number;
  config: { chainId: number; contractAddress: string } | null;
  wallet: { address: string; provider: NonNullable<EthereumWallet['provider']> } | null;
  connectionStarted: boolean;
  stage: 'connecting' | 'minting';
  quote: EthereumMintQuote | null;
  priceKey: string | null;
};

export function useEthereumMintAction(options: EthereumMintActionOptions) {
  const latest = useRef(options);
  latest.current = options;
  const mounted = useRef(false);
  const active = useRef<MintAttempt | null>(null);
  const [stage, setStage] = useState<MintAttempt['stage'] | null>(null);
  const [error, setError] = useState<{ message: string; loadError: boolean } | null>(null);

  useEffect(() => {
    setError(current => current?.loadError && current.message !== options.loadError ? null : current);
  }, [options.loadError]);

  const release = useCallback((attempt: MintAttempt) => {
    if (active.current !== attempt) return;
    active.current = null;
    if (mounted.current) setStage(null);
  }, []);

  const cancel = useCallback(() => {
    const attempt = active.current;
    if (!attempt || attempt.stage === 'minting') return;
    release(attempt);
    if (attempt.connectionStarted && !attempt.wallet) latest.current.wallet.cancel();
  }, [release]);

  const advance = useCallback((attempt: MintAttempt) => {
    if (!mounted.current || active.current !== attempt || attempt.stage !== 'connecting') return;
    const current = latest.current;
    const fail = (message: string, loadError = false) => { setError({ message, loadError }); cancel(); };
    if (current.suspended || current.blocked || current.kind !== attempt.kind) {
      cancel();
      return;
    }
    if (current.loadError) {
      fail(current.loadError, true);
      return;
    }
    if (current.priceKey !== undefined) {
      if (attempt.priceKey !== null && current.priceKey !== attempt.priceKey) {
        fail('Your mint terms changed. Check the updated price and try again.');
        return;
      }
      attempt.priceKey ??= current.priceKey;
    }
    if (current.config) {
      if (attempt.config && (current.config.chainId !== attempt.config.chainId ||
        current.config.contractAddress !== attempt.config.contractAddress)) {
        fail('This drop changed. Please try minting again.');
        return;
      }
      if (!current.config.enabled || !current.config.contractAddress) {
        fail('Minting is unavailable for this drop.');
        return;
      }
      attempt.config ??= { chainId: current.config.chainId, contractAddress: current.config.contractAddress };
    }
    if (current.saleActive === false) {
      fail('Minting is paused.');
      return;
    }
    if (current.remaining !== undefined && current.remaining < attempt.quantity) {
      fail(current.remaining <= 0
        ? `${ETHEREUM_CONTAINER_MEDIA[attempt.kind].pluralLabel} are sold out.`
        : `That quantity is no longer available. Choose fewer ${ETHEREUM_CONTAINER_MEDIA[attempt.kind].pluralLabel.toLowerCase()}.`);
      return;
    }
    const wallet = current.wallet;
    if (attempt.wallet && (wallet.address !== attempt.wallet.address || wallet.provider !== attempt.wallet.provider ||
      wallet.status === 'disconnected')) {
      fail('Your Ethereum wallet changed. Please try minting again.');
      return;
    }
    if (wallet.status === 'connected' && wallet.address && wallet.provider) {
      attempt.wallet ??= { address: wallet.address, provider: wallet.provider };
    } else if (wallet.status === 'connecting' || wallet.status === 'choosing') {
      attempt.connectionStarted = true;
    }
    if (!wallet.ready || wallet.status === 'restoring') return;
    if (wallet.status === 'disconnected') {
      if (attempt.connectionStarted) {
        fail(wallet.error ?? 'Wallet connection was cancelled. Try again when you’re ready.');
      } else {
        attempt.connectionStarted = true;
        try {
          wallet.connect();
        } catch (cause) {
          fail(cause instanceof Error ? cause.message : 'Unable to connect your Ethereum wallet. Please try again.');
        }
      }
      return;
    }
    if (wallet.status !== 'connected' || !attempt.wallet || !current.config ||
      current.saleActive === undefined || current.remaining === undefined) return;
    attempt.quote ??= current.mintQuote?.(attempt.kind, attempt.quantity) ?? null;
    if (current.mintQuote && !attempt.quote) return;
    attempt.stage = 'minting';
    setStage('minting');
    try {
      void latest.current.onMint(attempt.kind, attempt.quantity, attempt.quote ?? undefined).then(() => release(attempt), () => release(attempt));
    } catch {
      release(attempt);
    }
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

  useEffect(() => {
    const attempt = active.current;
    if (attempt) advance(attempt);
  });

  const mint = useCallback(() => {
    const current = latest.current;
    if (!mounted.current || active.current || current.blocked || current.suspended) return;
    setError(null);
    if (!Number.isInteger(current.quantity) || current.quantity < 1) {
      setError({ message: 'Choose a whole-number quantity of at least 1.', loadError: false });
      return;
    }
    const attempt: MintAttempt = {
      kind: current.kind,
      quantity: current.quantity,
      config: null,
      wallet: null,
      connectionStarted: false,
      stage: 'connecting',
      quote: current.wallet.status === 'connected' ? current.mintQuote?.(current.kind, current.quantity) ?? null : null,
      priceKey: current.priceKey ?? null,
    };
    active.current = attempt;
    setStage('connecting');
    advance(attempt);
  }, [advance]);

  const clearError = useCallback(() => setError(null), []);
  return { mint, cancel, connecting: stage === 'connecting', pending: stage !== null,
    error: error && (!error.loadError || error.message === options.loadError) ? error.message : null, clearError };
}
