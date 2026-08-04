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
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const ELF_PATH = process.env.LSB_PROGRAM_ELF || 'onchain/target/deploy/box_minter.so';
const PROGRAM_ID = new PublicKey('22NeePs5wgkzP4j5sPzfzJqXsFAu9SUMiGBznPQVaAep');
const CONFIG_PDA = new PublicKey('iGsmSPPYJovrb7jNFCX6BimZN5Z7dpkmCuW9SYAgcMc');
const ADMIN = new PublicKey('kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx');
const TREASURY = new PublicKey('8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM');
const COLLECTION = new PublicKey('7c3tY7nEZ6yDuUCrsL6dX7AFcCqKbwMwS6HRvdZXeQXr');
const RECEIPTS_TREE = new PublicKey('Bep28XBM8LEjdCHgTzhuo5hFazpKrKgxDaEcnRg2VThV');
const MPL_CORE = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
const SPL_NOOP = new PublicKey('noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV');
const MPL_NOOP = new PublicKey('mnoopTCrg4p8ry25e4bcWA9XZjbNjMTfgYVGGEdRsf3');
const ACCOUNT_COMPRESSION = new PublicKey('mcmt6YrQEMKw8Mw43FmpRLmf7BqRnFMKmAcbxE3xkAW');
const BUBBLEGUM = new PublicKey('BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY');
const MPL_CORE_CPI_SIGNER = new PublicKey('CbNY3JiXdXNE9tPNEk1aRZVEkWdj2v7kfJLNQwZZgpXk');
const OLD_BASE = 'https://assets.mons.link/drops/lsb';
const NEW_BASE = 'https://cdn.lil.org/nft/little_swag_boxes';
const SET_URI_BASE = Buffer.from([160, 250, 204, 89, 122, 8, 207, 34]);
const START_OPEN_BOX = Buffer.from('c6646bb41bf3288f', 'hex');
const FINALIZE_OPEN_BOX = Buffer.from('cf5e6dfd1544ed16', 'hex');
const MINT_RECEIPTS = Buffer.from('c7c2556f92996a77', 'hex');

