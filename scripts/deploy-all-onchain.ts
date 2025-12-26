import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import bs58 from 'bs58';
import { createInterface } from 'node:readline/promises';
import {
  clusterApiUrl,
  AddressLookupTableProgram,
  Connection,
  ComputeBudgetProgram,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { getConcurrentMerkleTreeAccountSize } from '@solana/spl-account-compression';

// MPL Core program id.
const MPL_CORE_PROGRAM_ID = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
// SPL Noop program (Metaplex "log wrapper").
const SPL_NOOP_PROGRAM_ID = new PublicKey('noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV');
// Metaplex Noop program (Bubblegum v2 log wrapper).
const MPL_NOOP_PROGRAM_ID = new PublicKey('mnoopTCrg4p8ry25e4bcWA9XZjbNjMTfgYVGGEdRsf3');
// Metaplex Account Compression program (used by Bubblegum v2 trees).
const MPL_ACCOUNT_COMPRESSION_PROGRAM_ID = new PublicKey('mcmt6YrQEMKw8Mw43FmpRLmf7BqRnFMKmAcbxE3xkAW');
// Metaplex Bubblegum program.
const BUBBLEGUM_PROGRAM_ID = new PublicKey('BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY');
// NOTE: This repo uses uncompressed MPL-Core for boxes/figures and Bubblegum v2 cNFTs for receipts.

type SolanaCluster = 'devnet' | 'testnet' | 'mainnet-beta';

// ---------------------------------------------------------------------------
// EDIT THESE CONSTANTS to change deploy behavior.
// This script intentionally accepts NO CLI args.
// NOTE: Metaplex programs (MPL Core/Bubblegum/etc) are often NOT deployed on Solana testnet.
// If you hit "Attempt to load a program that does not exist", use devnet or mainnet-beta.
const SOLANA_CLUSTER: SolanaCluster = 'devnet';
// Optional: set a custom RPC URL; otherwise the default cluster RPC is used.
const SOLANA_RPC_URL: string | undefined = undefined;
// Optional: set to an existing MPL-Core collection address (must have update authority = config PDA).
// If unset, the script auto-creates a new collection on first deploy.
const CORE_COLLECTION_PUBKEY: string | undefined = undefined;
// If true, reuse the existing program id/keypair (upgrade in-place). If false, auto-generate a fresh program id.
const REUSE_PROGRAM_ID = false;

// Firebase project id used for Firestore cleanup.
// Defaults to the repo's configured Firebase project (see `src/config/deployment.ts`).
const FIREBASE_PROJECT_ID = (process.env.FIREBASE_PROJECT_ID || '').trim() || 'mons-shop';

// Firestore collections that belong to a specific drop and should be wiped on each full on-chain deployment.
// IMPORTANT: Do NOT add user-owned collections here (profiles/authSessions/wallets).
const FIRESTORE_DROP_COLLECTIONS_TO_DELETE = ['boxAssignments', 'dudeAssignments', 'meta', 'claimCodes', 'deliveryOrders'];

// MPL-Core collection-level royalties (secondary trading).
// NOTE: Not every marketplace enforces royalties, but this is the canonical on-chain royalty configuration.
const CORE_COLLECTION_ROYALTIES_BPS = 500; // 5.00%
// ---------------------------------------------------------------------------

async function promptMaskedInput(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error('Cannot prompt for private key: stdin is not a TTY. Run this script in an interactive terminal.');
  }

  const stdin = process.stdin;
  const stdout = process.stdout;

  stdout.write(prompt);
  stdin.setEncoding('utf8');

  const wasRaw = (stdin as any).isRaw;
  stdin.setRawMode(true);
  stdin.resume();

  let input = '';

  return await new Promise((resolve, reject) => {
    function cleanup() {
      stdin.removeListener('data', onData);
      try {
        stdin.setRawMode(Boolean(wasRaw));
      } catch {
        // ignore
      }
      stdin.pause();
    }

    function onData(chunk: string) {
      for (const ch of chunk) {
        // Ctrl+C
        if (ch === '\u0003') {
          stdout.write('\n');
          cleanup();
          reject(new Error('Cancelled'));
          return;
        }

        // Enter
        if (ch === '\r' || ch === '\n') {
          stdout.write('\n');
          cleanup();
          resolve(input);
          return;
        }

        // Backspace (DEL / BS)
        if (ch === '\u007f' || ch === '\b') {
          if (input.length > 0) {
            input = input.slice(0, -1);
            stdout.write('\b \b');
          }
          continue;
        }

        // Ignore other control chars
        if (ch < ' ' && ch !== '\t') continue;

        input += ch;
        stdout.write('*');
      }
    }

    stdin.on('data', onData);
  });
}

async function promptYConfirmation(prompt: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    throw new Error('Cannot prompt for confirmation: stdin is not a TTY. Run this script in an interactive terminal.');
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(prompt)).trim().toLowerCase();
    return answer === 'y';
  } finally {
    rl.close();
  }
}

function keypairFromBytes(bytes: Uint8Array): Keypair {
  if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
  if (bytes.length === 32) return Keypair.fromSeed(bytes);
  throw new Error(`Invalid private key length: ${bytes.length} bytes (expected 32 or 64).`);
}

function parsePrivateKeyInput(input: string): Keypair {
  const raw = (input || '').trim();
  if (!raw) throw new Error('Empty private key input.');

  // Accept Solana CLI-style JSON keypair arrays (e.g. ~/.config/solana/id.json contents).
  if (raw.startsWith('[')) {
    let arr: unknown;
    try {
      arr = JSON.parse(raw);
    } catch {
      throw new Error('Invalid JSON private key. Expected a JSON array of numbers or a base58-encoded secret key.');
    }
    if (!Array.isArray(arr) || arr.some((n) => typeof n !== 'number')) {
      throw new Error('Invalid JSON private key. Expected a JSON array of numbers.');
    }
    return keypairFromBytes(Uint8Array.from(arr as number[]));
  }

  // Otherwise, treat as base58.
  try {
    return keypairFromBytes(bs58.decode(raw));
  } catch {
    throw new Error('Invalid base58 private key.');
  }
}

async function assertExecutableProgram(args: {
  connection: Connection;
  cluster: SolanaCluster;
  programId: PublicKey;
  name: string;
}) {
  const { connection, cluster, programId, name } = args;
  const info = await connection.getAccountInfo(programId, { commitment: 'confirmed' });
  if (!info) {
    const hint =
      cluster === 'testnet'
        ? `\nNote: Metaplex programs are often not deployed on Solana testnet. Try SOLANA_CLUSTER='devnet'.`
        : '';
    throw new Error(
      `${name} program is not deployed on this cluster.\n` +
        `- cluster: ${cluster}\n` +
        `- rpc    : ${connection.rpcEndpoint}\n` +
        `- program: ${programId.toBase58()}` +
        hint,
    );
  }
  if (!info.executable) {
    throw new Error(
      `${name} program account exists but is not executable.\n` +
        `- cluster: ${cluster}\n` +
        `- rpc    : ${connection.rpcEndpoint}\n` +
        `- program: ${programId.toBase58()}\n` +
        `- owner  : ${info.owner.toBase58()}`,
    );
  }
}

async function assertExternalProgramsDeployed(connection: Connection, cluster: SolanaCluster) {
  await assertExecutableProgram({ connection, cluster, programId: MPL_CORE_PROGRAM_ID, name: 'MPL Core' });
  await assertExecutableProgram({ connection, cluster, programId: BUBBLEGUM_PROGRAM_ID, name: 'Metaplex Bubblegum' });
  await assertExecutableProgram({
    connection,
    cluster,
    programId: MPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
    name: 'Metaplex Account Compression',
  });
  await assertExecutableProgram({
    connection,
    cluster,
    programId: MPL_NOOP_PROGRAM_ID,
    name: 'Metaplex Noop (Bubblegum log wrapper)',
  });
}

async function sendAndConfirmTx(args: {
  connection: Connection;
  tx: Transaction;
  signers: Keypair[];
  label: string;
  commitment?: 'processed' | 'confirmed' | 'finalized';
}): Promise<string> {
  const { connection, tx, signers, label, commitment = 'confirmed' } = args;
  try {
    return await sendAndConfirmTransaction(connection, tx, signers, { commitment });
  } catch (err) {
    const anyErr = err as any;
    const msg =
      (typeof anyErr?.transactionMessage === 'string' && anyErr.transactionMessage) ||
      (anyErr instanceof Error ? anyErr.message : String(anyErr));
    const programIds = Array.from(new Set(tx.instructions.map((ix) => ix.programId.toBase58())));

    console.error(`\n❌ Transaction failed (${label})`);
    console.error('RPC:', connection.rpcEndpoint);
    console.error('Program IDs in tx:', programIds.join(', ') || '(none)');
    if (msg) console.error('Error:', msg);

    // Try to print simulation logs (web3.js attaches `getLogs()` to SendTransactionError).
    if (typeof anyErr?.getLogs === 'function') {
      try {
        const logs = await anyErr.getLogs(connection);
        if (Array.isArray(logs) && logs.length) {
          console.error('--- logs ---');
          for (const l of logs) console.error(l);
        }
      } catch {
        // ignore
      }
    } else if (Array.isArray(anyErr?.transactionLogs) && anyErr.transactionLogs.length) {
      console.error('--- logs ---');
      for (const l of anyErr.transactionLogs) console.error(l);
    }

    if (typeof msg === 'string' && msg.includes('Attempt to load a program that does not exist')) {
      console.error('\nTip: one of the program IDs above is missing on this cluster/RPC.');
    }
    throw err;
  }
}

