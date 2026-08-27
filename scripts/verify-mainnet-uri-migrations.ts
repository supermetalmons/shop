import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ACCOUNT_COMPRESSION,
  ADMIN,
  BUBBLEGUM,
  KNOWN_DEPLOYMENT_BUFFERS,
  MAINNET_GENESIS,
  MAINNET_URI_DROPS,
  MPL_CORE,
  assertConfigState,
  assertNoMutableLegacy,
  assertProgramState,
  assertTreeConfig,
  assertUpgradeTransaction,
  paginateDasAssets,
  parseRawCollection,
  parseRawCoreAsset,
  scanInventory,
} from './shared/mainnetUriMigrationVerification.ts';

type RpcAccount = {
  executable: boolean;
  owner: string;
  data: [string, 'base64'];
};

const argv = process.argv.slice(2);
if (argv.some((arg) => /send|keypair|private|secret|signer|rpc-url/i.test(arg))) {
  throw new Error('The verifier is read-only and does not accept signing material, send flags, or RPC arguments');
}
let outputPath: string | undefined;
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] !== '--output') throw new Error(`Unknown option: ${argv[index]}`);
  const value = String(argv[++index] || '').trim();
  if (!value) throw new Error('--output requires a path');
  outputPath = path.resolve(value);
}

const apiKey = process.env.HELIUS_API_KEY?.trim();
const rpcUrl = process.env.MAINNET_RPC_URL?.trim()
  || (apiKey ? `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}` : '');
if (!rpcUrl) throw new Error('HELIUS_API_KEY or MAINNET_RPC_URL is required');
const sanitizedRpc = (() => {
  const value = new URL(rpcUrl);
  return `${value.protocol}//${value.host}${value.pathname}`;
})();

let sequence = 0;
async function rpc<T>(method: string, params: unknown = []): Promise<T> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method, params }),
    });
    const payload = response.ok
      ? await response.json() as { result?: T; error?: { code?: number; message?: string } }
      : undefined;
    if (response.ok && !payload?.error) return payload?.result as T;
    const retryable = response.status === 429
      || response.status >= 500
      || payload?.error?.code === 429
      || payload?.error?.code === -32005;
    if (!retryable) throw new Error(`${method}: ${payload?.error?.message || `HTTP ${response.status}`}`);
    if (attempt === 7) throw new Error(`${method}: RPC retry limit exceeded`);
    const retryAfter = Number(response.headers.get('retry-after'));
    const delay = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1_000
      : Math.min(6_000, 250 * 2 ** attempt) + Math.floor(Math.random() * 200);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  throw new Error(`${method}: unreachable retry state`);
}

function accountData(account: RpcAccount | null, address: string): Buffer {
  if (!account) throw new Error(`Missing account ${address}`);
  if (!Array.isArray(account.data) || account.data[1] !== 'base64') {
    throw new Error(`Unexpected account encoding for ${address}`);
  }
  return Buffer.from(account.data[0], 'base64');
}

async function getAccount(address: string): Promise<RpcAccount> {
  const result = await rpc<{ value: RpcAccount | null }>('getAccountInfo', [
    address,
    { commitment: 'finalized', encoding: 'base64' },
  ]);
  if (!result?.value) throw new Error(`Missing account ${address}`);
  return result.value;
}

