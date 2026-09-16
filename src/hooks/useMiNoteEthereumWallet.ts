import { useCallback, useEffect, useRef, useState } from 'react';
import { normalizeMiNoteAddress } from '../../shared/miNoteCards.ts';
import {
  getLegacyInjectedProvider,
  listInjectedEthereumProviders,
  primeInjectedEthereumProviderDiscovery,
  subscribeInjectedEthereumProviders,
  type EIP6963ProviderDetail,
  type EthereumProviderListener,
} from '../wallet/injectedEthereumProviders';

const WALLET_STORAGE_KEY = 'mons.shop.mi-note.ethereum-wallet';

type RememberedWallet = { type: 'announced'; rdns: string } | { type: 'legacy' };
export type MiNoteEthereumWalletStatus = 'disconnected' | 'restoring' | 'connecting' | 'choosing' | 'connected';
type WalletState = {
  address: string | null;
  status: MiNoteEthereumWalletStatus;
  wallets: EIP6963ProviderDetail[];
  error: string | null;
};
type WalletSession = {
  remembered: RememberedWallet | null;
  established: boolean;
  revision: number;
  cleanup: () => void;
};

const disconnectedState: WalletState = { address: null, status: 'disconnected', wallets: [], error: null };

function readRememberedWallet(): RememberedWallet | null {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(WALLET_STORAGE_KEY) ?? 'null');
    if (!value || typeof value !== 'object' || !('type' in value)) return null;
    if (value.type === 'legacy') return { type: 'legacy' };
    if (value.type === 'announced' && 'rdns' in value && typeof value.rdns === 'string' && value.rdns) {
      return { type: 'announced', rdns: value.rdns };
    }
  } catch {}
  return null;
}

function rememberWallet(wallet: RememberedWallet | null): void {
  try {
    if (wallet) window.localStorage.setItem(WALLET_STORAGE_KEY, JSON.stringify(wallet));
    else window.localStorage.removeItem(WALLET_STORAGE_KEY);
  } catch {}
}

function firstAccount(accounts: unknown): string | null {
  return Array.isArray(accounts) ? normalizeMiNoteAddress(accounts[0]) : null;
}

function connectionError(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
  if (code === 4001) return 'Wallet connection was cancelled. Try again when you’re ready.';
  if (code === -32002) return 'A connection request is already open. Check your Ethereum wallet.';
  return 'Unable to connect your Ethereum wallet. Please try again.';
}

function legacyWallet(): EIP6963ProviderDetail | null {
  const provider = getLegacyInjectedProvider();
  return provider ? { info: { uuid: 'legacy', name: 'Ethereum wallet', icon: '', rdns: '' }, provider } : null;
}

