import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

function getArg(flag: string, fallback?: string) {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

function run(cmd: string, args: string[], opts: { cwd?: string } = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', cwd: opts.cwd, env: process.env });
  if (res.status !== 0) {
    throw new Error(`Command failed: ${cmd} ${args.join(' ')}`);
  }
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

async function main() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const root = path.resolve(__dirname, '..');
  const onchainDir = path.join(root, 'onchain');
  const programKeypair = path.join(onchainDir, 'target', 'deploy', 'box_minter-keypair.json');

  const cluster = (getArg('--cluster', process.env.SOLANA_CLUSTER || 'devnet') || 'devnet').toLowerCase();
  const rpc = getArg('--rpc', process.env.SOLANA_RPC_URL);
  const keypair = getArg('--keypair', process.env.SOLANA_KEYPAIR);
  const anchorCluster = rpc || (cluster === 'mainnet-beta' ? 'mainnet' : cluster);

  console.log('--- deploy ALL (program + collection + tree + delegation) ---');
  console.log('cluster:', cluster);
  if (rpc) console.log('rpc    :', rpc);
  if (keypair) console.log('keypair:', keypair);
  console.log('');

  if (!existsSync(programKeypair)) {
    throw new Error(
      `Missing program keypair: ${programKeypair}\n` +
        `Generate it with:\n` +
        `  solana-keygen new --no-bip39-passphrase -o ${programKeypair}\n` +
        `Then re-run this deploy script.`,
    );
  }

  // 1) Build + deploy program via Anchor.
  run('anchor', ['keys', 'sync'], { cwd: onchainDir });
  run('anchor', ['build'], { cwd: onchainDir });

  const deployArgs = ['deploy'];
  // Anchor accepts provider flags; pass through if provided.
  if (anchorCluster) deployArgs.push('--provider.cluster', anchorCluster);
  if (keypair) deployArgs.push('--provider.wallet', keypair);
  run('anchor', deployArgs, { cwd: onchainDir });

  const programId = readProgramId(onchainDir);
  console.log('\nProgram deployed:', programId);

  // 2) Deploy on-chain prerequisites + initialize config PDA.
  const deployBoxMinterArgs = ['run', 'box-minter:deploy', '--', '--program-id', programId, '--cluster', cluster];
  if (rpc) deployBoxMinterArgs.push('--rpc', rpc);
  if (keypair) deployBoxMinterArgs.push('--keypair', keypair);
  run('npm', deployBoxMinterArgs, { cwd: root });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


