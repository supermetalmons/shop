/**
 * Frontend deployment constants (COMMITTED).
 *
 * Values produced by on-chain deployment live in `src/config/deployed.ts` and are
 * updated by `scripts/deploy-all-box-minter.ts`.
 *
 * Secrets:
 * - Do NOT put secrets here.
 * - Only `VITE_HELIUS_API_KEY` and `VITE_FIREBASE_API_KEY` should be provided via env.
 */
import { FRONTEND_DEPLOYED } from './deployed';

export const FRONTEND_DEPLOYMENT = {
  ...FRONTEND_DEPLOYED,

  // Delivery address encryption (public key only; keep secret key offline).
  addressEncryptionPublicKey: 't6amHtGqTyN1odz/o7m7EuXFmfS2wqegHF1r/3TAhDg=',

  // Firebase (non-secret parts of client config)
  firebase: {
    authDomain: 'mons-shop.firebaseapp.com',
    projectId: 'mons-shop',
    storageBucket: 'mons-shop.firebasestorage.app',
    messagingSenderId: '804781326988',
    appId: '1:804781326988:web:abeb4da8cfe43318a671a9',
  },

  // Firebase Cloud Functions region.
  firebaseFunctionsRegion: 'us-central1' as const,
} as const;

export type FrontendDeploymentConfig = typeof FRONTEND_DEPLOYMENT;