function writeTempKeypairFile(kp: Keypair): string {
  const filePath = path.join(tmpdir(), `mons-shop-deployer-${process.pid}-${Date.now()}.json`);
  // solana-cli expects a JSON array of 64 u8 values.
  writeFileSync(filePath, JSON.stringify(Array.from(kp.secretKey)), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return filePath;
}

function registerTempKeypairCleanup(filePath: string) {
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      unlinkSync(filePath);
    } catch {
      // ignore
    }
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(143);
  });
}

function tsStringLiteral(value: string): string {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function normalizeDropBase(base: string): string {
  // Drop base should be stable and never end with `/`.
  return (base || '').trim().replace(/\/+$/, '');
}

function readExistingTsObjectStringField(filePath: string, field: string): string | undefined {
  if (!existsSync(filePath)) return undefined;
  try {
    const content = readFileSync(filePath, 'utf8');
    const re = new RegExp(`${field}\\s*:\\s*'([^']*)'`, 'm');
    const match = content.match(re);
    return match?.[1] || undefined;
  } catch {
    return undefined;
  }
}

function writeTextFileIfChanged(filePath: string, content: string) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const next = content.endsWith('\n') ? content : `${content}\n`;
  const prev = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
  if (prev === next) return;
  writeFileSync(filePath, next, 'utf8');
}

function readDiscountList(filePath: string): string[] {
  if (!existsSync(filePath)) {
    throw new Error(`Missing discount whitelist CSV: ${filePath}`);
  }
  const raw = readFileSync(filePath, 'utf8');
  const lines = raw
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
  const normalized = lines.map((addr) => new PublicKey(addr).toBase58());
  return Array.from(new Set(normalized));
}

function sha256(data: Buffer): Buffer {
  return createHash('sha256').update(data).digest();
}

function hashLeafAddress(address: string): Buffer {
  return sha256(new PublicKey(address).toBuffer());
}

function hashSortedPair(left: Buffer, right: Buffer): Buffer {
  const ordered = Buffer.compare(left, right) <= 0 ? [left, right] : [right, left];
  return sha256(Buffer.concat(ordered));
}

function buildMerkleTree(leaves: Buffer[]): Buffer[][] {
  if (!leaves.length) return [];
  const levels: Buffer[][] = [leaves];
  let level = leaves;
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = level[i + 1] ?? left;
      next.push(hashSortedPair(left, right));
    }
    levels.push(next);
    level = next;
  }
  return levels;
}

function buildMerkleProof(levels: Buffer[][], leafIndex: number): Buffer[] {
  const proof: Buffer[] = [];
  let idx = leafIndex;
  for (let level = 0; level < levels.length - 1; level += 1) {
    const nodes = levels[level];
    const isRight = idx % 2 === 1;
    const siblingIndex = isRight ? idx - 1 : idx + 1;
    const sibling = nodes[siblingIndex] ?? nodes[idx];
    proof.push(sibling);
    idx = Math.floor(idx / 2);
  }
  return proof;
}

function buildDiscountMerkleData(addresses: string[]) {
  const leaves = addresses
    .map((address) => ({ address, hash: hashLeafAddress(address) }))
    .sort((a, b) => Buffer.compare(a.hash, b.hash));
  const leafHashes = leaves.map((leaf) => leaf.hash);
  const levels = buildMerkleTree(leafHashes);
  const root = levels.length ? levels[levels.length - 1][0] : Buffer.alloc(32);
  const proofs: Record<string, string[]> = {};
  leaves.forEach((leaf, index) => {
    proofs[leaf.address] = buildMerkleProof(levels, index).map((buf) => buf.toString('hex'));
  });
  return { root, proofs };
}

function writeDiscountMerkleJson(args: { root: Buffer; proofs: Record<string, string[]>; filePath: string }) {
  const payload = {
    root: args.root.toString('hex'),
    proofs: args.proofs,
  };
  writeTextFileIfChanged(args.filePath, JSON.stringify(payload, null, 2));
}

function writeFrontendDeployedConfig(args: {
  root: string;
  solanaCluster: string;
  metadataBase: string;
  treasury: string;
  priceSol: number;
  discountPriceSol: number;
  discountMerkleRoot: string;
  maxSupply: number;
  maxPerTx: number;
  namePrefix: string;
  symbol: string;
  boxMinterProgramId: string;
  collectionMint: string;
}) {
  const filePath = path.join(args.root, 'src', 'config', 'deployed.ts');
  const content = `/**
 * Frontend values produced by on-chain deployment (COMMITTED).
 *
 * This file is intended to be overwritten by \`scripts/deploy-all-onchain.ts\` (\`npm run deploy-all-onchain\`).
 * Put anything that is NOT produced by deployment (Firebase non-secret config,
 * encryption public key, etc) in \`src/config/deployment.ts\`.
 */
export type SolanaCluster = 'devnet' | 'testnet' | 'mainnet-beta';

export type FrontendDeployedConfig = {
  solanaCluster: SolanaCluster;
  // Drop metadata base (collection.json + json/* + images/*)
  metadataBase: string;

  // Drop config (kept in sync with on-chain config; useful for UI defaults)
  treasury: string;
  priceSol: number;
  discountPriceSol: number;
  discountMerkleRoot: string;
  maxSupply: number;
  maxPerTx: number;
  namePrefix: string;
  symbol: string;

  boxMinterProgramId: string;
  collectionMint: string;
};

export const FRONTEND_DEPLOYED: FrontendDeployedConfig = {
  solanaCluster: ${tsStringLiteral(args.solanaCluster)},
  metadataBase: ${tsStringLiteral(args.metadataBase)},
  treasury: ${tsStringLiteral(args.treasury)},
  priceSol: ${Number(args.priceSol)},
  discountPriceSol: ${Number(args.discountPriceSol)},
  discountMerkleRoot: ${tsStringLiteral(args.discountMerkleRoot)},
  maxSupply: ${Number(args.maxSupply)},
  maxPerTx: ${Number(args.maxPerTx)},
  namePrefix: ${tsStringLiteral(args.namePrefix)},
  symbol: ${tsStringLiteral(args.symbol)},
  boxMinterProgramId: ${tsStringLiteral(args.boxMinterProgramId)},
  collectionMint: ${tsStringLiteral(args.collectionMint)},
};

export type DropPaths = {
  /** Normalized drop base (no trailing slash). */
  base: string;
  collectionJson: string;
  boxesJsonBase: string;
  figuresJsonBase: string;
  receiptsBoxesJsonBase: string;
  receiptsFiguresJsonBase: string;
};

export function normalizeDropBase(base: string): string {
  // Allow callers to pass either \`https://.../drops/lsb\` or \`https://.../drops/lsb/\`.
  return String(base || '').replace(/\\/+$/, '');
}

export function dropPathsFromBase(dropBase: string): DropPaths {
  const base = normalizeDropBase(dropBase);
  return {
    base,
    collectionJson: \`\${base}/collection.json\`,
    boxesJsonBase: \`\${base}/json/boxes/\`,
    figuresJsonBase: \`\${base}/json/figures/\`,
    receiptsBoxesJsonBase: \`\${base}/json/receipts/boxes/\`,
    receiptsFiguresJsonBase: \`\${base}/json/receipts/figures/\`,
  };
}

/**
 * Canonical derived paths for the current drop.
 *
 * Keep all path building in one place to avoid duplicating URL strings.
 */
export const FRONTEND_PATHS = dropPathsFromBase(FRONTEND_DEPLOYED.metadataBase);
`;
  writeTextFileIfChanged(filePath, content);
  return filePath;
}

function writeFunctionsDeploymentConfig(args: {
  root: string;
  solanaCluster: string;
  metadataBase: string;
  treasury: string;
  priceSol: number;
  discountPriceSol: number;
  discountMerkleRoot: string;
  maxSupply: number;
  maxPerTx: number;
  namePrefix: string;
  symbol: string;
  boxMinterProgramId: string;
  collectionMint: string;
  receiptsMerkleTree: string;
  deliveryLookupTable: string;
}) {
  const filePath = path.join(args.root, 'functions', 'src', 'config', 'deployment.ts');
  const content = `/**
 * Cloud Functions deployment constants (COMMITTED).
 *
 * This file is intended to be updated by \`scripts/deploy-all-onchain.ts\` (\`npm run deploy-all-onchain\`) after
 * an on-chain deployment, so functions can run with minimal env usage.
 *
 * Secrets:
 * - HELIUS_API_KEY (env/runtime config)
 * - COSIGNER_SECRET (Firebase Functions secret / Google Secret Manager)
 */

export type SolanaCluster = 'devnet' | 'testnet' | 'mainnet-beta';

export type FunctionsDeploymentConfig = {
  solanaCluster: SolanaCluster;

  // Drop metadata base (collection.json + json/* + images/*)
  metadataBase: string;

  // Drop config (kept in sync with on-chain config; useful for server-side defaults/validation)
  treasury: string;
  priceSol: number;
  discountPriceSol: number;
  discountMerkleRoot: string;
  maxSupply: number;
  maxPerTx: number;
  namePrefix: string;
  symbol: string;

  // On-chain ids
  boxMinterProgramId: string;
  collectionMint: string;
  receiptsMerkleTree: string;
  deliveryLookupTable: string;
};

export const FUNCTIONS_DEPLOYMENT: FunctionsDeploymentConfig = {
  solanaCluster: ${tsStringLiteral(args.solanaCluster)},

  // Drop metadata base (collection.json + json/* + images/*)
  metadataBase: ${tsStringLiteral(args.metadataBase)},

  // Drop config (kept in sync with on-chain config; useful for server-side defaults/validation)
  treasury: ${tsStringLiteral(args.treasury)},
  priceSol: ${Number(args.priceSol)},
  discountPriceSol: ${Number(args.discountPriceSol)},
  discountMerkleRoot: ${tsStringLiteral(args.discountMerkleRoot)},
  maxSupply: ${Number(args.maxSupply)},
  maxPerTx: ${Number(args.maxPerTx)},
  namePrefix: ${tsStringLiteral(args.namePrefix)},
  symbol: ${tsStringLiteral(args.symbol)},

  // On-chain ids
  boxMinterProgramId: ${tsStringLiteral(args.boxMinterProgramId)},
  collectionMint: ${tsStringLiteral(args.collectionMint)},
  receiptsMerkleTree: ${tsStringLiteral(args.receiptsMerkleTree)},
  deliveryLookupTable: ${tsStringLiteral(args.deliveryLookupTable)},
};

export type DropPaths = {
  /** Normalized drop base (no trailing slash). */
  base: string;
  collectionJson: string;
  boxesJsonBase: string;
  figuresJsonBase: string;
  receiptsBoxesJsonBase: string;
  receiptsFiguresJsonBase: string;
};

export function normalizeDropBase(base: string): string {
  // Allow callers to pass either \`https://.../drops/lsb\` or \`https://.../drops/lsb/\`.
  return String(base || '').replace(/\\/+$/, '');
}

export function dropPathsFromBase(dropBase: string): DropPaths {
  const base = normalizeDropBase(dropBase);
  return {
    base,
    collectionJson: \`\${base}/collection.json\`,
    boxesJsonBase: \`\${base}/json/boxes/\`,
    figuresJsonBase: \`\${base}/json/figures/\`,
    receiptsBoxesJsonBase: \`\${base}/json/receipts/boxes/\`,
    receiptsFiguresJsonBase: \`\${base}/json/receipts/figures/\`,
  };
}

/**
 * Canonical derived paths for the current drop.
 *
 * Keep all path building in one place to avoid duplicating URL strings.
 */
export const FUNCTIONS_PATHS = dropPathsFromBase(FUNCTIONS_DEPLOYMENT.metadataBase);
`;
  writeTextFileIfChanged(filePath, content);
  return filePath;
}

