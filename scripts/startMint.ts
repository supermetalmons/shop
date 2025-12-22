import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
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

function readExistingTsObjectStringField(filePath: string, field: string): string | undefined {
  try {
    const content = readFileSync(filePath, 'utf8');
    const re = new RegExp(`${field}\\s*:\\s*'([^']*)'`, 'm');
    const match = content.match(re);
    return match?.[1] || undefined;
  } catch {
    return undefined;
  }
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
  if (extraArgs.length) {
    throw new Error(`This script accepts no CLI args.\nRun:\n  npm run start-mint\n`);
  }

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const root = path.resolve(__dirname, '..');

  const deployedCfgPath = path.join(root, 'src', 'config', 'deployed.ts');
  const clusterStr = readExistingTsObjectStringField(deployedCfgPath, 'solanaCluster') as SolanaCluster | undefined;
  const programIdStr = readExistingTsObjectStringField(deployedCfgPath, 'boxMinterProgramId');

  if (!clusterStr || !['devnet', 'testnet', 'mainnet-beta'].includes(clusterStr)) {
    throw new Error(
      `Could not read solanaCluster from ${deployedCfgPath}.\n` +
        `Make sure you've run:\n` +
        `  npm run deploy-all-onchain\n`,
    );
  }
  if (!programIdStr) {
    throw new Error(
      `Could not read boxMinterProgramId from ${deployedCfgPath}.\n` +
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


