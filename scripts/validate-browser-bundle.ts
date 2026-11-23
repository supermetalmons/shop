import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveTarotConfig, TAROT_MAX_CARDS } from '../shared/ethereum/tarot.ts';
import { assertTarotCredentialPin, TAROT_CREDENTIAL_PIN_PATH, type TarotClaimLinks } from './tarot/claimLinks.ts';

const options = process.argv.slice(2);
if (options.length > 1 || options.some(option => option !== '--require-tarot-manifest')) {
  console.error('[browser-bundle] Use --require-tarot-manifest for release scans.');
  process.exit(1);
}
const requireTarotManifest = options.includes('--require-tarot-manifest');

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
  'ETHEREUM_TAROT_SEPOLIA_SIGNER_SECRET',
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

const tarotManifest = resolve(process.env.ETHEREUM_TAROT_PRIVATE_MANIFEST || '.operations/tarot-sepolia-v1/claim-links.private.json');
let tarotCodes: string[] = [];
if (requireTarotManifest || existsSync(tarotManifest) || process.env.ETHEREUM_TAROT_PRIVATE_MANIFEST) {
  try {
    const manifest = JSON.parse(readFileSync(tarotManifest, 'utf8')) as TarotClaimLinks;
    if (requireTarotManifest) {
      const pin = JSON.parse(readFileSync(new URL('../' + TAROT_CREDENTIAL_PIN_PATH, import.meta.url), 'utf8'));
      assertTarotCredentialPin(manifest, pin);
      const api = JSON.parse(readFileSync(new URL('../cloud/workers/api/wrangler.jsonc', import.meta.url), 'utf8')) as {
        vars?: { ETHEREUM_TAROT_SEPOLIA_CONTRACT_ADDRESS?: string };
      };
      const expected = resolveTarotConfig({ contractAddress: api.vars?.ETHEREUM_TAROT_SEPOLIA_CONTRACT_ADDRESS });
      if (!expected.contractAddress || manifest.chainId !== expected.chainId || manifest.contractAddress !== expected.contractAddress) throw new Error();
    } else if (manifest.links.length !== TAROT_MAX_CARDS || manifest.links.some(link => typeof link.code !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(link.code))) throw new Error();
    tarotCodes = manifest.links.map(link => link.code);
  } catch {
    console.error(requireTarotManifest
      ? '[browser-bundle] A valid private Tarot manifest for the configured deployment is required, matching its verified credential-set fingerprint.'
      : '[browser-bundle] Invalid private Tarot manifest.');
    process.exit(1);
  }
}

function listFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = resolve(directory, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

const violations = listFiles(distDirectory).flatMap((path) => {
  const text = readFileSync(path).toString('utf8');
  const tarotText = tarotCodes.length ? text.toLowerCase() : '';
  return [
    ...forbiddenStrings.filter((value) => text.includes(value)).map(() => 'a forbidden provider endpoint or private binding'),
    ...forbiddenPatterns.filter(({ pattern }) => pattern.test(text)).map(({ label }) => label),
    ...(accessCodes.some(code => text.includes(code)) ? ['a configured relic access code'] : []),
    ...(tarotCodes.some(code => tarotText.includes(code)) ? ['a configured Tarot claim code'] : []),
  ];
});

if (violations.length) {
  new Set(violations).forEach(label => console.error(`[browser-bundle] Found ${label} in browser output.`));
  process.exitCode = 1;
} else {
  console.log('[browser-bundle] No private credentials, relic access codes, or direct provider endpoints found.');
}
