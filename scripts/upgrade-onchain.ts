import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { clusterApiUrl, Keypair, PublicKey } from '@solana/web3.js';
import { FRONTEND_DROPS, normalizeDropId, type FrontendDropConfig, type SolanaCluster } from '../src/config/deployment.ts';
import { parsePrivateKeyInput, promptMaskedInput, promptYConfirmation } from './shared/interactive.ts';

type CliOptions = {
  dropId?: string;
  cluster?: SolanaCluster;
  rpcUrl?: string;
  skipTests: boolean;
  skipTypecheck: boolean;
  dryRun: boolean;
  yes: boolean;
  useRpc: boolean;
  computeUnitPrice?: string;
  maxSignAttempts?: string;
};

type ParsedCliOptions = CliOptions & { dropId: string };
type ToolEnv = Record<string, string | undefined>;
type CommandOptions = { cwd?: string; env?: ToolEnv };

type ProgramShowInfo = {
  programId: string;
  owner: string;
  programdataAddress?: string;
  authority?: string | null;
  lastDeploySlot?: number;
  dataLen?: number;
  lamports?: number;
};

const BPF_LOADER_UPGRADEABLE = 'BPFLoaderUpgradeab1e11111111111111111111111';
const DECLARE_ID_RE = /declare_id!\("([1-9A-HJ-NP-Za-km-z]{32,44})"\)/;

function usage(): string {
  return [
    'Usage:',
    '  npm run upgrade-onchain -- <dropId> [options]',
    '',
    'Examples:',
    '  npm run upgrade-onchain -- little_swag_hoodies_devnet',
    '  npm run upgrade-onchain -- little_swag_hoodies --rpc-url https://api.mainnet-beta.solana.com',
    '',
    'Options:',
    '  --cluster <devnet|testnet|mainnet-beta>  Assert the registry target cluster.',
    '  --rpc-url <url>                          Override the Solana RPC URL.',
    '  --skip-tests                            Skip cargo test --lib.',
    '  --skip-typecheck                        Skip npm run typecheck.',
    '  --dry-run                               Build and compare hashes, but do not prompt or deploy.',
    '  --yes                                   Skip the final y/N deploy confirmation.',
    '  --use-rpc                               Send deploy transactions through RPC.',
    '  --compute-unit-price <micro-lamports>   Forward to solana program deploy.',
    '  --max-sign-attempts <count>             Forward to solana program deploy.',
    '  -h, --help                              Show this help.',
  ].join('\n');
}

function parseArgs(argv: string[]): ParsedCliOptions {
  const opts: CliOptions = {
    skipTests: false,
    skipTypecheck: false,
    dryRun: false,
    yes: false,
    useRpc: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      console.log(usage());
      process.exit(0);
    }
    if (arg === '--cluster') {
      opts.cluster = requireCluster(argv[++i], '--cluster');
      continue;
    }
    if (arg === '--rpc-url') {
      opts.rpcUrl = requireValue(argv[++i], '--rpc-url');
      continue;
    }
    if (arg === '--compute-unit-price') {
      opts.computeUnitPrice = requireValue(argv[++i], '--compute-unit-price');
      continue;
    }
    if (arg === '--max-sign-attempts') {
      opts.maxSignAttempts = requireValue(argv[++i], '--max-sign-attempts');
      continue;
    }
    if (arg === '--skip-tests') {
      opts.skipTests = true;
      continue;
    }
    if (arg === '--skip-typecheck') {
      opts.skipTypecheck = true;
      continue;
    }
    if (arg === '--dry-run') {
      opts.dryRun = true;
      continue;
    }
    if (arg === '--yes') {
      opts.yes = true;
      continue;
    }
    if (arg === '--use-rpc') {
      opts.useRpc = true;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
    }
    if (opts.dropId) {
      throw new Error(`Unexpected extra positional argument: ${arg}\n\n${usage()}`);
    }
    opts.dropId = arg;
  }

  if (!opts.dropId) {
    throw new Error(`Missing dropId.\n\n${usage()}`);
  }
  return { ...opts, dropId: opts.dropId };
}

function requireValue(value: string | undefined, optionName: string): string {
  const trimmed = String(value || '').trim();
  if (!trimmed) throw new Error(`Missing value for ${optionName}`);
  return trimmed;
}

