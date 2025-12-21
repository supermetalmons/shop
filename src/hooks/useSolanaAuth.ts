import { useCallback, useEffect, useRef, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { signOut as firebaseSignOut } from 'firebase/auth';
import { auth } from '../lib/firebase';
import { getProfile, solanaAuth } from '../lib/api';
import { Profile } from '../types';
import { buildSignInMessage } from '../lib/solana';

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function isRetryableSolanaAuthError(err: unknown): boolean {
  const anyErr = err as any;
  const code = typeof anyErr?.code === 'string' ? anyErr.code : '';
  const normalized = code.startsWith('functions/') ? code.slice('functions/'.length) : code;
  // Firebase callable transient-ish errors:
  // https://firebase.google.com/docs/functions/callable#handle_errors
  if (
    normalized === 'unavailable' ||
    normalized === 'deadline-exceeded' ||
    normalized === 'resource-exhausted' ||
    normalized === 'internal' ||
    normalized === 'unknown' ||
    normalized === 'cancelled' ||
    normalized === 'aborted'
  ) {
    return true;
  }

  // Generic network-ish failures (browser fetch / transport issues).
  const message = typeof anyErr?.message === 'string' ? anyErr.message : '';
  if (err instanceof TypeError && /fetch/i.test(message)) return true;
  if (/network|timeout|temporarily unavailable|connection/i.test(message.toLowerCase())) return true;
  return false;
}

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
  const lastSignedRef = useRef<{ wallet: string; message: string; signature: Uint8Array; createdAt: number } | null>(null);
  const updateProfile = useCallback((profile: Profile | null) => {
    setState((prev) => ({ ...prev, profile }));
  }, []);

  // On reload, restore the saved profile/addresses if this device already has a wallet session
  // (set by a previous `solanaAuth` call). This avoids requiring another wallet signature just
  // to *view* saved addresses.
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
        const { profile } = await getProfile();
        if (!profile || profile.wallet !== wallet) return;
        const token = await auth.currentUser?.getIdToken();
        if (!token) return;
        const normalizedProfile = { ...profile, addresses: profile.addresses || [] };
        if (!cancelled) setState({ profile: normalizedProfile, token, loading: false });
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
  }, [connected, publicKey, sessionWalletChecked, state.profile?.wallet]);

  const signIn = useCallback(async () => {
    if (!auth) throw new Error('Firebase client is not configured');
    if (!publicKey) throw new Error('Connect a wallet first');
    if (!signMessage) throw new Error('Wallet cannot sign messages');

    setState((prev) => ({ ...prev, loading: true }));
    setError(null);
    try {
      const wallet = publicKey.toBase58();

      // If the user just tried signing in and the network flaked out, reuse the last signature
      // to avoid re-prompting the wallet.
      const reuseWindowMs = 2 * 60 * 1000;
      const cached = lastSignedRef.current;
      const now = Date.now();
      let message: string;
      let signature: Uint8Array;
      if (cached && cached.wallet === wallet && now - cached.createdAt <= reuseWindowMs) {
        ({ message, signature } = cached);
      } else {
        message = buildSignInMessage(wallet);
        const encoded = new TextEncoder().encode(message);
        signature = await signMessage(encoded);
        lastSignedRef.current = { wallet, message, signature, createdAt: now };
      }

      // Retry only the callable (idempotent) step with exponential backoff.
      const maxAttempts = 4;
      let lastErr: unknown;
      let profile: Profile | null = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          ({ profile } = await solanaAuth(wallet, message, signature));
          break;
        } catch (err) {
          lastErr = err;
          const shouldRetry = attempt < maxAttempts && isRetryableSolanaAuthError(err);
          if (!shouldRetry) throw err;
          const baseDelayMs = 400;
          const maxDelayMs = 4000;
          const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
          const jitter = Math.round(exp * 0.2 * Math.random());
          await sleep(exp + jitter);
        }
      }
      if (!profile) throw (lastErr ?? new Error('Failed to sign in'));

      const token = await auth.currentUser?.getIdToken();
      if (!token) throw new Error('Missing Firebase auth token');
      const normalizedProfile = { ...profile, addresses: profile.addresses || [] };
      setState({ profile: normalizedProfile, token, loading: false });
      setSessionWalletChecked(wallet);
      return { profile: normalizedProfile, token };
    } catch (err) {
      console.error(err);
      // If we cached a bad signature payload, clear it so the next attempt forces a fresh wallet signature.
      if (isInvalidSignatureError(err)) lastSignedRef.current = null;
      setError(err instanceof Error ? err.message : 'Failed to sign in');
      setState((prev) => ({ ...prev, loading: false }));
      throw err;
    }
  }, [publicKey, signMessage]);

  const signOut = useCallback(async () => {
    setState({ profile: null, token: null, loading: false });
    setError(null);
    if (auth) await firebaseSignOut(auth);
  }, []);

  useEffect(() => {
    if (!connected) {
      setState({ profile: null, token: null, loading: false });
      setError(null);
      setSessionWalletChecked(null);
      lastSignedRef.current = null;
    }
  }, [connected]);

  return { ...state, error, signIn, signOut, updateProfile };
}
