import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { WalletContextState } from '@solana/wallet-adapter-react';
import type { useSolanaAuth } from '../../hooks/useSolanaAuth';
import { readStaffWalletSession, subscribeStaffWalletSession } from '../../lib/staffWalletSession';
import { useMainnetSolBalance } from './useMainnetSolBalance';

type HeaderWalletOptions = {
  auth: Pick<ReturnType<typeof useSolanaAuth>,
    'authenticated' | 'sessionWallet' | 'sessionResolution' | 'error' | 'refreshProfileState' |
    'signOut' | 'intentCancellationSignal'>;
  wallet: Pick<WalletContextState,
    'connected' | 'connecting' | 'disconnecting' | 'publicKey' | 'wallet' | 'disconnect'>;
  signIn: (request?: { signal?: AbortSignal }) => Promise<boolean>;
  joinPendingSignIn?: (request?: { signal?: AbortSignal }) => Promise<boolean> | null;
  signInPending?: boolean;
  mutationPending?: boolean;
  suspended?: boolean;
  walletModalVisible?: boolean;
  scopeKey?: string;
  onBeforeOpen?: () => void;
  onBeforeDisconnect?: () => void;
  onDisconnectingChange?: (disconnecting: boolean) => void;
  showToast: (message: string) => void;
};

export type HeaderWallet = {
  address: string | undefined;
  open: boolean;
  status: 'loading' | 'connecting' | 'signing-in' | 'account' | 'error';
  loadingError: string | null;
  buttonDisabled: boolean;
  disconnectDisabled: boolean;
  disconnecting: boolean;
  disconnectError: string | null;
  balanceLamports: number | undefined;
  balanceLoading: boolean;
  balanceError: boolean;
  activate: () => Promise<void>;
  close: () => void;
  disconnect: () => Promise<void>;
  retryBalance: () => void;
  retryLoading: () => void;
};

type OpenIntent = {
  controller: AbortController;
  signal: AbortSignal;
  scopeKey: string | undefined;
  signInCompleted: boolean;
  ownsPicker: boolean;
  observedExternalSignIn: boolean;
};

type DisconnectAttempt = {
  address: string;
  balanceLamports: number | undefined;
  sessionPending: boolean;
  walletPending: boolean;
  adapter: WalletContextState['wallet'];
  connectedAddress: string | undefined;
  disconnectWallet: () => Promise<void>;
  intentSignal: AbortSignal;
  startingSignOut: boolean;
  expectedWalletDisconnect: boolean;
  acceptNextIntent: boolean;
  staffSessionToken: string | null;
};

