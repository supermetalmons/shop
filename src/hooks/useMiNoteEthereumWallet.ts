import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { normalizeMiNoteAddress } from '../../shared/miNoteCards.ts';
import {
  getLegacyInjectedProvider,
  listInjectedEthereumProviders,
  primeInjectedEthereumProviderDiscovery,
  subscribeInjectedEthereumProviders,
  type EIP6963ProviderDetail,
  type EthereumProviderListener,
  type EIP1193Provider,
} from '../wallet/injectedEthereumProviders';

const WALLET_STORAGE_KEY = 'mons.shop.mi-note.ethereum-wallet';

type RememberedWallet = { type: 'announced'; rdns: string } | { type: 'legacy' };
export type MiNoteEthereumWalletStatus = 'disconnected' | 'restoring' | 'connecting' | 'choosing' | 'connected';
type WalletState = {
  address: string | null;
  provider: EIP1193Provider | null;
  status: MiNoteEthereumWalletStatus;
  wallets: EIP6963ProviderDetail[];
  error: string | null;
};
type WalletSession = {
  remembered: RememberedWallet | null;
  established: boolean;
  revision: number;
  cleanup: () => void;
  applyAccounts: (accounts: unknown, showEmptyError: boolean) => void;
};

const disconnectedState: WalletState = { address: null, provider: null, status: 'disconnected', wallets: [], error: null };

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

const accountSwitchInstruction = 'Select another account in your wallet, then choose Check account.';

function accountChangeError(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
  if (code === 4001) return 'Account change was cancelled. Your current wallet is still connected.';
  if (code === -32002) return 'A request is already open. Check your Ethereum wallet, then choose Check account.';
  if (code === 4200 || code === -32601) return `This wallet cannot open an account selector here. ${accountSwitchInstruction}`;
  return `Unable to check your Ethereum account. ${accountSwitchInstruction}`;
}

function legacyWallet(): EIP6963ProviderDetail | null {
  const provider = getLegacyInjectedProvider();
  return provider ? { info: { uuid: 'legacy', name: 'Ethereum wallet', icon: '', rdns: '' }, provider } : null;
}

