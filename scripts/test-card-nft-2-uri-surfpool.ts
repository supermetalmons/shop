import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import bs58 from 'bs58';
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';

const SURFPOOL_RPC = process.env.SURFPOOL_RPC_URL || 'http://127.0.0.1:8899';
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || '';
const HELIUS_RPC = process.env.HELIUS_RPC_URL
  || `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(HELIUS_API_KEY)}`;
const ELF_PATH = process.env.CARD_NFT_2_PROGRAM_ELF || 'onchain/target/deploy/box_minter.so';
const PROGRAM_ID = new PublicKey('7FGMn1z6TMi6ndyVooP9n1y3zuWhcrxfcJgcSQs6VNNU');
const CONFIG_PDA = new PublicKey('5Wm8XacaTagt9UTdYuGSUmVk87GgMLeyeV5JerzjTNqm');
const ADMIN = new PublicKey('kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx');
const TREASURY = new PublicKey('AmzcjtuzXkSziYHRqmavPiTsbJveW13wiRhCTRnuheiq');
const COLLECTION = new PublicKey('EAzEpagtyeRAx9npnpVMpygoA8ouX7DRpLTghhPvYTiu');
const RECEIPTS_TREE = new PublicKey('EsGrHZjZzHmxzCSrqjyzuBBC4oAq3yS87ZNF1JdvDBh');
const MPL_CORE = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
const SPL_NOOP = new PublicKey('noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV');
const MPL_NOOP = new PublicKey('mnoopTCrg4p8ry25e4bcWA9XZjbNjMTfgYVGGEdRsf3');
const ACCOUNT_COMPRESSION = new PublicKey('mcmt6YrQEMKw8Mw43FmpRLmf7BqRnFMKmAcbxE3xkAW');
const BUBBLEGUM = new PublicKey('BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY');
const MPL_CORE_CPI_SIGNER = new PublicKey('CbNY3JiXdXNE9tPNEk1aRZVEkWdj2v7kfJLNQwZZgpXk');
const OLD_BASE = 'https://assets.mons.link/drops/cardnft2/json';
const NEW_BASE = 'https://cdn.lil.org/nft/card_nft_2/json';
const SET_URI_BASE = Buffer.from([160, 250, 204, 89, 122, 8, 207, 34]);
const START_OPEN_BOX = Buffer.from('c6646bb41bf3288f', 'hex');
const FINALIZE_OPEN_BOX = Buffer.from('cf5e6dfd1544ed16', 'hex');
const MINT_RECEIPTS = Buffer.from('c7c2556f92996a77', 'hex');
const START_MINT = Buffer.from([251, 42, 167, 4, 106, 190, 131, 214]);
const SIBLING_CONFIGS = [
  new PublicKey('9fd9YF6ZYMZw9ERwdnc798xoUFo584Tmqxc5bWu8j1Bi'),
  new PublicKey('FRJeVgAF9sjUgUJD6Da4eRCBSyfzxjoU4wjxStp8RGXG'),
  new PublicKey('3WSAzs8qN1kQoFM8eSKXAYkHXxZ3UianQDRVbVazb8Hi'),
];
const SETUP_MIGRATION_ONLY = process.argv.includes('--setup-migration-only');

type DecodedConfig = {
  admin: string;
  treasury: string;
  coreCollection: string;
  priceLamports: string;
  discountPriceLamports: string;
  discountMerkleRoot: string;
  maxSupply: number;
  maxPerTx: number;
  itemsPerBox: number;
  minted: number;
  namePrefix: string;
  symbol: string;
  uriBase: string;
  started: boolean;
  bump: number;
  discountMintsPerWallet: number;
  figureNamePrefix: string;
};

type TransactionResult = NonNullable<Awaited<ReturnType<Connection['getTransaction']>>>;

if (!HELIUS_API_KEY) throw new Error('HELIUS_API_KEY is required to resolve live DAS fixtures');

const connection = new Connection(SURFPOOL_RPC, 'processed');

async function rpc<T>(url: string, method: string, params: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params }),
  });
  const payload = await response.json() as { result?: T; error?: { message?: string } };
  if (payload.error) throw new Error(`${method}: ${payload.error.message || JSON.stringify(payload.error)}`);
  return payload.result as T;
}

