import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Manual Cloudflare releases point this at an empty temporary directory so
  // developer-only .env files cannot change the deployed client configuration.
  envDir: process.env.MONS_SHOP_VITE_ENV_DIR || undefined,
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
});
