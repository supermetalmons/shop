import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type D1MaintenanceRow = Record<string, unknown>;
type D1MaintenanceDatabase = 'data' | 'ops' | 'commerce';
type ExecuteFile = (
  file: string,
  args: string[],
  options: ExecFileSyncOptionsWithStringEncoding,
) => string;

export type D1MaintenanceQueryBatch = <Key extends string>(
  queries: Record<Key, string>,
) => Record<Key, D1MaintenanceRow[]>;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const wranglerBinary = resolve(
  repoRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler',
);

export function createD1MaintenanceRunner(
  database: D1MaintenanceDatabase,
  executeFile: ExecuteFile = execFileSync,
) {
  const label = database === 'data' ? 'D1' : database === 'ops' ? 'Ops D1' : 'Commerce D1';
  const commerce = database === 'commerce';

  function execute(inputFlag: '--command' | '--file', input: string): D1MaintenanceRow[][] {
    let output: string;
    try {
      output = executeFile(wranglerBinary, [
        'd1', 'execute', `mons-shop-${database}`, '--remote', inputFlag, input,
        '--config', 'cloud/workers/api/wrangler.jsonc',
        '--env-file', 'cloud/workers/api/release.env',
        '--json',
      ], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: process.env,
        maxBuffer: (commerce ? 64 : 32) * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10 * 60_000,
      }).trim();
    } catch (error) {
      const detail = error && typeof error === 'object'
        ? [
            'stdout' in error ? error.stdout : '',
            'stderr' in error ? error.stderr : '',
          ]
            .map((value) => String(value || '').replace(/\u001b\[[0-9;]*m/g, '').trim())
            .filter(Boolean)
            .join('\n')
        : '';
      throw new Error(detail || `Wrangler ${label} command failed.`);
    }
    let parsed: unknown;
    try {
      const jsonStart = commerce ? output.indexOf('[') : -1;
      parsed = JSON.parse(jsonStart >= 0 ? output.slice(jsonStart) : output);
    } catch {
      throw new Error(`${label} returned invalid JSON.`);
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error(`${label} returned an invalid ${commerce ? 'result' : 'query'} envelope.`);
    }
    return parsed.map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error(`${label} returned an invalid ${commerce ? '' : 'query '}result.`);
      }
      if (entry.success !== true || !Array.isArray(entry.results)) {
        throw new Error(`${label} query failed.`);
      }
      return entry.results as D1MaintenanceRow[];
    });
  }

  function executeCommand(sql: string): D1MaintenanceRow[][] {
    return execute('--command', sql);
  }

  function query(sql: string): D1MaintenanceRow[] {
    const results = executeCommand(sql);
    if (results.length !== 1) throw new Error(`Expected exactly one ${label} statement result.`);
    return results[0];
  }

  function queryBatch<Key extends string>(queries: Record<Key, string>): Record<Key, D1MaintenanceRow[]> {
    const entries = Object.entries<string>(queries);
    if (entries.length === 0 || entries.some(([, sql]) => !sql.trim())) {
      throw new Error(`${label} query batch must contain non-empty statements.`);
    }
    const results = executeCommand(entries.map(([, sql]) => sql.trim().replace(/;$/, '')).join(';\n'));
    if (results.length !== entries.length) {
      throw new Error(`Expected exactly ${entries.length} ${label} statement results.`);
    }
    return Object.fromEntries(entries.map(([key], index) => [key, results[index]])) as Record<Key, D1MaintenanceRow[]>;
  }

  return {
    executeCommand,
    executeFile: (filePath: string) => execute('--file', filePath),
    query,
    queryBatch,
  };
}
