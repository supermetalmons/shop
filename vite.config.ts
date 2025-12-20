import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
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
  },
  build: {
    outDir: 'dist',
  },
});
