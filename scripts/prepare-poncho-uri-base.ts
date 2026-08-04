import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';

const MAINNET_RPC = process.env.HELIUS_RPC_URL
  || (process.env.HELIUS_API_KEY
    ? `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(process.env.HELIUS_API_KEY)}`
    : 'https://api.mainnet-beta.solana.com');
const GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const PROGRAM_ID = new PublicKey('C96UF1dNPzAiRoWPDyU1BRVez5Rfqf2WeFy6gipkBS5A');
const CONFIG_PDA = new PublicKey('2bYowarQZyoBjHmu1fzHDnWUfQRctLL4YHr7yhYjnVQq');
const ADMIN = new PublicKey('kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx');
const TARGET_URI_BASE = 'https://cdn.lil.org/nft/poncho_drifella';
const ROLLBACK_URI_BASE = 'https://assets.mons.link/drops/poncho';
const CONFIG_BYTES = 307;
const CONFIG_DISCRIMINATOR = Buffer.from([62, 29, 116, 188, 219, 247, 48, 227]);
const SET_URI_BASE_DISCRIMINATOR = Buffer.from([160, 250, 204, 89, 122, 8, 207, 34]);

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

function readU32(data: Buffer, offset: number) {
  return data.readUInt32LE(offset);
}

function readString(data: Buffer, offset: number) {
  const length = readU32(data, offset);
  const start = offset + 4;
  const end = start + length;
  if (end > data.length) throw new Error('Config string exceeds account data');
  return { value: data.subarray(start, end).toString('utf8'), offset: end };
}

function decodeConfig(data: Buffer): DecodedConfig {
  if (data.length !== CONFIG_BYTES) throw new Error(`Config must remain ${CONFIG_BYTES} bytes`);
  if (!data.subarray(0, 8).equals(CONFIG_DISCRIMINATOR)) {
    throw new Error('Config discriminator mismatch');
  }

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
  const maxSupply = readU32(data, offset);
  offset += 4;
  const maxPerTx = data[offset];
  offset += 1;
  const itemsPerBox = data[offset];
  offset += 1;
  const minted = readU32(data, offset);
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

function encodeSetUriBase(uriBase: string) {
  const value = Buffer.from(uriBase, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32LE(value.length);
  return Buffer.concat([SET_URI_BASE_DISCRIMINATOR, length, value]);
}

function simulationAccountData(value: unknown): Buffer | null {
  if (!value || typeof value !== 'object' || !('data' in value)) return null;
  const data = (value as { data: unknown }).data;
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (Array.isArray(data) && typeof data[0] === 'string') return Buffer.from(data[0], 'base64');
  return null;
}

function assertOnlyUriBaseChanged(before: DecodedConfig, after: DecodedConfig, uriBase: string) {
  for (const key of Object.keys(before) as Array<keyof DecodedConfig>) {
    if (key === 'uriBase') continue;
    if (before[key] !== after[key]) throw new Error(`Unexpected simulated config change: ${key}`);
  }
  if (after.uriBase !== uriBase) throw new Error('Simulation did not set the requested URI base');
}

const args = process.argv.slice(2);
if (args.some((arg) => /keypair|private|secret|signer/i.test(arg))) {
  throw new Error('This client does not accept signing material');
}
const rollback = args.includes('--rollback');
const printOnly = args.includes('--print-only');
const rpcUrl = MAINNET_RPC;
const uriBase = rollback ? ROLLBACK_URI_BASE : TARGET_URI_BASE;

const manifest = JSON.parse(
  await readFile(new URL('../onchain/releases/poncho-drifella-uri-base.json', import.meta.url), 'utf8'),
);
if (
  manifest.programId !== PROGRAM_ID.toBase58()
  || manifest.configPda !== CONFIG_PDA.toBase58()
  || manifest.admin !== ADMIN.toBase58()
  || manifest.targetUriBase !== TARGET_URI_BASE
  || manifest.rollbackUriBase !== ROLLBACK_URI_BASE
  || JSON.stringify(manifest.instruction.discriminator) !== JSON.stringify([...SET_URI_BASE_DISCRIMINATOR])
) {
  throw new Error('Setter manifest does not match the fixed client scope');
}

const instruction = new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [
    { pubkey: CONFIG_PDA, isSigner: false, isWritable: true },
    { pubkey: ADMIN, isSigner: true, isWritable: false },
  ],
  data: encodeSetUriBase(uriBase),
});

if (printOnly) {
  process.stdout.write(`${JSON.stringify({
    mode: 'print-only',
    rollback,
    programId: PROGRAM_ID.toBase58(),
    configPda: CONFIG_PDA.toBase58(),
    admin: ADMIN.toBase58(),
    uriBase,
    instructionDataBase64: instruction.data.toString('base64'),
    instructionAccounts: instruction.keys.map((key) => ({
      address: key.pubkey.toBase58(),
      signer: key.isSigner,
      writable: key.isWritable,
    })),
  }, null, 2)}\n`);
  process.exit(0);
}

const connection = new Connection(rpcUrl, 'finalized');
const genesisHash = await connection.getGenesisHash();
if (genesisHash !== GENESIS_HASH) throw new Error(`Refusing non-mainnet genesis hash ${genesisHash}`);

const account = await connection.getAccountInfo(CONFIG_PDA, 'finalized');
if (!account) throw new Error('Config PDA does not exist');
if (!account.owner.equals(PROGRAM_ID)) throw new Error('Config PDA owner mismatch');
const beforeData = Buffer.from(account.data);
const before = decodeConfig(beforeData);
if (before.admin !== ADMIN.toBase58()) throw new Error('Config admin mismatch');

const { blockhash } = await connection.getLatestBlockhash('finalized');
const message = new TransactionMessage({
  payerKey: ADMIN,
  recentBlockhash: blockhash,
  instructions: [instruction],
}).compileToV0Message();
const transaction = new VersionedTransaction(message);
const simulation = await connection.simulateTransaction(transaction, {
  commitment: 'finalized',
  sigVerify: false,
  replaceRecentBlockhash: true,
  accounts: { addresses: [CONFIG_PDA.toBase58()], encoding: 'base64' },
});

const afterData = simulationAccountData(simulation.value.accounts?.[0]);
if (!simulation.value.err && afterData) {
  const after = decodeConfig(afterData);
  assertOnlyUriBaseChanged(before, after, uriBase);
}

const summary = {
  mode: 'simulate',
  rollback,
  genesisHash,
  programId: PROGRAM_ID.toBase58(),
  configPda: CONFIG_PDA.toBase58(),
  admin: ADMIN.toBase58(),
  configOwner: account.owner.toBase58(),
  configBytes: beforeData.length,
  configSha256: createHash('sha256').update(beforeData).digest('hex'),
  before,
  requestedUriBase: uriBase,
  instructionDataBase64: instruction.data.toString('base64'),
  instructionAccounts: instruction.keys.map((key) => ({
    address: key.pubkey.toBase58(),
    signer: key.isSigner,
    writable: key.isWritable,
  })),
  unsignedTransactionBase64: Buffer.from(transaction.serialize()).toString('base64'),
  simulation: {
    err: simulation.value.err,
    unitsConsumed: simulation.value.unitsConsumed,
    logs: simulation.value.logs,
    returnedConfig: Boolean(afterData),
  },
};

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
if (simulation.value.err) process.exitCode = 2;
