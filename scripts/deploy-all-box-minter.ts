import { existsSync, readFileSync, renameSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

function getArg(flag: string, fallback?: string) {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
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

function readProgramId(onchainDir: string): string {
  const libPath = path.join(onchainDir, 'programs', 'box_minter', 'src', 'lib.rs');
  const content = readFileSync(libPath, 'utf8');
  const match = content.match(/declare_id!\(\"([1-9A-HJ-NP-Za-km-z]{32,44})\"\)/);
  if (!match?.[1]) {
    throw new Error(`Could not find declare_id!(\"...\") in ${libPath}`);
  }
  return match[1];
}

function cargoLockHasPackage(onchainDir: string, name: string, version: string): boolean {
  const lockPath = path.join(onchainDir, 'Cargo.lock');
  if (!existsSync(lockPath)) return false;
  const content = readFileSync(lockPath, 'utf8');
  const re = new RegExp(`\\[\\[package\\]\\]\\s*\\nname = "${name}"\\s*\\nversion = "${version}"`, 'm');
  return re.test(content);
}

async function main() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const root = path.resolve(__dirname, '..');
  const onchainDir = path.join(root, 'onchain');
  const programKeypair = path.join(onchainDir, 'target', 'deploy', 'box_minter-keypair.json');
  const programBinary = path.join(onchainDir, 'target', 'deploy', 'box_minter.so');

  const cluster = (getArg('--cluster', process.env.SOLANA_CLUSTER || 'devnet') || 'devnet').toLowerCase();
  const rpc = getArg('--rpc', process.env.SOLANA_RPC_URL);
  const keypair = getArg('--keypair', process.env.SOLANA_KEYPAIR);
  const anchorCluster = rpc || (cluster === 'mainnet-beta' ? 'mainnet' : cluster);
  const solanaUrl = rpc || cluster;
  const solanaBinDir = readSolanaActiveReleaseBinDir();
  const toolEnv = solanaBinDir ? { PATH: `${solanaBinDir}:${process.env.PATH || ''}` } : undefined;

  console.log('--- deploy ALL (program + collection + tree + delegation) ---');
  console.log('cluster:', cluster);
  if (rpc) console.log('rpc    :', rpc);
  if (keypair) console.log('keypair:', keypair);
  if (solanaBinDir) console.log('solana bin:', solanaBinDir);
  console.log('');

  if (!existsSync(programKeypair)) {
    throw new Error(
      `Missing program keypair: ${programKeypair}\n` +
        `Generate it with:\n` +
        `  solana-keygen new --no-bip39-passphrase -o ${programKeypair}\n` +
        `Then re-run this deploy script.`,
    );
  }

  const hasSolanaCargo = canRunSolanaCargo();
  if (hasSolanaCargo) {
    console.log('solana cargo toolchain:', 'cargo +solana');
  } else {
    console.warn('⚠️  Missing rustup `solana` toolchain (`cargo +solana`). Anchor may fail if your Cargo.lock is too new.');
  }

  // 1) Build + deploy program via Anchor.
  run('anchor', ['keys', 'sync'], { cwd: onchainDir, env: toolEnv });

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

  run('anchor', ['build', '--arch', 'sbf'], { cwd: onchainDir, env: toolEnv });
  if (!existsSync(programBinary)) {
    throw new Error(`Missing program binary after build: ${programBinary}`);
  }

  // Deploy program via Solana CLI (Agave). This avoids `anchor deploy` rebuilding with the wrong arch/tooling.
  const deployArgs = ['program', 'deploy', programBinary, '--program-id', programKeypair, '--url', solanaUrl];
  if (keypair) deployArgs.push('--keypair', keypair);
  run('solana', deployArgs, { cwd: onchainDir, env: toolEnv });

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


