import { useCallback, useEffect, useRef, useState } from 'react';
import type { PublicKey } from '@solana/web3.js';
import type { useSolanaAuth } from '../../hooks/useSolanaAuth';

type ShopSignInOptions = {
  auth: Pick<ReturnType<typeof useSolanaAuth>,
    'loading' | 'sessionResolution' | 'signIn' | 'hasAuthenticatedWalletSession' | 'awaitWalletSessionRestoration'> & { intentCancellationSignal?: AbortSignal };
  connectedWallet: string | undefined;
  publicKey: PublicKey | null;
  wallet: { connecting: boolean; disconnecting: boolean };
  walletModalVisible: boolean;
  setVisible: (visible: boolean) => void;
  isSignedInWallet: boolean;
  hasAuthenticatedAccount: boolean;
  showToast: (message: string) => void;
  isUserRejectedError: (error: unknown) => boolean;
};

export type ShopSignInRequestOptions = {
  signal?: AbortSignal;
  expectedWallet?: string;
};

type SignInAttempt = {
  controller: AbortController;
  wallet: string | null;
  expectedWallet?: string;
  sawPicker: boolean;
  pickerRequested: boolean;
  consumers: Set<symbol>;
  walletPromise: Promise<string | null>;
  resolveWallet: (wallet: string | null) => void;
  signInPromise: Promise<string | null> | null;
  signing: boolean;
};

