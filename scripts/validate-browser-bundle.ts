import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const distDirectory = resolve(process.cwd(), 'dist');
const forbiddenStrings = [
  'eth-mainnet.g.alchemy.com',
  'ALCHEMY_MI_NOTE_API_KEY',
  'api.opensea.io',
  'OPENSEA_API_KEY',
  'helius-rpc.com',
  'api.helius.xyz',
  'VITE_HELIUS_API_KEY',
  'HELIUS_API_KEY',
  'api-key=',
  'api.mainnet-beta.solana.com',
  'api.devnet.solana.com',
  'api.testnet.solana.com',
  'ETHEREUM_PRE111K_ACCESS_CODES',
];

const forbiddenPatterns = [
  { label: 'Google API key', pattern: /AIza[0-9A-Za-z_-]{35}/ },
] as const;

function configuredAccessCodes(): string[] | null {
  try {
    const value: unknown = JSON.parse(process.env.ETHEREUM_PRE111K_ACCESS_CODES || '');
    if (!Array.isArray(value) || value.length < 1 || value.length > 32 ||
      value.some(code => typeof code !== 'string' || !code.trim() || code.trim().toUpperCase().length > 64)) return null;
    return [...new Set(value.flatMap((code: string) => [code.trim(), code.trim().toUpperCase()]))];
  } catch { return null; }
}

const accessCodes = configuredAccessCodes();
if (!accessCodes) {
  console.error('[browser-bundle] Configure ETHEREUM_PRE111K_ACCESS_CODES with the private JSON code array before scanning.');
  process.exit(1);
}

function listFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = resolve(directory, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

const violations = listFiles(distDirectory).flatMap((path) => {
  const text = readFileSync(path).toString('utf8');
  return [
    ...forbiddenStrings.filter((value) => text.includes(value)).map(() => 'a forbidden provider endpoint or private binding'),
    ...forbiddenPatterns.filter(({ pattern }) => pattern.test(text)).map(({ label }) => label),
    ...(accessCodes.some(code => text.includes(code)) ? ['a configured relic access code'] : []),
  ];
});

if (violations.length) {
  new Set(violations).forEach(label => console.error(`[browser-bundle] Found ${label} in browser output.`));
  process.exitCode = 1;
} else {
  console.log('[browser-bundle] No private credentials, relic access codes, or direct provider endpoints found.');
}