export function useHeaderWallet(options: HeaderWalletOptions): HeaderWallet {
  const latest = useRef(options);
  latest.current = options;
  const mounted = useRef(false);
  const [open, setOpenState] = useState(false);
  const openRef = useRef(false);
  const openIntent = useRef<OpenIntent | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);
  const signInFlight = useRef<OpenIntent | null>(null);
  const retryFlight = useRef<Promise<void> | null>(null);
  const disconnectFlight = useRef<Promise<void> | null>(null);
  const disconnectAttempt = useRef<DisconnectAttempt | null>(null);
  const authenticatedAddress = options.auth.authenticated ? options.auth.sessionWallet || undefined : undefined;
  const validatedAddress = options.auth.sessionResolution === 'settled' ? authenticatedAddress : undefined;
  const connectedAddress = options.wallet.connected ? options.wallet.publicKey?.toBase58() : undefined;
  const address = disconnectAttempt.current?.address ?? validatedAddress;
  const balance = useMainnetSolBalance(validatedAddress,
    open && !options.suspended && !options.walletModalVisible && !disconnectAttempt.current);
  const balanceRef = useRef(balance);
  balanceRef.current = balance;

  const setOpen = useCallback((value: boolean) => {
    openRef.current = value;
    setOpenState(value);
  }, []);

  const cancelOpenIntent = useCallback(() => {
    const intent = openIntent.current;
    openIntent.current = null;
    intent?.controller.abort();
  }, []);

  const close = useCallback(() => {
    cancelOpenIntent();
    retryFlight.current = null;
    setOpen(false);
    setRetrying(false);
    setRetryError(null);
  }, [cancelOpenIntent, setOpen]);

  useEffect(() => {
    mounted.current = true;
    window.addEventListener('pagehide', close);
    return () => {
      mounted.current = false;
      openRef.current = false;
      cancelOpenIntent();
      window.removeEventListener('pagehide', close);
    };
  }, [cancelOpenIntent, close]);

  const isCurrentIntent = useCallback((intent: OpenIntent) => mounted.current &&
    openIntent.current === intent && openRef.current && !intent.controller.signal.aborted &&
    intent.signal === latest.current.auth.intentCancellationSignal && !intent.signal.aborted &&
    intent.scopeKey === latest.current.scopeKey && !latest.current.suspended, []);

  const discardReplacedStaffSession = useCallback(() => {
    const attempt = disconnectAttempt.current;
    const token = readStaffWalletSession()?.token;
    if (!attempt || !token || token === attempt.staffSessionToken) return false;
    disconnectAttempt.current = null;
    if (mounted.current) {
      setDisconnectError(null);
      close();
    }
    return true;
  }, [close]);

  useEffect(() => subscribeStaffWalletSession(discardReplacedStaffSession), [discardReplacedStaffSession]);

  const adapter = options.wallet.wallet?.adapter;
  const previousIdentity = useRef({ authenticatedAddress, connectedAddress, adapter });
  useLayoutEffect(() => {
    const previous = previousIdentity.current;
    previousIdentity.current = { authenticatedAddress, connectedAddress, adapter };
    if (previous.authenticatedAddress === authenticatedAddress && previous.connectedAddress === connectedAddress && previous.adapter === adapter) return;
    const attempt = disconnectAttempt.current;
    if (attempt &&
      (!authenticatedAddress || (attempt.sessionPending && authenticatedAddress === attempt.address)) &&
      (!connectedAddress || connectedAddress === attempt.connectedAddress) &&
      (!adapter || adapter === attempt.adapter?.adapter)) return;
    disconnectAttempt.current = null;
    setDisconnectError(null);
    const intent = openIntent.current;
    if (!attempt && intent && isCurrentIntent(intent) &&
      (!previous.authenticatedAddress || previous.authenticatedAddress === authenticatedAddress) &&
      (!previous.connectedAddress || previous.connectedAddress === connectedAddress) &&
      (!previous.adapter || previous.adapter === adapter || !previous.connectedAddress && !previous.authenticatedAddress) &&
      (!authenticatedAddress || !connectedAddress || authenticatedAddress === connectedAddress)) return;
    close();
  }, [adapter, authenticatedAddress, close, connectedAddress, isCurrentIntent]);

  useLayoutEffect(() => {
    const signal = options.auth.intentCancellationSignal;
    const invalidateAttempt = () => {
      disconnectAttempt.current = null;
      setDisconnectError(null);
      close();
    };
    const attempt = disconnectAttempt.current;
    if (attempt && attempt.intentSignal !== signal) {
      if (attempt.acceptNextIntent) {
        attempt.intentSignal = signal;
        attempt.acceptNextIntent = false;
      } else {
        invalidateAttempt();
      }
    }
    if (openIntent.current && openIntent.current.signal !== signal) close();
    const onAbort = () => {
      const operation = disconnectAttempt.current;
      if (!operation || operation.intentSignal !== signal) {
        close();
        return;
      }
      if (operation.startingSignOut) {
        operation.acceptNextIntent = true;
      } else if (operation.expectedWalletDisconnect && !latest.current.wallet.connected &&
        previousIdentity.current.connectedAddress === operation.connectedAddress) {
        operation.expectedWalletDisconnect = false;
        operation.acceptNextIntent = true;
      } else {
        invalidateAttempt();
      }
    };
    signal.addEventListener('abort', onAbort);
    return () => signal.removeEventListener('abort', onAbort);
  }, [close, options.auth.intentCancellationSignal]);

  useLayoutEffect(() => { close(); }, [close, options.scopeKey]);
  useLayoutEffect(() => {
    const intent = openIntent.current;
    if (options.suspended || options.walletModalVisible && (!intent?.ownsPicker || intent.signInCompleted)) close();
  }, [close, options.suspended, options.walletModalVisible]);

  const activate = useCallback(async () => {
    const current = latest.current;
    if (!mounted.current || current.suspended || current.walletModalVisible) return;
    if (openRef.current) {
      close();
      return;
    }
    if (!disconnectAttempt.current) {
      openIntent.current = {
        controller: new AbortController(), signal: current.auth.intentCancellationSignal,
        scopeKey: current.scopeKey, signInCompleted: false,
        ownsPicker: false,
        observedExternalSignIn: Boolean(current.signInPending),
      };
    }
    setOpen(true);
    current.onBeforeOpen?.();
  }, [close, setOpen]);

  useEffect(() => {
    const intent = openIntent.current;
    if (!intent || !isCurrentIntent(intent) || options.walletModalVisible || signInFlight.current) return;
    if (validatedAddress) {
      if (retryError) setRetryError(null);
      return;
    }
    if (intent.signInCompleted) {
      close();
      return;
    }
    const pendingSignIn = options.joinPendingSignIn?.({ signal: intent.controller.signal });
    if (!pendingSignIn) {
      if (options.signInPending) intent.observedExternalSignIn = true;
      else if (intent.observedExternalSignIn) {
        close();
        return;
      }
      if (disconnectAttempt.current || disconnectFlight.current || options.wallet.connecting || options.wallet.disconnecting ||
        options.auth.sessionResolution !== 'settled' || options.signInPending || options.mutationPending) return;
    }
    intent.ownsPicker = !pendingSignIn;
    intent.observedExternalSignIn = false;
    signInFlight.current = intent;
    setSigningIn(true);
    void (async () => {
      try {
        const signedIn = await (pendingSignIn ?? latest.current.signIn({ signal: intent.controller.signal }));
        if (!isCurrentIntent(intent)) return;
        intent.signInCompleted = true;
        if (!signedIn) close();
      } catch (error) {
        if (!isCurrentIntent(intent)) return;
        latest.current.showToast(error instanceof Error ? error.message : 'Unable to sign in. Please try again.');
        close();
      } finally {
        if (signInFlight.current === intent) {
          signInFlight.current = null;
          if (mounted.current) setSigningIn(false);
        }
      }
    })();
  });

  const retryLoading = useCallback(() => {
    const intent = openIntent.current;
    if (!intent || !isCurrentIntent(intent) || retryFlight.current) return;
    setRetryError(null);
    setRetrying(true);
    const promise = (async () => {
      try {
        await latest.current.auth.refreshProfileState();
      } catch (error) {
        if (isCurrentIntent(intent)) {
          setRetryError(error instanceof Error ? error.message : 'Unable to load wallet. Please try again.');
        }
      }
    })().finally(() => {
      if (retryFlight.current === promise) retryFlight.current = null;
      if (mounted.current && openIntent.current === intent) setRetrying(false);
    });
    retryFlight.current = promise;
  }, [isCurrentIntent]);

  const disconnect = useCallback((): Promise<void> => {
    if (disconnectFlight.current) return disconnectFlight.current;
    if (discardReplacedStaffSession()) return Promise.resolve();
    const current = latest.current;
    if (current.suspended || current.walletModalVisible || current.mutationPending || current.wallet.connecting ||
      current.wallet.disconnecting || signInFlight.current || current.signInPending) {
      return Promise.resolve();
    }
    let attempt = disconnectAttempt.current;
    if (attempt && !attempt.sessionPending && current.auth.authenticated) {
      disconnectAttempt.current = null;
      attempt = null;
    }
    if (!attempt) {
      const accountAddress = current.auth.authenticated ? current.auth.sessionWallet : null;
      if (!accountAddress) return Promise.resolve();
      attempt = {
        address: accountAddress,
        balanceLamports: balanceRef.current.lamports,
        sessionPending: true,
        walletPending: Boolean(current.wallet.connected || current.wallet.wallet),
        adapter: current.wallet.wallet,
        connectedAddress: current.wallet.publicKey?.toBase58(),
        disconnectWallet: current.wallet.disconnect,
        intentSignal: current.auth.intentCancellationSignal,
        startingSignOut: false,
        expectedWalletDisconnect: false,
        acceptNextIntent: false,
        staffSessionToken: readStaffWalletSession()?.token ?? null,
      };
      disconnectAttempt.current = attempt;
    }
    const operation = attempt;
    cancelOpenIntent();
    setDisconnecting(true);
    current.onDisconnectingChange?.(true);
    setDisconnectError(null);
    setOpen(true);
    current.onBeforeDisconnect?.();

    const run = async () => {
      if (operation.sessionPending) {
        try {
          operation.startingSignOut = true;
          const signingOut = current.auth.signOut();
          operation.startingSignOut = false;
          await signingOut;
          operation.sessionPending = false;
        } catch {
          operation.startingSignOut = false;
        }
      }
      if (!mounted.current || discardReplacedStaffSession() || disconnectAttempt.current !== operation) return;
      if (operation.walletPending && latest.current.mutationPending) {
        setDisconnectError('A transaction is still running. Wait for it to finish, then retry disconnect.');
        return;
      }
      if (operation.walletPending) {
        const activeWallet = latest.current.wallet;
        const activeAddress = activeWallet.publicKey?.toBase58();
        const adapterAddress = operation.adapter?.adapter.publicKey?.toBase58();
        const changedWallet = activeWallet.wallet?.adapter !== operation.adapter?.adapter ||
          Boolean(activeAddress && operation.connectedAddress && activeAddress !== operation.connectedAddress) ||
          Boolean(adapterAddress && operation.connectedAddress && adapterAddress !== operation.connectedAddress);
        if (changedWallet) {
          operation.walletPending = false;
        } else {
          try {
            operation.expectedWalletDisconnect = true;
            await operation.disconnectWallet();
            operation.walletPending = false;
          } catch {}
        }
      }
      if (!mounted.current || disconnectAttempt.current !== operation) return;
      if (!operation.sessionPending && !operation.walletPending) {
        disconnectAttempt.current = null;
        setDisconnectError(null);
        close();
        return;
      }
      setDisconnectError(operation.sessionPending && operation.walletPending
        ? 'Could not sign out or disconnect the wallet. Please try again.'
        : operation.sessionPending
          ? 'Wallet disconnected, but the shop session could not be signed out. Please try again.'
          : 'Shop session signed out, but the wallet could not be disconnected. Please try again.');
    };
    const promise = run().finally(() => {
      if (disconnectFlight.current === promise) disconnectFlight.current = null;
      if (mounted.current) {
        setDisconnecting(false);
        latest.current.onDisconnectingChange?.(false);
      }
    });
    disconnectFlight.current = promise;
    return promise;
  }, [cancelOpenIntent, close, discardReplacedStaffSession, setOpen]);

  const loadingError = options.auth.sessionResolution !== 'settled' ? options.auth.error || retryError : null;
  const connecting = options.wallet.connecting || (signingIn || options.signInPending) && !connectedAddress;
  const status = address ? 'account'
    : connecting ? 'connecting'
      : signingIn || options.signInPending ? 'signing-in'
        : loadingError && !retrying ? 'error' : 'loading';

  return {
    address,
    open: Boolean(open && !options.suspended && !options.walletModalVisible),
    status,
    loadingError,
    buttonDisabled: Boolean(options.suspended || options.walletModalVisible),
    disconnectDisabled: Boolean(options.mutationPending || options.suspended || options.walletModalVisible || options.wallet.connecting ||
      options.wallet.disconnecting || options.signInPending || signingIn || disconnecting),
    disconnecting,
    disconnectError,
    balanceLamports: disconnectAttempt.current ? disconnectAttempt.current.balanceLamports : balance.lamports,
    balanceLoading: !disconnectAttempt.current && balance.loading,
    balanceError: !disconnectAttempt.current && balance.error,
    activate,
    close,
    disconnect,
    retryBalance: balance.retry,
    retryLoading,
  };
}
