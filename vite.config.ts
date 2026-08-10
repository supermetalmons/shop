import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { normalizeMonsApiOrigin } from './src/lib/monsApiOrigin.ts';

function publicSolanaRpcReplacements(apiOrigin: string): ReadonlyMap<string, string> {
  return new Map([
    ['https://api.mainnet-beta.solana.com/', `${apiOrigin}/rpc/mainnet-beta`],
    ['http://api.mainnet-beta.solana.com/', `${apiOrigin}/rpc/mainnet-beta`],
    ['https://api.devnet.solana.com/', `${apiOrigin}/rpc/devnet`],
    ['http://api.devnet.solana.com/', `${apiOrigin}/rpc/devnet`],
    ['https://api.mainnet-beta.solana.com', `${apiOrigin}/rpc/mainnet-beta`],
    ['http://api.mainnet-beta.solana.com', `${apiOrigin}/rpc/mainnet-beta`],
    ['https://api.devnet.solana.com', `${apiOrigin}/rpc/devnet`],
    ['http://api.devnet.solana.com', `${apiOrigin}/rpc/devnet`],
  ]);
}

export function rewriteDependencyPublicRpcFallbacks(code: string, id: string, apiOrigin: string): string | undefined {
  if (!id.includes('/node_modules/')) return undefined;
  let transformed = code;
  for (const [publicRpc, shopRpc] of publicSolanaRpcReplacements(apiOrigin)) {
    transformed = transformed.replaceAll(publicRpc, shopRpc);
  }
  return transformed === code ? undefined : transformed;
}

export function redirectDependencyPublicRpcFallbacks(apiOrigin: string): Plugin {
  return {
    name: 'redirect-dependency-public-rpc-fallbacks',
    enforce: 'pre',
    transform(code, id) {
      const transformed = rewriteDependencyPublicRpcFallbacks(code, id, apiOrigin);
      return transformed === undefined ? null : { code: transformed, map: null };
    },
  };
}

export default defineConfig(({ mode }) => {
  const configuredEnvDir = process.env.MONS_SHOP_VITE_ENV_DIR;
  const environment = loadEnv(mode, configuredEnvDir || process.cwd(), 'VITE_');
  const apiOrigin = normalizeMonsApiOrigin(environment.VITE_MONS_API_ORIGIN);

  return {
    plugins: [redirectDependencyPublicRpcFallbacks(apiOrigin), react()],

    envDir: configuredEnvDir || undefined,
    envPrefix: ['VITE_', 'STRIPE_TEST_UNIT_AMOUNT_CENTS'],

    // Vite 7 externalizes Node built-ins by default. We need the npm `buffer` polyfill
    // for Solana web3.js and our client code.
    resolve: {
      alias: {
        buffer: 'buffer/',
      },
    },
    define: {
      global: 'globalThis',
    },
    server: {
      port: 5173,
      allowedHosts: ['.trycloudflare.com'],
    },
    build: {
      outDir: 'dist',
    },
  };
});
