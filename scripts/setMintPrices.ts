import { createHash } from 'crypto';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import {
  clusterApiUrl,
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import { parsePrivateKeyInput, promptMaskedInput, promptYConfirmation } from './shared/interactive.ts';

type SolanaCluster = 'devnet' | 'testnet' | 'mainnet-beta';

type DeploymentDropConfig = {
  solanaCluster: SolanaCluster;
  dropId: string;
  metadataBase: string;
  priceSol: number;
  discountPriceSol: number;
  boxMinterProgramId: string;
  boxMinterConfigPda?: string;
};

type DecodedBoxMinterConfig = {
  admin: PublicKey;
  treasury: PublicKey;
  coreCollection: PublicKey;
  priceLamports: bigint;
  discountPriceLamports: bigint;
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
};

const IX_SET_MINT_PRICES = createHash('sha256').update('global:set_mint_prices').digest().subarray(0, 8);
const ACCOUNT_BOX_MINTER_CONFIG = Uint8Array.from([0x3e, 0x1d, 0x74, 0xbc, 0xdb, 0xf7, 0x30, 0xe3]);

function usage(): string {
  return `Run:\n  npm run set-mint-prices -- <dropId>\n  npm run set-mint-prices -- <dropId> --dry-run\n`;
}

function normalizeDropId(value: string | undefined): string {
  return String(value || '').trim().toLowerCase();
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertSolanaCluster(value: unknown, label: string): SolanaCluster {
  if (value === 'devnet' || value === 'testnet' || value === 'mainnet-beta') return value;
  throw new Error(`Invalid ${label}: ${String(value)}`);
}

function requireString(value: unknown, label: string): string {
  const parsed = typeof value === 'string' ? value.trim() : '';
  if (parsed) return parsed;
  throw new Error(`Missing ${label}.`);
}

function requireNumber(value: unknown, label: string): number {
  const parsed = Number(value);
  if (Number.isFinite(parsed)) return parsed;
  throw new Error(`Invalid ${label}: ${String(value)}`);
}

function readDropConfig(value: unknown, label: string): DeploymentDropConfig {
  if (!isObjectRecord(value)) throw new Error(`Missing ${label}.`);
  return {
    solanaCluster: assertSolanaCluster(value.solanaCluster, `${label}.solanaCluster`),
    dropId: requireString(value.dropId, `${label}.dropId`),
    metadataBase: requireString(value.metadataBase, `${label}.metadataBase`),
    priceSol: requireNumber(value.priceSol, `${label}.priceSol`),
    discountPriceSol: requireNumber(value.discountPriceSol, `${label}.discountPriceSol`),
    boxMinterProgramId: requireString(value.boxMinterProgramId, `${label}.boxMinterProgramId`),
    ...(typeof value.boxMinterConfigPda === 'string' && value.boxMinterConfigPda.trim()
      ? { boxMinterConfigPda: value.boxMinterConfigPda.trim() }
      : {}),
  };
}

async function loadDropFromRegistry(args: {
  filePath: string;
  exportName: string;
  dropId: string;
  label: string;
}): Promise<DeploymentDropConfig> {
  if (!existsSync(args.filePath)) {
    throw new Error(`Missing ${args.label} deployment config: ${args.filePath}`);
  }

  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(args.filePath).href)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`Could not load ${args.label} deployment config from ${args.filePath}: ${String(err)}`);
  }

  const registry = mod[args.exportName];
  if (!isObjectRecord(registry)) {
    throw new Error(`Could not read ${args.exportName} from ${args.filePath}.`);
  }

  const entry = registry[args.dropId];
  if (!entry) {
    const knownDropIds = Object.keys(registry).sort((a, b) => a.localeCompare(b));
    throw new Error(
      `Drop ${args.dropId} is not present in ${args.filePath}.\n` +
        `Known drops: ${knownDropIds.length ? knownDropIds.join(', ') : '(none)'}`,
    );
  }

  return readDropConfig(entry, `${args.label}.${args.dropId}`);
}

