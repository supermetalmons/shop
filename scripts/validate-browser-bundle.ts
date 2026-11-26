import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveTarotConfig, TAROT_MAX_CARDS } from '../shared/ethereum/tarot.ts';
import { assertTarotCredentialPin, TAROT_CREDENTIAL_PIN_PATH, type TarotClaimLinks } from './tarot/claimLinks.ts';
import { mainnetCredentialFingerprint } from './tarot/mainnetClaims.ts';

const options = process.argv.slice(2);
if (options.length > 1 || options.some(option => option !== '--require-tarot-manifest')) {
  console.error('[browser-bundle] Use --require-tarot-manifest for release scans.');
  process.exit(1);
}
const requireTarotManifest = options.includes('--require-tarot-manifest');
const apiVars = requireTarotManifest ? (JSON.parse(readFileSync(
  new URL('../cloud/workers/api/wrangler.jsonc', import.meta.url), 'utf8')) as {
  vars?: {
    ETHEREUM_TAROT_SEPOLIA_CONTRACT_ADDRESS?: string;
    ETHEREUM_TAROT_MAINNET_CONTRACT_ADDRESS?: string;
    ETHEREUM_TAROT_MAINNET_ENABLED?: string;
  };
}).vars : undefined;

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
  'ETHEREUM_TAROT_MAINNET_SIGNER_SECRET',
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

const tarotManifest = resolve(process.env.ETHEREUM_TAROT_PRIVATE_MANIFEST || '.operations/dmx-sepolia-v3/claim-links.private.json');
let tarotCodes: string[] = [];
if (requireTarotManifest || existsSync(tarotManifest) || process.env.ETHEREUM_TAROT_PRIVATE_MANIFEST) {
  try {
    const manifest = JSON.parse(readFileSync(tarotManifest, 'utf8')) as TarotClaimLinks;
    if (requireTarotManifest) {
      const pin = JSON.parse(readFileSync(new URL('../' + TAROT_CREDENTIAL_PIN_PATH, import.meta.url), 'utf8'));
      assertTarotCredentialPin(manifest, pin);
      const expected = resolveTarotConfig({ testnet: true, contractAddress: apiVars?.ETHEREUM_TAROT_SEPOLIA_CONTRACT_ADDRESS });
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

const mainnetManifest = resolve(process.env.ETHEREUM_DMX_MAINNET_PRIVATE_MANIFEST || '.operations/dmx-mainnet-v1/claim-links.private.json');
const requireMainnetManifest = requireTarotManifest && !!(apiVars?.ETHEREUM_TAROT_MAINNET_CONTRACT_ADDRESS ||
  apiVars?.ETHEREUM_TAROT_MAINNET_ENABLED === 'true');
let mainnetCodes: string[] = [];
if (requireMainnetManifest || existsSync(mainnetManifest) || process.env.ETHEREUM_DMX_MAINNET_PRIVATE_MANIFEST) {
  try {
    const manifest: Parameters<typeof mainnetCredentialFingerprint>[0] = JSON.parse(readFileSync(mainnetManifest, 'utf8'));
    const fingerprint = mainnetCredentialFingerprint(manifest);
    if (requireMainnetManifest) {
      const { contractAddress } = resolveTarotConfig({ contractAddress: apiVars?.ETHEREUM_TAROT_MAINNET_CONTRACT_ADDRESS });
      const pin = JSON.parse(readFileSync(new URL('../releases/dmx-mainnet-v1/credential-binding.json', import.meta.url), 'utf8'));
      if (!contractAddress || !pin || pin.chainId !== 1 || pin.collectionKey !== manifest.collectionKey ||
        pin.contractAddress !== contractAddress || pin.status !== 'bound' || pin.credentialCount !== TAROT_MAX_CARDS ||
        pin.allCredentialsVerified !== true || pin.credentialSetSha256 !== fingerprint ||
        typeof pin.checkedAt !== 'string' || !Number.isFinite(Date.parse(pin.checkedAt))) throw new Error();
    }
    mainnetCodes = manifest.links.map(link => link.code);
  } catch {
    console.error(requireMainnetManifest
      ? '[browser-bundle] A valid private DMX mainnet manifest matching the configured deployment and verified credential-set fingerprint is required.'
      : '[browser-bundle] Invalid private DMX mainnet staging manifest.');
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
  const tarotText = tarotCodes.length || mainnetCodes.length ? text.toLowerCase() : '';
  return [
    ...forbiddenStrings.filter((value) => text.includes(value)).map(() => 'a forbidden provider endpoint or private binding'),
    ...forbiddenPatterns.filter(({ pattern }) => pattern.test(text)).map(({ label }) => label),
    ...(accessCodes.some(code => text.includes(code)) ? ['a configured relic access code'] : []),
    ...(tarotCodes.some(code => tarotText.includes(code)) ? ['a configured Tarot claim code'] : []),
    ...(mainnetCodes.some(code => tarotText.includes(code)) ? ['a configured DMX mainnet claim code'] : []),
  ];
});

if (violations.length) {
  new Set(violations).forEach(label => console.error(`[browser-bundle] Found ${label} in browser output.`));
  process.exitCode = 1;
} else {
  console.log('[browser-bundle] No private credentials, relic access codes, or direct provider endpoints found.');
}
