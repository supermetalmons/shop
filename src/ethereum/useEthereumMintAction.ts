import { useCallback, useEffect, useRef, useState } from 'react';
import type { Ethereum111kConfig } from '../../shared/ethereum/config';
import type { EthereumWallet } from './useEthereum111k';

type EthereumMintActionOptions = {
  wallet: EthereumWallet;
  config: Pick<Ethereum111kConfig, 'enabled' | 'chainId' | 'contractAddress'>;
  quantity: number;
  remaining: number | undefined;
  saleActive: boolean | undefined;
  blocked: boolean;
  suspended: boolean;
  onMint: (quantity: number) => Promise<boolean>;
};

type MintAttempt = {
  quantity: number;
  chainId: number;
  contractAddress: string;
  stage: 'connecting' | 'minting';
};

export function useEthereumMintAction(options: EthereumMintActionOptions) {
  const latest = useRef(options);
  latest.current = options;
  const mounted = useRef(false);
  const active = useRef<MintAttempt | null>(null);
  const [stage, setStage] = useState<MintAttempt['stage'] | null>(null);

  const release = useCallback((attempt: MintAttempt) => {
    if (active.current !== attempt) return;
    active.current = null;
    if (mounted.current) setStage(null);
  }, []);

  const cancel = useCallback(() => {
    const attempt = active.current;
    if (!attempt || attempt.stage === 'minting') return;
    release(attempt);
    latest.current.wallet.cancel();
  }, [release]);

  const execute = useCallback((attempt: MintAttempt) => {
    if (!mounted.current || active.current !== attempt || attempt.stage !== 'connecting') return;
    attempt.stage = 'minting';
    setStage('minting');
    try {
      void latest.current.onMint(attempt.quantity).then(() => release(attempt), () => release(attempt));
    } catch {
      release(attempt);
    }
  }, [release]);

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
    if (!attempt || attempt.stage !== 'connecting') return;
    const current = latest.current;
    if (current.suspended || current.blocked || !current.config.enabled ||
      current.config.chainId !== attempt.chainId || current.config.contractAddress !== attempt.contractAddress ||
      !current.saleActive || current.remaining === undefined || current.remaining < attempt.quantity ||
      current.wallet.error || current.wallet.status === 'disconnected' || current.wallet.status === 'restoring') {
      cancel();
      return;
    }
    if (current.wallet.status === 'connected' && current.wallet.address && current.wallet.provider && current.wallet.ready) {
      execute(attempt);
    }
  });

  const mint = useCallback(() => {
    const current = latest.current;
    if (!mounted.current || active.current || current.blocked || current.suspended ||
      !current.config.enabled || !current.config.contractAddress || !current.saleActive ||
      !Number.isInteger(current.quantity) || current.quantity < 1 ||
      current.remaining === undefined || current.remaining < current.quantity || !current.wallet.ready ||
      !['connected', 'disconnected'].includes(current.wallet.status)) return;
    const attempt: MintAttempt = {
      quantity: current.quantity,
      chainId: current.config.chainId,
      contractAddress: current.config.contractAddress,
      stage: 'connecting',
    };
    active.current = attempt;
    if (current.wallet.status === 'connected' && current.wallet.address && current.wallet.provider) {
      execute(attempt);
      return;
    }
    setStage('connecting');
    try {
      current.wallet.connect();
    } catch {
      cancel();
    }
  }, [cancel, execute]);

  return { mint, cancel, connecting: stage === 'connecting', pending: stage !== null };
}
