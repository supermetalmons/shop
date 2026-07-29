import { useCallback, useEffect, useRef, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { signOut as firebaseSignOut } from 'firebase/auth';
import { auth } from '../lib/firebase';
import { ensureAuthenticated, getProfile, solanaAuth } from '../lib/api';
import { isRetryableCallableError, retryWithBackoff } from '../lib/callableErrors';
import { Profile } from '../types';
import { buildSignInMessage } from '../lib/solana';
import { createSessionProfileRequestCoordinator } from '../lib/sessionProfileRequestCoordinator';

type StripeDeliveryMergeOptions = {
  mergeStripeDeliveryOrders?: boolean;
};

type RestoreProfileFromSessionOptions = StripeDeliveryMergeOptions & {
  expectedWallet?: string;
};

function isInvalidSignatureError(err: unknown): boolean {
  const anyErr = err as any;
  const message = typeof anyErr?.message === 'string' ? anyErr.message : '';
  if (/invalid signature/i.test(message)) return true;
  const details = anyErr?.details;
  if (typeof details === 'string' && /invalid signature/i.test(details)) return true;
  return false;
}

export function useSolanaAuth() {
  const { publicKey, signMessage, connected } = useWallet();
  const [state, setState] = useState<{ profile: Profile | null; token: string | null; loading: boolean }>({
    profile: null,
    token: null,
    loading: false,
  });
  const [error, setError] = useState<string | null>(null);
  const [sessionWalletChecked, setSessionWalletChecked] = useState<string | null>(null);
  const lastSignedRef = useRef<{ wallet: string; uid: string; message: string; signature: Uint8Array; createdAt: number } | null>(null);
  const lastConnectedWalletRef = useRef<string | null>(null);
  const connectedWalletRef = useRef<string | null>(publicKey?.toBase58() || null);
  const connectedRef = useRef<boolean>(connected);
  const authAttemptEpochRef = useRef(0);
  const signInAttemptRef = useRef<{ epoch: number; completion: Promise<void> | null }>({
    epoch: 0,
    completion: null,
  });
  const sessionProfileRequestCoordinatorRef = useRef<ReturnType<
    typeof createSessionProfileRequestCoordinator<{ profile: Profile; token: string } | null>
  > | null>(null);
  if (!sessionProfileRequestCoordinatorRef.current) {
    sessionProfileRequestCoordinatorRef.current = createSessionProfileRequestCoordinator(
      async ({ mergeStripeDeliveryOrders }) => {
        const { profile } = await getProfile(
          undefined,
          mergeStripeDeliveryOrders ? { mergeStripeDeliveryOrders: true } : undefined,
        );
        if (!profile) return null;
        const token = (await auth?.currentUser?.getIdToken()) || null;
        return token ? { profile, token } : null;
      },
    );
  }
  const loadSessionProfile = useCallback(
    async (options?: RestoreProfileFromSessionOptions): Promise<{ profile: Profile; token: string } | null> => {
      const session = await sessionProfileRequestCoordinatorRef.current!({
        mergeStripeDeliveryOrders: options?.mergeStripeDeliveryOrders,
      });
      if (!session || (options?.expectedWallet && session.profile.wallet !== options.expectedWallet)) return null;
      return session;
    },
    [],
  );
  const clearLocalAuthState = useCallback((options?: { clearSessionWalletChecked?: boolean }) => {
    setState({ profile: null, token: null, loading: false });
    setError(null);
    if (options?.clearSessionWalletChecked !== false) {
      setSessionWalletChecked(null);
    }
    lastSignedRef.current = null;
  }, []);
  const updateProfile = useCallback((profile: Profile | null) => {
    setState((prev) => ({ ...prev, profile }));
  }, []);
  const restoreProfileFromSession = useCallback(
    async (options?: RestoreProfileFromSessionOptions): Promise<Profile | null> => {
      if (!auth) return null;
      while (true) {
        const activeSignIn = signInAttemptRef.current.completion;
        if (activeSignIn) {
          await activeSignIn;
          continue;
        }

        const attemptEpoch = authAttemptEpochRef.current;
        const signInAttemptEpoch = signInAttemptRef.current.epoch;
        const session = await loadSessionProfile(options);
        if (authAttemptEpochRef.current !== attemptEpoch) return null;
        if (
          signInAttemptRef.current.completion ||
          signInAttemptRef.current.epoch !== signInAttemptEpoch
        ) {
          continue;
        }
        if (!session) return null;

        const activeWallet = connectedWalletRef.current;
        if (activeWallet && session.profile.wallet !== activeWallet) return null;
        setState((prev) => ({ ...prev, profile: session.profile, token: session.token }));
        setSessionWalletChecked(session.profile.wallet);
        return session.profile;
      }
    },
    [loadSessionProfile],
  );
  const refreshProfile = useCallback(async (options?: StripeDeliveryMergeOptions): Promise<Profile | null> => {
    if (!auth || !connected || !publicKey) return null;
    const wallet = publicKey.toBase58();
    return restoreProfileFromSession({ ...options, expectedWallet: wallet });
  }, [connected, publicKey, restoreProfileFromSession]);

  useEffect(() => {
    connectedWalletRef.current = publicKey?.toBase58() || null;
    connectedRef.current = connected;
  }, [connected, publicKey]);

  useEffect(() => {
    const wallet = publicKey?.toBase58() || null;
    if (!connected) {
      lastConnectedWalletRef.current = null;
      return;
    }
    if (!wallet) return;

    const prevWallet = lastConnectedWalletRef.current;
    lastConnectedWalletRef.current = wallet;
    const restoredWallet = state.profile?.wallet || null;
    if ((!prevWallet && (!restoredWallet || restoredWallet === wallet)) || prevWallet === wallet) {
      return;
    }

    authAttemptEpochRef.current += 1;
    clearLocalAuthState();
    if (auth) {
      void firebaseSignOut(auth).catch(() => {

      });
    }
  }, [clearLocalAuthState, connected, publicKey, state.profile?.wallet]);

  useEffect(() => {
    if (!auth || !connected || !publicKey) return;
    const wallet = publicKey.toBase58();
    if (sessionWalletChecked === wallet) return;
    if (state.profile?.wallet === wallet) {
      setSessionWalletChecked(wallet);
      return;
    }
    if (state.profile) return;

    let cancelled = false;
    setState((prev) => ({ ...prev, loading: true }));
    setError(null);
    (async () => {
      try {
        const session = await loadSessionProfile({ expectedWallet: wallet });
        if (!session?.token) return;
        if (!cancelled) setState({ profile: session.profile, token: session.token, loading: false });
      } catch {} finally {
        if (!cancelled) {
          setState((prev) => ({ ...prev, loading: false }));
          setSessionWalletChecked(wallet);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [connected, loadSessionProfile, publicKey, sessionWalletChecked, state.profile?.wallet]);

  const signIn = useCallback(async (options?: StripeDeliveryMergeOptions) => {
    if (!auth) throw new Error('Firebase client is not configured');
    if (!publicKey) throw new Error('Connect a wallet first');
    if (!signMessage) throw new Error('Wallet cannot sign messages');

    const wallet = publicKey.toBase58();
    connectedWalletRef.current = wallet;
    connectedRef.current = connected;
    const signInAttemptEpoch = signInAttemptRef.current.epoch + 1;
    let settleSignInAttempt!: () => void;
    const signInAttemptCompletion = new Promise<void>((resolve) => {
      settleSignInAttempt = resolve;
    });
    signInAttemptRef.current = {
      epoch: signInAttemptEpoch,
      completion: signInAttemptCompletion,
    };
    const attemptEpoch = authAttemptEpochRef.current;
    const ensureAttemptCurrent = () => {
      const stale =
        authAttemptEpochRef.current !== attemptEpoch ||
        !connectedRef.current ||
        connectedWalletRef.current !== wallet;
      if (!stale) return;
      const err = new Error('Wallet changed during sign-in. Please try again.');
      (err as Error & { code?: string }).code = 'wallet-changed';
      throw err;
    };

    setState((prev) => ({ ...prev, loading: true }));
    setError(null);
    try {
      const uid = await ensureAuthenticated();
      ensureAttemptCurrent();

      const reuseWindowMs = 2 * 60 * 1000;
      const cached = lastSignedRef.current;
      const now = Date.now();
      let message: string;
      let signature: Uint8Array;
      if (cached && cached.wallet === wallet && cached.uid === uid && now - cached.createdAt <= reuseWindowMs) {
        ({ message, signature } = cached);
      } else {
        message = buildSignInMessage(wallet, uid);
        const encoded = new TextEncoder().encode(message);
        signature = await signMessage(encoded);
        ensureAttemptCurrent();
        lastSignedRef.current = { wallet, uid, message, signature, createdAt: now };
      }

      const { profile } = await retryWithBackoff(
        async () => {
          const session = await solanaAuth(wallet, message, signature, options);
          ensureAttemptCurrent();
          return session;
        },
        {
          maxAttempts: 4,
          baseDelayMs: 400,
          maxDelayMs: 4000,
          jitterRatio: 0.2,
          shouldRetry: (err) => {
            ensureAttemptCurrent();
            return isRetryableCallableError(err);
          },
        },
      );

      const token = await auth.currentUser?.getIdToken();
      ensureAttemptCurrent();
      if (!token) throw new Error('Missing Firebase auth token');
      setState({ profile, token, loading: false });
      setSessionWalletChecked(wallet);
      return { profile, token };
    } catch (err) {
      console.error(err);

      if (isInvalidSignatureError(err)) lastSignedRef.current = null;
      if ((err as { code?: string } | null)?.code === 'wallet-changed') {
        setState((prev) => ({ ...prev, loading: false }));
        throw err;
      }
      setError(err instanceof Error ? err.message : 'Failed to sign in');
      setState((prev) => ({ ...prev, loading: false }));
      throw err;
    } finally {
      settleSignInAttempt();
      if (
        signInAttemptRef.current.epoch === signInAttemptEpoch &&
        signInAttemptRef.current.completion === signInAttemptCompletion
      ) {
        signInAttemptRef.current = { epoch: signInAttemptEpoch, completion: null };
      }
    }
  }, [publicKey, signMessage, connected]);

  const signOut = useCallback(async () => {
    authAttemptEpochRef.current += 1;
    clearLocalAuthState({ clearSessionWalletChecked: false });
    if (auth) await firebaseSignOut(auth);
  }, [clearLocalAuthState]);

  useEffect(() => {
    if (!connected) {
      authAttemptEpochRef.current += 1;
      clearLocalAuthState();
    }
  }, [clearLocalAuthState, connected]);

  return { ...state, error, signIn, signOut, updateProfile, refreshProfile, restoreProfileFromSession };
}
