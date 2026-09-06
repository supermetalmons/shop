import { useEffect, useRef, useState } from 'react';
import type { PublicKey } from '@solana/web3.js';
import type { useSolanaAuth } from '../../hooks/useSolanaAuth';
import { walletSessionSignInReadiness } from '../../lib/profileClientLifecycle';

type ShopSignInOptions = {
  auth: Pick<ReturnType<typeof useSolanaAuth>,
    'sessionWallet' | 'authenticated' | 'loading' | 'sessionResolution' | 'signIn' | 'hasAuthenticatedWalletSession'>;
  connectedWallet: string | undefined;
  publicKey: PublicKey | null;
  wallet: { connecting: boolean; disconnecting: boolean };
  walletModalVisible: boolean;
  setVisible: (visible: boolean) => void;
  isSignedInWallet: boolean;
  hasAuthenticatedAccount: boolean;
  claimOpen: boolean;
  showToast: (message: string) => void;
  isUserRejectedError: (error: unknown) => boolean;
};

export function useShopSignIn({
  auth, connectedWallet, publicKey, wallet, walletModalVisible, setVisible,
  isSignedInWallet, hasAuthenticatedAccount, claimOpen, showToast, isUserRejectedError,
}: ShopSignInOptions) {
  const { sessionWallet, authenticated, loading: authLoading, sessionResolution, signIn, hasAuthenticatedWalletSession } = auth;
  const authReady = sessionResolution === 'settled';
  const walletBusy = wallet.connecting || wallet.disconnecting;
  const [walletIdleReady, setWalletIdleReady] = useState(false);
  const [pendingShipmentsSignIn, setPendingShipmentsSignIn] = useState(false);
  const [pendingHeaderWalletSignIn, setPendingHeaderWalletSignIn] = useState(false);
  const headerWalletSignInGenerationRef = useRef(0);
  const [pendingClaimSignIn, setPendingClaimSignIn] = useState(false);
  const [headerWalletButtonRevealed, setHeaderWalletButtonRevealed] = useState(false);
  const signInPromiseRef = useRef<Promise<boolean> | null>(null);
  useEffect(() => {
    signInPromiseRef.current = null;
  }, [connectedWallet, sessionWallet]);
  const ensureSignedIn = async (): Promise<boolean> => {
    const hasCurrentSession =
      Boolean(connectedWallet) && hasAuthenticatedWalletSession(connectedWallet);
    if (!connectedWallet || !publicKey) {
      setVisible(true);
      return false;
    }
    const readiness = walletSessionSignInReadiness({
      hasAuthenticatedSession: Boolean((isSignedInWallet && authenticated) || hasCurrentSession),
      sessionResolution,
      authLoading,
    });
    if (readiness === 'authenticated') return true;
    if (signInPromiseRef.current) return signInPromiseRef.current;
    if (readiness === 'resolving') {
      showToast('Restoring wallet session…');
      return false;
    }

    let promise: Promise<boolean>;
    promise = signIn()
      .then(() => true)
      .catch((err) => {
        if (!isUserRejectedError(err)) {
          showToast(err instanceof Error ? err.message : 'Failed to sign in');
        }
        return false;
      })
      .finally(() => {
        if (signInPromiseRef.current === promise) {
          signInPromiseRef.current = null;
        }
      });

    signInPromiseRef.current = promise;
    return promise;
  };

  const runHeaderSignIn = async () => {
    const generation = headerWalletSignInGenerationRef.current + 1;
    headerWalletSignInGenerationRef.current = generation;
    setPendingHeaderWalletSignIn(true);
    try {
      await ensureSignedIn();
    } finally {
      if (headerWalletSignInGenerationRef.current === generation) {
        setPendingHeaderWalletSignIn(false);
      }
    }
  };

  useEffect(() => {
    const claimRequested = pendingClaimSignIn && claimOpen;
    if (pendingClaimSignIn && !claimOpen) setPendingClaimSignIn(false);
    if (!pendingShipmentsSignIn && !pendingHeaderWalletSignIn && !claimRequested) return;

    const cancelled = !walletModalVisible && !connectedWallet && !wallet.connecting;
    const alreadySignedIn = connectedWallet && publicKey && isSignedInWallet;
    if (cancelled || alreadySignedIn) {
      setPendingShipmentsSignIn(false);
      setPendingClaimSignIn(false);
      if (pendingHeaderWalletSignIn) {
        headerWalletSignInGenerationRef.current += 1;
        setPendingHeaderWalletSignIn(false);
      }
      return;
    }
    if (!connectedWallet || !publicKey || !authReady || authLoading) return;

    setPendingShipmentsSignIn(false);
    setPendingClaimSignIn(false);
    if (pendingHeaderWalletSignIn) void runHeaderSignIn();
    else void ensureSignedIn();
  }, [
    authLoading,
    authReady,
    claimOpen,
    connectedWallet,
    isSignedInWallet,
    pendingClaimSignIn,
    pendingHeaderWalletSignIn,
    pendingShipmentsSignIn,
    publicKey,
    wallet.connecting,
    walletModalVisible,
  ]);

  useEffect(() => {
    if (isSignedInWallet || hasAuthenticatedAccount || !authReady || authLoading) {
      setHeaderWalletButtonRevealed(false);
      return;
    }
    if (pendingHeaderWalletSignIn) {
      setHeaderWalletButtonRevealed(false);
      return;
    }
    if (connectedWallet) {
      if (authReady && !authLoading) setHeaderWalletButtonRevealed(true);
      return;
    }
    if (walletIdleReady && !walletBusy) setHeaderWalletButtonRevealed(true);
  }, [
    authLoading,
    authReady,
    connectedWallet,
    hasAuthenticatedAccount,
    isSignedInWallet,
    pendingHeaderWalletSignIn,
    walletBusy,
    walletIdleReady,
  ]);
  useEffect(() => {
    if (connectedWallet || walletBusy) {
      setWalletIdleReady(false);
      return;
    }
    const timeout = setTimeout(() => {
      setWalletIdleReady(true);
    }, 250);
    return () => {
      clearTimeout(timeout);
    };
  }, [connectedWallet, walletBusy]);
  const handleSignInForShipments = async () => {
    if (!connectedWallet || !publicKey) {
      setPendingShipmentsSignIn(true);
      setVisible(true);
      return;
    }
    if (authLoading) return;
    await ensureSignedIn();
  };

  const handleHeaderWalletSignIn = async () => {
    if (authLoading || walletBusy || pendingHeaderWalletSignIn) return;
    if (!connectedWallet || !publicKey) {
      headerWalletSignInGenerationRef.current += 1;
      setPendingHeaderWalletSignIn(true);
      setVisible(true);
      return;
    }
    await runHeaderSignIn();
  };

  return {
    authReady, walletBusy, walletIdleReady,
    pendingShipmentsSignIn, pendingHeaderWalletSignIn, pendingClaimSignIn, headerWalletButtonRevealed,
    ensureSignedIn, handleSignInForShipments, handleHeaderWalletSignIn,
    requestClaimSignIn: () => setPendingClaimSignIn(true),
  };
}
