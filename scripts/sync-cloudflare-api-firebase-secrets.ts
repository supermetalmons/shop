import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PROJECT_ID = 'mons-shop';
const SECRET_NAMES = [
  'ADDRESS_DECRYPTION_SECRET',
  'COSIGNER_SECRET',
  'SHIPSTATION_API_KEY',
  'SHIPSTATION_SHIP_FROM',
  'STRIPE_SECRET_KEY',
  'STRIPE_RESTRICTED_KEY',
  'STRIPE_SECRET_KEY_LIVE',
  'STRIPE_RESTRICTED_KEY_LIVE',
] as const;
const CONFIG_ARGS = ['--config', 'cloud/workers/api/wrangler.jsonc', '--env-file', 'cloud/workers/api/release.env'];
const WRANGLER = resolve('node_modules/.bin/wrangler');

function fail(message: string): never {
  throw new Error(message);
}

function run(command: string, args: string[], input?: string): string {
  const result = spawnSync(command, args, {
    cwd: resolve('.'),
    encoding: 'utf8',
    input,
    shell: false,
    env: {
      ...process.env,
      WRANGLER_LOG_PATH: resolve('.cache/wrangler-logs'),
      WRANGLER_LOG_SANITIZE: 'true',
      WRANGLER_SEND_ERROR_REPORTS: 'false',
      WRANGLER_SEND_METRICS: 'false',
    },
  });
  if (result.status !== 0) fail(`${command} failed with exit code ${result.status ?? 1}`);
  return result.stdout;
}

function stableVersionId(): string {
  const output = run(WRANGLER, ['deployments', 'status', '--json', ...CONFIG_ARGS]);
  const payload = JSON.parse(output) as { versions?: Array<{ version_id?: string; percentage?: number }> };
  const stable = payload.versions?.filter((version) => version.percentage === 100 && typeof version.version_id === 'string') || [];
  if (stable.length !== 1) fail('API Worker is not on one stable production version');
  return stable[0].version_id!;
}

function readSecret(name: typeof SECRET_NAMES[number]): string {
  const value = run('gcloud', ['secrets', 'versions', 'access', 'latest', '--secret', name, '--project', PROJECT_ID]).trim();
  if (!value) fail(`Google Secret Manager returned an empty value for ${name}`);
  return value;
}

function main(): void {
  if (!String(process.env.CLOUDFLARE_API_TOKEN || '').trim()) fail('CLOUDFLARE_API_TOKEN is required');
  const before = stableVersionId();
  const directory = mkdtempSync(join(tmpdir(), 'mons-shop-api-firebase-secrets-'));
  chmodSync(directory, 0o700);
  const path = join(directory, 'secrets.json');
  try {
    const secrets = Object.fromEntries(SECRET_NAMES.map((name) => [name, readSecret(name)]));
    writeFileSync(path, JSON.stringify(secrets), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    chmodSync(path, 0o600);
    run(WRANGLER, [
      'versions', 'secret', 'bulk', path,
      '--message', 'Stage Firebase migration secrets',
      ...CONFIG_ARGS,
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  const after = stableVersionId();
  if (after !== before) fail('Secret synchronization changed the live production version');
  console.log(JSON.stringify({ synced: SECRET_NAMES.length, productionVersion: after, productionUnchanged: true }));
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
