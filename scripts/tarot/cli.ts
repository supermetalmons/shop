import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';
import { createD1MaintenanceRunner, loadD1Credentials } from '../shared/d1MaintenanceRunner.ts';
import { environmentStorage } from '../ethereum-metadata/storage.ts';
import { generateTarotMetadata, publishTarotMetadata, verifyPublicTarotMetadata, verifyTarotMedia } from './catalog.ts';
import { assertExistingTarotCredentialPin, createTarotClaimLinks, loadTarotClaimLinks,
  privateDirectory, recordVerifiedTarotCredentials, tarotCredentialSql, verifyTarotCredentials } from './claimLinks.ts';
import { bindMainnetCredentials, createMainnetClaimLinks, loadMainnetClaimLinks, mainnetBindingConfiguration,
  mainnetBindingRpc, mainnetCredentialFingerprint,
  stageMainnetCredentials, verifyMainnetCredentials } from './mainnetClaims.ts';
import { withMetadataLock } from '../ethereum-metadata/lock.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

async function configureStorage(): Promise<void> {
  loadD1Credentials(root);
  for (const name of ['.env.local', '.env']) {
    const file = resolve(root, name);
    if (!existsSync(file)) continue;
    const values = parseEnv(readFileSync(file, 'utf8'));
    for (const key of ['R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_SESSION_TOKEN', 'CLOUDFLARE_API_TOKEN_ID']) {
      if (!process.env[key] && values[key]) process.env[key] = values[key];
    }
  }
  const accountId = 'e25f90fc073ea309b54b8b5144bf28e0';
  process.env.CLOUDFLARE_ACCOUNT_ID ??= accountId;
  if (!process.env.R2_ACCESS_KEY_ID && !process.env.CLOUDFLARE_API_TOKEN_ID && process.env.CLOUDFLARE_API_TOKEN) {
    for (const endpoint of [`accounts/${accountId}/tokens/verify`, 'user/tokens/verify']) {
      const response = await fetch(`https://api.cloudflare.com/client/v4/${endpoint}`, {
        headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` }, signal: AbortSignal.timeout(30_000),
      });
      const result = await response.json() as { success?: boolean; result?: { id?: string; status?: string } };
      if (response.ok && result.success && result.result?.status === 'active' && /^[a-f0-9]{32}$/.test(result.result.id || '')) {
        process.env.CLOUDFLARE_API_TOKEN_ID = result.result.id;
        break;
      }
    }
  }
}

export async function runTarotOperations(argv: string[]) {
  const { values, positionals, tokens } = parseArgs({ args: argv, allowPositionals: true, tokens: true,
    options: { directory: { type: 'string' }, contract: { type: 'string' }, 'deployment-block': { type: 'string' },
      'deployment-transaction': { type: 'string' } } });
  const options = tokens.filter(token => token.kind === 'option').map(token => token.name);
  const command = positionals[0];
  if (positionals.length !== 1 || new Set(options).size !== options.length ||
    !['metadata', 'verify-media', 'publish', 'verify-public', 'links', 'provision', 'verify-codes',
      'mainnet-links', 'mainnet-provision', 'mainnet-verify', 'mainnet-bind'].includes(command)) {
    throw new Error('Use metadata|verify-media|publish|verify-public|links|provision|verify-codes|mainnet-links|mainnet-provision|mainnet-verify|mainnet-bind [--directory PATH] [--contract ADDRESS for links or mainnet-bind] [--deployment-block BLOCK --deployment-transaction HASH for mainnet-bind].');
  }
  if (command !== 'mainnet-bind' && values['deployment-block'] !== undefined) throw new Error('--deployment-block is only allowed for mainnet-bind.');
  if (command !== 'mainnet-bind' && values['deployment-transaction'] !== undefined) throw new Error('--deployment-transaction is only allowed for mainnet-bind.');
  if (command.startsWith('mainnet-')) {
    const binding = command === 'mainnet-bind'
      ? mainnetBindingConfiguration(values.contract, values['deployment-block'], values['deployment-transaction']) : null;
    const rpc = binding ? mainnetBindingRpc() : null;
    if (!binding && values.contract !== undefined) throw new Error('Mainnet staging must not bind a contract.');
    const directory = resolve(root, values.directory || '.operations/dmx-mainnet-v1');
    privateDirectory(directory, root);
    return withMetadataLock(resolve(directory, 'claim-links.lock'), async () => {
      const manifest = command === 'mainnet-links'
        ? createMainnetClaimLinks(directory, root) : loadMainnetClaimLinks(directory, root);
      const fingerprint = mainnetCredentialFingerprint(manifest);
      const files = { privateManifest: resolve(directory, 'claim-links.private.json'),
        csv: resolve(directory, 'claim-links.private.csv') };
      if (command === 'mainnet-links') return { operation: command, chainId: 1, batchId: manifest.batchId,
        credentialCount: manifest.links.length, credentialSetSha256: fingerprint,
        status: 'local', contractAddress: null, verified: false, ...files };
      loadD1Credentials(root);
      const database = createD1MaintenanceRunner('ops');
      const verified = binding && rpc ? await bindMainnetCredentials(manifest, database, binding, rpc)
        : command === 'mainnet-provision' ? stageMainnetCredentials(manifest, database) : verifyMainnetCredentials(manifest, database);
      if (mainnetCredentialFingerprint(loadMainnetClaimLinks(directory, root)) !== fingerprint) {
        throw new Error('Private mainnet files changed during provisioning.');
      }
      return { operation: command, ...verified, ...files };
    });
  }
  if (command === 'metadata') return generateTarotMetadata(resolve(root, values.directory || '.cache/tarot-sepolia-v1/metadata'));
  if (command === 'verify-media') return verifyTarotMedia();
  if (command === 'verify-public') return verifyPublicTarotMetadata();
  if (command === 'publish') {
    await configureStorage();
    const storage = environmentStorage(16);
    try { return await publishTarotMetadata(storage); } finally { storage.close(); }
  }
  const directory = resolve(root, values.directory || '.operations/tarot-sepolia-v1');
  const manifest = command === 'links' ? createTarotClaimLinks(directory, values.contract || '', root) : loadTarotClaimLinks(directory, root);
  if (command !== 'links') {
    assertExistingTarotCredentialPin(manifest, root);
    loadD1Credentials(root);
    const database = createD1MaintenanceRunner('ops');
    const query = `SELECT chain_id,contract_address,token_id,code_hash,created_at_ms,revoked_at_ms FROM tarot_claim_codes WHERE chain_id=${manifest.chainId} AND contract_address='${manifest.contractAddress}' ORDER BY token_id`;
    let rows = database.query(query);
    if (command === 'provision') {
      verifyTarotCredentials(manifest, rows, false);
      database.executeCommand(tarotCredentialSql(manifest));
      rows = database.query(query);
    }
    recordVerifiedTarotCredentials(manifest, rows, root);
  }
  return { operation: command, chainId: manifest.chainId, contractAddress: manifest.contractAddress,
    credentialCount: manifest.links.length, privateManifest: resolve(directory, 'claim-links.private.json'), verified: true };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runTarotOperations(process.argv.slice(2)).then(result => console.log(JSON.stringify(result)), () => {
    console.error('Tarot operation failed. Check configuration, deployment scope, and the private manifest; no secrets were printed.');
    process.exitCode = 1;
  });
}