function u64LE(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return buf;
}

function u32LE(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value >>> 0);
  return buf;
}

function u16LE(value: number): Buffer {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 0xffff) throw new Error(`Invalid u16: ${value}`);
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(n & 0xffff);
  return buf;
}

function borshString(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([u32LE(bytes.length), bytes]);
}

function u8(value: number): Buffer {
  return Buffer.from([value & 0xff]);
}

function borshOption(value: Buffer | null | undefined): Buffer {
  if (!value) return Buffer.from([0]);
  return Buffer.concat([Buffer.from([1]), value]);
}

function encodeUmiArray(items: Buffer[]): Buffer {
  return Buffer.concat([u32LE(items.length), ...items]);
}

// MPL-Core plugin encoding helpers (Umi dataEnum + option layouts).
// We need BubblegumV2 + UpdateDelegate so Bubblegum can mint cNFT receipts into this collection
// even though the collection update authority is a PDA (box_minter config PDA).
function mplCoreBasePluginAuthorityAddress(address: PublicKey): Buffer {
  // BasePluginAuthority::Address enum index = 3 (None=0, Owner=1, UpdateAuthority=2, Address=3)
  return Buffer.concat([u8(3), address.toBuffer()]);
}

function mplCorePluginBubblegumV2(): Buffer {
  // Plugin::BubblegumV2 enum index = 15 (see mpl-core PluginType order).
  return u8(15);
}

function mplCorePluginUpdateDelegate(additionalDelegates: PublicKey[]): Buffer {
  // Plugin::UpdateDelegate enum index = 4 (Royalties=0, FreezeDelegate=1, BurnDelegate=2, TransferDelegate=3, UpdateDelegate=4)
  // UpdateDelegate data: { additionalDelegates: Vec<Pubkey> }
  return Buffer.concat([u8(4), encodeUmiArray(additionalDelegates.map((k) => k.toBuffer()))]);
}

function mplCoreBaseRuleSetNone(): Buffer {
  // BaseRuleSet::None enum index = 0 (None=0, ProgramAllowList=1, ProgramDenyList=2).
  return u8(0);
}

function mplCoreCreator(address: PublicKey, percentage: number): Buffer {
  const pct = Number(percentage);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw new Error(`Invalid creator percentage: ${percentage}`);
  return Buffer.concat([address.toBuffer(), u8(pct)]);
}

function mplCorePluginRoyalties(args: { basisPoints: number; creators: { address: PublicKey; percentage: number }[] }): Buffer {
  const bps = Number(args.basisPoints);
  if (!Number.isFinite(bps) || bps < 0 || bps > 10_000) throw new Error(`Invalid royalties basisPoints: ${args.basisPoints}`);
  const creators = Array.isArray(args.creators) ? args.creators : [];

  // BaseRoyalties = { basisPoints: u16, creators: Vec<Creator>, ruleSet: BaseRuleSet }
  const baseRoyalties = Buffer.concat([
    u16LE(bps),
    encodeUmiArray(creators.map((c) => mplCoreCreator(c.address, c.percentage))),
    mplCoreBaseRuleSetNone(),
  ]);

  // Plugin::Royalties enum index = 0. Payload = BaseRoyalties (no extra wrapper beyond tuple(1)).
  return Buffer.concat([u8(0), baseRoyalties]);
}

function mplCorePluginAuthorityPairRoyalties(args: {
  basisPoints: number;
  creators: { address: PublicKey; percentage: number }[];
  authority?: PublicKey | null;
}): Buffer {
  const authority = args.authority ? mplCoreBasePluginAuthorityAddress(args.authority) : null;
  return Buffer.concat([mplCorePluginRoyalties({ basisPoints: args.basisPoints, creators: args.creators }), borshOption(authority)]);
}

function mplCorePluginAuthorityPairBubblegumV2(): Buffer {
  // PluginAuthorityPair = { plugin: Plugin, authority: Option<BasePluginAuthority> }
  // BubblegumV2 authority is fixed to the Bubblegum program (mpl-core enforces this at creation time).
  // We omit the authority field (None) so mpl-core uses the default manager authority.
  return Buffer.concat([mplCorePluginBubblegumV2(), borshOption(null)]);
}

function mplCorePluginAuthorityPairUpdateDelegate(additionalDelegates: PublicKey[]): Buffer {
  // Let Bubblegum mint by letting our deploy/admin key be an UpdateDelegate.
  // We keep the plugin authority as None => UpdateAuthority (the collection update authority, i.e. the config PDA).
  // Bubblegum’s own checks will pass as long as `collection_authority` is in `additionalDelegates`.
  return Buffer.concat([mplCorePluginUpdateDelegate(additionalDelegates), borshOption(null)]);
}

/**
 * MPL-Core instruction: create_collection_v2 (discriminator = 21, mpl-core 1.7.0).
 *
 * Data layout (umi-serializers, which are Borsh-compatible here):
 * - u8 discriminator (21)
 * - string name
 * - string uri
 * - Option<Vec<PluginAuthorityPair>> plugins
 * - Option<Vec<BaseExternalPluginAdapterInitInfo>> externalPluginAdapters
 *
 * NOTE: BubblegumV2 plugin can ONLY be added at creation time (it is permanent and rejects addCollectionPlugin).
 * We include it here so Bubblegum v2 can mint receipt cNFTs into this MPL-Core collection.
 */
