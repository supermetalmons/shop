import { useCallback, useEffect, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { signOut as firebaseSignOut } from 'firebase/auth';
import { auth } from '../lib/firebase';
import { getProfile, solanaAuth } from '../lib/api';
import { Profile } from '../types';
import { buildSignInMessage } from '../lib/solana';

export function useSolanaAuth() {
  const { publicKey, signMessage, connected } = useWallet();
  const [state, setState] = useState<{ profile: Profile | null; token: string | null; loading: boolean }>({
    profile: null,
    token: null,
    loading: false,
  });
  const [error, setError] = useState<string | null>(null);
  const [sessionWalletChecked, setSessionWalletChecked] = useState<string | null>(null);
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
      const message = buildSignInMessage(publicKey.toBase58());
      const encoded = new TextEncoder().encode(message);
      const signature = await signMessage(encoded);
      const { profile } = await solanaAuth(publicKey.toBase58(), message, signature);
      const token = await auth.currentUser?.getIdToken();
      if (!token) throw new Error('Missing Firebase auth token');
      const normalizedProfile = { ...profile, addresses: profile.addresses || [] };
      setState({ profile: normalizedProfile, token, loading: false });
      setSessionWalletChecked(publicKey.toBase58());
      return { profile: normalizedProfile, token };
    } catch (err) {
      console.error(err);
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
    }
  }, [connected]);

  return { ...state, error, signIn, signOut, updateProfile };
}
