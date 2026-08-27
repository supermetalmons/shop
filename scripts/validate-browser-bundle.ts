import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const distDirectory = resolve(process.cwd(), 'dist');
const forbiddenStrings = [
  'helius-rpc.com',
  'api.helius.xyz',
  'VITE_HELIUS_API_KEY',
  'HELIUS_API_KEY',
  'api-key=',
  'api.mainnet-beta.solana.com',
  'api.devnet.solana.com',
  'api.testnet.solana.com',
];

const forbiddenPatterns = [
  { label: 'Google API key', pattern: /AIza[0-9A-Za-z_-]{35}/ },
] as const;

function listFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = resolve(directory, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

const violations = listFiles(distDirectory).flatMap((path) => {
  const text = readFileSync(path).toString('utf8');
  return [
    ...forbiddenStrings.filter((value) => text.includes(value)).map((label) => ({ path, label })),
    ...forbiddenPatterns.filter(({ pattern }) => pattern.test(text)).map(({ label }) => ({ path, label })),
  ];
});

if (violations.length) {
  violations.forEach(({ path, label }) => console.error(`[browser-bundle] Found ${label} in ${path}`));
  process.exitCode = 1;
} else {
  console.log('[browser-bundle] No direct Helius credentials/endpoints, Solana public RPC hosts, or Google API keys found.');
}