export function useMiNoteEthereumWallet(active: boolean) {
  const activationScope = useMemo(() => ({ active }), [active]);
  const [initializedScope, setInitializedScope] = useState<typeof activationScope | null>(null);
  const [state, setState] = useState<WalletState>(disconnectedState);
  const stateRef = useRef(state);
  const activeRef = useRef(active);
  const mounted = useRef(false);
  const operation = useRef(0);
  const sessionRef = useRef<WalletSession | null>(null);
  const pendingSessionRef = useRef<WalletSession | null>(null);
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

  const releasePendingSession = useCallback(() => {
    const session = pendingSessionRef.current;
    pendingSessionRef.current = null;
    session?.cleanup();
  }, []);

  const cancel = useCallback(() => {
    operation.current += 1;
    releasePendingSession();
    const session = sessionRef.current;
    if (session?.established) {
      if (stateRef.current.status === 'connecting' || stateRef.current.status === 'choosing') {
        session.revision += 1;
        update({ ...stateRef.current, status: 'connected', wallets: [], error: null });
      }
      return;
    }
    releaseSession();
    update(disconnectedState);
  }, [releasePendingSession, releaseSession, update]);

  const disconnect = useCallback(() => {
    operation.current += 1;
    releasePendingSession();
    releaseSession();
    rememberWallet(null);
    update(disconnectedState);
  }, [releasePendingSession, releaseSession, update]);

  const readWallet = useCallback((provider: EIP1193Provider, remembered: RememberedWallet | null, interactive: boolean, preserveEstablished = false) => {
    const established = sessionRef.current?.established === true && stateRef.current.provider === provider;
    releasePendingSession();
    const replacing = preserveEstablished && sessionRef.current?.established === true;
    const session: WalletSession = { remembered, established, revision: 0, cleanup: () => {}, applyAccounts: () => {} };
    if (replacing) pendingSessionRef.current = session;
    else {
      releaseSession();
      sessionRef.current = session;
    }
    const current = () => mounted.current && (sessionRef.current === session && (session.established || activeRef.current) ||
      pendingSessionRef.current === session && activeRef.current);
    const restoreEstablished = (error: string | null) => {
      const connected = Boolean(sessionRef.current?.established && stateRef.current.address && stateRef.current.provider);
      update({ ...(connected ? stateRef.current : disconnectedState), status: connected ? 'connected' : 'disconnected', wallets: [], error });
    };
    const disconnectSession = () => {
      if (sessionRef.current === session && pendingSessionRef.current) {
        releaseSession();
        rememberWallet(null);
        update({ ...disconnectedState, status: 'connecting' });
      } else disconnect();
    };
    const applyAccounts = (accounts: unknown, showEmptyError: boolean) => {
      if (!current()) return;
      const address = firstAccount(accounts);
      if (!address) {
        if (pendingSessionRef.current === session) {
          releasePendingSession();
          restoreEstablished(showEmptyError ? 'No Ethereum account is available. Unlock your wallet and try again.' : null);
          return;
        }
        disconnectSession();
        if (showEmptyError) update({ ...stateRef.current, error: 'No Ethereum account is available. Unlock your wallet and try again.' });
        return;
      }
      if (pendingSessionRef.current === session) {
        pendingSessionRef.current = null;
        releaseSession();
        sessionRef.current = session;
      }
      session.established = true;
      rememberWallet(session.remembered);
      const choosing = stateRef.current.status === 'choosing';
      update({ address, provider, status: choosing ? 'choosing' : pendingSessionRef.current ? 'connecting' : 'connected',
        wallets: choosing ? stateRef.current.wallets : [], error: null });
    };
    session.applyAccounts = applyAccounts;
    const fail = (error: unknown, showError: boolean) => {
      if (!current()) return;
      if (pendingSessionRef.current === session) {
        releasePendingSession();
        restoreEstablished(showError ? connectionError(error) : null);
        return;
      }
      releaseSession();
      update({ ...disconnectedState, status: pendingSessionRef.current ? 'connecting' : 'disconnected',
        error: showError ? connectionError(error) : null });
    };
    const readAccounts = async (method: 'eth_accounts' | 'eth_requestAccounts', showError: boolean) => {
      const revision = ++session.revision;
      try {
        const accounts = await provider.request({ method });
        if (current() && session.revision === revision) applyAccounts(accounts, showError);
      } catch (error) {
        if (current() && session.revision === revision) fail(error, showError);
      }
    };
    const accountsChanged: EthereumProviderListener = (accounts) => {
      session.revision += 1;
      applyAccounts(accounts, false);
    };
    const disconnected: EthereumProviderListener = () => {
      if (!current()) return;
      if (pendingSessionRef.current === session) fail(new Error('Disconnected'), true);
      else disconnectSession();
    };
    const chainChanged: EthereumProviderListener = () => {
      if (current() && (session.established || !interactive)) void readAccounts('eth_accounts', false);
    };
    const listeners = [
      ['accountsChanged', accountsChanged], ['disconnect', disconnected], ['chainChanged', chainChanged],
    ] as const;
    session.cleanup = () => {
      for (const [event, listener] of listeners) {
        try { provider.removeListener?.(event, listener); } catch {}
      }
    };
    try {
      if (provider.on && provider.removeListener) {
        for (const [event, listener] of listeners) provider.on(event, listener);
      }
      void readAccounts(interactive ? 'eth_requestAccounts' : 'eth_accounts', interactive);
    } catch (error) {
      fail(error, interactive);
    }
  }, [disconnect, releasePendingSession, releaseSession, update]);

  const chooseWallet = useCallback(() => {
    if (!mounted.current || !activeRef.current || !['connected', 'disconnected'].includes(stateRef.current.status)) return;
    const attempt = ++operation.current;
    update({ ...stateRef.current, status: 'choosing', wallets: [], error: null });
    void listInjectedEthereumProviders().then(wallets => {
      if (!mounted.current || !activeRef.current || operation.current !== attempt) return;
      const fallback = wallets.length ? null : legacyWallet();
      const choices = fallback ? [fallback] : wallets;
      if (choices.length) update({ ...stateRef.current, status: 'choosing', wallets: choices });
      else update({ ...stateRef.current, status: sessionRef.current?.established ? 'connected' : 'disconnected',
        error: 'No Ethereum wallet found. Install a wallet extension or open this page in your wallet’s browser.' });
    }).catch((error: unknown) => {
      if (mounted.current && activeRef.current && operation.current === attempt) {
        update({ ...stateRef.current, status: sessionRef.current?.established ? 'connected' : 'disconnected', wallets: [], error: connectionError(error) });
      }
    });
  }, [update]);

  const requestAccount = useCallback((permissions: boolean) => {
    const wallet = stateRef.current;
    const session = sessionRef.current;
    if (!mounted.current || !activeRef.current || wallet.status !== 'connected' || !wallet.provider || !session?.established) return;
    const provider = wallet.provider;
    const attempt = ++operation.current;
    let revision = session.revision;
    const current = () => mounted.current && activeRef.current && operation.current === attempt &&
      sessionRef.current === session && stateRef.current.provider === provider;
    update({ ...wallet, status: 'connecting', error: null });
    void (async () => {
      try {
        if (permissions) {
          await provider.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] });
          if (!current()) return;
        }
        revision = ++session.revision;
        const accounts = await provider.request({ method: 'eth_accounts' });
        if (!current() || session.revision !== revision) return;
        session.applyAccounts(accounts, true);
        if (current() && firstAccount(accounts) === wallet.address) {
          update({ ...stateRef.current, error: `Your wallet is still using the same account. ${accountSwitchInstruction}` });
        }
      } catch (error) {
        if (current() && session.revision === revision) update({ ...stateRef.current, status: 'connected', error: accountChangeError(error) });
      }
    })();
  }, [update]);

  const changeAccount = useCallback(() => requestAccount(true), [requestAccount]);
  const checkAccount = useCallback(() => requestAccount(false), [requestAccount]);

  const connect = useCallback(() => {
    if (!mounted.current || !activeRef.current) return;
    const current = stateRef.current;
    if (current.status === 'connected' && current.provider) {
      update({ ...current, status: 'connecting', error: null });
      readWallet(current.provider, sessionRef.current?.remembered ?? null, false);
      return;
    }
    if (current.status !== 'disconnected') return;
    const attempt = ++operation.current;
    update({ ...disconnectedState, status: 'connecting' });
    void listInjectedEthereumProviders().then((wallets) => {
      if (!mounted.current || !activeRef.current || operation.current !== attempt) return;
      if (wallets.length > 1) {
        update({ ...disconnectedState, status: 'choosing', wallets });
      } else if (wallets.length === 1) {
        const wallet = wallets[0];
        readWallet(wallet.provider, wallet.info.rdns ? { type: 'announced', rdns: wallet.info.rdns } : null, true);
      } else {
        const wallet = legacyWallet();
        if (wallet) readWallet(wallet.provider, { type: 'legacy' }, true);
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
    update({ ...stateRef.current, status: 'connecting', wallets: [], error: null });
    readWallet(wallet.provider, wallet.info.rdns ? { type: 'announced', rdns: wallet.info.rdns } :
      wallet.info.uuid === 'legacy' ? { type: 'legacy' } : null, true, true);
  }, [readWallet, update]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      operation.current += 1;
      releasePendingSession();
      releaseSession();
    };
  }, [releasePendingSession, releaseSession]);

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
          if (wallet) readWallet(wallet.provider, remembered, false);
          else update(disconnectedState);
        }).catch(() => {
          if (mounted.current && activeRef.current && operation.current === attempt) update(disconnectedState);
        });
      }
    }
    setInitializedScope(activationScope);
    return unsubscribe;
  }, [active, activationScope, cancel, readWallet, update]);

  const ready = state.status !== 'restoring' && (sessionRef.current?.established === true || initializedScope === activationScope);
  return { ...state, ready, connect, chooseWallet, changeAccount, checkAccount, selectWallet, cancel, disconnect };
}
