import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ACCOUNT_COMPRESSION,
  ADMIN,
  BUBBLEGUM,
  COLLECTION,
  LIVE_PROGRAM_CAPACITY,
  LIVE_PROGRAM_SHA256,
  MAINNET_GENESIS,
  MPL_CORE,
  PROGRAM_DATA,
  PROGRAM_ID,
  RECEIPTS_TREE,
  RECEIPTS_TREE_CONFIG,
  SHARED_CONFIGS,
  UPGRADEABLE_LOADER,
  accountData,
  assertCardConfig,
  assertReceiptTreeConfig,
  authorityIncludes,
  classifyCollectionAsset,
  configuredMainnetRpc,
  decodeConfig,
  inCollection,
  repositoryRoot,
  rpc,
  sanitizedRpcUrl,
  searchAllCollectionAssets,
  sha256,
} from './shared/cardNft2UriMigration.ts';

const args = process.argv.slice(2);
if (args.some((arg) => /keypair|private|secret|signer|send|rpc-url/i.test(arg))) {
  throw new Error('The archival client is read-only and does not accept signing material or RPC arguments');
}
let outputDirectory: string | undefined;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] !== '--out') throw new Error(`Unknown option: ${args[index]}`);
  outputDirectory = path.resolve(String(args[++index] || '').trim());
  if (!outputDirectory) throw new Error('--out requires a directory');
}

const { rpcUrl, rpcSource } = configuredMainnetRpc();
const genesisHash = await rpc<string>(rpcUrl, 'getGenesisHash');
if (genesisHash !== MAINNET_GENESIS) throw new Error(`Unexpected genesis hash ${genesisHash}`);

const accountAddresses = [
  PROGRAM_ID,
  PROGRAM_DATA,
  ...Object.values(SHARED_CONFIGS),
  COLLECTION,
  RECEIPTS_TREE,
  RECEIPTS_TREE_CONFIG,
  ADMIN,
];
const responses = await Promise.all(accountAddresses.map((address) => rpc<any>(rpcUrl, 'getAccountInfo', [
  address.toBase58(),
  { encoding: 'base64', commitment: 'finalized' },
])));
const responseByAddress = new Map(accountAddresses.map((address, index) => [address.toBase58(), responses[index]]));
const programResponse = responseByAddress.get(PROGRAM_ID.toBase58());
const programDataResponse = responseByAddress.get(PROGRAM_DATA.toBase58());
const programData = accountData(programResponse, PROGRAM_ID.toBase58());
const rawProgramData = accountData(programDataResponse, PROGRAM_DATA.toBase58());
if (programResponse.value.owner !== UPGRADEABLE_LOADER.toBase58() || !programResponse.value.executable) {
  throw new Error('Program owner or executable state mismatch');
}
if (programData.readUInt32LE(0) !== 2
  || !programData.subarray(4, 36).equals(PROGRAM_DATA.toBuffer())) {
  throw new Error('Program account state mismatch');
}
if (programDataResponse.value.owner !== UPGRADEABLE_LOADER.toBase58()
  || rawProgramData.readUInt32LE(0) !== 3
  || rawProgramData[12] !== 1) {
  throw new Error('ProgramData state mismatch');
}
const upgradeAuthority = new (await import('@solana/web3.js')).PublicKey(rawProgramData.subarray(13, 45));
if (!upgradeAuthority.equals(ADMIN)) throw new Error(`Unexpected upgrade authority ${upgradeAuthority}`);
const deploymentSlot = Number(rawProgramData.readBigUInt64LE(4));
const livePayload = rawProgramData.subarray(45);
if (livePayload.length !== LIVE_PROGRAM_CAPACITY) {
  throw new Error(`Live ProgramData capacity is ${livePayload.length}, expected ${LIVE_PROGRAM_CAPACITY}`);
}
if (sha256(livePayload) !== LIVE_PROGRAM_SHA256) {
  throw new Error(`Live ProgramData hash is ${sha256(livePayload)}, expected ${LIVE_PROGRAM_SHA256}`);
}

const configs: Record<string, any> = {};
for (const [dropId, address] of Object.entries(SHARED_CONFIGS)) {
  const response = responseByAddress.get(address.toBase58());
  const data = accountData(response, address.toBase58());
  if (response.value.owner !== PROGRAM_ID.toBase58()) throw new Error(`Config owner mismatch: ${dropId}`);
  const decoded = decodeConfig(data);
  if (dropId === 'card_nft_2') assertCardConfig(decoded);
  configs[dropId] = {
    address: address.toBase58(),
    bytes: data.length,
    sha256: sha256(data),
    lamports: response.value.lamports,
    decoded,
  };
}

