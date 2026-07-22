import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

type DeployMode = 'dry-run' | 'preview' | 'production';

type CliOptions = {
  mode: DeployMode;
  tokenFile?: string;
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';
const npmBinary = isWindows ? 'npm.cmd' : 'npm';
const wranglerBinary = resolve(repoRoot, 'node_modules', '.bin', isWindows ? 'wrangler.cmd' : 'wrangler');

function usage(): string {
  return [
    'Build and deploy the mons.shop frontend with the pinned local Wrangler.',
    '',
    'Usage:',
    '  npm run deploy -- dry-run',
    '  npm run deploy -- preview --token-file /path/to/cloudflare-token',
    '  npm run deploy -- production --token-file /path/to/cloudflare-token',
    '',
    'Authentication:',
    '  Pass --token-file, or set CLOUDFLARE_API_TOKEN in the shell.',
    '  The token is only provided to the Wrangler subprocess and is never printed.',
  ].join('\n');
}

function fail(message: string, exitCode = 1): never {
  console.error(`\n[deploy] ${message}\n`);
  process.exit(exitCode);
}

function parseArgs(argv: string[]): CliOptions {
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(usage());
    process.exit(0);
  }

  const mode = argv[0];
  if (mode !== 'dry-run' && mode !== 'preview' && mode !== 'production') {
    fail(`Expected one deployment mode: dry-run, preview, or production.\n\n${usage()}`, 2);
  }

  let tokenFile: string | undefined;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--token-file') {
      const value = argv[++i];
      if (!value) fail('Missing value for --token-file.', 2);
      tokenFile = value;
      continue;
    }
    fail(`Unknown argument: ${arg}\n\n${usage()}`, 2);
  }

  return { mode, tokenFile };
}

function run(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  label: string,
): void {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
    shell: false,
  });

  if (result.error) {
    fail(`${label} could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`${label} failed with exit code ${result.status ?? 1}.`, result.status ?? 1);
  }
}

function readApiToken(tokenFile?: string): string {
  if (tokenFile) {
    let value: string;
    try {
      value = readFileSync(resolve(tokenFile), 'utf8').trim();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      fail(`Unable to read --token-file: ${detail}`);
    }
    if (!value) fail('The Cloudflare token file is empty.');
    return value;
  }

  const value = (process.env.CLOUDFLARE_API_TOKEN || '').trim();
  if (!value) {
    fail('Missing Cloudflare authentication. Pass --token-file or set CLOUDFLARE_API_TOKEN.');
  }
  return value;
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const [nodeMajor = Number.NaN, nodeMinor = Number.NaN] = process.versions.node
    .split('.')
    .slice(0, 2)
    .map((part) => Number.parseInt(part, 10));
  if (
    !Number.isFinite(nodeMajor) ||
    !Number.isFinite(nodeMinor) ||
    nodeMajor < 22 ||
    (nodeMajor === 22 && nodeMinor < 12)
  ) {
    fail(`Node 22.12 or newer is required; current version is ${process.versions.node}.`);
  }
  if (!existsSync(wranglerBinary)) {
    fail('Pinned Wrangler binary not found. Run npm install --legacy-peer-deps first.');
  }

  const buildEnv = { ...process.env };
  for (const name of Object.keys(buildEnv)) {
    if (
      name.startsWith('VITE_') ||
      name.startsWith('CLOUDFLARE_') ||
      name === 'STRIPE_TEST_UNIT_AMOUNT_CENTS'
    ) {
      delete buildEnv[name];
    }
  }
  buildEnv.VITE_BUILD_DATETIME = String(Math.floor(Date.now() / 1000));

  console.log(`[deploy] Mode:  ${opts.mode}`);
  console.log('[deploy] Build: npm run build (isolated Vite environment)');
  const viteEnvDirectory = mkdtempSync(join(tmpdir(), 'mons-shop-vite-env-'));
  buildEnv.MONS_SHOP_VITE_ENV_DIR = viteEnvDirectory;
  try {
    run(npmBinary, ['run', 'build'], buildEnv, 'Frontend build');
  } finally {
    rmSync(viteEnvDirectory, { force: true, recursive: true });
  }

  const wranglerLogDirectory = resolve(repoRoot, '.cache', 'wrangler-logs');
  mkdirSync(wranglerLogDirectory, { recursive: true });

  const wranglerEnv: NodeJS.ProcessEnv = {
    ...buildEnv,
    WRANGLER_LOG_PATH: wranglerLogDirectory,
    WRANGLER_LOG_SANITIZE: 'true',
    WRANGLER_SEND_ERROR_REPORTS: 'false',
    WRANGLER_SEND_METRICS: 'false',
  };

  let wranglerArgs: string[];
  if (opts.mode === 'dry-run') {
    wranglerArgs = ['deploy', '--dry-run', '--config', 'wrangler.jsonc'];
  } else {
    wranglerEnv.CLOUDFLARE_API_TOKEN = readApiToken(opts.tokenFile);
    wranglerArgs =
      opts.mode === 'preview'
        ? ['versions', 'upload', '--preview-alias', 'candidate', '--config', 'wrangler.jsonc']
        : ['deploy', '--config', 'wrangler.jsonc'];
  }

  console.log(`[deploy] Wrangler: ${wranglerArgs.slice(0, 2).join(' ')}`);
  run(wranglerBinary, wranglerArgs, wranglerEnv, 'Wrangler');
}

main();
