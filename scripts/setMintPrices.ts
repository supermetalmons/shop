import { createHash } from 'crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
import {
  DEPLOYMENT_DROPS,
  getDeploymentDrop,
  type DeploymentRegistryDrop,
} from '../functions/src/shared/deploymentRegistry.ts';
import {
  normalizeDropId,
  type SolanaCluster,
} from '../functions/src/shared/deploymentCore.ts';
import {
  BOX_MINTER_CONFIG_ACCOUNT_SIZE_ITEMS,
  BoxMinterConfigCodecError,
  decodeBoxMinterConfigData,
} from '../functions/src/shared/boxMinterConfigCodec.ts';

type DeploymentDropConfig = Pick<
  DeploymentRegistryDrop,
  | 'solanaCluster'
  | 'dropId'
  | 'priceSol'
  | 'discountPriceSol'
  | 'boxMinterProgramId'
  | 'boxMinterConfigPda'
>;

const IX_SET_MINT_PRICES = createHash('sha256').update('global:set_mint_prices').digest().subarray(0, 8);

function usage(): string {
  return `Run:\n  npm run set-mint-prices -- <dropId>\n  npm run set-mint-prices -- <dropId> --dry-run\n`;
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
    priceSol: requireNumber(value.priceSol, `${label}.priceSol`),
    discountPriceSol: requireNumber(value.discountPriceSol, `${label}.discountPriceSol`),
    boxMinterProgramId: requireString(value.boxMinterProgramId, `${label}.boxMinterProgramId`),
    ...(typeof value.boxMinterConfigPda === 'string' && value.boxMinterConfigPda.trim()
      ? { boxMinterConfigPda: value.boxMinterConfigPda.trim() }
      : {}),
  };
}

function loadDropFromRegistry(dropId: string): DeploymentDropConfig {
  const entry = getDeploymentDrop(dropId);
  if (!entry) {
    const knownDropIds = Object.keys(DEPLOYMENT_DROPS).sort((a, b) =>
      a.localeCompare(b),
    );
    throw new Error(
      `Drop ${dropId} is not present in functions/src/shared/deploymentRegistry.ts.\n` +
        `Known drops: ${knownDropIds.length ? knownDropIds.join(', ') : '(none)'}`,
    );
  }
  return readDropConfig(entry, `deployment registry.${dropId}`);
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

export function decodeBoxMinterConfigForPriceUpdate(data: Buffer) {
  if (data.length < BOX_MINTER_CONFIG_ACCOUNT_SIZE_ITEMS) {
    throw new Error(
      `Unsupported box minter config schema: expected at least ${BOX_MINTER_CONFIG_ACCOUNT_SIZE_ITEMS} bytes, got ${data.length}.`,
    );
  }
  try {
    const decoded = decodeBoxMinterConfigData(data, {
      validateDiscriminator: true,
      validateItemsPerBox: false,
      normalizeDiscountMintsPerWallet: false,
      decodeExtensions: false,
      stringDecodeErrorMessages: {
        length:
          'Unsupported box minter config schema while decoding string length.',
        bytes:
          'Unsupported box minter config schema while decoding string bytes.',
      },
    });
    return {
      ...decoded,
      admin: new PublicKey(decoded.admin),
      treasury: new PublicKey(decoded.treasury),
      coreCollection: new PublicKey(decoded.coreCollection),
    };
  } catch (err) {
    if (
      err instanceof BoxMinterConfigCodecError &&
      err.reason === 'invalid-discriminator'
    ) {
      throw new Error('Invalid box minter config discriminator.');
    }
    throw err;
  }
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
  const requestedDropId = normalizeDropId(positionalArgs[0] || '');
  if (!requestedDropId) {
    throw new Error(`Missing dropId.\n${usage()}`);
  }

  const frontendDrop = loadDropFromRegistry(requestedDropId);

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
  const onchainConfig = decodeBoxMinterConfigForPriceUpdate(
    Buffer.from(info.data),
  );

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

  let updatedConfig:
    | ReturnType<typeof decodeBoxMinterConfigForPriceUpdate>
    | undefined;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const updatedInfo = await connection.getAccountInfo(configPda, { commitment: 'finalized' });
    if (updatedInfo) {
      const candidate = decodeBoxMinterConfigForPriceUpdate(
        Buffer.from(updatedInfo.data),
      );
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

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return Boolean(entry) && path.resolve(entry) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