const IX_MPL_CORE_CREATE_COLLECTION_V2 = 21;
function buildCreateMplCoreCollectionV2Ix(args: {
  collection: PublicKey;
  updateAuthority: PublicKey;
  payer: PublicKey;
  systemProgram: PublicKey;
  name: string;
  uri: string;
  royaltiesRecipient: PublicKey;
}): TransactionInstruction {
  const pluginsOpt = borshOption(
    encodeUmiArray([
      // Collection-level royalties: 5% to the same treasury used for primary mint payments.
      // IMPORTANT: we set the *plugin authority* to the deployer key so this script can later
      // update royalties if the on-chain payment treasury is changed (update authority is a PDA).
      mplCorePluginAuthorityPairRoyalties({
        basisPoints: CORE_COLLECTION_ROYALTIES_BPS,
        creators: [{ address: args.royaltiesRecipient, percentage: 100 }],
        authority: args.payer,
      }),
      mplCorePluginAuthorityPairBubblegumV2(),
      mplCorePluginAuthorityPairUpdateDelegate([args.payer]),
    ]),
  );
  const externalAdaptersOpt = borshOption(encodeUmiArray([]));

  const data = Buffer.concat([
    u8(IX_MPL_CORE_CREATE_COLLECTION_V2),
    borshString(args.name),
    borshString(args.uri),
    pluginsOpt,
    externalAdaptersOpt,
  ]);

  return new TransactionInstruction({
    programId: MPL_CORE_PROGRAM_ID,
    keys: [
      { pubkey: args.collection, isSigner: true, isWritable: true },
      { pubkey: args.updateAuthority, isSigner: false, isWritable: false },
      { pubkey: args.payer, isSigner: true, isWritable: true },
      { pubkey: args.systemProgram, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// MPL-Core instructions used to keep collection-level royalties in sync.
const IX_MPL_CORE_ADD_COLLECTION_PLUGIN_V1 = 3;
const IX_MPL_CORE_UPDATE_COLLECTION_PLUGIN_V1 = 7;

function buildUpdateMplCoreCollectionRoyaltiesV1Ix(args: {
  collection: PublicKey;
  payer: PublicKey;
  authority: PublicKey;
  royaltiesRecipient: PublicKey;
}): TransactionInstruction {
  const plugin = mplCorePluginRoyalties({
    basisPoints: CORE_COLLECTION_ROYALTIES_BPS,
    creators: [{ address: args.royaltiesRecipient, percentage: 100 }],
  });
  const data = Buffer.concat([u8(IX_MPL_CORE_UPDATE_COLLECTION_PLUGIN_V1), plugin]);
  return new TransactionInstruction({
    programId: MPL_CORE_PROGRAM_ID,
    keys: [
      { pubkey: args.collection, isSigner: false, isWritable: true },
      { pubkey: args.payer, isSigner: true, isWritable: true },
      { pubkey: args.authority, isSigner: true, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function buildAddMplCoreCollectionRoyaltiesV1Ix(args: {
  collection: PublicKey;
  payer: PublicKey;
  authority: PublicKey;
  royaltiesRecipient: PublicKey;
}): TransactionInstruction {
  const plugin = mplCorePluginRoyalties({
    basisPoints: CORE_COLLECTION_ROYALTIES_BPS,
    creators: [{ address: args.royaltiesRecipient, percentage: 100 }],
  });
  // initAuthority: Some(BasePluginAuthority::Address(authority))
  const initAuthority = borshOption(mplCoreBasePluginAuthorityAddress(args.authority));
  const data = Buffer.concat([u8(IX_MPL_CORE_ADD_COLLECTION_PLUGIN_V1), plugin, initAuthority]);
  return new TransactionInstruction({
    programId: MPL_CORE_PROGRAM_ID,
    keys: [
      { pubkey: args.collection, isSigner: false, isWritable: true },
      { pubkey: args.payer, isSigner: true, isWritable: true },
      { pubkey: args.authority, isSigner: true, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

async function upsertMplCoreCollectionRoyalties(args: {
  connection: Connection;
  payer: Keypair;
  collection: PublicKey;
  royaltiesRecipient: PublicKey;
}) {
  const { connection, payer, collection, royaltiesRecipient } = args;

  // Try update first (common path once the plugin exists).
  try {
    const updateIx = buildUpdateMplCoreCollectionRoyaltiesV1Ix({
      collection,
      payer: payer.publicKey,
      authority: payer.publicKey,
      royaltiesRecipient,
    });
    const tx = new Transaction().add(updateIx);
    tx.feePayer = payer.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
    const sig = await sendAndConfirmTx({
      connection,
      tx,
      signers: [payer],
      label: 'update core collection royalties',
      commitment: 'confirmed',
    });
    console.log('✅ Collection royalties updated:', sig);
    return;
  } catch (err) {
    console.warn('⚠️  updateCollectionPluginV1 failed (will try addCollectionPluginV1):', err instanceof Error ? err.message : String(err));
  }

  // If update failed (e.g. plugin missing), try to add.
  const addIx = buildAddMplCoreCollectionRoyaltiesV1Ix({
    collection,
    payer: payer.publicKey,
    authority: payer.publicKey,
    royaltiesRecipient,
  });
  const tx = new Transaction().add(addIx);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
  const sig = await sendAndConfirmTx({ connection, tx, signers: [payer], label: 'add core collection royalties', commitment: 'confirmed' });
  console.log('✅ Collection royalties added:', sig);
}

function readBorshString(buf: Buffer, offset: number): { value: string; offset: number } {
  const len = buf.readUInt32LE(offset);
  const start = offset + 4;
  const end = start + len;
  return { value: buf.subarray(start, end).toString('utf8'), offset: end };
}

function decodeMplCoreCollectionRoyalties(data: Buffer): {
  basisPoints: number;
  creators: { address: PublicKey; percentage: number }[];
  ruleSetKind: number;
  authorityKind: number;
  authorityAddress?: PublicKey;
} | null {
  let o = 0;
  const key = data[o];
  o += 1;
  if (key !== 5) return null; // Not a CollectionV1 account.

  // updateAuthority pubkey
  o += 32;
  // name + uri
  o = readBorshString(data, o).offset;
  o = readBorshString(data, o).offset;
  // numMinted + currentSize
  o += 4;
  o += 4;

  // No plugins section.
  if (o >= data.length) return null;

  // PluginHeaderV1 (key=3, pluginRegistryOffset=u64)
  const pluginHeaderKey = data[o];
  o += 1;
  if (pluginHeaderKey !== 3) return null;
  const pluginRegistryOffset = Number(data.readBigUInt64LE(o));
  if (!Number.isFinite(pluginRegistryOffset) || pluginRegistryOffset < 0 || pluginRegistryOffset >= data.length) return null;

  // PluginRegistryV1 (key=4)
  let r = pluginRegistryOffset;
  const regKey = data[r];
  r += 1;
  if (regKey !== 4) return null;
  const registryLen = data.readUInt32LE(r);
  r += 4;

  let royaltiesPluginOffset: number | null = null;
  let authorityKind = 0;
  let authorityAddress: PublicKey | undefined;

  // RegistryRecord[]: pluginType(u8) + authority(BasePluginAuthority) + offset(u64)
  for (let i = 0; i < registryLen; i++) {
    const pluginType = data[r];
    r += 1;

    const authKind = data[r];
    r += 1;
    if (authKind === 3) {
      const pk = new PublicKey(data.subarray(r, r + 32));
      r += 32;
      if (pluginType === 0) authorityAddress = pk;
    }

    const off = Number(data.readBigUInt64LE(r));
    r += 8;

    if (pluginType === 0) {
      royaltiesPluginOffset = off;
      authorityKind = authKind;
    }
  }

  if (royaltiesPluginOffset == null || !Number.isFinite(royaltiesPluginOffset) || royaltiesPluginOffset < 0 || royaltiesPluginOffset >= data.length)
    return null;

  let p = royaltiesPluginOffset;
  const pluginVariant = data[p];
  p += 1;
  // Plugin variant must match Royalties (0).
  if (pluginVariant !== 0) return null;

  const basisPoints = data.readUInt16LE(p);
  p += 2;
  const creatorsLen = data.readUInt32LE(p);
  p += 4;
  const creators: { address: PublicKey; percentage: number }[] = [];
  for (let i = 0; i < creatorsLen; i++) {
    const address = new PublicKey(data.subarray(p, p + 32));
    p += 32;
    const percentage = data[p];
    p += 1;
    creators.push({ address, percentage });
  }
  const ruleSetKind = data[p];

  return { basisPoints, creators, ruleSetKind, authorityKind, authorityAddress };
}

async function assertMplCoreCollectionRoyalties(args: { connection: Connection; coreCollection: PublicKey; treasury: PublicKey }) {
  const { connection, coreCollection, treasury } = args;
  const info = await connection.getAccountInfo(coreCollection, { commitment: 'confirmed' });
  if (!info?.data) throw new Error(`Missing core collection account: ${coreCollection.toBase58()}`);

  const royalties = decodeMplCoreCollectionRoyalties(info.data);
  if (!royalties) {
    throw new Error(`Missing/undecodable Royalties plugin on core collection: ${coreCollection.toBase58()}`);
  }

  const ok =
    royalties.basisPoints === CORE_COLLECTION_ROYALTIES_BPS &&
    royalties.ruleSetKind === 0 &&
    royalties.creators.length === 1 &&
    royalties.creators[0].address.equals(treasury) &&
    royalties.creators[0].percentage === 100;

  if (!ok) {
    throw new Error(
      `Core collection royalties mismatch.\n` +
        `Collection: ${coreCollection.toBase58()}\n` +
        `Expected: ${CORE_COLLECTION_ROYALTIES_BPS} bps -> ${treasury.toBase58()} (100%)\n` +
        `Actual  : ${royalties.basisPoints} bps -> ${royalties.creators.map((c) => `${c.address.toBase58()} (${c.percentage}%)`).join(', ') || '(none)'}\n`,
    );
  }

  console.log('\n✅ Core collection royalties verified');
  console.log(`  basisPoints: ${royalties.basisPoints}`);
  console.log(`  recipient : ${treasury.toBase58()} (100%)`);
  console.log(`  ruleSet   : ${royalties.ruleSetKind === 0 ? 'None' : `kind=${royalties.ruleSetKind}`}`);
}

function decodeBoxMinterConfig(data: Buffer) {
  // Anchor account discriminator is the first 8 bytes.
  let o = 8;
  const admin = new PublicKey(data.subarray(o, o + 32));
  o += 32;
  const treasury = new PublicKey(data.subarray(o, o + 32));
  o += 32;
  const coreCollection = new PublicKey(data.subarray(o, o + 32));
  o += 32;
  const priceLamports = data.readBigUInt64LE(o);
  o += 8;
  const discountPriceLamports = data.readBigUInt64LE(o);
  o += 8;
  const discountMerkleRoot = data.subarray(o, o + 32);
  o += 32;
  const maxSupply = data.readUInt32LE(o);
  o += 4;
  const maxPerTx = data[o];
  o += 1;
  const minted = data.readUInt32LE(o);
  o += 4;
  const namePrefix = readBorshString(data, o);
  o = namePrefix.offset;
  const symbol = readBorshString(data, o);
  o = symbol.offset;
  const uriBase = readBorshString(data, o);
  o = uriBase.offset;
  const started = Boolean(data[o]);
  o += 1;
  const bump = data[o];

  return {
    admin,
    treasury,
    coreCollection,
    priceLamports,
    discountPriceLamports,
    discountMerkleRoot,
    maxSupply,
    maxPerTx,
    started,
    minted,
    namePrefix: namePrefix.value,
    symbol: symbol.value,
    uriBase: uriBase.value,
    bump,
  };
}

function boxMinterConfigPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('config')], programId)[0];
}

// Anchor instruction discriminator: sha256("global:initialize")[0..8]
const IX_INITIALIZE = Buffer.from('afaf6d1f0d989bed', 'hex');
// Anchor instruction discriminator: sha256("global:set_treasury")[0..8]
const IX_SET_TREASURY = createHash('sha256').update('global:set_treasury').digest().subarray(0, 8);

function buildInitializeIx(args: {
  programId: PublicKey;
  admin: PublicKey;
  treasury: PublicKey;
  coreCollection: PublicKey;
  priceLamports: bigint;
  discountPriceLamports: bigint;
  discountMerkleRoot: Buffer;
  maxSupply: number;
  maxPerTx: number;
  namePrefix: string;
  symbol: string;
  /**
   * Drop base URL (canonical), e.g. `https://assets.mons.link/drops/lsb`.
   *
   * The on-chain program derives per-asset JSON URIs from this base.
   */
  metadataBase: string;
}): TransactionInstruction {
  const configPda = boxMinterConfigPda(args.programId);
  const data = Buffer.concat([
    IX_INITIALIZE,
    u64LE(args.priceLamports),
    u64LE(args.discountPriceLamports),
    Buffer.from(args.discountMerkleRoot),
    u32LE(args.maxSupply),
    Buffer.from([args.maxPerTx & 0xff]),
    borshString(args.namePrefix),
    borshString(args.symbol),
    borshString(args.metadataBase),
  ]);

  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: args.admin, isSigner: true, isWritable: true },
      { pubkey: args.treasury, isSigner: false, isWritable: false },
      { pubkey: args.coreCollection, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function buildSetTreasuryIx(args: { programId: PublicKey; admin: PublicKey; treasury: PublicKey }): TransactionInstruction {
  const configPda = boxMinterConfigPda(args.programId);
  const data = Buffer.concat([IX_SET_TREASURY, args.treasury.toBuffer()]);
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: args.admin, isSigner: true, isWritable: false },
    ],
    data,
  });
}

function canRunSolanaCargo(): boolean {
  // Anchor uses the rustup toolchain directive `cargo +solana ...`.
  // If we have that toolchain, we can generate a v3 Cargo.lock that's compatible
  // with Solana's older Rust toolchain (1.72.x).
  const res = spawnSync('cargo', ['+solana', '--version'], { stdio: ['ignore', 'ignore', 'ignore'], env: process.env });
  return res.status === 0;
}

function readSolanaActiveReleaseBinDir(): string | undefined {
  const home = process.env.HOME;
  if (!home) return undefined;
  const configPath = path.join(home, '.config', 'solana', 'install', 'config.yml');
  if (existsSync(configPath)) {
    const cfg = readFileSync(configPath, 'utf8');
    const match = cfg.match(/^\s*active_release_dir:\s*(.+)\s*$/m);
    if (match?.[1]) {
      return path.join(match[1].trim(), 'bin');
    }
  }
  // Default install location for both legacy solana-install and agave-install.
  return path.join(home, '.local', 'share', 'solana', 'install', 'active_release', 'bin');
}

function ensureAnchorCompatibleCargoLock(onchainDir: string) {
  const lockPath = path.join(onchainDir, 'Cargo.lock');
  if (!existsSync(lockPath)) return false;

  const head = readFileSync(lockPath, 'utf8').slice(0, 4096);
  const match = head.match(/^\s*version\s*=\s*(\d+)\s*$/m);
  const version = match?.[1] ? Number(match[1]) : undefined;
  if (!version || Number.isNaN(version)) return false;

  // Solana/Anchor toolchains often bundle an older Cargo that can't parse lockfile v4
  // ("lock file version 4 requires -Znext-lockfile-bump"). If we detect that, move it
  // aside so `anchor build` can regenerate a compatible lockfile.
  if (version >= 4) {
    const backupPath = path.join(onchainDir, `Cargo.lock.v${version}.bak`);
    console.warn(
      `⚠️  Detected on-chain Cargo.lock version ${version} (incompatible with the Solana/Anchor toolchain cargo).\n` +
        `   Renaming it to ${backupPath} so Anchor can regenerate a compatible lockfile...`,
    );
    try {
      renameSync(lockPath, backupPath);
    } catch {
      const fallback = path.join(onchainDir, `Cargo.lock.bak.${Date.now()}`);
      renameSync(lockPath, fallback);
    }
    return true;
  }
  return false;
}

function run(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string | undefined> } = {}) {
  const env = opts.env ? { ...process.env, ...opts.env } : process.env;
  const res = spawnSync(cmd, args, { stdio: 'inherit', cwd: opts.cwd, env });
  if (res.status !== 0) {
    throw new Error(`Command failed: ${cmd} ${args.join(' ')}`);
  }
}

async function maybeWipeFirestoreDropData(args: { root: string; projectId: string }) {
  const projectId = (args.projectId || '').trim();
  if (!projectId) return;

  const collections = FIRESTORE_DROP_COLLECTIONS_TO_DELETE.filter((c) => typeof c === 'string' && c.trim()).map((c) => c.trim());
  if (!collections.length) return;

  console.log('\n⚠️  FIRESTORE WIPE (drop data)');
  console.log(`Project: ${projectId}`);
  console.log('This will permanently delete ALL documents (recursively) in the following collections:');
  collections.forEach((c) => console.log(`- ${c}`));
  console.log('This will NOT touch: profiles/**, authSessions/**, wallets/** (and their subcollections).');
  console.log('');

  const confirmed = await promptYConfirmation("Type 'y' to confirm Firestore wipe: ");
  if (!confirmed) {
    console.log('Skipping Firestore wipe.');
    return;
  }

  for (const collection of collections) {
    console.log(`\nDeleting Firestore collection: ${collection}`);
    // `--force` skips Firebase CLI prompts; we already prompted above.
    run('firebase', ['firestore:delete', collection, '--recursive', '--force', '--project', projectId], { cwd: args.root });
  }

  console.log('\n✅ Firestore drop data wipe complete.');
}

function readProgramId(onchainDir: string): string {
  const libPath = path.join(onchainDir, 'programs', 'box_minter', 'src', 'lib.rs');
  const content = readFileSync(libPath, 'utf8');
  const match = content.match(/declare_id!\(\"([1-9A-HJ-NP-Za-km-z]{32,44})\"\)/);
  if (!match?.[1]) {
    throw new Error(`Could not find declare_id!(\"...\") in ${libPath}`);
  }
  return match[1];
}

function uniquePubkeys(keys: PublicKey[]) {
  const seen = new Set<string>();
  const out: PublicKey[] = [];
  for (const k of keys) {
    const s = k.toBase58();
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(k);
  }
  return out;
}

async function ensureDeliveryLookupTable(args: {
  connection: Connection;
  payer: Keypair;
  programId: PublicKey;
  configPda: PublicKey;
  treasury: PublicKey;
  coreCollection: PublicKey;
  receiptsMerkleTree?: PublicKey;
}): Promise<PublicKey> {
  const { connection, payer, programId, configPda, treasury, coreCollection, receiptsMerkleTree } = args;
  const required = uniquePubkeys([
    programId,
    configPda,
    treasury,
    coreCollection,
    MPL_CORE_PROGRAM_ID,
    SystemProgram.programId,
    ComputeBudgetProgram.programId,
    SPL_NOOP_PROGRAM_ID,
    // Also include Bubblegum v2 + compression + sysvar programs used by IRL claim txs,
    // so `DELIVERY_LOOKUP_TABLE` can be reused to shrink them below tx-size limits.
    MPL_NOOP_PROGRAM_ID,
    MPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
    BUBBLEGUM_PROGRAM_ID,
    // Bubblegum -> MPL-Core CPI signer.
    new PublicKey('CbNY3JiXdXNE9tPNEk1aRZVEkWdj2v7kfJLNQwZZgpXk'),
    // Also include the receipt tree + its Bubblegum PDA so claim txs can stay tiny.
    ...(receiptsMerkleTree ? [receiptsMerkleTree, bubblegumTreeConfigPda(receiptsMerkleTree)] : []),
  ]);

  // Create a fresh LUT + extend with required addresses (no caching; clean deployments).
  // IMPORTANT: Address Lookup Tables require a *recent rooted slot* (present in the SlotHashes sysvar).
  // Using `confirmed` can return a slot that's not yet rooted, which fails with:
  //   "<slot> is not a recent slot" (InvalidInstructionData)
  const recentSlot = await connection.getSlot('finalized');
  const [createIx, lutAddress] = AddressLookupTableProgram.createLookupTable({
    payer: payer.publicKey,
    authority: payer.publicKey,
    recentSlot,
  });
  const extendIx = AddressLookupTableProgram.extendLookupTable({
    payer: payer.publicKey,
    authority: payer.publicKey,
    lookupTable: lutAddress,
    addresses: required,
  });

  const tx = new Transaction().add(createIx, extendIx);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash('finalized')).blockhash;
  const sig = await sendAndConfirmTx({ connection, tx, signers: [payer], label: 'create delivery ALT', commitment: 'confirmed' });
  console.log('✅ Delivery ALT created:', sig);
  console.log('  ALT:', lutAddress.toBase58());
  return lutAddress;
}

// ---------------------------------------------------------------------------
// Receipt cNFT Merkle tree sizing (Bubblegum v2).
//
// This tree ONLY stores *compressed receipt NFTs* minted via `box_minter::mint_receipts`.
// The uncompressed MPL-Core assets (boxes + revealed figures) are NOT stored in this tree.
//
// Max receipts in this drop:
// - 333 box receipts (1 per box id)
// - 999 figure receipts (1 per figure id)
// => 1332 total receipts.
//
// A concurrent Merkle tree can store up to 2^maxDepth leaves:
// NOTE: Bubblegum only supports a fixed set of (maxDepth, maxBufferSize) constants.
// The smallest supported depth that fits 1332 receipts is depth 14:
// - depth 14 => 16384 (fits, with plenty of headroom)
// ---------------------------------------------------------------------------
const RECEIPTS_TREE_MAX_DEPTH = 14;
const RECEIPTS_TREE_MAX_BUFFER_SIZE = 64;
// Canopy depth controls how many proof nodes are stored on-chain in the tree account.
// NOTE: For Phantom UX, we prefer canopy depth = 0 so wallets can see the *full proof* in the tx
// (this can make previews more reliable). Our IRL-claim tx now fits in one packet without canopy
// by minting the 3 dude receipts via a single `box_minter` instruction (server-cosigned).
const RECEIPTS_TREE_CANOPY_DEPTH = 0;
const IX_BUBBLEGUM_CREATE_TREE_CONFIG_V2 = Buffer.from([55, 99, 95, 215, 142, 203, 227, 205]);

function bubblegumTreeConfigPda(merkleTree: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([merkleTree.toBuffer()], BUBBLEGUM_PROGRAM_ID)[0];
}

function buildCreateBubblegumTreeConfigV2Ix(args: {
  merkleTree: PublicKey;
  payer: PublicKey;
  treeCreator: PublicKey;
  maxDepth: number;
  maxBufferSize: number;
  // If undefined/null, encodes Option::None (private tree).
  isPublic?: boolean | null;
}): TransactionInstruction {
  const treeConfig = bubblegumTreeConfigPda(args.merkleTree);
  const publicOpt = args.isPublic == null ? Buffer.from([0]) : Buffer.from([1, args.isPublic ? 1 : 0]);
  const data = Buffer.concat([
    IX_BUBBLEGUM_CREATE_TREE_CONFIG_V2,
    u32LE(args.maxDepth),
    u32LE(args.maxBufferSize),
    publicOpt,
  ]);

  return new TransactionInstruction({
    programId: BUBBLEGUM_PROGRAM_ID,
    keys: [
      { pubkey: treeConfig, isSigner: false, isWritable: true },
      { pubkey: args.merkleTree, isSigner: false, isWritable: true },
      { pubkey: args.payer, isSigner: true, isWritable: true },
      { pubkey: args.treeCreator, isSigner: true, isWritable: false },
      { pubkey: MPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: MPL_ACCOUNT_COMPRESSION_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

async function createReceiptsMerkleTree(connection: Connection, payer: Keypair): Promise<PublicKey> {
  const merkleTree = Keypair.generate();
  const space = getConcurrentMerkleTreeAccountSize(RECEIPTS_TREE_MAX_DEPTH, RECEIPTS_TREE_MAX_BUFFER_SIZE, RECEIPTS_TREE_CANOPY_DEPTH);
  const lamports = await connection.getMinimumBalanceForRentExemption(space, 'confirmed');

  const createTreeAccountIx = SystemProgram.createAccount({
    fromPubkey: payer.publicKey,
    newAccountPubkey: merkleTree.publicKey,
    lamports,
    space,
    programId: MPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
  });
  const createTreeConfigIx = buildCreateBubblegumTreeConfigV2Ix({
    merkleTree: merkleTree.publicKey,
    payer: payer.publicKey,
    treeCreator: payer.publicKey,
    maxDepth: RECEIPTS_TREE_MAX_DEPTH,
    maxBufferSize: RECEIPTS_TREE_MAX_BUFFER_SIZE,
    isPublic: null,
  });

  const tx = new Transaction().add(createTreeAccountIx).add(createTreeConfigIx);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
  const sig = await sendAndConfirmTx({
    connection,
    tx,
    signers: [payer, merkleTree],
    label: 'create receipts Merkle tree',
    commitment: 'confirmed',
  });
  console.log('✅ Receipt cNFT Merkle tree created:', sig);
  console.log('  RECEIPTS_MERKLE_TREE:', merkleTree.publicKey.toBase58());
  return merkleTree.publicKey;
}

function generateFreshProgramKeypair(programKeypairPath: string): { programId: string; backupPath?: string } {
  mkdirSync(path.dirname(programKeypairPath), { recursive: true });

  let backupPath: string | undefined;
  if (existsSync(programKeypairPath)) {
    // Keep a copy so you can still upgrade older deployments if needed.
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    backupPath = programKeypairPath.replace(/\.json$/i, `.${ts}.bak.json`);
    try {
      renameSync(programKeypairPath, backupPath);
    } catch {
      // Fallback: best-effort unique name.
      backupPath = programKeypairPath.replace(/\.json$/i, `.bak.${Date.now()}.json`);
      renameSync(programKeypairPath, backupPath);
    }
  }

  const kp = Keypair.generate();
  // solana-cli expects a JSON array of 64 u8 values.
  writeFileSync(programKeypairPath, JSON.stringify(Array.from(kp.secretKey)), { encoding: 'utf8', mode: 0o600 });
  return { programId: kp.publicKey.toBase58(), backupPath };
}

function cargoLockHasPackage(onchainDir: string, name: string, version: string): boolean {
  const lockPath = path.join(onchainDir, 'Cargo.lock');
  if (!existsSync(lockPath)) return false;
  const content = readFileSync(lockPath, 'utf8');
  const re = new RegExp(`\\[\\[package\\]\\]\\s*\\nname = "${name}"\\s*\\nversion = "${version}"`, 'm');
  return re.test(content);
}

async function assertMplCoreCollection(connection: Connection, coreCollection: PublicKey) {
  const info = await connection.getAccountInfo(coreCollection, { commitment: 'confirmed' });
  if (!info) {
    throw new Error(
      `Missing core collection account: ${coreCollection.toBase58()}\n` +
        `Make sure SOLANA_CLUSTER / SOLANA_RPC_URL are correct (scripts/deploy-all-onchain.ts).`,
    );
  }
  if (!info.owner.equals(MPL_CORE_PROGRAM_ID)) {
    throw new Error(
      `coreCollection ${coreCollection.toBase58()} is not owned by the MPL-Core program.\n` +
        `Expected owner: ${MPL_CORE_PROGRAM_ID.toBase58()}\n` +
        `Actual owner  : ${info.owner.toBase58()}\n` +
        `If you set CORE_COLLECTION_PUBKEY, it must be an MPL-Core collection address (not a Token Metadata mint).`,
    );
  }
}

function decodeMplCoreCollectionUpdateAuthority(data: Buffer): PublicKey {
  // mpl-core BaseCollectionV1 starts with `Key` enum (u8). CollectionV1 = 5.
  const key = data[0];
  if (key !== 5) {
    throw new Error(`Not an MPL-Core collection account (unexpected Key enum ${key})`);
  }
  // BaseCollectionV1::update_authority is the next 32 bytes.
  return new PublicKey(data.subarray(1, 1 + 32));
}

async function getMplCoreCollectionUpdateAuthority(connection: Connection, coreCollection: PublicKey): Promise<PublicKey> {
  const info = await connection.getAccountInfo(coreCollection, { commitment: 'confirmed' });
  if (!info?.data) {
    throw new Error(`Missing core collection account: ${coreCollection.toBase58()}`);
  }
  return decodeMplCoreCollectionUpdateAuthority(info.data);
}

async function main() {
  const extraArgs = process.argv.slice(2);
  if (extraArgs.length) {
    throw new Error(
      `This script accepts no CLI args.\n` +
        `Run:\n` +
        `  npm run deploy-all-onchain\n` +
        `\n` +
        `To change cluster/RPC/core collection or reuse settings, edit constants at the top of scripts/deploy-all-onchain.ts.\n`,
    );
  }

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const root = path.resolve(__dirname, '..');
  const onchainDir = path.join(root, 'onchain');
  const programKeypair = path.join(onchainDir, 'target', 'deploy', 'box_minter-keypair.json');
  const programBinary = path.join(onchainDir, 'target', 'deploy', 'box_minter.so');
  const discountCsvPath = path.join(root, 'scripts', 'discount.csv');
  const discountAddresses = readDiscountList(discountCsvPath);
  const discountMerkle = buildDiscountMerkleData(discountAddresses);
  const discountMerkleJsonPath = path.join(root, 'src', 'config', 'discountMerkle.json');
  writeDiscountMerkleJson({
    root: discountMerkle.root,
    proofs: discountMerkle.proofs,
    filePath: discountMerkleJsonPath,
  });

  const cluster: SolanaCluster = SOLANA_CLUSTER;
  const rpcUrlForApps = SOLANA_RPC_URL || clusterApiUrl(cluster);
  const solanaUrl = SOLANA_RPC_URL || cluster;
  const solanaBinDir = readSolanaActiveReleaseBinDir();

  console.log('--- deploy ALL (program + MPL Core collection + config) ---');
  console.log('cluster:', cluster);
  console.log('rpc url :', rpcUrlForApps);
  if (CORE_COLLECTION_PUBKEY) console.log('core collection:', CORE_COLLECTION_PUBKEY);
  if (solanaBinDir) console.log('solana bin:', solanaBinDir);
  console.log('');

  // Fail fast if the target cluster/RPC does not have the Metaplex programs we depend on.
  const connection = new Connection(rpcUrlForApps, { commitment: 'confirmed' });
  await assertExternalProgramsDeployed(connection, cluster);

  console.log('Enter the deployer wallet private key (input is hidden).');
  console.log('Accepted formats: base58 secret key, or JSON array (like ~/.config/solana/id.json contents).');
  const payer = parsePrivateKeyInput(await promptMaskedInput('deployer private key: '));
  console.log('deployer pubkey:', payer.publicKey.toBase58());

  const tempKeypairPath = writeTempKeypairFile(payer);
  registerTempKeypairCleanup(tempKeypairPath);
  const toolEnv = {
    ...(solanaBinDir ? { PATH: `${solanaBinDir}:${process.env.PATH || ''}` } : {}),
    // Keep anchor + solana cli aligned with the deployer wallet.
    ANCHOR_WALLET: tempKeypairPath,
  };

  const reuseProgramId = REUSE_PROGRAM_ID;
  let expectedProgramId: string | undefined;
  if (reuseProgramId) {
    if (!existsSync(programKeypair)) {
      throw new Error(
        `Missing program keypair: ${programKeypair}\n` +
          `Either create it first, or set REUSE_PROGRAM_ID=false to auto-generate a fresh program id.\n` +
          `Generate it with:\n` +
          `  solana-keygen new --no-bip39-passphrase -o ${programKeypair}\n`,
      );
    }
    console.log('Reusing existing program keypair:', programKeypair);
  } else {
    const { programId, backupPath } = generateFreshProgramKeypair(programKeypair);
    expectedProgramId = programId;
    console.log('Generated fresh program id:', programId);
    console.log('Program keypair:', programKeypair);
    if (backupPath) console.log('Backed up previous program keypair to:', backupPath);
  }

  const hasSolanaCargo = canRunSolanaCargo();
  if (hasSolanaCargo) {
    console.log('solana cargo toolchain:', 'cargo +solana');
  } else {
    console.warn('⚠️  Missing rustup `solana` toolchain (`cargo +solana`). Anchor may fail if your Cargo.lock is too new.');
  }

  // 1) Build + deploy program via Anchor.
  run('anchor', ['keys', 'sync'], { cwd: onchainDir, env: toolEnv });
  if (expectedProgramId) {
    const synced = readProgramId(onchainDir);
    if (synced !== expectedProgramId) {
      throw new Error(
        `Program id sync mismatch.\n` +
          `Expected: ${expectedProgramId}\n` +
          `Synced  : ${synced}\n` +
          `\n` +
          `This usually means 'anchor keys sync' did not update the program source/Anchor.toml.\n` +
          `Try running it manually in ${onchainDir} and re-run this script.`,
      );
    }
  }

  // Ensure Cargo.lock is compatible with the Solana toolchain (cargo 1.72.x).
  const lockMoved = ensureAnchorCompatibleCargoLock(onchainDir);

  // Only (re)generate a lockfile if it's missing (fresh clone) or if we moved aside an incompatible v4 lockfile.
  // If a compatible Cargo.lock already exists, keep it as-is so dependency versions remain pinned.
  if (hasSolanaCargo && (lockMoved || !existsSync(path.join(onchainDir, 'Cargo.lock')))) {
    run('cargo', ['+solana', 'generate-lockfile'], { cwd: onchainDir });

    // Cargo can pick newer crates that exceed Solana's pinned Rust toolchain MSRV.
    // In particular, borsh 1.6.x requires rustc >= 1.77; pin borsh to 1.5.5 if needed.
    if (cargoLockHasPackage(onchainDir, 'borsh', '1.6.0')) {
      run('cargo', ['+solana', 'update', '-p', 'borsh@1.6.0', '--precise', '1.5.5'], { cwd: onchainDir });
    }
  }

  // Build with Anchor "lean" features to reduce binary size (no on-chain IDL + no auto instruction-name logs).
  run('anchor', ['build', '--arch', 'sbf', '--', '--features', 'no-idl,no-log-ix-name'], { cwd: onchainDir, env: toolEnv });
  if (!existsSync(programBinary)) {
    throw new Error(`Missing program binary after build: ${programBinary}`);
  }

  // Deploy program via Solana CLI (Agave). This avoids `anchor deploy` rebuilding with the wrong arch/tooling.
  const deployArgs = ['program', 'deploy', programBinary, '--program-id', programKeypair, '--url', solanaUrl, '--keypair', tempKeypairPath];
  run('solana', deployArgs, { cwd: onchainDir, env: toolEnv });

  const programId = readProgramId(onchainDir);
  console.log('\nProgram deployed:', programId);

  // 2) Deploy on-chain prerequisites + initialize config PDA.
  // ---------------------------------------------------------------------------
  // EDIT THESE CONSTANTS to control drop metadata. No ENV/CLI overrides.
  const DROP_METADATA_BASE = 'https://assets.mons.link/drops/lsb';
  const BOX_MINTER_CONFIG = {
    // Payment + mint caps
    // Payments: SOL from box mints + delivery fees go here.
    // Custody/vault: boxes and delivered assets still transfer to the deployer/admin key (config.admin).
    // Set to `undefined` to default payments to the deployer/admin key.
    treasury: '8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM',
    priceSol: 0.01,
    discountPriceSol: 0.55,
    discountMerkleRoot: discountMerkle.root,
    maxSupply: 333,
    maxPerTx: 15,

    // Box metadata (stored on-chain)
    namePrefix: 'box',
    symbol: 'box',
    // Canonical drop base. The on-chain program derives:
    // - boxes   : `${metadataBase}/json/boxes/{id}.json`
    // - figures : `${metadataBase}/json/figures/{id}.json`
    // - receipts: `${metadataBase}/json/receipts/{kind}/{id}.json`
    // (The program also supports legacy configs where the stored value is already `${base}/json/boxes/`.)
    metadataBase: DROP_METADATA_BASE,
  };
  // ---------------------------------------------------------------------------

  const programPk = new PublicKey(programId);
  const configPda = boxMinterConfigPda(programPk);

  const existingCfg = await connection.getAccountInfo(configPda, { commitment: 'confirmed' });
  if (existingCfg) {
    const cfg = decodeBoxMinterConfig(existingCfg.data);
    console.log('\nConfig PDA already exists (skipping init):', configPda.toBase58());
    console.log(
      `Minted: ${cfg.minted}/${cfg.maxSupply} · price(lamports): ${cfg.priceLamports.toString()} · max/tx: ${cfg.maxPerTx}`,
    );
    // Require the deployer key to match the configured admin (custody vault + server cosigner).
    if (!payer.publicKey.equals(cfg.admin)) {
      throw new Error(
        `Config admin pubkey does not match the deployer key you entered.\n` +
          `- deployer: ${payer.publicKey.toBase58()}\n` +
          `- admin   : ${cfg.admin.toBase58()}\n` +
          `\n` +
          `Fix: re-run with the admin keypair, or redeploy fresh without reusing this config PDA.`,
      );
    }
    await assertMplCoreCollection(connection, cfg.coreCollection);

    // Optional: update payment treasury if configured in BOX_MINTER_CONFIG.
    let paymentTreasury = cfg.treasury;
    if (BOX_MINTER_CONFIG.treasury) {
      const desired = new PublicKey(BOX_MINTER_CONFIG.treasury);
      if (!desired.equals(cfg.treasury)) {
        console.log('\nUpdating payment treasury…');
        console.log('  from:', cfg.treasury.toBase58());
        console.log('  to  :', desired.toBase58());
        const setIx = buildSetTreasuryIx({ programId: programPk, admin: payer.publicKey, treasury: desired });
        const tx = new Transaction().add(setIx);
        tx.feePayer = payer.publicKey;
        tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
        const sig = await sendAndConfirmTx({ connection, tx, signers: [payer], label: 'set treasury', commitment: 'confirmed' });
        console.log('✅ Payment treasury updated:', sig);
        paymentTreasury = desired;
      }
    }

    // Enforce/keep collection-level royalties in sync with the payment treasury.
    // (If the collection was created by an older version of this script, this will try to add the plugin.)
    await upsertMplCoreCollectionRoyalties({ connection, payer, collection: cfg.coreCollection, royaltiesRecipient: paymentTreasury });

    console.log('');
    let receiptsTree: PublicKey | null = null;
    try {
      receiptsTree = await createReceiptsMerkleTree(connection, payer);
      console.log(`RECEIPTS_MERKLE_TREE=${receiptsTree.toBase58()}`);
    } catch (err) {
      console.warn('⚠️  Failed to create receipts merkle tree:', err instanceof Error ? err.message : String(err));
    }

    let deliveryLut: PublicKey | null = null;
    try {
      deliveryLut = await ensureDeliveryLookupTable({
        connection,
        payer,
        programId: programPk,
        configPda,
        treasury: paymentTreasury,
        coreCollection: cfg.coreCollection,
        receiptsMerkleTree: receiptsTree || undefined,
      });
      console.log(`DELIVERY_LOOKUP_TABLE=${deliveryLut.toBase58()}`);
    } catch (err) {
      console.warn('⚠️  Failed to create/reuse delivery ALT:', err instanceof Error ? err.message : String(err));
    }

    const functionsCfgPath = path.join(root, 'functions', 'src', 'config', 'deployment.ts');
    const previousReceipts = readExistingTsObjectStringField(functionsCfgPath, 'receiptsMerkleTree');
    const previousLut = readExistingTsObjectStringField(functionsCfgPath, 'deliveryLookupTable');
    const receiptsTreeStr = receiptsTree?.toBase58() || previousReceipts || '';
    const deliveryLutStr = deliveryLut?.toBase58() || previousLut || '';

    const resolvedDropBase = normalizeDropBase(cfg.uriBase) || normalizeDropBase(DROP_METADATA_BASE);

    const frontendCfgPath = writeFrontendDeployedConfig({
      root,
      solanaCluster: cluster,
      metadataBase: resolvedDropBase,
      treasury: paymentTreasury.toBase58(),
      priceSol: Number(cfg.priceLamports) / LAMPORTS_PER_SOL,
      discountPriceSol: Number(cfg.discountPriceLamports) / LAMPORTS_PER_SOL,
      discountMerkleRoot: cfg.discountMerkleRoot.toString('hex'),
      maxSupply: cfg.maxSupply,
      maxPerTx: cfg.maxPerTx,
      namePrefix: cfg.namePrefix,
      symbol: cfg.symbol,
      boxMinterProgramId: programPk.toBase58(),
      collectionMint: cfg.coreCollection.toBase58(),
    });
    const functionsCfgWrittenPath = writeFunctionsDeploymentConfig({
      root,
      solanaCluster: cluster,
      metadataBase: resolvedDropBase,
      treasury: paymentTreasury.toBase58(),
      priceSol: Number(cfg.priceLamports) / LAMPORTS_PER_SOL,
      discountPriceSol: Number(cfg.discountPriceLamports) / LAMPORTS_PER_SOL,
      discountMerkleRoot: cfg.discountMerkleRoot.toString('hex'),
      maxSupply: cfg.maxSupply,
      maxPerTx: cfg.maxPerTx,
      namePrefix: cfg.namePrefix,
      symbol: cfg.symbol,
      boxMinterProgramId: programPk.toBase58(),
      collectionMint: cfg.coreCollection.toBase58(),
      receiptsMerkleTree: receiptsTreeStr,
      deliveryLookupTable: deliveryLutStr,
    });

    console.log('');
    console.log('--- updated tracked config ---');
    console.log(`- ${path.relative(root, frontendCfgPath)}`);
    console.log(`- ${path.relative(root, functionsCfgWrittenPath)}`);
    console.log('');

    await maybeWipeFirestoreDropData({ root, projectId: FIREBASE_PROJECT_ID });
    return;
  }

  // Payment treasury (defaults to deployer/admin key if unset).
  const treasury = new PublicKey(BOX_MINTER_CONFIG.treasury || payer.publicKey.toBase58());
  const priceLamports = BigInt(Math.round(Number(BOX_MINTER_CONFIG.priceSol) * LAMPORTS_PER_SOL));
  const discountPriceLamports = BigInt(Math.round(Number(BOX_MINTER_CONFIG.discountPriceSol) * LAMPORTS_PER_SOL));
  const discountMerkleRoot = BOX_MINTER_CONFIG.discountMerkleRoot;
  const maxSupply = Number(BOX_MINTER_CONFIG.maxSupply);
  const maxPerTx = Number(BOX_MINTER_CONFIG.maxPerTx);
  // 2) Create or reuse an MPL-Core collection (uncompressed).
  // IMPORTANT: for the on-chain program to mint into the collection, the collection update authority
  // must be the program config PDA.
  const coreCollection = CORE_COLLECTION_PUBKEY ? new PublicKey(CORE_COLLECTION_PUBKEY) : undefined;

  // EDIT THESE CONSTANTS to control the MPL-Core collection metadata.
  const CORE_COLLECTION_CONFIG = {
    name: 'little swag figures',
    uri: `${DROP_METADATA_BASE}/collection.json`,
  };

  let resolvedCoreCollection: PublicKey;
  if (coreCollection) {
    resolvedCoreCollection = coreCollection;
    await assertMplCoreCollection(connection, resolvedCoreCollection);
    const updateAuthority = await getMplCoreCollectionUpdateAuthority(connection, resolvedCoreCollection);
    if (!updateAuthority.equals(configPda)) {
      throw new Error(
        `CORE_COLLECTION_PUBKEY is not configured for this deployment.\n` +
          `Collection: ${resolvedCoreCollection.toBase58()}\n` +
          `Expected update authority (program config PDA): ${configPda.toBase58()}\n` +
          `Actual update authority: ${updateAuthority.toBase58()}\n` +
          `\n` +
          `Fix: unset CORE_COLLECTION_PUBKEY to auto-create one, or transfer collection update authority to the config PDA.`,
      );
    }
    console.log('\n[2/3] Using existing MPL-Core collection…');
    console.log('  core collection:', resolvedCoreCollection.toBase58());
    console.log('  collection update authority (config PDA):', configPda.toBase58());
  } else {
    console.log('\n[2/3] Creating MPL-Core collection (uncompressed)…');
    const collection = Keypair.generate();
    const createCollectionIx = buildCreateMplCoreCollectionV2Ix({
      collection: collection.publicKey,
      updateAuthority: configPda,
      payer: payer.publicKey,
      systemProgram: SystemProgram.programId,
      name: CORE_COLLECTION_CONFIG.name,
      uri: CORE_COLLECTION_CONFIG.uri,
      royaltiesRecipient: treasury,
    });
    const createCollectionTx = new Transaction().add(createCollectionIx);
    createCollectionTx.feePayer = payer.publicKey;
    createCollectionTx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
    createCollectionTx.partialSign(collection);
    const sig = await sendAndConfirmTx({
      connection,
      tx: createCollectionTx,
      signers: [payer, collection],
      label: 'create MPL-Core collection',
      commitment: 'confirmed',
    });
    console.log('✅ Collection created:', sig);
    console.log('  Collection:', collection.publicKey.toBase58());
    console.log('  Collection update authority (program config PDA):', configPda.toBase58());
    resolvedCoreCollection = collection.publicKey;
    await assertMplCoreCollection(connection, resolvedCoreCollection);
  }

  // Read-only check: confirm the collection Royalties plugin is present and matches the payment treasury.
  await assertMplCoreCollectionRoyalties({ connection, coreCollection: resolvedCoreCollection, treasury });

  // If we are using a pre-existing collection (CORE_COLLECTION_PUBKEY), enforce royalties here.
  // For freshly created collections, royalties are already set in `create_collection_v2`.
  if (coreCollection) {
    await upsertMplCoreCollectionRoyalties({ connection, payer, collection: resolvedCoreCollection, royaltiesRecipient: treasury });
  }

  console.log('\n[3/3] Initializing box minter…');

  const initIx = buildInitializeIx({
    programId: programPk,
    admin: payer.publicKey,
    treasury,
    coreCollection: resolvedCoreCollection,
    priceLamports,
    discountPriceLamports,
    discountMerkleRoot,
    maxSupply,
    maxPerTx,
    namePrefix: BOX_MINTER_CONFIG.namePrefix,
    symbol: BOX_MINTER_CONFIG.symbol,
    metadataBase: normalizeDropBase(BOX_MINTER_CONFIG.metadataBase),
  });

  const setupTx = new Transaction().add(initIx);
  setupTx.feePayer = payer.publicKey;
  setupTx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
  const setupSig = await sendAndConfirmTx({ connection, tx: setupTx, signers: [payer], label: 'initialize box minter', commitment: 'confirmed' });
  console.log('✅ Box minter configured:', setupSig);
  console.log('  Config PDA:', configPda.toBase58());
  console.log('  Payment treasury:', treasury.toBase58());
  console.log('  Price (lamports):', priceLamports.toString());
  console.log('  Discount price (lamports):', discountPriceLamports.toString());
  console.log('');

  let receiptsTree: PublicKey | null = null;
  try {
    receiptsTree = await createReceiptsMerkleTree(connection, payer);
    console.log(`RECEIPTS_MERKLE_TREE=${receiptsTree.toBase58()}`);
  } catch (err) {
    console.warn('⚠️  Failed to create receipts merkle tree:', err instanceof Error ? err.message : String(err));
  }

  let deliveryLut: PublicKey | null = null;
  try {
    deliveryLut = await ensureDeliveryLookupTable({
      connection,
      payer,
      programId: programPk,
      configPda,
      treasury,
      coreCollection: resolvedCoreCollection,
      receiptsMerkleTree: receiptsTree || undefined,
    });
    console.log(`DELIVERY_LOOKUP_TABLE=${deliveryLut.toBase58()}`);
  } catch (err) {
    console.warn('⚠️  Failed to create/reuse delivery ALT:', err instanceof Error ? err.message : String(err));
  }

  const functionsCfgPath = path.join(root, 'functions', 'src', 'config', 'deployment.ts');
  const previousReceipts = readExistingTsObjectStringField(functionsCfgPath, 'receiptsMerkleTree');
  const previousLut = readExistingTsObjectStringField(functionsCfgPath, 'deliveryLookupTable');
  const receiptsTreeStr = receiptsTree?.toBase58() || previousReceipts || '';
  const deliveryLutStr = deliveryLut?.toBase58() || previousLut || '';

  const frontendCfgPath = writeFrontendDeployedConfig({
    root,
    solanaCluster: cluster,
    metadataBase: DROP_METADATA_BASE,
    treasury: treasury.toBase58(),
    priceSol: Number(BOX_MINTER_CONFIG.priceSol),
    discountPriceSol: Number(BOX_MINTER_CONFIG.discountPriceSol),
    discountMerkleRoot: discountMerkleRoot.toString('hex'),
    maxSupply: Number(BOX_MINTER_CONFIG.maxSupply),
    maxPerTx: Number(BOX_MINTER_CONFIG.maxPerTx),
    namePrefix: BOX_MINTER_CONFIG.namePrefix,
    symbol: BOX_MINTER_CONFIG.symbol,
    boxMinterProgramId: programPk.toBase58(),
    collectionMint: resolvedCoreCollection.toBase58(),
  });
  const functionsCfgWrittenPath = writeFunctionsDeploymentConfig({
    root,
    solanaCluster: cluster,
    metadataBase: DROP_METADATA_BASE,
    treasury: treasury.toBase58(),
    priceSol: Number(BOX_MINTER_CONFIG.priceSol),
    discountPriceSol: Number(BOX_MINTER_CONFIG.discountPriceSol),
    discountMerkleRoot: discountMerkleRoot.toString('hex'),
    maxSupply: Number(BOX_MINTER_CONFIG.maxSupply),
    maxPerTx: Number(BOX_MINTER_CONFIG.maxPerTx),
    namePrefix: BOX_MINTER_CONFIG.namePrefix,
    symbol: BOX_MINTER_CONFIG.symbol,
    boxMinterProgramId: programPk.toBase58(),
    collectionMint: resolvedCoreCollection.toBase58(),
    receiptsMerkleTree: receiptsTreeStr,
    deliveryLookupTable: deliveryLutStr,
  });

  console.log('');
  console.log('--- updated tracked config ---');
  console.log(`- ${path.relative(root, frontendCfgPath)}`);
  console.log(`- ${path.relative(root, functionsCfgWrittenPath)}`);
  console.log('');

  await maybeWipeFirestoreDropData({ root, projectId: FIREBASE_PROJECT_ID });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
