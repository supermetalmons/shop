import { useCallback, useEffect, useRef, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { signOut as firebaseSignOut } from 'firebase/auth';
import { auth } from '../lib/firebase';
import { ensureAuthenticated, getProfile, solanaAuth } from '../lib/api';
import { isRetryableCallableError, retryWithBackoff } from '../lib/callableErrors';
import { Profile } from '../types';
import { buildSignInMessage } from '../lib/solana';

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
  const loadCurrentSessionProfile = useCallback(async (expectedWallet: string): Promise<{ profile: Profile; token: string | null } | null> => {
    const { profile } = await getProfile();
    if (!profile || profile.wallet !== expectedWallet) return null;
    return {
      profile,
      token: (await auth?.currentUser?.getIdToken()) || null,
    };
  }, []);
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
  const refreshProfile = useCallback(async (): Promise<Profile | null> => {
    if (!auth || !connected || !publicKey) return null;
    const wallet = publicKey.toBase58();
    const session = await loadCurrentSessionProfile(wallet);
    if (!session) return null;
    setState((prev) => ({ ...prev, profile: session.profile, token: session.token || prev.token }));
    setSessionWalletChecked(wallet);
    return session.profile;
  }, [connected, loadCurrentSessionProfile, publicKey]);

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
    if (!prevWallet || prevWallet === wallet) return;

    // Wallet account changed while remaining connected. Clear local auth state and
    // force a fresh Firebase anonymous session to avoid carrying over prior wallet mapping.
    authAttemptEpochRef.current += 1;
    clearLocalAuthState();
    if (auth) {
      void firebaseSignOut(auth).catch(() => {
        // Ignore sign-out races; next auth call will recover.
      });
    }
  }, [clearLocalAuthState, connected, publicKey]);

  // On reload, restore the saved profile if this device already has a wallet session
  // (set by a previous `solanaAuth` call). This avoids requiring another wallet signature.
  useEffect(() => {
    if (!auth || !connected || !publicKey) return;
    const wallet = publicKey.toBase58();
    if (sessionWalletChecked === wallet) return;
    if (state.profile?.wallet === wallet) {
      setSessionWalletChecked(wallet);
      return;
    }

    let cancelled = false;
    setState((prev) => ({ ...prev, loading: true }));
    setError(null);
    (async () => {
      try {
        const session = await loadCurrentSessionProfile(wallet);
        if (!session?.token) return;
        if (!cancelled) setState({ profile: session.profile, token: session.token, loading: false });
      } catch {
        // No session (or expired) is totally normal on first visit; don't surface as an error.
      } finally {
        if (!cancelled) {
          setState((prev) => ({ ...prev, loading: false }));
          setSessionWalletChecked(wallet);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [connected, loadCurrentSessionProfile, publicKey, sessionWalletChecked, state.profile?.wallet]);

  const signIn = useCallback(async () => {
    if (!auth) throw new Error('Firebase client is not configured');
    if (!publicKey) throw new Error('Connect a wallet first');
    if (!signMessage) throw new Error('Wallet cannot sign messages');

    const wallet = publicKey.toBase58();
    connectedWalletRef.current = wallet;
    connectedRef.current = connected;
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

      // If the user just tried signing in and the network flaked out, reuse the last signature
      // to avoid re-prompting the wallet.
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

      // Retry only the callable (idempotent) step with exponential backoff.
      const { profile } = await retryWithBackoff(
        async () => {
          const session = await solanaAuth(wallet, message, signature);
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
      // If we cached a bad signature payload, clear it so the next attempt forces a fresh wallet signature.
      if (isInvalidSignatureError(err)) lastSignedRef.current = null;
      if ((err as { code?: string } | null)?.code === 'wallet-changed') {
        setState((prev) => ({ ...prev, loading: false }));
        throw err;
      }
      setError(err instanceof Error ? err.message : 'Failed to sign in');
      setState((prev) => ({ ...prev, loading: false }));
      throw err;
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

  return { ...state, error, signIn, signOut, updateProfile, refreshProfile };
}
