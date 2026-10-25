import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { WalletContextState } from '@solana/wallet-adapter-react';
import type { useSolanaAuth } from '../../hooks/useSolanaAuth';
import { readStaffWalletSession, subscribeStaffWalletSession } from '../../lib/staffWalletSession';
import { useMainnetSolBalance } from './useMainnetSolBalance';

type HeaderWalletOptions = {
  auth: Pick<ReturnType<typeof useSolanaAuth>,
    'authenticated' | 'sessionWallet' | 'sessionResolution' | 'loading' | 'signOut' | 'intentCancellationSignal'>;
  wallet: Pick<WalletContextState,
    'connected' | 'connecting' | 'disconnecting' | 'publicKey' | 'wallet' | 'disconnect'>;
  signIn: () => Promise<unknown>;
  signInPending?: boolean;
  mutationPending?: boolean;
  suspended?: boolean;
  scopeKey?: string;
  onBeforeOpen?: () => void;
  onBeforeDisconnect?: () => void;
  onDisconnectingChange?: (disconnecting: boolean) => void;
  showToast: (message: string) => void;
};

export type HeaderWallet = {
  address: string | undefined;
  open: boolean;
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
  const [open, setOpen] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);
  const signInFlight = useRef(false);
  const disconnectFlight = useRef<Promise<void> | null>(null);
  const disconnectAttempt = useRef<DisconnectAttempt | null>(null);
  const authenticatedAddress = options.auth.authenticated ? options.auth.sessionWallet || undefined : undefined;
  const connectedAddress = options.wallet.connected ? options.wallet.publicKey?.toBase58() : undefined;
  const address = disconnectAttempt.current?.address ?? authenticatedAddress;
  const balance = useMainnetSolBalance(authenticatedAddress, open && !options.suspended && !disconnectAttempt.current);
  const balanceRef = useRef(balance);
  balanceRef.current = balance;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const discardReplacedStaffSession = useCallback(() => {
    const attempt = disconnectAttempt.current;
    const token = readStaffWalletSession()?.token;
    if (!attempt || !token || token === attempt.staffSessionToken) return false;
    disconnectAttempt.current = null;
    if (mounted.current) {
      setDisconnectError(null);
      setOpen(false);
    }
    return true;
  }, []);

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
    setOpen(false);
  }, [adapter, authenticatedAddress, connectedAddress]);

  useLayoutEffect(() => {
    const signal = options.auth.intentCancellationSignal;
    const invalidateAttempt = () => {
      disconnectAttempt.current = null;
      setDisconnectError(null);
      setOpen(false);
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
    const onAbort = () => {
      const operation = disconnectAttempt.current;
      if (!operation || operation.intentSignal !== signal) return;
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
  }, [options.auth.intentCancellationSignal]);

  useEffect(() => { setOpen(false); }, [options.scopeKey]);
  useEffect(() => {
    if (options.suspended) setOpen(false);
  }, [options.suspended]);

  const close = useCallback(() => setOpen(false), []);
  const isButtonDisabled = () => {
    const current = latest.current;
    return Boolean(
      current.suspended || disconnectFlight.current || signInFlight.current ||
      current.wallet.connecting || current.wallet.disconnecting ||
      !disconnectAttempt.current && (
        current.auth.sessionResolution !== 'settled' || current.auth.loading || current.signInPending
      ),
    );
  };

  const activate = useCallback(async () => {
    if (isButtonDisabled()) return;
    const current = latest.current;
    current.onBeforeOpen?.();
    if (current.auth.authenticated && current.auth.sessionWallet || disconnectAttempt.current) {
      setOpen((value) => !value);
      return;
    }
    if (current.mutationPending) return;
    signInFlight.current = true;
    setSigningIn(true);
    try {
      await current.signIn();
    } catch (error) {
      if (mounted.current) latest.current.showToast(error instanceof Error ? error.message : 'Unable to sign in. Please try again.');
    } finally {
      signInFlight.current = false;
      if (mounted.current) setSigningIn(false);
    }
  }, []);

  const disconnect = useCallback((): Promise<void> => {
    if (disconnectFlight.current) return disconnectFlight.current;
    if (discardReplacedStaffSession()) return Promise.resolve();
    const current = latest.current;
    if (current.suspended || current.mutationPending || current.wallet.connecting || current.wallet.disconnecting || signInFlight.current) {
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
        setOpen(false);
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
  }, [discardReplacedStaffSession]);

  return {
    address,
    open: Boolean(open && address && !options.suspended),
    buttonDisabled: Boolean(isButtonDisabled() || signingIn || disconnecting),
    disconnectDisabled: Boolean(options.mutationPending || options.suspended || options.wallet.connecting ||
      options.wallet.disconnecting || signingIn || disconnecting),
    disconnecting,
    disconnectError,
    balanceLamports: disconnectAttempt.current ? disconnectAttempt.current.balanceLamports : balance.lamports,
    balanceLoading: !disconnectAttempt.current && balance.loading,
    balanceError: !disconnectAttempt.current && balance.error,
    activate,
    close,
    disconnect,
    retryBalance: balance.retry,
  };
}
