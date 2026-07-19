import { lstatSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'crypto';
import { clusterApiUrl, Connection, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction } from '@solana/web3.js';
import { parsePrivateKeyInput, promptMaskedInput, promptYConfirmation } from './shared/interactive.ts';
import {
  normalizeDropBase,
  normalizeAndValidateDropId,
  readDeploymentDropRegistry,
} from './shared/deploymentRegistry.ts';
import { decodeBoxMinterConfigData } from '../functions/src/shared/boxMinterConfigCodec.ts';
import { normalizeBoxMinterMetadataBaseForComparison } from '../functions/src/shared/deploymentCore.ts';
import { BOX_MINTER_CONFIG_SEED } from '../functions/src/shared/boxMinterProtocol.ts';

type SolanaCluster = 'devnet' | 'testnet' | 'mainnet-beta';

// Anchor instruction discriminator: sha256("global:start_mint")[0..8]
const IX_START_MINT = createHash('sha256').update('global:start_mint').digest().subarray(0, 8);

function formatKnownDrops(knownDropIds: string[]): string {
  return knownDropIds.length ? knownDropIds.join(', ') : '(none)';
}

function startMintUsage(): string {
  return `Run:\n  npm run start-mint -- <dropId>\n`;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function pathEntryExists(filePath: string): boolean {
  try {
    lstatSync(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
    throw error;
  }
}

async function importDeploymentModule(
  filePath: string,
): Promise<Record<string, unknown>> {
  try {
    return (await import(pathToFileURL(filePath).href)) as Record<
      string,
      unknown
    >;
  } catch (err) {
    throw new Error(
      `Could not load deployment config from ${filePath}: ${String(err)}`,
    );
  }
}

export async function resolveDeploymentConfig(args: {
  root: string;
  requestedDropId: string;
}): Promise<{
  dropConfig: Record<string, unknown>;
  knownDropIds: string[];
  registryLabel: string;
}> {
  const requestedDropId = normalizeAndValidateDropId(
    args.requestedDropId,
    'requested dropId',
  );
  const canonicalPath = path.join(
    args.root,
    'functions',
    'src',
    'shared',
    'deploymentRegistry.ts',
  );
  const legacyPath = path.join(args.root, 'src', 'config', 'deployed.ts');
  if (pathEntryExists(canonicalPath)) {
    const registry = await readDeploymentDropRegistry(canonicalPath);
    const knownDropIds = Object.keys(registry.drops).sort((left, right) =>
      left.localeCompare(right),
    );
    const dropConfig = Object.prototype.hasOwnProperty.call(
      registry.drops,
      requestedDropId,
    )
      ? registry.drops[requestedDropId]
      : undefined;
    if (!isObjectRecord(dropConfig)) {
      throw new Error(
        `Drop ${requestedDropId} is not present in ${canonicalPath}.\n` +
          `Known deployed drops: ${formatKnownDrops(knownDropIds)}\n` +
          `Run npm run deploy-all-onchain -- ${requestedDropId} for this drop before start-mint.`,
      );
    }
    return {
      dropConfig,
      knownDropIds,
      registryLabel: canonicalPath,
    };
  }

  if (!pathEntryExists(legacyPath)) {
    throw new Error(
      `Could not find deployment config.\n` +
        `Checked:\n` +
        `  - ${canonicalPath}\n` +
        `  - ${legacyPath}\n` +
        `Make sure you've run:\n` +
        `  npm run deploy-all-onchain -- ${requestedDropId}\n`,
    );
  }

  const mod = await importDeploymentModule(legacyPath);
  const legacyConfig = mod.DEPLOYMENT || mod.default;
  if (!isObjectRecord(legacyConfig)) {
    throw new Error(
      `Could not parse deployment config from ${legacyPath}.\n` +
        `Run npm run deploy-all-onchain -- <dropId> and retry.`,
    );
  }
  const configuredDropId =
    Object.prototype.hasOwnProperty.call(legacyConfig, 'dropId') &&
    typeof legacyConfig.dropId === 'string'
      ? legacyConfig.dropId
      : '';
  const legacyDropId = configuredDropId
    ? normalizeAndValidateDropId(configuredDropId, 'deployed dropId')
    : '';
  if (legacyDropId && legacyDropId !== requestedDropId) {
    throw new Error(
      `Drop ${requestedDropId} does not match the deployed config in ${legacyPath}.\n` +
        `Configured deployed drop: ${legacyDropId}\n` +
        `Pass the deployed dropId explicitly, or rerun npm run deploy-all-onchain -- ${requestedDropId} first.`,
    );
  }
  return {
    dropConfig: legacyConfig,
    knownDropIds: legacyDropId ? [legacyDropId] : [],
    registryLabel: legacyPath,
  };
}

function boxMinterConfigPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from(BOX_MINTER_CONFIG_SEED)], programId)[0];
}