function requireCluster(value: string | undefined, optionName: string): SolanaCluster {
  const trimmed = requireValue(value, optionName);
  if (trimmed !== 'devnet' && trimmed !== 'testnet' && trimmed !== 'mainnet-beta') {
    throw new Error(`Invalid ${optionName}: ${trimmed}`);
  }
  return trimmed;
}

function resolveDropTarget(dropId: string, cluster?: SolanaCluster): FrontendDropConfig {
  const normalizedDropId = normalizeDropId(dropId);
  const drop = FRONTEND_DROPS[normalizedDropId];
  if (!drop) {
    const known = Object.keys(FRONTEND_DROPS).sort().join(', ');
    throw new Error(`Unknown dropId: ${dropId}\nKnown drops: ${known}`);
  }
  if (cluster && drop.solanaCluster !== cluster) {
    throw new Error(
      `Drop ${drop.dropId} is configured for ${drop.solanaCluster}, not ${cluster}.\n` +
        `Use the environment-specific drop id from src/config/deployment.ts.`,
    );
  }
  new PublicKey(drop.boxMinterProgramId);
  return drop;
}

function commandEnv(env: ToolEnv = {}) {
  return { ...process.env, NO_DNA: '1', ...env };
}

function removeFileIfExists(filePath: string) {
  try {
    if (existsSync(filePath)) unlinkSync(filePath);
  } catch {
    // ignore
  }
}

function run(cmd: string, args: string[], opts: CommandOptions = {}) {
  const env = commandEnv(opts.env);
  const res = spawnSync(cmd, args, { stdio: 'inherit', cwd: opts.cwd, env });
  if (res.status !== 0) {
    throw new Error(`Command failed: ${cmd} ${args.join(' ')}`);
  }
}

function runCapture(cmd: string, args: string[], opts: CommandOptions = {}) {
  const env = commandEnv(opts.env);
  const res = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: opts.cwd, env, encoding: 'utf8' });
  if (res.status !== 0) {
    const stderr = String(res.stderr || '').trim();
    throw new Error(`Command failed: ${cmd} ${args.join(' ')}${stderr ? `\n${stderr}` : ''}`);
  }
  return String(res.stdout || '');
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function canRunSolanaCargo(env: ToolEnv): boolean {
  const res = spawnSync('cargo', ['+solana', '--version'], {
    stdio: ['ignore', 'ignore', 'ignore'],
    env: commandEnv(env),
  });
  return res.status === 0;
}

function readSolanaActiveReleaseBinDir(): string | undefined {
  const home = process.env.HOME;
  if (!home) return undefined;
  const configPath = path.join(home, '.config', 'solana', 'install', 'config.yml');
  if (existsSync(configPath)) {
    const cfg = readFileSync(configPath, 'utf8');
    const match = cfg.match(/^\s*active_release_dir:\s*(.+)\s*$/m);
    if (match?.[1]) return path.join(match[1].trim(), 'bin');
  }
  return path.join(home, '.local', 'share', 'solana', 'install', 'active_release', 'bin');
}

function removeStaleAnchorGeneratedArtifacts(onchainDir: string) {
  for (const relPath of ['target/idl', 'target/types']) {
    const artifactPath = path.join(onchainDir, relPath);
    if (!existsSync(artifactPath)) continue;
    rmSync(artifactPath, { recursive: true, force: true });
    console.log(`Removed stale Anchor generated artifacts: ${artifactPath}`);
  }
}

function readCargoLockVersion(lockPath: string): number | undefined {
  if (!existsSync(lockPath)) return undefined;
  const head = readFileSync(lockPath, 'utf8').slice(0, 4096);
  const match = head.match(/^\s*version\s*=\s*(\d+)\s*$/m);
  const version = match?.[1] ? Number(match[1]) : undefined;
  return version && !Number.isNaN(version) ? version : undefined;
}

function cargoLockHasPackage(onchainDir: string, name: string, version: string): boolean {
  const lockPath = path.join(onchainDir, 'Cargo.lock');
  if (!existsSync(lockPath)) return false;
  const content = readFileSync(lockPath, 'utf8');
  const re = new RegExp(`\\[\\[package\\]\\]\\s*\\nname = "${name}"\\s*\\nversion = "${version}"`, 'm');
  return re.test(content);
}

