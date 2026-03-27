/**
 * Frontend deployment constants (COMMITTED).
 *
 * Values produced by on-chain deployment live in `src/config/deployed.ts` and are
 * updated by `scripts/deploy-all-onchain.ts` (`npm run deploy-all-onchain`).
 *
 * Secrets:
 * - Do NOT put secrets here.
 * - `VITE_HELIUS_API_KEY` and `VITE_FIREBASE_API_KEY` may be provided via env to
 *   override the bundled frontend defaults in `src/lib/helius.ts` and `src/lib/firebase.ts`.
 */
import { FRONTEND_DEPLOYED, FRONTEND_PATHS } from './deployed';

export const FRONTEND_DEPLOYMENT = {
  ...FRONTEND_DEPLOYED,

  // Canonical derived drop paths (avoid duplicating URL strings).
  paths: FRONTEND_PATHS,
} as const;

export type FrontendDeploymentConfig = typeof FRONTEND_DEPLOYMENT;
