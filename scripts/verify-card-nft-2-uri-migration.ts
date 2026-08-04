import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ACCOUNT_COMPRESSION,
  ADMIN,
  BUBBLEGUM,
  COLLECTION,
  CONFIG_PDA,
  MAINNET_GENESIS,
  MPL_CORE,
  NEW_BASE,
  OLD_BASE,
  PROGRAM_DATA,
  PROGRAM_ID,
  RECEIPTS_TREE,
  RECEIPTS_TREE_CONFIG,
  SHARED_CONFIGS,
  UPGRADEABLE_LOADER,
  accountData,
  assertCardConfig,
  assertReceiptTreeConfig,
  batches,
  classifyCollectionAsset,
  configuredMainnetRpc,
  decodeConfig,
  expectedName,
  expectedReceiptDataHash,
  parseRawCollection,
  parseRawCoreAsset,
  repositoryRoot,
  rpc,
  sanitizedRpcUrl,
  searchAllCollectionAssets,
  sha256,
} from './shared/cardNft2UriMigration.ts';

const args = process.argv.slice(2);
if (args.some((arg) => /keypair|private|secret|signer|send|rpc-url/i.test(arg))) {
  throw new Error('The verifier is read-only and does not accept signing material or RPC arguments');
}
let rollback = false;
let planPath = path.join(repositoryRoot(), '.cache', 'card-nft-2-uri-migration', 'plan.json');
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--rollback') rollback = true;
  else if (args[index] === '--plan') {
    planPath = path.resolve(String(args[++index] || '').trim());
    if (!planPath) throw new Error('--plan requires a path');
  } else throw new Error(`Unknown option: ${args[index]}`);
}
const targetBase = rollback ? OLD_BASE : NEW_BASE;
const sourceBase = rollback ? NEW_BASE : OLD_BASE;
const plan = JSON.parse(await readFile(planPath, 'utf8')) as any;
if (plan.rollback !== rollback || plan.targetBase !== targetBase || plan.sourceBase !== sourceBase) {
  throw new Error('Plan direction mismatch');
}
const { rpcUrl, rpcSource } = configuredMainnetRpc();
const genesisHash = await rpc<string>(rpcUrl, 'getGenesisHash');
if (genesisHash !== MAINNET_GENESIS) throw new Error(`Unexpected genesis hash ${genesisHash}`);
const addresses = [
  PROGRAM_ID,
  PROGRAM_DATA,
  ...Object.values(SHARED_CONFIGS),
  COLLECTION,
  RECEIPTS_TREE,
  RECEIPTS_TREE_CONFIG,
];
const responses = await Promise.all(addresses.map((address) => rpc<any>(rpcUrl, 'getAccountInfo', [
  address.toBase58(),
  { encoding: 'base64', commitment: 'finalized' },
])));
const byAddress = new Map(addresses.map((address, index) => [address.toBase58(), responses[index]]));
const program = byAddress.get(PROGRAM_ID.toBase58());
const programData = accountData(byAddress.get(PROGRAM_DATA.toBase58()), PROGRAM_DATA.toBase58());
if (program.value.owner !== UPGRADEABLE_LOADER.toBase58()
  || !program.value.executable
  || byAddress.get(PROGRAM_DATA.toBase58()).value.owner !== UPGRADEABLE_LOADER.toBase58()
  || programData[12] !== 1
  || !programData.subarray(13, 45).equals(ADMIN.toBuffer())
  || sha256(programData.subarray(45)) !== plan.program.payloadSha256) {
  throw new Error('Program executable or authority mismatch');
}
for (const [dropId, address] of Object.entries(SHARED_CONFIGS)) {
  const response = byAddress.get(address.toBase58());
  const data = accountData(response, address.toBase58());
  if (response.value.owner !== PROGRAM_ID.toBase58()) throw new Error(`Config owner mismatch: ${dropId}`);
  if (sha256(data) !== plan.configs[dropId].sha256) throw new Error(`Config changed: ${dropId}`);
}
const config = decodeConfig(accountData(byAddress.get(CONFIG_PDA.toBase58()), CONFIG_PDA.toBase58()));
assertCardConfig(config);
if (config.uriBase !== targetBase) throw new Error(`Card config URI is ${config.uriBase}`);
const collectionData = accountData(byAddress.get(COLLECTION.toBase58()), COLLECTION.toBase58());
const collection = parseRawCollection(collectionData);
if (collection.updateAuthority !== ADMIN.toBase58()
  || collection.name !== 'Card NFT 2'
  || collection.uri !== `${targetBase}/collection.json`) {
  throw new Error('Collection verification failed');
}
const treeResponse = byAddress.get(RECEIPTS_TREE.toBase58());
const treeConfigResponse = byAddress.get(RECEIPTS_TREE_CONFIG.toBase58());
if (treeResponse.value.owner !== ACCOUNT_COMPRESSION.toBase58()
  || treeConfigResponse.value.owner !== BUBBLEGUM.toBase58()) {
  throw new Error('Receipt tree or TreeConfig owner mismatch');
}
assertReceiptTreeConfig(accountData(treeConfigResponse, RECEIPTS_TREE_CONFIG.toBase58()));
const inventory = await searchAllCollectionAssets(rpcUrl);
const classified = classifyCollectionAsset(inventory.assets, sourceBase, targetBase);
if (classified.coreTargets.length || classified.receiptTargets.length) {
  throw new Error(`Mutable legacy URIs remain: ${JSON.stringify({
    core: classified.coreTargets.map((target) => target.address),
    receipts: classified.receiptTargets.map((target) => target.address),
  })}`);
}
const liveCore = inventory.assets.filter((asset) => asset.interface === 'MplCoreAsset' && !asset.burnt);
const liveReceipts = inventory.assets.filter((asset) => asset.interface === 'MplBubblegumV2' && !asset.burnt);
for (const asset of liveReceipts) {
  const uri = String(asset.content?.json_uri || '');
  if (expectedReceiptDataHash(asset, uri) !== String(asset.compression?.data_hash || '')) {
    throw new Error(`Receipt metadata hash verification failed: ${asset.id}`);
  }
}
for (const group of batches(liveCore, 100)) {
  const result = await rpc<any>(rpcUrl, 'getMultipleAccounts', [
    group.map((asset) => asset.id),
    { encoding: 'base64', commitment: 'finalized' },
  ]);
  group.forEach((asset, index) => {
    const response = result.value[index];
    if (!response || response.owner !== MPL_CORE.toBase58()) throw new Error(`Core account missing: ${asset.id}`);
    const raw = parseRawCoreAsset(Buffer.from(response.data[0], 'base64'));
    const uri = String(asset.content?.json_uri || '');
    const classification = /^.*\/b([1-9]\d*)\.json$/.test(uri)
      ? { kind: 'box' as const, id: Number(uri.match(/\/b([1-9]\d*)\.json$/)![1]) }
      : /^.*\/f([1-9]\d*)\.json$/.test(uri)
        ? { kind: 'card' as const, id: Number(uri.match(/\/f([1-9]\d*)\.json$/)![1]) }
        : null;
    if (!classification
      || raw.updateAuthorityKind !== 2
      || raw.updateAuthority !== COLLECTION.toBase58()
      || raw.uri !== uri
      || raw.name !== expectedName(classification.kind, classification.id, false)) {
      throw new Error(`Raw Core verification failed: ${asset.id}`);
    }
  });
}
console.log('Card NFT 2 URI migration verified at finalized commitment.');
console.log('rpc                 :', sanitizedRpcUrl(rpcUrl));
console.log('rpc credential      :', rpcSource);
console.log('program payload hash:', plan.program.payloadSha256);
console.log('config URI          :', config.uriBase);
console.log('collection URI      :', collection.uri);
console.log('live Core           :', liveCore.length);
console.log('live receipts       :', liveReceipts.length);
console.log('burned Core         :', classified.burned.core);
console.log('burned receipts     :', classified.burned.receipts);
console.log('mutable legacy URIs : 0');
console.log('sibling configs     : unchanged');