function prepareAnchorCompatibleCargoLock(onchainDir: string, env: ToolEnv): () => void {
  const lockPath = path.join(onchainDir, 'Cargo.lock');
  const originalLock = existsSync(lockPath) ? readFileSync(lockPath, 'utf8') : undefined;
  const originalVersion = readCargoLockVersion(lockPath);
  const hasSolanaCargo = canRunSolanaCargo(env);
  let backupPath: string | undefined;
  let shouldRestore = false;

  const restore = () => {
    if (!shouldRestore) return;
    shouldRestore = false;
    if (typeof originalLock === 'string') {
      writeFileSync(lockPath, originalLock, 'utf8');
      if (backupPath) removeFileIfExists(backupPath);
      console.log('Restored original on-chain Cargo.lock.');
      return;
    }
    if (existsSync(lockPath)) {
      unlinkSync(lockPath);
      console.log('Removed temporary on-chain Cargo.lock.');
    }
  };

  try {
    if (hasSolanaCargo) {
      console.log('solana cargo toolchain:', 'cargo +solana');
    } else {
      console.warn('Warning: missing rustup `solana` toolchain (`cargo +solana`). Anchor may fail if Cargo.lock is too new.');
    }

    const lockIsTooNew = typeof originalVersion === 'number' && originalVersion >= 4;
    const shouldGenerateLock = !originalLock || lockIsTooNew;

    if (lockIsTooNew) {
      backupPath = path.join(onchainDir, `Cargo.lock.v${originalVersion}.upgrade-${process.pid}-${Date.now()}.bak`);
      console.warn(
        `Detected on-chain Cargo.lock version ${originalVersion} (incompatible with the Solana/Anchor toolchain cargo).\n` +
          `Temporarily moving it to ${backupPath} for the Anchor build...`,
      );
      renameSync(lockPath, backupPath);
      shouldRestore = true;
    } else if (!originalLock) {
      shouldRestore = true;
    }

    if (hasSolanaCargo && shouldGenerateLock) {
      run('cargo', ['+solana', 'generate-lockfile'], { cwd: onchainDir, env });

      // Cargo can pick newer crates that exceed Solana's pinned Rust toolchain MSRV.
      // In particular, borsh 1.6.x requires rustc >= 1.77; pin borsh to 1.5.5 if needed.
      if (cargoLockHasPackage(onchainDir, 'borsh', '1.6.0')) {
        run('cargo', ['+solana', 'update', '-p', 'borsh@1.6.0', '--precise', '1.5.5'], { cwd: onchainDir, env });
      }
    }

    return restore;
  } catch (err) {
    restore();
    throw err;
  }
}

function sha256File(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function readProgramIdFromSource(libPath: string): string {
  const content = readFileSync(libPath, 'utf8');
  const match = content.match(DECLARE_ID_RE);
  if (!match?.[1]) throw new Error(`Could not find declare_id!("...") in ${libPath}`);
  return match[1];
}

function setTemporaryDeclareId(libPath: string, programId: string): () => void {
  const original = readFileSync(libPath, 'utf8');
  const updated = original.replace(DECLARE_ID_RE, `declare_id!("${programId}")`);
  if (updated === original && readProgramIdFromSource(libPath) !== programId) {
    throw new Error(`Could not update declare_id!("...") in ${libPath}`);
  }
  if (updated !== original) {
    writeFileSync(libPath, updated, 'utf8');
    console.log(`Temporarily set declare_id! to ${programId} for this build.`);
  }
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    if (readFileSync(libPath, 'utf8') !== original) {
      writeFileSync(libPath, original, 'utf8');
      console.log('Restored original on-chain source declare_id!.');
    }
  };
}