function assertMatchingConfig(frontend: DeploymentDropConfig, functionsDrop: DeploymentDropConfig) {
  const fields = [
    'solanaCluster',
    'dropId',
    'metadataBase',
    'priceSol',
    'discountPriceSol',
    'boxMinterProgramId',
    'boxMinterConfigPda',
  ] as const;
  for (const field of fields) {
    if (frontend[field] !== functionsDrop[field]) {
      throw new Error(
        `Frontend/functions deployment config mismatch for ${field}.\n` +
          `- frontend : ${String(frontend[field])}\n` +
          `- functions: ${String(functionsDrop[field])}`,
      );
    }
  }
}

function solToLamports(value: number, label: string): bigint {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite SOL amount.`);
  }
  const lamports = Math.round(value * LAMPORTS_PER_SOL);
  if (!Number.isSafeInteger(lamports) || lamports <= 0) {
    throw new Error(`${label} cannot be represented as safe lamports.`);
  }
  return BigInt(lamports);
}

function validatePricePair(priceLamports: bigint, discountPriceLamports: bigint) {
  if (priceLamports <= 0n) throw new Error('priceSol must be greater than zero.');
  if (discountPriceLamports <= 0n) throw new Error('discountPriceSol must be greater than zero.');
  if (discountPriceLamports > priceLamports) {
    throw new Error('discountPriceSol must be less than or equal to priceSol.');
  }
}

function formatSolFromLamports(lamports: bigint): string {
  const sign = lamports < 0n ? '-' : '';
  const abs = lamports < 0n ? -lamports : lamports;
  const whole = abs / BigInt(LAMPORTS_PER_SOL);
  const fraction = abs % BigInt(LAMPORTS_PER_SOL);
  const fractionText = fraction.toString().padStart(9, '0').replace(/0+$/, '');
  return `${sign}${whole.toString()}${fractionText ? `.${fractionText}` : ''}`;
}

function u64LE(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return buf;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readBorshString(buf: Buffer, offset: number): { value: string; offset: number } {
  if (offset + 4 > buf.length) {
    throw new Error('Unsupported box minter config schema while decoding string length.');
  }
  const len = buf.readUInt32LE(offset);
  const start = offset + 4;
  const end = start + len;
  if (end > buf.length) {
    throw new Error('Unsupported box minter config schema while decoding string bytes.');
  }
  return { value: buf.subarray(start, end).toString('utf8'), offset: end };
}

function decodeBoxMinterConfig(data: Buffer): DecodedBoxMinterConfig {
  const expectedMinLen =
    8 +
    32 * 3 +
    8 +
    8 +
    32 +
    4 +
    1 +
    1 +
    4 +
    4 +
    8 +
    4 +
    10 +
    4 +
    96 +
    1 +
    1;
  if (data.length < expectedMinLen) {
    throw new Error(`Unsupported box minter config schema: expected at least ${expectedMinLen} bytes, got ${data.length}.`);
  }
  for (let i = 0; i < ACCOUNT_BOX_MINTER_CONFIG.length; i += 1) {
    if (data[i] !== ACCOUNT_BOX_MINTER_CONFIG[i]) {
      throw new Error('Invalid box minter config discriminator.');
    }
  }

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
  o += 8 + 32;
  const maxSupply = data.readUInt32LE(o);
  o += 4;
  const maxPerTx = data[o];
  o += 1;
  const itemsPerBox = data[o];
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
  o += 1;
  const discountMintsPerWallet = data[o];

  return {
    admin,
    treasury,
    coreCollection,
    priceLamports,
    discountPriceLamports,
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
  };
}

function buildSetMintPricesIx(args: {
  programId: PublicKey;
  configPda: PublicKey;
  admin: PublicKey;
  priceLamports: bigint;
  discountPriceLamports: bigint;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.configPda, isSigner: false, isWritable: true },
      { pubkey: args.admin, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([IX_SET_MINT_PRICES, u64LE(args.priceLamports), u64LE(args.discountPriceLamports)]),
  });
}

async function main() {
  const extraArgs = process.argv.slice(2);
  const dryRun = extraArgs.includes('--dry-run');
  const positionalArgs = extraArgs.filter((arg) => arg !== '--dry-run');
  if (positionalArgs.length !== 1) {
    throw new Error(`This script requires exactly one dropId argument.\n${usage()}`);
  }
  const requestedDropId = normalizeDropId(positionalArgs[0]);
  if (!requestedDropId) {
    throw new Error(`Missing dropId.\n${usage()}`);
  }

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const root = path.resolve(__dirname, '..');
  const frontendConfigPath = path.join(root, 'src', 'config', 'deployment.ts');
  const functionsConfigPath = path.join(root, 'functions', 'src', 'config', 'deployment.ts');

  const frontendDrop = await loadDropFromRegistry({
    filePath: frontendConfigPath,
    exportName: 'FRONTEND_DROPS',
    dropId: requestedDropId,
    label: 'frontend',
  });
  const functionsDrop = await loadDropFromRegistry({
    filePath: functionsConfigPath,
    exportName: 'FUNCTIONS_DROPS',
    dropId: requestedDropId,
    label: 'functions',
  });
  assertMatchingConfig(frontendDrop, functionsDrop);

  const targetPriceLamports = solToLamports(frontendDrop.priceSol, 'priceSol');
  const targetDiscountPriceLamports = solToLamports(frontendDrop.discountPriceSol, 'discountPriceSol');
  validatePricePair(targetPriceLamports, targetDiscountPriceLamports);

  const rpcUrl = (process.env.SOLANA_RPC_URL || '').trim() || clusterApiUrl(frontendDrop.solanaCluster);
  const connection = new Connection(rpcUrl, { commitment: 'confirmed' });
  const programId = new PublicKey(frontendDrop.boxMinterProgramId);
  const configPda = new PublicKey(requireString(frontendDrop.boxMinterConfigPda, 'boxMinterConfigPda'));

  const info = await connection.getAccountInfo(configPda, { commitment: 'confirmed' });
  if (!info) throw new Error(`Missing config PDA on ${frontendDrop.solanaCluster}: ${configPda.toBase58()}`);
  if (!info.owner.equals(programId)) {
    throw new Error(
      `Config PDA owner mismatch.\n` +
        `- expected program: ${programId.toBase58()}\n` +
        `- actual owner     : ${info.owner.toBase58()}`,
    );
  }
  const onchainConfig = decodeBoxMinterConfig(Buffer.from(info.data));

  console.log('--- set mint prices (box_minter) ---');
  console.log('cluster:', frontendDrop.solanaCluster);
  console.log('rpc    :', rpcUrl);
  console.log('drop   :', frontendDrop.dropId);
  console.log('program:', programId.toBase58());
  console.log('config :', configPda.toBase58());
  console.log('admin  :', onchainConfig.admin.toBase58());
  console.log('');
  console.log('Current on-chain prices:');
  console.log(`  no discount: ${formatSolFromLamports(onchainConfig.priceLamports)} SOL (${onchainConfig.priceLamports} lamports)`);
  console.log(
    `  discount   : ${formatSolFromLamports(onchainConfig.discountPriceLamports)} SOL (${onchainConfig.discountPriceLamports} lamports)`,
  );
  console.log('Target committed prices:');
  console.log(`  no discount: ${formatSolFromLamports(targetPriceLamports)} SOL (${targetPriceLamports} lamports)`);
  console.log(`  discount   : ${formatSolFromLamports(targetDiscountPriceLamports)} SOL (${targetDiscountPriceLamports} lamports)`);
  console.log('');

  if (onchainConfig.priceLamports === targetPriceLamports && onchainConfig.discountPriceLamports === targetDiscountPriceLamports) {
    console.log('On-chain prices already match committed config. Nothing to send.');
    return;
  }
  if (dryRun) {
    console.log('--dry-run set; not prompting for admin key and not sending a transaction.');
    return;
  }

  console.log('Enter the admin/deployer wallet private key (input is hidden).');
  console.log('Accepted formats: base58 secret key, or JSON array (like ~/.config/solana/id.json contents).');
  const admin = parsePrivateKeyInput(await promptMaskedInput('admin private key: '));
  console.log('admin pubkey:', admin.publicKey.toBase58());
  if (!admin.publicKey.equals(onchainConfig.admin)) {
    throw new Error(
      `Private key does not match the on-chain config admin.\n` +
        `- expected admin: ${onchainConfig.admin.toBase58()}\n` +
        `- provided key  : ${admin.publicKey.toBase58()}`,
    );
  }

  const ix = buildSetMintPricesIx({
    programId,
    configPda,
    admin: admin.publicKey,
    priceLamports: targetPriceLamports,
    discountPriceLamports: targetDiscountPriceLamports,
  });
  const tx = new Transaction().add(ix);
  tx.feePayer = admin.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
  tx.sign(admin);

  console.log('\nSimulating set_mint_prices...');
  const simulation = await connection.simulateTransaction(tx, [admin]);
  if (simulation.value.logs?.length) {
    console.log(simulation.value.logs.map((line) => `  ${line}`).join('\n'));
  }
  if (simulation.value.err) {
    throw new Error(`Simulation failed: ${JSON.stringify(simulation.value.err)}`);
  }
  console.log('Simulation succeeded.');

  console.log('\nTransaction summary:');
  console.log('  instruction : set_mint_prices');
  console.log('  cluster     :', frontendDrop.solanaCluster);
  console.log('  fee payer   :', admin.publicKey.toBase58());
  console.log('  program     :', programId.toBase58());
  console.log('  config PDA  :', configPda.toBase58());
  console.log('  SOL transfer: none; network fee only');
  console.log(`  no discount : ${formatSolFromLamports(onchainConfig.priceLamports)} -> ${formatSolFromLamports(targetPriceLamports)} SOL`);
  console.log(
    `  discount    : ${formatSolFromLamports(onchainConfig.discountPriceLamports)} -> ${formatSolFromLamports(
      targetDiscountPriceLamports,
    )} SOL`,
  );
  const ok = await promptYConfirmation("Type 'y' to send this transaction: ");
  if (!ok) {
    console.log('Cancelled before send.');
    return;
  }

  const sendTx = new Transaction().add(ix);
  sendTx.feePayer = admin.publicKey;
  sendTx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
  const sig = await sendAndConfirmTransaction(connection, sendTx, [admin], { commitment: 'confirmed' });
  console.log('\n✅ set_mint_prices confirmed:', sig);

  let updatedConfig: DecodedBoxMinterConfig | undefined;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const updatedInfo = await connection.getAccountInfo(configPda, { commitment: 'finalized' });
    if (updatedInfo) {
      const candidate = decodeBoxMinterConfig(Buffer.from(updatedInfo.data));
      if (candidate.priceLamports === targetPriceLamports && candidate.discountPriceLamports === targetDiscountPriceLamports) {
        updatedConfig = candidate;
        break;
      }
      updatedConfig = candidate;
    }
    if (attempt < 10) await sleep(1_500);
  }

  if (!updatedConfig) throw new Error(`Config PDA disappeared after transaction: ${configPda.toBase58()}`);
  if (updatedConfig.priceLamports !== targetPriceLamports || updatedConfig.discountPriceLamports !== targetDiscountPriceLamports) {
    throw new Error(
      `Post-transaction verification failed.\n` +
        `- expected no discount: ${targetPriceLamports}, actual: ${updatedConfig.priceLamports}\n` +
        `- expected discount   : ${targetDiscountPriceLamports}, actual: ${updatedConfig.discountPriceLamports}`,
    );
  }

  console.log('Verified on-chain prices:');
  console.log(`  no discount: ${formatSolFromLamports(updatedConfig.priceLamports)} SOL (${updatedConfig.priceLamports} lamports)`);
  console.log(
    `  discount   : ${formatSolFromLamports(updatedConfig.discountPriceLamports)} SOL (${updatedConfig.discountPriceLamports} lamports)`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