function readString(data: Buffer, offset: number) {
  const length = data.readUInt32LE(offset);
  const start = offset + 4;
  const end = start + length;
  return { value: data.subarray(start, end).toString('utf8'), offset: end };
}

function decodeConfig(data: Buffer): DecodedConfig {
  assert.equal(data.length, 376);
  let offset = 8;
  const readPubkey = () => {
    const value = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
    offset += 32;
    return value;
  };
  const admin = readPubkey();
  const treasury = readPubkey();
  const coreCollection = readPubkey();
  const priceLamports = data.readBigUInt64LE(offset).toString();
  offset += 8;
  const discountPriceLamports = data.readBigUInt64LE(offset).toString();
  offset += 8;
  const discountMerkleRoot = data.subarray(offset, offset + 32).toString('hex');
  offset += 32;
  const maxSupply = data.readUInt32LE(offset);
  offset += 4;
  const maxPerTx = data[offset];
  offset += 1;
  const itemsPerBox = data[offset];
  offset += 1;
  const minted = data.readUInt32LE(offset);
  offset += 4;
  const namePrefix = readString(data, offset);
  offset = namePrefix.offset;
  const symbol = readString(data, offset);
  offset = symbol.offset;
  const uriBase = readString(data, offset);
  offset = uriBase.offset;
  const started = data[offset] === 1;
  offset += 1;
  const bump = data[offset];
  offset += 1;
  const discountMintsPerWallet = data[offset];
  offset += 1;
  const figureNamePrefix = readString(data, offset);
  return {
    admin,
    treasury,
    coreCollection,
    priceLamports,
    discountPriceLamports,
    discountMerkleRoot,
    maxSupply,
    maxPerTx,
    itemsPerBox,
    minted,
    namePrefix: namePrefix.value,
    symbol: symbol.value,
    uriBase: uriBase.value,
    started,
    bump,
    discountMintsPerWallet,
    figureNamePrefix: figureNamePrefix.value,
  };
}

function parseCoreAsset(data: Buffer) {
  assert.equal(data[0], 1);
  let offset = 1;
  const owner = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;
  const updateAuthorityKind = data[offset];
  offset += 1;
  const updateAuthority = updateAuthorityKind === 0
    ? null
    : new PublicKey(data.subarray(offset, offset + 32));
  if (updateAuthorityKind !== 0) offset += 32;
  const name = readString(data, offset);
  offset = name.offset;
  const uri = readString(data, offset);
  return { owner, updateAuthorityKind, updateAuthority, name: name.value, uri: uri.value };
}

function assertConfigFieldsEqual(before: DecodedConfig, after: DecodedConfig, uriBase: string) {
  for (const key of Object.keys(before) as Array<keyof DecodedConfig>) {
    if (key === 'uriBase') continue;
    assert.equal(after[key], before[key], key);
  }
  assert.equal(after.uriBase, uriBase);
}

function encodeStringInstruction(discriminator: Buffer, value: string) {
  const bytes = Buffer.from(value);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(bytes.length);
  return Buffer.concat([discriminator, length, bytes]);
}

function u16(value: number) {
  const data = Buffer.alloc(2);
  data.writeUInt16LE(value);
  return data;
}

function u32(value: number) {
  const data = Buffer.alloc(4);
  data.writeUInt32LE(value);
  return data;
}

async function fund(pubkey: PublicKey) {
  await connection.getAccountInfo(pubkey);
  await rpc(SURFPOOL_RPC, 'surfnet_setAccount', [pubkey.toBase58(), { lamports: 10_000_000_000 }]);
}

