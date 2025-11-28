import { useCallback, useEffect, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { signInWithCustomToken, signOut as firebaseSignOut } from 'firebase/auth';
import { auth } from '../lib/firebase';
import { solanaAuth } from '../lib/api';
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
  const updateProfile = useCallback((profile: Profile | null) => {
    setState((prev) => ({ ...prev, profile }));
  }, []);

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
      const { customToken, profile } = await solanaAuth(publicKey.toBase58(), message, signature);
      const credential = await signInWithCustomToken(auth, customToken);
      const token = await credential.user.getIdToken();
      const normalizedProfile = { ...profile, addresses: profile.addresses || [] };
      setState({ profile: normalizedProfile, token, loading: false });
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
    }
  }, [connected]);

  return { ...state, error, signIn, signOut, updateProfile };
}
