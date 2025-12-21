/**
 * Frontend runtime secrets (NOT committed as values).
 *
 * Keep secrets in env:
 * - VITE_HELIUS_API_KEY
 * - VITE_FIREBASE_API_KEY
 */

// NOTE: These are *public* client-side keys (shipped in the bundle) and were previously
// hardcoded fallbacks in `src/lib/helius.ts` and `src/lib/firebase.ts`.
// Env overrides are supported for deployments that want to rotate/override them.
const DEFAULT_HELIUS_API_KEY = 'b59d8426-e980-4028-bfeb-0d9c7c54582b';
const DEFAULT_FIREBASE_API_KEY = 'AIzaSyA3NTv_zfVYMB2VNORxbKg3rJUsiMXIhko';

function env(name: 'VITE_HELIUS_API_KEY' | 'VITE_FIREBASE_API_KEY'): string {
  const raw = (import.meta.env as any)?.[name] as string | undefined;
  return (raw || '').trim();
}

export const FRONTEND_RUNTIME = {
  heliusApiKey: env('VITE_HELIUS_API_KEY') || DEFAULT_HELIUS_API_KEY,
  firebaseApiKey: env('VITE_FIREBASE_API_KEY') || DEFAULT_FIREBASE_API_KEY,
} as const;

export type FrontendRuntimeConfig = typeof FRONTEND_RUNTIME;