async function waitTransaction(signature: string): Promise<TransactionResult> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const transaction = await connection.getTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
    if (transaction) return transaction;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${signature}`);
}

async function sendInstructions(payer: PublicKey, instructions: TransactionInstruction[]) {
  const { blockhash } = await connection.getLatestBlockhash('processed');
  const message = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions })
    .compileToV0Message();
  const transaction = new VersionedTransaction(message);
  transaction.signatures[0] = randomBytes(64);
  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: true,
    maxRetries: 0,
  });
  return { signature, transaction: await waitTransaction(signature) };
}

async function deployPatchedProgram(elf: Buffer) {
  const programAccount = await connection.getAccountInfo(PROGRAM_ID);
  assert(programAccount);
  const programData = new PublicKey(programAccount.data.subarray(4, 36));
  await connection.getAccountInfo(programData);
  await rpc(SURFPOOL_RPC, 'surfnet_writeProgram', [
    PROGRAM_ID.toBase58(),
    elf.toString('hex'),
    0,
    ADMIN.toBase58(),
  ]);
  const patchedProgramData = await connection.getAccountInfo(programData);
  assert(patchedProgramData);
  assert.equal(patchedProgramData.data.length, 45 + elf.length);
  assert.deepEqual(patchedProgramData.data.subarray(45), elf);
  await rpc(SURFPOOL_RPC, 'surfnet_setAccount', [
    PROGRAM_ID.toBase58(),
    {
      lamports: programAccount.lamports,
      data: programAccount.data.toString('hex'),
      owner: programAccount.owner.toBase58(),
      executable: true,
    },
  ]);
  return programData;
}

async function setUriBase(signer: PublicKey, uriBase: string) {
  const instruction = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: CONFIG_PDA, isSigner: false, isWritable: true },
      { pubkey: signer, isSigner: true, isWritable: false },
    ],
    data: encodeStringInstruction(SET_URI_BASE, uriBase),
  });
  assert.deepEqual(
    instruction.keys.map((key) => [key.pubkey.toBase58(), key.isSigner, key.isWritable]),
    [
      [CONFIG_PDA.toBase58(), false, true],
      [signer.toBase58(), true, false],
    ],
  );
  return sendInstructions(signer, [instruction]);
}

async function exerciseSibling(config: PublicKey) {
  return sendInstructions(ADMIN, [new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: ADMIN, isSigner: true, isWritable: false },
    ],
    data: START_MINT,
  })]);
}

async function liveFixtures() {
  const assets = await rpc<{ items: Array<Record<string, any>> }>(HELIUS_RPC, 'searchAssets', {
    grouping: ['collection', COLLECTION.toBase58()],
    page: 1,
    limit: 1000,
    options: { showUnverifiedCollections: true },
  });
  const boxes = assets.items.filter((asset) =>
    String(asset?.content?.json_uri || '').startsWith(`${OLD_BASE}/b`)
    && !asset?.burnt
    && asset?.ownership?.owner
    && asset.ownership.owner !== ADMIN.toBase58());
  const unopened: Array<{ asset: PublicKey; owner: PublicKey; uri: string }> = [];
  for (const box of boxes) {
    const asset = new PublicKey(box.id);
    const owner = new PublicKey(box.ownership.owner);
    const ownerInfo = await rpc<{ value?: { owner?: string; executable?: boolean; data?: [string, string] } }>(
      HELIUS_RPC,
      'getAccountInfo',
      [owner.toBase58(), { encoding: 'base64', commitment: 'finalized' }],
    );
    if (
      ownerInfo.value?.owner !== SystemProgram.programId.toBase58()
      || ownerInfo.value.executable
      || ownerInfo.value.data?.[0]
    ) {
      continue;
    }
    const [pending] = PublicKey.findProgramAddressSync([Buffer.from('open'), asset.toBuffer()], PROGRAM_ID);
    const pendingInfo = await rpc<{ value: unknown }>(HELIUS_RPC, 'getAccountInfo', [
      pending.toBase58(),
      { encoding: 'base64', commitment: 'finalized' },
    ]);
    if (!pendingInfo.value) {
      unopened.push({ asset, owner, uri: box.content.json_uri });
      if (unopened.length === 2) break;
    }
  }
  assert.equal(unopened.length, 2, 'Two unopened old-base box fixtures are required');
  return { beforeSetter: unopened[0], afterSetter: unopened[1] };
}

async function startOpenBox(
  fixture: { asset: PublicKey; owner: PublicKey; uri: string },
  itemsPerBox: number,
) {
  const assetInfo = await connection.getAccountInfo(fixture.asset);
  assert(assetInfo);
  const asset = parseCoreAsset(Buffer.from(assetInfo.data));
  assert.equal(asset.owner.toBase58(), fixture.owner.toBase58());
  assert.equal(asset.uri, fixture.uri);
  const [pending] = PublicKey.findProgramAddressSync(
    [Buffer.from('open'), fixture.asset.toBuffer()],
    PROGRAM_ID,
  );
  const figures = Array.from({ length: itemsPerBox }, (_, index) => PublicKey.findProgramAddressSync(
    [Buffer.from('pdude'), pending.toBuffer(), Buffer.from([index])],
    PROGRAM_ID,
  )[0]);
  assert.equal(await connection.getAccountInfo(pending), null);
  const instruction = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: CONFIG_PDA, isSigner: false, isWritable: false },
      { pubkey: fixture.owner, isSigner: true, isWritable: true },
      { pubkey: fixture.asset, isSigner: false, isWritable: true },
      { pubkey: ADMIN, isSigner: false, isWritable: false },
      { pubkey: COLLECTION, isSigner: false, isWritable: false },
      { pubkey: MPL_CORE, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SPL_NOOP, isSigner: false, isWritable: false },
      { pubkey: pending, isSigner: false, isWritable: true },
      ...figures.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
    ],
    data: START_OPEN_BOX,
  });
  const result = await sendInstructions(fixture.owner, [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    instruction,
  ]);
  assert.equal(result.transaction.meta?.err, null);
  const pendingAccount = await connection.getAccountInfo(pending);
  assert(pendingAccount);
  return { ...fixture, pending, figures, signature: result.signature, bytes: pendingAccount.data.length };
}

function innerInstructionContains(transaction: TransactionResult, value: string) {
  const needle = Buffer.from(value);
  for (const group of transaction.meta?.innerInstructions || []) {
    for (const instruction of group.instructions) {
      if ('data' in instruction && Buffer.from(bs58.decode(instruction.data)).includes(needle)) return true;
    }
  }
  return false;
}

const elf = await readFile(ELF_PATH);
const elfSha256 = createHash('sha256').update(elf).digest('hex');
if (SETUP_MIGRATION_ONLY) {
  const programData = await deployPatchedProgram(elf);
  await Promise.all([fund(ADMIN), fund(TREASURY)]);
  const beforeAccount = await connection.getAccountInfo(CONFIG_PDA);
  assert(beforeAccount);
  const before = decodeConfig(Buffer.from(beforeAccount.data));
  assert.equal(before.uriBase, OLD_BASE);
  const setter = await setUriBase(ADMIN, NEW_BASE);
  assert.equal(setter.transaction.meta?.err, null);
  const afterAccount = await connection.getAccountInfo(CONFIG_PDA);
  assert(afterAccount);
  assertConfigFieldsEqual(before, decodeConfig(Buffer.from(afterAccount.data)), NEW_BASE);
  process.stdout.write(`${JSON.stringify({
    mode: 'migration-setup',
    surfpoolRpc: SURFPOOL_RPC,
    programId: PROGRAM_ID.toBase58(),
    programData: programData.toBase58(),
    elfSha256,
    setter: setter.signature,
    configBytes: afterAccount.data.length,
    uriBase: NEW_BASE,
  }, null, 2)}\n`);
  process.exit(0);
}
const fixtures = await liveFixtures();
const siblingConfigBytes = new Map<string, Buffer>();
for (const address of SIBLING_CONFIGS) {
  const account = await connection.getAccountInfo(address);
  assert(account);
  siblingConfigBytes.set(address.toBase58(), Buffer.from(account.data));
}
const programData = await deployPatchedProgram(elf);
await Promise.all([
  fund(ADMIN),
  fund(TREASURY),
  fund(fixtures.beforeSetter.owner),
  fund(fixtures.afterSetter.owner),
]);

const configAccount = await connection.getAccountInfo(CONFIG_PDA);
assert(configAccount);
assert.equal(configAccount.owner.toBase58(), PROGRAM_ID.toBase58());
assert.equal(configAccount.data.length, 376);
const originalConfig = decodeConfig(Buffer.from(configAccount.data));
assert.equal(originalConfig.uriBase, OLD_BASE);
assert.equal(originalConfig.admin, ADMIN.toBase58());
assert.equal(originalConfig.treasury, TREASURY.toBase58());
assert.equal(originalConfig.maxSupply, 3711);
assert.equal(originalConfig.itemsPerBox, 3);
assert.equal(originalConfig.namePrefix, 'pack');
assert.equal(originalConfig.figureNamePrefix, 'card');

const siblingOperations = [];
for (const address of SIBLING_CONFIGS) {
  const result = await exerciseSibling(address);
  assert.equal(result.transaction.meta?.err, null);
  const account = await connection.getAccountInfo(address);
  assert(account);
  assert.deepEqual(Buffer.from(account.data), siblingConfigBytes.get(address.toBase58()));
  siblingOperations.push({ config: address.toBase58(), signature: result.signature });
}

const pendingBeforeSetter = await startOpenBox(fixtures.beforeSetter, originalConfig.itemsPerBox);

const authorized = await setUriBase(ADMIN, NEW_BASE);
assert.equal(authorized.transaction.meta?.err, null);
const newConfigAccount = await connection.getAccountInfo(CONFIG_PDA);
assert(newConfigAccount);
assert.equal(newConfigAccount.data.length, 376);
const newConfig = decodeConfig(Buffer.from(newConfigAccount.data));
assertConfigFieldsEqual(originalConfig, newConfig, NEW_BASE);

const unauthorized = await setUriBase(TREASURY, OLD_BASE);
assert.notEqual(unauthorized.transaction.meta?.err, null);
assert.equal(
  unauthorized.transaction.meta?.logMessages?.some((line) => line.includes('ConstraintHasOne')),
  true,
);
const afterUnauthorized = await connection.getAccountInfo(CONFIG_PDA);
assert(afterUnauthorized);
assertConfigFieldsEqual(originalConfig, decodeConfig(Buffer.from(afterUnauthorized.data)), NEW_BASE);

const rollback = await setUriBase(ADMIN, OLD_BASE);
assert.equal(rollback.transaction.meta?.err, null);
const rolledBackAccount = await connection.getAccountInfo(CONFIG_PDA);
assert(rolledBackAccount);
assertConfigFieldsEqual(originalConfig, decodeConfig(Buffer.from(rolledBackAccount.data)), OLD_BASE);
const restoreNew = await setUriBase(ADMIN, NEW_BASE);
assert.equal(restoreNew.transaction.meta?.err, null);

const pendingAfterSetter = await startOpenBox(fixtures.afterSetter, originalConfig.itemsPerBox);
const pendingBoxInfo = await connection.getAccountInfo(pendingBeforeSetter.asset);
assert(pendingBoxInfo);
const pendingBox = parseCoreAsset(Buffer.from(pendingBoxInfo.data));
assert.equal(pendingBox.owner.toBase58(), ADMIN.toBase58());
assert.equal(pendingBox.uri.startsWith(`${OLD_BASE}/b`), true);
const maximumCardId = originalConfig.maxSupply * originalConfig.itemsPerBox;
const revealedIds = [maximumCardId - 2, maximumCardId - 1, maximumCardId];
const finalizeOpen = new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [
    { pubkey: CONFIG_PDA, isSigner: false, isWritable: false },
    { pubkey: ADMIN, isSigner: true, isWritable: true },
    { pubkey: pendingBeforeSetter.asset, isSigner: false, isWritable: true },
    { pubkey: COLLECTION, isSigner: false, isWritable: true },
    { pubkey: MPL_CORE, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SPL_NOOP, isSigner: false, isWritable: false },
    { pubkey: pendingBeforeSetter.pending, isSigner: false, isWritable: true },
    { pubkey: pendingBeforeSetter.owner, isSigner: false, isWritable: false },
    ...pendingBeforeSetter.figures.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
  ],
  data: Buffer.concat([FINALIZE_OPEN_BOX, u32(revealedIds.length), ...revealedIds.map(u16)]),
});
const finalized = await sendInstructions(ADMIN, [
  ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
  finalizeOpen,
]);
assert.equal(finalized.transaction.meta?.err, null);
assert.equal(await connection.getAccountInfo(pendingBeforeSetter.pending), null);
for (let index = 0; index < pendingBeforeSetter.figures.length; index += 1) {
  const info = await connection.getAccountInfo(pendingBeforeSetter.figures[index]);
  assert(info);
  const asset = parseCoreAsset(Buffer.from(info.data));
  assert.equal(asset.owner.toBase58(), pendingBeforeSetter.owner.toBase58());
  assert.equal(asset.updateAuthorityKind, 2);
  assert.equal(asset.updateAuthority?.toBase58(), COLLECTION.toBase58());
  assert.equal(asset.uri, `${NEW_BASE}/f${revealedIds[index]}.json`);
}

const [treeConfig] = PublicKey.findProgramAddressSync([RECEIPTS_TREE.toBuffer()], BUBBLEGUM);
const mintReceipts = new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [
    { pubkey: CONFIG_PDA, isSigner: false, isWritable: false },
    { pubkey: ADMIN, isSigner: true, isWritable: true },
    { pubkey: pendingBeforeSetter.owner, isSigner: false, isWritable: false },
    { pubkey: RECEIPTS_TREE, isSigner: false, isWritable: true },
    { pubkey: treeConfig, isSigner: false, isWritable: true },
    { pubkey: COLLECTION, isSigner: false, isWritable: true },
    { pubkey: BUBBLEGUM, isSigner: false, isWritable: false },
    { pubkey: MPL_NOOP, isSigner: false, isWritable: false },
    { pubkey: ACCOUNT_COMPRESSION, isSigner: false, isWritable: false },
    { pubkey: MPL_CORE, isSigner: false, isWritable: false },
    { pubkey: MPL_CORE_CPI_SIGNER, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
  data: Buffer.concat([MINT_RECEIPTS, u32(1), u32(originalConfig.maxSupply), u32(0)]),
});
const receipt = await sendInstructions(ADMIN, [
  ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
  mintReceipts,
]);
assert.equal(receipt.transaction.meta?.err, null);
assert.equal(
  innerInstructionContains(
    receipt.transaction,
    `${NEW_BASE}/rb${originalConfig.maxSupply}.json`,
  ),
  true,
);

const finalConfigAccount = await connection.getAccountInfo(CONFIG_PDA);
assert(finalConfigAccount);
assert.equal(finalConfigAccount.data.length, 376);
assertConfigFieldsEqual(originalConfig, decodeConfig(Buffer.from(finalConfigAccount.data)), NEW_BASE);
for (const address of SIBLING_CONFIGS) {
  const account = await connection.getAccountInfo(address);
  assert(account);
  assert.deepEqual(Buffer.from(account.data), siblingConfigBytes.get(address.toBase58()));
}

process.stdout.write(`${JSON.stringify({
  surfpoolRpc: SURFPOOL_RPC,
  programId: PROGRAM_ID.toBase58(),
  programData: programData.toBase58(),
  elfSha256,
  configBytes: finalConfigAccount.data.length,
  originalUriBase: originalConfig.uriBase,
  finalUriBase: NEW_BASE,
  authorizedSetter: authorized.signature,
  unauthorizedSetter: unauthorized.signature,
  rollbackSetter: rollback.signature,
  restoredSetter: restoreNew.signature,
  oldPendingCreatedBeforeSetter: {
    asset: pendingBeforeSetter.asset.toBase58(),
    pending: pendingBeforeSetter.pending.toBase58(),
    signature: pendingBeforeSetter.signature,
  },
  oldBoxStartedAfterSetter: {
    asset: pendingAfterSetter.asset.toBase58(),
    pending: pendingAfterSetter.pending.toBase58(),
    signature: pendingAfterSetter.signature,
  },
  oldPendingFinalize: { pending: pendingBeforeSetter.pending.toBase58(), signature: finalized.signature },
  newFigureUris: revealedIds.map((id) => `${NEW_BASE}/f${id}.json`),
  newReceiptUri: `${NEW_BASE}/rb${originalConfig.maxSupply}.json`,
  receiptMint: receipt.signature,
  siblingOperations,
  siblingConfigsUnchanged: true,
}, null, 2)}\n`);