export function useShopSignIn(options: ShopSignInOptions) {
  const {
    auth: { loading: authLoading, sessionResolution }, connectedWallet, wallet,
    isSignedInWallet, hasAuthenticatedAccount,
  } = options;
  const latestRef = useRef(options);
  latestRef.current = options;
  const mountedRef = useRef(true);
  const attemptRef = useRef<SignInAttempt | null>(null);
  const authReady = sessionResolution === 'settled';
  const walletBusy = wallet.connecting || wallet.disconnecting;
  const [walletIdleReady, setWalletIdleReady] = useState(false);
  const [pendingShipmentsSignIn, setPendingShipmentsSignIn] = useState(false);
  const [pendingHeaderWalletSignIn, setPendingHeaderWalletSignIn] = useState(false);
  const [headerWalletButtonRevealed, setHeaderWalletButtonRevealed] = useState(false);
  const headerRequestRef = useRef<Promise<void> | null>(null);
  const shipmentsRequestRef = useRef<Promise<void> | null>(null);

  const isCurrentWallet = useCallback((attempt: SignInAttempt, expectedWallet: string) => {
    const current = latestRef.current;
    return mountedRef.current && !attempt.controller.signal.aborted &&
      current.connectedWallet === expectedWallet && current.publicKey?.toBase58() === expectedWallet &&
      !current.wallet.disconnecting;
  }, []);

  const releaseAttempt = useCallback((attempt: SignInAttempt) => {
    if (attempt.consumers.size > 0) return;
    if (mountedRef.current && !attempt.wallet && attempt.pickerRequested && latestRef.current.walletModalVisible) {
      latestRef.current.setVisible(false);
    }
    attempt.controller.abort();
    if (!attempt.signing && attemptRef.current === attempt) attemptRef.current = null;
  }, []);

  const updateAttempt = useCallback((attempt: SignInAttempt) => {
    if (attempt.controller.signal.aborted) return;
    const current = latestRef.current;
    if (attempt.wallet) {
      if (!isCurrentWallet(attempt, attempt.wallet)) attempt.controller.abort();
      return;
    }
    if (current.connectedWallet && current.publicKey?.toBase58() === current.connectedWallet && !current.wallet.disconnecting) {
      if (attempt.expectedWallet && attempt.expectedWallet !== current.connectedWallet) {
        current.showToast('Choose the wallet that owns these items.');
        attempt.controller.abort();
        return;
      }
      attempt.wallet = current.connectedWallet;
      attempt.resolveWallet(current.connectedWallet);
      return;
    }
    if (current.walletModalVisible) attempt.sawPicker = true;
    if (attempt.sawPicker && !current.walletModalVisible && !current.wallet.connecting && !current.wallet.disconnecting) {
      attempt.controller.abort();
    }
  }, [isCurrentWallet]);

  const requestWallet = useCallback((requireSignIn: boolean, request: ShopSignInRequestOptions = {}): Promise<string | null> => {
    if (!mountedRef.current || request.signal?.aborted || latestRef.current.auth.intentCancellationSignal?.aborted) return Promise.resolve(null);
    let attempt = attemptRef.current;
    if (attempt?.controller.signal.aborted) return Promise.resolve(null);
    if (attempt && request.expectedWallet && attempt.expectedWallet && request.expectedWallet !== attempt.expectedWallet) {
      return Promise.resolve(null);
    }
    if (!attempt) {
      let resolveWallet!: SignInAttempt['resolveWallet'];
      const walletPromise = new Promise<string | null>((resolve) => { resolveWallet = resolve; });
      attempt = {
        controller: new AbortController(), wallet: null, expectedWallet: request.expectedWallet,
        sawPicker: latestRef.current.walletModalVisible, pickerRequested: false,
        consumers: new Set(), walletPromise, resolveWallet, signInPromise: null, signing: false,
      };
      const identitySignal = latestRef.current.auth.intentCancellationSignal;
      const controller = attempt.controller;
      const cancelIdentity = () => controller.abort();
      identitySignal?.addEventListener('abort', cancelIdentity, { once: true });
      controller.signal.addEventListener('abort', () => {
        identitySignal?.removeEventListener('abort', cancelIdentity);
        resolveWallet(null);
      }, { once: true });
      attemptRef.current = attempt;
    }
    const activeAttempt = attempt;
    const consumer = Symbol();
    activeAttempt.consumers.add(consumer);
    const expectedWallet = request.expectedWallet;
    if (!activeAttempt.expectedWallet && expectedWallet && !activeAttempt.wallet) activeAttempt.expectedWallet = expectedWallet;

    const result = new Promise<string | null>((resolve) => {
      let settled = false;
      const finish = (walletAddress: string | null) => {
        if (settled) return;
        settled = true;
        request.signal?.removeEventListener('abort', cancel);
        activeAttempt.controller.signal.removeEventListener('abort', cancel);
        activeAttempt.consumers.delete(consumer);
        resolve(walletAddress);
        releaseAttempt(activeAttempt);
      };
      const cancel = () => finish(null);
      request.signal?.addEventListener('abort', cancel, { once: true });
      activeAttempt.controller.signal.addEventListener('abort', cancel, { once: true });

      const prerequisite = async () => {
        const walletAddress = await activeAttempt.walletPromise;
        if (!walletAddress || !isCurrentWallet(activeAttempt, walletAddress)) return null;
        if (expectedWallet && walletAddress !== expectedWallet) {
          latestRef.current.showToast('Choose the wallet that owns these items.');
          return null;
        }
        if (!requireSignIn) return walletAddress;
        if (!activeAttempt.signInPromise) {
          activeAttempt.signing = true;
          activeAttempt.signInPromise = (async () => {
            try {
              if (!latestRef.current.auth.hasAuthenticatedWalletSession(walletAddress)) {
                const restoration = await latestRef.current.auth.awaitWalletSessionRestoration(walletAddress, activeAttempt.controller.signal);
                if (restoration === 'cancelled' || !isCurrentWallet(activeAttempt, walletAddress)) return null;
                if (!latestRef.current.auth.hasAuthenticatedWalletSession(walletAddress)) {
                  await latestRef.current.auth.signIn();
                }
              }
              return isCurrentWallet(activeAttempt, walletAddress) && latestRef.current.auth.hasAuthenticatedWalletSession(walletAddress)
                ? walletAddress : null;
            } catch (error) {
              if (isCurrentWallet(activeAttempt, walletAddress)) {
                if (latestRef.current.auth.hasAuthenticatedWalletSession(walletAddress)) return walletAddress;
                if (!latestRef.current.isUserRejectedError(error)) {
                  latestRef.current.showToast(error instanceof Error ? error.message : 'Failed to sign in. Please try again.');
                }
              }
              return null;
            } finally {
              activeAttempt.signing = false;
              releaseAttempt(activeAttempt);
            }
          })();
        }
        return activeAttempt.signInPromise;
      };
      void prerequisite().then((walletAddress) => {
        finish(walletAddress && isCurrentWallet(activeAttempt, walletAddress) ? walletAddress : null);
      });
    });
    updateAttempt(activeAttempt);
    if (!activeAttempt.wallet && !activeAttempt.controller.signal.aborted && !activeAttempt.pickerRequested) {
      activeAttempt.pickerRequested = true;
      latestRef.current.setVisible(true);
    }
    return result;
  }, [isCurrentWallet, releaseAttempt, updateAttempt]);

  const ensureWalletConnected = useCallback((request?: ShopSignInRequestOptions) => requestWallet(false, request), [requestWallet]);
  const ensureSignedIn = useCallback(async (request?: ShopSignInRequestOptions) => Boolean(await requestWallet(true, request)), [requestWallet]);

  useEffect(() => {
    if (attemptRef.current) updateAttempt(attemptRef.current);
  });
  useEffect(() => {
    mountedRef.current = true;
    const cancel = () => attemptRef.current?.controller.abort();
    window.addEventListener('pagehide', cancel);
    return () => {
      mountedRef.current = false;
      window.removeEventListener('pagehide', cancel);
      cancel();
    };
  }, []);

  const handleSignInForShipments = useCallback(() => {
    if (shipmentsRequestRef.current) return shipmentsRequestRef.current;
    setPendingShipmentsSignIn(true);
    const request = ensureSignedIn().then(() => undefined).finally(() => {
      if (shipmentsRequestRef.current !== request) return;
      shipmentsRequestRef.current = null;
      if (mountedRef.current) setPendingShipmentsSignIn(false);
    });
    shipmentsRequestRef.current = request;
    return request;
  }, [ensureSignedIn]);

  const handleHeaderWalletSignIn = useCallback(() => {
    if (headerRequestRef.current) return headerRequestRef.current;
    setPendingHeaderWalletSignIn(true);
    const request = ensureSignedIn().then(() => undefined).finally(() => {
      if (headerRequestRef.current !== request) return;
      headerRequestRef.current = null;
      if (mountedRef.current) setPendingHeaderWalletSignIn(false);
    });
    headerRequestRef.current = request;
    return request;
  }, [ensureSignedIn]);

  useEffect(() => {
    if (isSignedInWallet || hasAuthenticatedAccount || !authReady || authLoading || pendingHeaderWalletSignIn) {
      setHeaderWalletButtonRevealed(false);
      return;
    }
    if (connectedWallet || (walletIdleReady && !walletBusy)) setHeaderWalletButtonRevealed(true);
  }, [authLoading, authReady, connectedWallet, hasAuthenticatedAccount, isSignedInWallet, pendingHeaderWalletSignIn, walletBusy, walletIdleReady]);
  useEffect(() => {
    if (connectedWallet || walletBusy) {
      setWalletIdleReady(false);
      return;
    }
    const timeout = setTimeout(() => setWalletIdleReady(true), 250);
    return () => clearTimeout(timeout);
  }, [connectedWallet, walletBusy]);

  return {
    authReady, walletBusy, walletIdleReady,
    pendingShipmentsSignIn, pendingHeaderWalletSignIn, headerWalletButtonRevealed,
    ensureSignedIn, ensureWalletConnected, handleSignInForShipments, handleHeaderWalletSignIn,
  };
}
