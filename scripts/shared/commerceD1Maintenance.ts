import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type CommerceD1Row = Record<string, unknown>;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const configPath = 'cloud/workers/api/wrangler.jsonc';
const envFilePath = 'cloud/workers/api/release.env';
const databaseName = 'mons-shop-commerce';
const wranglerBinary = resolve(
  repoRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler',
);

function fail(message: string): never {
  throw new Error(message);
}

function runWrangler(args: string[], json = true): string {
  try {
    return execFileSync(
      wranglerBinary,
      [
        ...args,
        '--config',
        configPath,
        '--env-file',
        envFilePath,
        ...(json ? ['--json'] : []),
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: process.env,
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ).trim();
  } catch (error) {
    const output = error && typeof error === 'object'
      ? [
          'stdout' in error ? (error as { stdout?: unknown }).stdout : '',
          'stderr' in error ? (error as { stderr?: unknown }).stderr : '',
        ]
          .map((value) => String(value || '').replace(/\u001b\[[0-9;]*m/g, '').trim())
          .filter(Boolean)
          .join('\n')
      : '';
    return fail(output || 'Wrangler Commerce D1 command failed.');
  }
}

export function uploadPrivateCommerceArchiveObject(filePath: string, objectKey: string): void {
  runWrangler([
    'r2',
    'object',
    'put',
    `mons-shop-commerce-archive/${objectKey}`,
    '--remote',
    '--file',
    filePath,
  ], false);
}

function parseEnvelope(output: string): CommerceD1Row[][] {
  let parsed: unknown;
  try {
    const jsonStart = output.indexOf('[');
    parsed = JSON.parse(jsonStart >= 0 ? output.slice(jsonStart) : output);
  } catch {
    return fail('Commerce D1 returned invalid JSON.');
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return fail('Commerce D1 returned an invalid result envelope.');
  return parsed.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return fail('Commerce D1 returned an invalid result.');
    const result = entry as { results?: unknown; success?: unknown };
    if (result.success !== true || !Array.isArray(result.results)) return fail('Commerce D1 query failed.');
    return result.results as CommerceD1Row[];
  });
}

export function queryRemoteCommerceD1(sql: string): CommerceD1Row[] {
  const results = parseEnvelope(runWrangler([
    'd1',
    'execute',
    databaseName,
    '--remote',
    '--command',
    sql,
  ]));
  if (results.length !== 1) return fail('Expected exactly one Commerce D1 statement result.');
  return results[0];
}

export function executeRemoteCommerceD1File(filePath: string): CommerceD1Row[][] {
  return parseEnvelope(runWrangler([
    'd1',
    'execute',
    databaseName,
    '--remote',
    '--file',
    filePath,
  ]));
}

export function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function safeInteger(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) return fail(`${label} is invalid.`);
  return number;
}