function writeTempKeypairFile(kp: Keypair, prefix: string): string {
  const filePath = path.join(tmpdir(), `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(Array.from(kp.secretKey)), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return filePath;
}

function readProgramShow(args: {
  programId: string;
  solanaUrl: string;
  keypairPath: string;
  cwd: string;
  env: ToolEnv;
}): ProgramShowInfo {
  const output = runCapture(
    'solana',
    ['program', 'show', args.programId, '--url', args.solanaUrl, '--keypair', args.keypairPath, '--output', 'json'],
    { cwd: args.cwd, env: args.env },
  );
  const parsed = JSON.parse(output) as ProgramShowInfo;
  if (parsed.owner !== BPF_LOADER_UPGRADEABLE) {
    throw new Error(
      `Program ${args.programId} is not upgradeable.\n` +
        `Expected owner: ${BPF_LOADER_UPGRADEABLE}\n` +
        `Actual owner  : ${parsed.owner}`,
    );
  }
  return parsed;
}

function deployedProgramHash(args: {
  programId: string;
  solanaUrl: string;
  cwd: string;
  env: ToolEnv;
}): string {
  const dumpPath = path.join(tmpdir(), `mons-shop-program-dump-${process.pid}-${Date.now()}.so`);
  try {
    const res = spawnSync('solana', ['program', 'dump', args.programId, dumpPath, '--url', args.solanaUrl], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: args.cwd,
      env: commandEnv(args.env),
      encoding: 'utf8',
    });
    if (res.status !== 0 || !existsSync(dumpPath)) {
      const stdout = String(res.stdout || '').trim();
      const stderr = String(res.stderr || '').trim();
      const details = [stderr, stdout].filter(Boolean).join('\n');
      throw new Error(
        `Could not dump deployed program ${args.programId} for hash comparison.${details ? `\n${details}` : ''}`,
      );
    }
    return sha256File(dumpPath);
  } finally {
    removeFileIfExists(dumpPath);
  }
}

function formatSol(lamports?: number): string {
  if (typeof lamports !== 'number') return '(unknown)';
  return `${(lamports / 1_000_000_000).toFixed(9)} SOL`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(__dirname, '..');
  const onchainDir = path.join(root, 'onchain');
  const libPath = path.join(onchainDir, 'programs', 'box_minter', 'src', 'lib.rs');
  const programBinary = path.join(onchainDir, 'target', 'deploy', 'box_minter.so');
  const drop = resolveDropTarget(opts.dropId, opts.cluster);
  const programId = drop.boxMinterProgramId;
  const solanaUrl = opts.rpcUrl || clusterApiUrl(drop.solanaCluster);
  const solanaBinDir = readSolanaActiveReleaseBinDir();
  const toolEnv = {
    ...(solanaBinDir ? { PATH: `${solanaBinDir}:${process.env.PATH || ''}` } : {}),
  };

  const readOnlyKeypairPath = writeTempKeypairFile(Keypair.generate(), 'mons-shop-upgrade-readonly');
  let authorityKeypairPath: string | undefined;
  let restoreSource: (() => void) | undefined;
  let restoreCargoLock: (() => void) | undefined;
  const cleanup = () => {
    if (restoreSource) restoreSource();
    if (restoreCargoLock) restoreCargoLock();
    for (const filePath of [readOnlyKeypairPath, authorityKeypairPath]) {
      if (!filePath) continue;
      removeFileIfExists(filePath);
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

  console.log('--- upgrade box_minter program ---');
  console.log('drop    :', drop.dropId);
  console.log('cluster :', drop.solanaCluster);
  console.log('rpc url :', solanaUrl);
  console.log('program :', programId);
  if (drop.boxMinterConfigPda) console.log('config  :', drop.boxMinterConfigPda);
  if (solanaBinDir) console.log('solana bin:', solanaBinDir);
  console.log('');

  const beforeInfo = readProgramShow({
    programId,
    solanaUrl,
    keypairPath: readOnlyKeypairPath,
    cwd: onchainDir,
    env: toolEnv,
  });
  if (!beforeInfo.authority) {
    throw new Error(`Program ${programId} has no upgrade authority; it cannot be upgraded.`);
  }
  console.log('Current deployed program:');
  console.log('  authority      :', beforeInfo.authority);
  console.log('  program data   :', beforeInfo.programdataAddress || '(unknown)');
  console.log('  last slot      :', beforeInfo.lastDeploySlot ?? '(unknown)');
  console.log('  max data length:', beforeInfo.dataLen ?? '(unknown)');
  console.log('  rent balance   :', formatSol(beforeInfo.lamports));
  console.log('');

  if (!opts.skipTypecheck) {
    run('npm', ['run', 'typecheck'], { cwd: root, env: toolEnv });
  }

  restoreSource = setTemporaryDeclareId(libPath, programId);
  try {
    if (!opts.skipTests) {
      run('cargo', ['test', '--lib'], { cwd: onchainDir, env: toolEnv });
    }
    restoreCargoLock = prepareAnchorCompatibleCargoLock(onchainDir, toolEnv);
    removeStaleAnchorGeneratedArtifacts(onchainDir);
    run('anchor', ['build', '--no-idl', '--arch', 'sbf', '--', '--features', 'no-idl,no-log-ix-name'], {
      cwd: onchainDir,
      env: toolEnv,
    });
  } finally {
    restoreSource();
    restoreSource = undefined;
    if (restoreCargoLock) {
      restoreCargoLock();
      restoreCargoLock = undefined;
    }
  }

  if (!existsSync(programBinary)) {
    throw new Error(`Missing program binary after build: ${programBinary}`);
  }
  const localHash = sha256File(programBinary);
  let deployedHash: string;
  try {
    deployedHash = deployedProgramHash({ programId, solanaUrl, cwd: onchainDir, env: toolEnv });
  } catch (err) {
    throw new Error(
      `Could not compare the local build with the currently deployed program.\n` +
        `${errorMessage(err)}\n` +
        `Use an RPC endpoint that supports 'solana program dump' before running an upgrade.`,
    );
  }
  console.log('');
  console.log('Binary comparison:');
  console.log('  local   :', localHash);
  console.log('  deployed:', deployedHash);
  console.log('');

  if (deployedHash === localHash) {
    console.log('Program already matches the local build; skipping upgrade.');
    return;
  }

  if (opts.dryRun) {
    console.log('--dry-run set; not prompting for authority and not deploying.');
    return;
  }

  console.log('Enter the upgrade authority private key (input is hidden).');
  console.log('Accepted formats: base58 secret key, or JSON array (like ~/.config/solana/id.json contents).');
  const authority = parsePrivateKeyInput(await promptMaskedInput('upgrade authority private key: '));
  const deployAuthorityKeypairPath = writeTempKeypairFile(authority, 'mons-shop-upgrade-authority');
  authorityKeypairPath = deployAuthorityKeypairPath;
  const authorityPubkey = authority.publicKey.toBase58();
  console.log('upgrade authority pubkey:', authorityPubkey);

  if (beforeInfo.authority !== authorityPubkey) {
    throw new Error(
      `Private key does not match the deployed upgrade authority.\n` +
        `Expected: ${beforeInfo.authority}\n` +
        `Got     : ${authorityPubkey}`,
    );
  }

  console.log('');
  console.log('Upgrade summary:');
  console.log('  drop     :', drop.dropId);
  console.log('  cluster  :', drop.solanaCluster);
  console.log('  rpc url  :', solanaUrl);
  console.log('  program  :', programId);
  console.log('  authority:', authorityPubkey);
  console.log('  binary   :', programBinary);
  console.log('  local sha:', localHash);
  console.log('');

  if (!opts.yes) {
    const mainnetPrefix = drop.solanaCluster === 'mainnet-beta' ? 'MAINNET ' : '';
    const ok = await promptYConfirmation(`Proceed with ${mainnetPrefix}program upgrade? [y/N] `);
    if (!ok) {
      console.log('Cancelled before deploy.');
      return;
    }
  }

  const deployArgs = [
    'program',
    'deploy',
    programBinary,
    '--program-id',
    programId,
    '--url',
    solanaUrl,
    '--keypair',
    deployAuthorityKeypairPath,
    '--upgrade-authority',
    deployAuthorityKeypairPath,
  ];
  if (opts.useRpc) deployArgs.push('--use-rpc');
  if (opts.computeUnitPrice) deployArgs.push('--with-compute-unit-price', opts.computeUnitPrice);
  if (opts.maxSignAttempts) deployArgs.push('--max-sign-attempts', opts.maxSignAttempts);

  run('solana', deployArgs, { cwd: onchainDir, env: toolEnv });

  const afterInfo = readProgramShow({
    programId,
    solanaUrl,
    keypairPath: deployAuthorityKeypairPath,
    cwd: onchainDir,
    env: toolEnv,
  });
  let afterHash: string;
  try {
    afterHash = deployedProgramHash({ programId, solanaUrl, cwd: onchainDir, env: toolEnv });
  } catch (err) {
    throw new Error(
      `Program deploy completed, but post-upgrade hash verification failed.\n` +
        `Expected local sha: ${localHash}\n` +
        `${errorMessage(err)}\n` +
        `Re-run the script or manually verify with: solana program dump ${programId} <file> --url ${solanaUrl}`,
    );
  }
  console.log('');
  console.log('Post-upgrade verification:');
  console.log('  last slot:', afterInfo.lastDeploySlot ?? '(unknown)');
  console.log('  deployed sha:', afterHash);
  if (afterHash !== localHash) {
    throw new Error(`Post-upgrade hash mismatch.\nExpected: ${localHash}\nActual  : ${afterHash}`);
  }
  console.log('✅ Program upgrade verified.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
