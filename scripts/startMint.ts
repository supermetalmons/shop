import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createHash } from 'crypto';
import bs58 from 'bs58';
import { createInterface } from 'node:readline/promises';
import { clusterApiUrl, Connection, Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction } from '@solana/web3.js';

type SolanaCluster = 'devnet' | 'testnet' | 'mainnet-beta';

// Anchor instruction discriminator: sha256("global:start_mint")[0..8]
const IX_START_MINT = createHash('sha256').update('global:start_mint').digest().subarray(0, 8);

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

const deploymentConfigObjectCache = new Map<string, Record<string, unknown> | null>();

async function readDeploymentConfigObject(filePath: string): Promise<Record<string, unknown> | undefined> {
  if (!existsSync(filePath)) return undefined;

  if (deploymentConfigObjectCache.has(filePath)) {
    return deploymentConfigObjectCache.get(filePath) || undefined;
  }

  try {
    const mod = (await import(pathToFileURL(filePath).href)) as Record<string, unknown>;
    const candidates = ['DEPLOYMENT', 'default'];
    for (const key of candidates) {
      const candidate = mod[key];
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
        const value = candidate as Record<string, unknown>;
        deploymentConfigObjectCache.set(filePath, value);
        return value;
      }
    }
  } catch {
    // Allow the caller to handle parse failure.
  }

  deploymentConfigObjectCache.set(filePath, null);
  return undefined;
}

function normalizeDropId(value: string | undefined): string {
  return String(value || '').trim().toLowerCase();
}

function formatKnownDrops(knownDropIds: string[]): string {
  return knownDropIds.length ? knownDropIds.join(', ') : '(none)';
}

function startMintUsage(): string {
  return `Run:\n  npm run start-mint -- <dropId>\n`;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function resolveFrontendDropConfig(args: {
  filePath: string;
  requestedDropId: string;
}): Promise<{
  dropConfig: Record<string, unknown>;
  knownDropIds: string[];
}> {
  if (!existsSync(args.filePath)) {
    throw new Error(`Missing frontend deployment config: ${args.filePath}`);
  }

  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(args.filePath).href)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`Could not load frontend deployment config from ${args.filePath}: ${String(err)}`);
  }

  const dropsCandidate = mod.FRONTEND_DROPS;
  if (isObjectRecord(dropsCandidate)) {
    const dropsMap = dropsCandidate as Record<string, unknown>;
    const knownDropIds = Object.keys(dropsMap).sort((a, b) => a.localeCompare(b));
    const entry = dropsMap[args.requestedDropId];
    if (!isObjectRecord(entry)) {
      throw new Error(
        `Drop ${args.requestedDropId} is not present in ${args.filePath}.\n` +
          `Known deployed drops: ${formatKnownDrops(knownDropIds)}\n` +
          `Run npm run deploy-all-onchain for this drop before start-mint.`,
      );
    }
    return { dropConfig: entry, knownDropIds };
  }

  const legacyConfig = await readDeploymentConfigObject(args.filePath);
  if (!legacyConfig) {
    throw new Error(
      `Could not parse frontend deployment config from ${args.filePath}.\n` +
        `Run npm run deploy-all-onchain and retry.`,
    );
  }
  const legacyDropId = normalizeDropId(typeof legacyConfig.dropId === 'string' ? legacyConfig.dropId : undefined);
  if (legacyDropId && legacyDropId !== args.requestedDropId) {
    throw new Error(
      `Drop ${args.requestedDropId} does not match the deployed config in ${args.filePath}.\n` +
        `Configured deployed drop: ${legacyDropId}\n` +
        `Pass the deployed dropId explicitly, or rerun deploy-all-onchain first.`,
    );
  }
  return { dropConfig: legacyConfig, knownDropIds: legacyDropId ? [legacyDropId] : [] };
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

function boxMinterConfigPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('config')], programId)[0];
}

async function main() {
  const extraArgs = process.argv.slice(2);
  if (extraArgs.length !== 1) {
    throw new Error(
      `This script requires exactly one dropId argument. No default drop is selected implicitly.\n` +
        `${startMintUsage()}`,
    );
  }
  const requestedDropId = normalizeDropId(extraArgs[0]);
  if (!requestedDropId) {
    throw new Error(
      `Missing dropId.\n` +
        `${startMintUsage()}`,
    );
  }

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const root = path.resolve(__dirname, '..');

  const frontendDeploymentCfgPath = path.join(root, 'src', 'config', 'deployment.ts');
  const legacyFrontendDeployedCfgPath = path.join(root, 'src', 'config', 'deployed.ts');

  // Prefer the canonical config path. Keep a legacy fallback only for older checkouts.
  const frontendCfgPath = existsSync(frontendDeploymentCfgPath) ? frontendDeploymentCfgPath : legacyFrontendDeployedCfgPath;
  if (!existsSync(frontendCfgPath)) {
    throw new Error(
      `Could not find frontend deployment config.\n` +
        `Checked:\n` +
        `  - ${frontendDeploymentCfgPath}\n` +
        `  - ${legacyFrontendDeployedCfgPath}\n` +
        `Make sure you've run:\n` +
        `  npm run deploy-all-onchain\n`,
    );
  }

  const { dropConfig, knownDropIds } = await resolveFrontendDropConfig({
    filePath: frontendCfgPath,
    requestedDropId,
  });

  const clusterStr = (typeof dropConfig.solanaCluster === 'string' ? dropConfig.solanaCluster : undefined) as
    | SolanaCluster
    | undefined;
  const programIdStr =
    typeof dropConfig.boxMinterProgramId === 'string' ? String(dropConfig.boxMinterProgramId).trim() : undefined;
  const deployedDropId = typeof dropConfig.dropId === 'string' ? String(dropConfig.dropId).trim() : undefined;
  const activeDropId = deployedDropId || requestedDropId || '(unknown)';

  if (!clusterStr || !['devnet', 'testnet', 'mainnet-beta'].includes(clusterStr)) {
    throw new Error(
      `Could not read solanaCluster from ${frontendCfgPath}.\n` +
        `Make sure you've run:\n` +
        `  npm run deploy-all-onchain\n`,
    );
  }
  if (!programIdStr) {
    throw new Error(
      `Could not read boxMinterProgramId from ${frontendCfgPath}.\n` +
        `Make sure you've run:\n` +
        `  npm run deploy-all-onchain\n`,
    );
  }

  const rpcUrl = (process.env.SOLANA_RPC_URL || '').trim() || clusterApiUrl(clusterStr);
  const connection = new Connection(rpcUrl, { commitment: 'confirmed' });

  const programId = new PublicKey(programIdStr);
  const configPda = boxMinterConfigPda(programId);

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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