function configuredBoxMinterConfigPda(programId: PublicKey, configured: unknown): PublicKey {
  const value = typeof configured === 'string' ? configured.trim() : '';
  return value ? new PublicKey(value) : boxMinterConfigPda(programId);
}

export function decodeStartMintMetadataBase(data: Uint8Array): string {
  const config = decodeBoxMinterConfigData(data, {
    validateItemsPerBox: false,
    decodeExtensions: false,
  });
  return normalizeBoxMinterMetadataBaseForComparison(config.uriBase);
}

async function main() {
  const extraArgs = process.argv.slice(2);
  if (extraArgs.length !== 1) {
    throw new Error(
      `This script requires exactly one dropId argument. No default drop is selected implicitly.\n` +
        `${startMintUsage()}`,
    );
  }
  if (!String(extraArgs[0] || '').trim()) {
    throw new Error(
      `Missing dropId.\n` +
        `${startMintUsage()}`,
    );
  }
  const requestedDropId = normalizeAndValidateDropId(
    extraArgs[0],
    'requested dropId',
  );

  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
  );
  const { dropConfig, knownDropIds, registryLabel } =
    await resolveDeploymentConfig({
      root,
      requestedDropId,
    });

  const clusterStr = (typeof dropConfig.solanaCluster === 'string' ? dropConfig.solanaCluster : undefined) as
    | SolanaCluster
    | undefined;
  const programIdStr =
    typeof dropConfig.boxMinterProgramId === 'string' ? String(dropConfig.boxMinterProgramId).trim() : undefined;
  const configPdaStr =
    typeof dropConfig.boxMinterConfigPda === 'string' ? String(dropConfig.boxMinterConfigPda).trim() : undefined;
  const metadataBase =
    typeof dropConfig.metadataBase === 'string' ? normalizeDropBase(dropConfig.metadataBase) : undefined;
  const deployedDropId = typeof dropConfig.dropId === 'string' ? String(dropConfig.dropId).trim() : undefined;
  const activeDropId = deployedDropId || requestedDropId || '(unknown)';

  if (!clusterStr || !['devnet', 'testnet', 'mainnet-beta'].includes(clusterStr)) {
    throw new Error(
      `Could not read solanaCluster from ${registryLabel}.\n` +
        `Make sure you've run:\n` +
        `  npm run deploy-all-onchain -- ${requestedDropId}\n`,
    );
  }
  if (!programIdStr) {
    throw new Error(
      `Could not read boxMinterProgramId from ${registryLabel}.\n` +
        `Make sure you've run:\n` +
        `  npm run deploy-all-onchain -- ${requestedDropId}\n`,
    );
  }

  const rpcUrl = (process.env.SOLANA_RPC_URL || '').trim() || clusterApiUrl(clusterStr);
  const connection = new Connection(rpcUrl, { commitment: 'confirmed' });

  const programId = new PublicKey(programIdStr);
  const configPda = configuredBoxMinterConfigPda(programId, configPdaStr);

  console.log('--- start mint (box_minter) ---');
  console.log('cluster:', clusterStr);
  console.log('rpc    :', rpcUrl);
  console.log('drop   :', activeDropId);
  if (knownDropIds.length) console.log('known  :', formatKnownDrops(knownDropIds));
  console.log('program:', programId.toBase58());
  console.log('config :', configPda.toBase58());
  console.log('');

  const info = await connection.getAccountInfo(configPda, { commitment: 'confirmed' });
  if (!info) {
    throw new Error(`Missing config PDA on this cluster: ${configPda.toBase58()}`);
  }
  if (metadataBase) {
    const onchainMetadataBase = decodeStartMintMetadataBase(info.data);
    if (onchainMetadataBase !== metadataBase) {
      throw new Error(
        `Config PDA ${configPda.toBase58()} does not match drop ${activeDropId}.\n` +
          `- configured metadataBase : ${metadataBase}\n` +
          `- on-chain metadata base  : ${onchainMetadataBase}\n` +
          `\n` +
          `This usually means the deployment config is stale or boxMinterConfigPda is missing for a scoped config.`,
      );
    }
  }

  console.log('This will permanently enable minting until the program is redeployed/reinitialized.');
  const ok = await promptYConfirmation("Type 'y' to call start_mint: ");
  if (!ok) {
    console.log('Cancelled.');
    return;
  }

  console.log('\nEnter the admin/deployer wallet private key (input is hidden).');
  console.log('Accepted formats: base58 secret key, or JSON array (like ~/.config/solana/id.json contents).');
  const admin = parsePrivateKeyInput(await promptMaskedInput('admin private key: '));
  console.log('admin pubkey:', admin.publicKey.toBase58());

  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: admin.publicKey, isSigner: true, isWritable: false },
    ],
    data: IX_START_MINT,
  });

  const tx = new Transaction().add(ix);
  tx.feePayer = admin.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;

  const sig = await sendAndConfirmTransaction(connection, tx, [admin], { commitment: 'confirmed' });
  console.log('\n✅ start_mint confirmed:', sig);
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