type DecodedConfig = {
  admin: string;
  treasury: string;
  coreCollection: string;
  priceLamports: string;
  discountPriceLamports: string;
  discountMerkleRoot: string;
  maxSupply: number;
  maxPerTx: number;
  minted: number;
  namePrefix: string;
  symbol: string;
  uriBase: string;
  started: boolean;
  bump: number;
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
  assert.equal(data.length, 289);
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
  return {
    admin,
    treasury,
    coreCollection,
    priceLamports,
    discountPriceLamports,
    discountMerkleRoot,
    maxSupply,
    maxPerTx,
    minted,
    namePrefix: namePrefix.value,
    symbol: symbol.value,
    uriBase: uriBase.value,
    started,
    bump,
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

async function liveFixtures() {
  const assets = await rpc<{ items: Array<Record<string, any>> }>(HELIUS_RPC, 'searchAssets', {
    grouping: ['collection', COLLECTION.toBase58()],
    page: 1,
    limit: 1000,
    options: { showUnverifiedCollections: true },
  });
  const boxes = assets.items.filter((asset) =>
    String(asset?.content?.json_uri || '').startsWith(`${OLD_BASE}/json/boxes/`)
    && asset?.ownership?.owner
    && asset.ownership.owner !== ADMIN.toBase58());
  let unopened: { asset: PublicKey; owner: PublicKey; uri: string } | null = null;
  for (const box of boxes) {
    const asset = new PublicKey(box.id);
    const [pending] = PublicKey.findProgramAddressSync([Buffer.from('open'), asset.toBuffer()], PROGRAM_ID);
    const pendingInfo = await rpc<{ value: unknown }>(HELIUS_RPC, 'getAccountInfo', [
      pending.toBase58(),
      { encoding: 'base64', commitment: 'finalized' },
    ]);
    if (!pendingInfo.value) {
      unopened = { asset, owner: new PublicKey(box.ownership.owner), uri: box.content.json_uri };
      break;
    }
  }
  assert(unopened, 'No unopened old-base box fixture found');

  const pendingAccounts = await rpc<Array<{ pubkey: string; account: { data: [string, string] } }>>(
    HELIUS_RPC,
    'getProgramAccounts',
    [PROGRAM_ID.toBase58(), { encoding: 'base64', filters: [{ dataSize: 177 }] }],
  );
  assert(pendingAccounts.length > 0, 'No live pending-open fixture found');
  const pendingRow = pendingAccounts[0];
  const data = Buffer.from(pendingRow.account.data[0], 'base64');
  const pubkeyAt = (offset: number) => new PublicKey(data.subarray(offset, offset + 32));
  const pending = {
    pending: new PublicKey(pendingRow.pubkey),
    owner: pubkeyAt(8),
    boxAsset: pubkeyAt(40),
    dudes: [pubkeyAt(72), pubkeyAt(104), pubkeyAt(136)],
  };
  const pendingAsset = await rpc<Record<string, any>>(HELIUS_RPC, 'getAsset', { id: pending.boxAsset.toBase58() });
  assert.equal(pendingAsset?.content?.json_uri?.startsWith(`${OLD_BASE}/json/boxes/`), true);
  return { unopened, pending };
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
const fixtures = await liveFixtures();
const programData = await deployPatchedProgram(elf);
await Promise.all([fund(ADMIN), fund(TREASURY), fund(fixtures.unopened.owner)]);

const configAccount = await connection.getAccountInfo(CONFIG_PDA);
assert(configAccount);
assert.equal(configAccount.owner.toBase58(), PROGRAM_ID.toBase58());
assert.equal(configAccount.data.length, 289);
const originalConfig = decodeConfig(Buffer.from(configAccount.data));
assert.equal(originalConfig.uriBase, OLD_BASE);
assert.equal(originalConfig.admin, ADMIN.toBase58());

const authorized = await setUriBase(ADMIN, NEW_BASE);
assert.equal(authorized.transaction.meta?.err, null);
const newConfigAccount = await connection.getAccountInfo(CONFIG_PDA);
assert(newConfigAccount);
assert.equal(newConfigAccount.data.length, 289);
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

const unopenedAssetInfo = await connection.getAccountInfo(fixtures.unopened.asset);
assert(unopenedAssetInfo);
const unopenedAsset = parseCoreAsset(Buffer.from(unopenedAssetInfo.data));
assert.equal(unopenedAsset.owner.toBase58(), fixtures.unopened.owner.toBase58());
assert.equal(unopenedAsset.uri, fixtures.unopened.uri);
const [newPending] = PublicKey.findProgramAddressSync(
  [Buffer.from('open'), fixtures.unopened.asset.toBuffer()],
  PROGRAM_ID,
);
const newDudes = [0, 1, 2].map((index) => PublicKey.findProgramAddressSync(
  [Buffer.from('pdude'), newPending.toBuffer(), Buffer.from([index])],
  PROGRAM_ID,
)[0]);
assert.equal(await connection.getAccountInfo(newPending), null);
const startOpen = new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [
    { pubkey: CONFIG_PDA, isSigner: false, isWritable: false },
    { pubkey: fixtures.unopened.owner, isSigner: true, isWritable: true },
    { pubkey: fixtures.unopened.asset, isSigner: false, isWritable: true },
    { pubkey: ADMIN, isSigner: false, isWritable: false },
    { pubkey: COLLECTION, isSigner: false, isWritable: false },
    { pubkey: MPL_CORE, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SPL_NOOP, isSigner: false, isWritable: false },
    { pubkey: newPending, isSigner: false, isWritable: true },
    ...newDudes.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
  ],
  data: START_OPEN_BOX,
});
const started = await sendInstructions(fixtures.unopened.owner, [
  ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
  startOpen,
]);
assert.equal(started.transaction.meta?.err, null);
const createdPending = await connection.getAccountInfo(newPending);
assert.equal(createdPending?.data.length, 177);

const pendingBoxInfo = await connection.getAccountInfo(fixtures.pending.boxAsset);
assert(pendingBoxInfo);
const pendingBox = parseCoreAsset(Buffer.from(pendingBoxInfo.data));
assert.equal(pendingBox.owner.toBase58(), ADMIN.toBase58());
assert.equal(pendingBox.uri.startsWith(`${OLD_BASE}/json/boxes/`), true);
const revealedIds = [997, 998, 999];
const finalizeOpen = new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [
    { pubkey: CONFIG_PDA, isSigner: false, isWritable: false },
    { pubkey: ADMIN, isSigner: true, isWritable: true },
    { pubkey: fixtures.pending.boxAsset, isSigner: false, isWritable: true },
    { pubkey: COLLECTION, isSigner: false, isWritable: true },
    { pubkey: MPL_CORE, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SPL_NOOP, isSigner: false, isWritable: false },
    { pubkey: fixtures.pending.pending, isSigner: false, isWritable: true },
    { pubkey: fixtures.pending.owner, isSigner: false, isWritable: false },
    ...fixtures.pending.dudes.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
  ],
  data: Buffer.concat([FINALIZE_OPEN_BOX, ...revealedIds.map(u16)]),
});
const finalized = await sendInstructions(ADMIN, [
  ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
  finalizeOpen,
]);
assert.equal(finalized.transaction.meta?.err, null);
assert.equal(await connection.getAccountInfo(fixtures.pending.pending), null);
for (let index = 0; index < fixtures.pending.dudes.length; index += 1) {
  const info = await connection.getAccountInfo(fixtures.pending.dudes[index]);
  assert(info);
  const asset = parseCoreAsset(Buffer.from(info.data));
  assert.equal(asset.owner.toBase58(), fixtures.pending.owner.toBase58());
  assert.equal(asset.updateAuthorityKind, 2);
  assert.equal(asset.updateAuthority?.toBase58(), COLLECTION.toBase58());
  assert.equal(asset.uri, `${NEW_BASE}/json/figures/${revealedIds[index]}.json`);
}

