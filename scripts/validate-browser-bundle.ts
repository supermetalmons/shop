import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const distDirectory = resolve(process.cwd(), 'dist');
const forbidden = [
  'helius-rpc.com',
  'api.helius.xyz',
  'VITE_HELIUS_API_KEY',
  'HELIUS_API_KEY',
  'api-key=',
  'api.mainnet-beta.solana.com',
  'api.devnet.solana.com',
  'api.testnet.solana.com',
];

function listFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = resolve(directory, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

const violations = listFiles(distDirectory).flatMap((path) => {
  const text = readFileSync(path).toString('utf8');
  return forbidden.filter((value) => text.includes(value)).map((value) => ({ path, value }));
});

if (violations.length) {
  violations.forEach(({ path, value }) => console.error(`[browser-bundle] Found ${value} in ${path}`));
  process.exitCode = 1;
} else {
  console.log('[browser-bundle] No direct Helius credentials/endpoints or Solana public RPC hosts found.');
}
