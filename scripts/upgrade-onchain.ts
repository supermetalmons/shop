import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { clusterApiUrl, Keypair, PublicKey } from '@solana/web3.js';
import {
  DEPLOYMENT_DROPS,
  getDeploymentDrop,
  type DeploymentRegistryDrop,
} from '../functions/src/shared/deploymentRegistry.ts';
import { parsePrivateKeyInput, promptMaskedInput, promptYConfirmation } from './shared/interactive.ts';

type SolanaCluster = DeploymentRegistryDrop['solanaCluster'];

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

function resolveDropTarget(dropId: string, cluster?: SolanaCluster): DeploymentRegistryDrop {
  const drop = getDeploymentDrop(dropId);
  if (!drop) {
    const known = Object.keys(DEPLOYMENT_DROPS).sort().join(', ');
    throw new Error(`Unknown dropId: ${dropId}\nKnown drops: ${known}`);
  }
  if (cluster && drop.solanaCluster !== cluster) {
    throw new Error(
      `Drop ${drop.dropId} is configured for ${drop.solanaCluster}, not ${cluster}.\n` +
        `Use the environment-specific drop id from functions/src/shared/deploymentRegistry.ts.`,
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

function sha256File(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function programIdFeature(programId: string): string | undefined {
  const features: Record<string, string | undefined> = {
    '7FGMn1z6TMi6ndyVooP9n1y3zuWhcrxfcJgcSQs6VNNU': 'mainnet-program-id',
    'FPAzYdh8rdSRSXYQBneqwniqWGn3out5eQg2n1qyotxd': 'localnet-program-id',
    '22NeePs5wgkzP4j5sPzfzJqXsFAu9SUMiGBznPQVaAep': 'testnet-program-id',
    '7h4JRc5vELpaahm11AeshFEQHe1jePauRnMFWaPSRNpV': 'card-nft-2-devnet-final-program-id',
    '8oFSao3VA9DrZouLe3ZFqkbUsjuF6aFDr1eJPh4pyh6': 'shared-devnet-program-id',
    'Hr39xMTdeQFPkLb9D6yYxxzTTkfW6QgVyyUETT7jyfZw': undefined,
    'CTrBmaCdgNRE9iHtrfQJnxH2puKxfi2V3gBMTxMLrrUA': 'little-swag-boxes-devnet-program-id',
    'C96UF1dNPzAiRoWPDyU1BRVez5Rfqf2WeFy6gipkBS5A': 'poncho-mainnet-program-id',
    'J9ffqCnnV1kg2gZ7Wg4ebVW5KLFH557UDdz9Y6F8fK2W': 'poncho-devnet-program-id',
  };
  if (!Object.hasOwn(features, programId)) {
    throw new Error(`Program ${programId} has no committed build feature`);
  }
  return features[programId];
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
  const cleanup = () => {
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

  if (!opts.skipTests) {
    run('cargo', ['test', '--lib', '--locked'], { cwd: onchainDir, env: toolEnv });
  }
  removeStaleAnchorGeneratedArtifacts(onchainDir);
  const buildFeatures = ['no-idl', 'no-log-ix-name', programIdFeature(programId)]
    .filter((value): value is string => Boolean(value))
    .join(',');
  run('anchor', [
    'build',
    '--no-idl',
    '--arch',
    'sbf',
    '--',
    '--features',
    buildFeatures,
    '--',
    '--locked',
  ], {
    cwd: onchainDir,
    env: toolEnv,
  });

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