const [treeConfig] = PublicKey.findProgramAddressSync([RECEIPTS_TREE.toBuffer()], BUBBLEGUM);
const mintReceipts = new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [
    { pubkey: CONFIG_PDA, isSigner: false, isWritable: false },
    { pubkey: ADMIN, isSigner: true, isWritable: true },
    { pubkey: fixtures.pending.owner, isSigner: false, isWritable: false },
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
  data: Buffer.concat([MINT_RECEIPTS, u32(1), u32(333), u32(0)]),
});
const receipt = await sendInstructions(ADMIN, [
  ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
  mintReceipts,
]);
assert.equal(receipt.transaction.meta?.err, null);
assert.equal(
  innerInstructionContains(receipt.transaction, `${NEW_BASE}/json/receipts/boxes/333.json`),
  true,
);

const finalConfigAccount = await connection.getAccountInfo(CONFIG_PDA);
assert(finalConfigAccount);
assert.equal(finalConfigAccount.data.length, 289);
assertConfigFieldsEqual(originalConfig, decodeConfig(Buffer.from(finalConfigAccount.data)), NEW_BASE);

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
  oldBoxStart: { asset: fixtures.unopened.asset.toBase58(), signature: started.signature },
  oldPendingFinalize: { pending: fixtures.pending.pending.toBase58(), signature: finalized.signature },
  newFigureUris: revealedIds.map((id) => `${NEW_BASE}/json/figures/${id}.json`),
  newReceiptUri: `${NEW_BASE}/json/receipts/boxes/333.json`,
  receiptMint: receipt.signature,
}, null, 2)}\n`);