const collectionResponse = responseByAddress.get(COLLECTION.toBase58());
const treeResponse = responseByAddress.get(RECEIPTS_TREE.toBase58());
const treeConfigResponse = responseByAddress.get(RECEIPTS_TREE_CONFIG.toBase58());
const collectionRaw = accountData(collectionResponse, COLLECTION.toBase58());
const treeRaw = accountData(treeResponse, RECEIPTS_TREE.toBase58());
const treeConfigRaw = accountData(treeConfigResponse, RECEIPTS_TREE_CONFIG.toBase58());
if (collectionResponse.value.owner !== MPL_CORE.toBase58()) throw new Error('Collection raw account owner mismatch');
if (treeResponse.value.owner !== ACCOUNT_COMPRESSION.toBase58()) throw new Error('Receipt tree owner mismatch');
if (treeConfigResponse.value.owner !== BUBBLEGUM.toBase58()) throw new Error('Receipt TreeConfig owner mismatch');
const treeConfigAuthority = assertReceiptTreeConfig(treeConfigRaw);
const [collectionAsset, inventory] = await Promise.all([
  rpc<any>(rpcUrl, 'getAsset', { id: COLLECTION.toBase58() }),
  searchAllCollectionAssets(rpcUrl),
]);
if (collectionAsset.id !== COLLECTION.toBase58() || !authorityIncludes(collectionAsset)) {
  throw new Error('Collection DAS authority mismatch');
}
for (const asset of inventory.assets) {
  if (!inCollection(asset)) throw new Error(`Collection grouping mismatch: ${asset.id}`);
}
const classified = classifyCollectionAsset(inventory.assets, configs.card_nft_2.decoded.uriBase, configs.card_nft_2.decoded.uriBase);

const timestamp = new Date().toISOString();
const output = outputDirectory || path.join(
  repositoryRoot(),
  '.cache',
  'card-nft-2-mainnet-archive',
  `${deploymentSlot}-${timestamp.replaceAll(':', '-')}`,
);
await mkdir(path.join(output, 'configs'), { recursive: true, mode: 0o700 });
await Promise.all([
  writeFile(path.join(output, 'program-account.bin'), programData, { mode: 0o600 }),
  writeFile(path.join(output, 'programdata-account.bin'), rawProgramData, { mode: 0o600 }),
  writeFile(path.join(output, 'live-program-payload.so'), livePayload, { mode: 0o600 }),
  writeFile(path.join(output, 'collection-account.bin'), collectionRaw, { mode: 0o600 }),
  writeFile(path.join(output, 'receipt-tree-account.bin'), treeRaw, { mode: 0o600 }),
  writeFile(path.join(output, 'receipt-tree-config-account.bin'), treeConfigRaw, { mode: 0o600 }),
  ...Object.entries(SHARED_CONFIGS).map(([dropId, address]) => writeFile(
    path.join(output, 'configs', `${dropId}.bin`),
    accountData(responseByAddress.get(address.toBase58()), address.toBase58()),
    { mode: 0o600 },
  )),
]);

const compactAsset = (asset: any) => ({
  id: asset.id,
  interface: asset.interface ?? null,
  jsonUri: asset.content?.json_uri ?? null,
  name: asset.content?.metadata?.name ?? null,
  grouping: asset.grouping ?? [],
  compressed: asset.compression?.compressed ?? false,
  tree: asset.compression?.tree ?? null,
  leafId: asset.compression?.leaf_id ?? null,
  burnt: asset.burnt ?? false,
  mutable: asset.mutable ?? null,
  owner: asset.ownership?.owner ?? null,
  delegate: asset.ownership?.delegate ?? null,
  authorities: asset.authorities ?? [],
});
const snapshot = {
  schemaVersion: 1,
  capturedAt: timestamp,
  commitment: 'finalized',
  genesisHash,
  rpc: sanitizedRpcUrl(rpcUrl),
  rpcCredential: rpcSource,
  program: {
    address: PROGRAM_ID.toBase58(),
    programData: PROGRAM_DATA.toBase58(),
    deploymentSlot,
    upgradeAuthority: upgradeAuthority.toBase58(),
    payloadBytes: livePayload.length,
    payloadSha256: sha256(livePayload),
    rawProgramDataBytes: rawProgramData.length,
    rawProgramDataSha256: sha256(rawProgramData),
  },
  configs,
  collection: {
    address: COLLECTION.toBase58(),
    accountBytes: collectionRaw.length,
    accountSha256: sha256(collectionRaw),
    das: compactAsset(collectionAsset),
  },
  receipts: {
    tree: RECEIPTS_TREE.toBase58(),
    treeBytes: treeRaw.length,
    treeSha256: sha256(treeRaw),
    treeConfig: RECEIPTS_TREE_CONFIG.toBase58(),
    treeConfigBytes: treeConfigRaw.length,
    treeConfigSha256: sha256(treeConfigRaw),
    treeConfigAuthority,
  },
  inventory: {
    pages: inventory.pages,
    totalUnique: inventory.assets.length,
    liveCore: classified.coreTargets.length + classified.alreadyTarget.core,
    liveReceipts: classified.receiptTargets.length + classified.alreadyTarget.receipts,
    burnedCore: classified.burned.core,
    burnedReceipts: classified.burned.receipts,
    assets: inventory.assets.map(compactAsset).sort((left, right) => left.id.localeCompare(right.id)),
  },
};
await writeFile(path.join(output, 'snapshot.json'), `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
console.log('Card NFT 2 finalized mainnet archive complete.');
console.log('output               :', output);
console.log('deployment slot      :', deploymentSlot);
console.log('ProgramData capacity :', livePayload.length);
console.log('ProgramData SHA-256  :', sha256(livePayload));
console.log('DAS pages            :', inventory.pages);
console.log('unique assets        :', inventory.assets.length);
console.log('all four configs     : archived');
