/**
 * Frontend deployment constants (COMMITTED).
 *
 * Values produced by on-chain deployment live in `src/config/deployed.ts` and are
 * updated by `scripts/deploy-all-onchain.ts` (`npm run deploy-all-onchain`).
 *
 * Secrets:
 * - Do NOT put secrets here.
 * - Only `VITE_HELIUS_API_KEY` and `VITE_FIREBASE_API_KEY` should be provided via env.
 */
import { FRONTEND_DEPLOYED, FRONTEND_PATHS } from './deployed';

export const FRONTEND_DEPLOYMENT = {
  ...FRONTEND_DEPLOYED,

  // Canonical derived drop paths (avoid duplicating URL strings).
  paths: FRONTEND_PATHS,

  // Delivery address encryption (public key only; keep secret key offline).
  addressEncryptionPublicKey: 'OeuwTqGXImT/vfBBV6j6G89Hs6tU1Ij5+Gd2fQSCQB4=',

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