async function verifyDrop(spec: (typeof MAINNET_URI_DROPS)[number]) {
  const attestation = spec.programAttestation;
  const [
    program,
    programDataAccount,
    configAccount,
    collectionAccount,
    treeAccount,
    treeConfigAccount,
    upgradeTransaction,
  ] = await Promise.all([
    getAccount(attestation.address),
    getAccount(attestation.programData),
    getAccount(spec.config),
    getAccount(spec.collection),
    getAccount(spec.receiptsTree),
    getAccount(spec.receiptsTreeConfig),
    rpc<unknown>('getTransaction', [
      attestation.upgradeSignature,
      { commitment: 'finalized', encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
    ]),
  ]);
  const programData = assertProgramState(
    spec,
    program.owner,
    program.executable,
    accountData(program, attestation.address),
    programDataAccount.owner,
    accountData(programDataAccount, attestation.programData),
  );
  assertUpgradeTransaction(spec, upgradeTransaction);
  const config = assertConfigState(spec, configAccount.owner, accountData(configAccount, spec.config));
  if (collectionAccount.owner !== MPL_CORE) throw new Error(`${spec.dropId} collection owner mismatch`);
  const collection = parseRawCollection(accountData(collectionAccount, spec.collection));
  if (collection.updateAuthority !== spec.collectionUpdateAuthority
    || collection.uri !== `${spec.canonicalBase}/collection.json`) {
    throw new Error(`${spec.dropId} collection mismatch`);
  }
  assertTreeConfig(
    spec,
    treeAccount.owner,
    treeConfigAccount.owner,
    accountData(treeConfigAccount, spec.receiptsTreeConfig),
  );
  const inventory = await paginateDasAssets((page) => rpc<any>('searchAssets', {
    grouping: ['collection', spec.collection],
    page,
    limit: 1_000,
    options: { showUnverifiedCollections: true, showCollectionMetadata: true },
  }));
  const summary = scanInventory(spec, config, inventory.assets, inventory.pages);
  assertNoMutableLegacy(summary, spec.dropId);
  for (let offset = 0; offset < summary.liveCoreAssets.length; offset += 100) {
    const group = summary.liveCoreAssets.slice(offset, offset + 100);
    const accounts = await rpc<{ value: Array<RpcAccount | null> }>('getMultipleAccounts', [
      group.map((asset) => asset.id),
      { commitment: 'finalized', encoding: 'base64' },
    ]);
    if (!Array.isArray(accounts?.value) || accounts.value.length !== group.length) {
      throw new Error(`${spec.dropId} malformed Core account response`);
    }
    group.forEach((asset, index) => {
      const account = accounts.value[index];
      if (!account || account.owner !== MPL_CORE) throw new Error(`Missing Core account ${asset.id}`);
      const raw = parseRawCoreAsset(accountData(account, String(asset.id)));
      if (raw.updateAuthorityKind !== 2
        || raw.updateAuthority !== spec.collection
        || raw.uri !== String(asset.content?.json_uri || '')) {
        throw new Error(`Raw Core verification failed: ${asset.id}`);
      }
    });
  }
  const { liveCoreAssets: _liveCoreAssets, ...inventoryReport } = summary;
  return {
    dropId: spec.dropId,
    program: {
      address: attestation.address,
      programData: attestation.programData,
      deploymentSlot: programData.slot,
      elfSha256: programData.payloadSha256,
      authority: programData.authority,
      upgradeSignature: attestation.upgradeSignature,
    },
    config: {
      address: spec.config,
      bytes: spec.configBytes,
      sha256: spec.configSha256,
      uriBase: config.uriBase,
      admin: config.admin,
    },
    collection: {
      address: spec.collection,
      name: collection.name,
      uri: collection.uri,
      updateAuthority: collection.updateAuthority,
    },
    receiptInfrastructure: {
      tree: spec.receiptsTree,
      treeOwner: ACCOUNT_COMPRESSION,
      treeConfig: spec.receiptsTreeConfig,
      treeConfigOwner: BUBBLEGUM,
      authority: ADMIN,
    },
    inventory: inventoryReport,
  };
}

const genesisHash = await rpc<string>('getGenesisHash');
if (genesisHash !== MAINNET_GENESIS) throw new Error(`Unexpected genesis hash ${genesisHash}`);
const drops = [];
for (const spec of MAINNET_URI_DROPS) {
  process.stderr.write(`Verifying ${spec.dropId} at finalized commitment...\n`);
  drops.push(await verifyDrop(spec));
}
const buffers = await rpc<{ value: Array<RpcAccount | null> }>('getMultipleAccounts', [
  KNOWN_DEPLOYMENT_BUFFERS,
  { commitment: 'finalized', encoding: 'base64' },
]);
if (!Array.isArray(buffers?.value) || buffers.value.length !== KNOWN_DEPLOYMENT_BUFFERS.length) {
  throw new Error('Malformed deployment buffer response');
}
const openBuffers = KNOWN_DEPLOYMENT_BUFFERS.filter((_, index) => buffers.value[index] !== null);
if (openBuffers.length) throw new Error(`Deployment buffers remain open: ${openBuffers.join(', ')}`);

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  cluster: 'mainnet-beta',
  commitment: 'finalized',
  genesisHash,
  rpc: sanitizedRpc,
  overallPass: true,
  mutableLegacyUris: 0,
  knownDeploymentBuffers: {
    checked: KNOWN_DEPLOYMENT_BUFFERS.length,
    open: [],
  },
  drops,
};
if (outputPath) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}
console.log(JSON.stringify(report, null, 2));
