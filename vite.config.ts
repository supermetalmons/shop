import { defineConfig, loadEnv, type Plugin, type UserConfig } from 'vite';
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

export function resolveViteClientSettings(
  mode: string,
  environmentDirectory = process.cwd(),
  buildTimeMilliseconds = Date.now(),
) {
  const production = mode === 'production';
  const environment = production ? {} : loadEnv(mode, environmentDirectory, 'VITE_');
  const apiOrigin = normalizeMonsApiOrigin(environment.VITE_MONS_API_ORIGIN);

  return {
    apiOrigin,
    envDir: production ? false as const : environmentDirectory,
    envPrefix: production ? [] : ['VITE_', 'STRIPE_TEST_UNIT_AMOUNT_CENTS'],
    buildDatetime: production ? String(Math.floor(buildTimeMilliseconds / 1000)) : undefined,
  };
}

export function createViteConfig(
  mode: string,
  environmentDirectory = process.cwd(),
  buildTimeMilliseconds = Date.now(),
): UserConfig {
  const settings = resolveViteClientSettings(mode, environmentDirectory, buildTimeMilliseconds);

  return {
    plugins: [redirectDependencyPublicRpcFallbacks(settings.apiOrigin), react()],

    envDir: settings.envDir,
    envPrefix: settings.envPrefix,

    // Vite 7 externalizes Node built-ins by default. We need the npm `buffer` polyfill
    // for Solana web3.js and our client code.
    resolve: {
      alias: {
        buffer: 'buffer/',
      },
    },
    define: {
      global: 'globalThis',
      ...(settings.buildDatetime === undefined
        ? {}
        : { 'import.meta.env.VITE_BUILD_DATETIME': JSON.stringify(settings.buildDatetime) }),
    },
    server: {
      port: 5173,
      allowedHosts: ['.trycloudflare.com'],
      proxy: {
        '/api': {
          target: settings.apiOrigin,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api(?=\/|$)/, ''),
        },
      },
    },
    build: {
      outDir: 'dist',
    },
  };
}

export default defineConfig(({ mode }) => createViteConfig(mode));