export function useMiNoteEthereumWallet(active: boolean) {
  const [state, setState] = useState<WalletState>(disconnectedState);
  const stateRef = useRef(state);
  const activeRef = useRef(active);
  const mounted = useRef(false);
  const operation = useRef(0);
  const sessionRef = useRef<WalletSession | null>(null);
  activeRef.current = active;

  const update = useCallback((next: WalletState) => {
    stateRef.current = next;
    if (mounted.current) setState(next);
  }, []);

  const releaseSession = useCallback(() => {
    const session = sessionRef.current;
    sessionRef.current = null;
    session?.cleanup();
  }, []);

  const cancel = useCallback(() => {
    operation.current += 1;
    if (sessionRef.current?.established) return;
    releaseSession();
    update(disconnectedState);
  }, [releaseSession, update]);

  const disconnect = useCallback(() => {
    operation.current += 1;
    releaseSession();
    rememberWallet(null);
    update(disconnectedState);
  }, [releaseSession, update]);

  const readWallet = useCallback((wallet: EIP6963ProviderDetail, remembered: RememberedWallet | null, interactive: boolean) => {
    releaseSession();
    const session: WalletSession = { remembered, established: false, revision: 0, cleanup: () => {} };
    sessionRef.current = session;
    const current = () => mounted.current && sessionRef.current === session && (session.established || activeRef.current);
    const applyAccounts = (accounts: unknown, showEmptyError: boolean) => {
      if (!current()) return;
      const address = firstAccount(accounts);
      if (!address) {
        disconnect();
        if (showEmptyError) update({ ...disconnectedState, error: 'No Ethereum account is available. Unlock your wallet and try again.' });
        return;
      }
      session.established = true;
      rememberWallet(session.remembered);
      update({ address, status: 'connected', wallets: [], error: null });
    };
    const fail = (error: unknown, showError: boolean) => {
      if (!current()) return;
      releaseSession();
      update({ ...disconnectedState, error: showError ? connectionError(error) : null });
    };
    const readAccounts = async (method: 'eth_accounts' | 'eth_requestAccounts', showError: boolean) => {
      const revision = ++session.revision;
      try {
        const accounts = await wallet.provider.request({ method });
        if (current() && session.revision === revision) applyAccounts(accounts, showError);
      } catch (error) {
        if (current() && session.revision === revision) fail(error, showError);
      }
    };
    const accountsChanged: EthereumProviderListener = (accounts) => {
      session.revision += 1;
      applyAccounts(accounts, false);
    };
    const disconnected: EthereumProviderListener = () => { if (current()) disconnect(); };
    const chainChanged: EthereumProviderListener = () => {
      if (current() && (session.established || !interactive)) void readAccounts('eth_accounts', false);
    };
    const listeners = [
      ['accountsChanged', accountsChanged], ['disconnect', disconnected], ['chainChanged', chainChanged],
    ] as const;
    session.cleanup = () => {
      for (const [event, listener] of listeners) {
        try { wallet.provider.removeListener?.(event, listener); } catch {}
      }
    };
    try {
      if (wallet.provider.on && wallet.provider.removeListener) {
        for (const [event, listener] of listeners) wallet.provider.on(event, listener);
      }
      void readAccounts(interactive ? 'eth_requestAccounts' : 'eth_accounts', interactive);
    } catch (error) {
      fail(error, interactive);
    }
  }, [disconnect, releaseSession, update]);

  const connect = useCallback(() => {
    if (!mounted.current || !activeRef.current || stateRef.current.status !== 'disconnected') return;
    const attempt = ++operation.current;
    update({ ...disconnectedState, status: 'connecting' });
    void listInjectedEthereumProviders().then((wallets) => {
      if (!mounted.current || !activeRef.current || operation.current !== attempt) return;
      if (wallets.length > 1) {
        update({ ...disconnectedState, status: 'choosing', wallets });
      } else if (wallets.length === 1) {
        const wallet = wallets[0];
        readWallet(wallet, wallet.info.rdns ? { type: 'announced', rdns: wallet.info.rdns } : null, true);
      } else {
        const wallet = legacyWallet();
        if (wallet) readWallet(wallet, { type: 'legacy' }, true);
        else update({ ...disconnectedState, error: 'No Ethereum wallet found. Install a wallet extension or open this page in your wallet’s browser.' });
      }
    }).catch((error: unknown) => {
      if (mounted.current && activeRef.current && operation.current === attempt) {
        update({ ...disconnectedState, error: connectionError(error) });
      }
    });
  }, [readWallet, update]);

  const selectWallet = useCallback((wallet: EIP6963ProviderDetail) => {
    if (!mounted.current || !activeRef.current || stateRef.current.status !== 'choosing') return;
    if (!stateRef.current.wallets.includes(wallet)) return;
    operation.current += 1;
    update({ ...disconnectedState, status: 'connecting' });
    readWallet(wallet, wallet.info.rdns ? { type: 'announced', rdns: wallet.info.rdns } : null, true);
  }, [readWallet, update]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      operation.current += 1;
      releaseSession();
    };
  }, [releaseSession]);

  useEffect(() => {
    if (!active) {
      cancel();
      return;
    }
    const unsubscribe = subscribeInjectedEthereumProviders((wallets) => {
      if (stateRef.current.status === 'choosing') update({ ...stateRef.current, wallets });
    });
    primeInjectedEthereumProviderDiscovery();
    if (!sessionRef.current?.established) {
      const remembered = readRememberedWallet();
      if (remembered) {
        const attempt = ++operation.current;
        update({ ...disconnectedState, status: 'restoring' });
        void listInjectedEthereumProviders().then((wallets) => {
          if (!mounted.current || !activeRef.current || operation.current !== attempt) return;
          const matches = remembered.type === 'announced'
            ? wallets.filter((wallet) => wallet.info.rdns === remembered.rdns)
            : [];
          const wallet = remembered.type === 'legacy' && wallets.length === 0
            ? legacyWallet()
            : matches.length === 1 ? matches[0] : null;
          if (wallet) readWallet(wallet, remembered, false);
          else update(disconnectedState);
        }).catch(() => {
          if (mounted.current && activeRef.current && operation.current === attempt) update(disconnectedState);
        });
      }
    }
    return unsubscribe;
  }, [active, cancel, readWallet, update]);

  return { ...state, connect, selectWallet, cancel, disconnect };
}
