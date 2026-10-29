import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { CommerceD1Row } from './commerceD1Maintenance.ts';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));
const commandInput = fileURLToPath(new URL('./d1CommandInput.cjs', import.meta.url));
type Execution = { file: string; args: string[]; input: string; timeoutMs: number };
type Execute = (execution: Execution) => Promise<string>;

const execute: Execute = ({ file, args, input, timeoutMs }) => new Promise((resolve, reject) => {
  const failure = () => reject(new Error('Async D1 request failed or timed out.'));
  const child = execFile(file, args, { cwd: root, encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL',
    env: { ...process.env, WRANGLER_LOG_SANITIZE: 'true' }, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
    clearTimeout(deadline);
    if (error) failure();
    else resolve(stdout);
  });
  const deadline = setTimeout(() => {
    failure();
    child.kill('SIGKILL');
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
  }, timeoutMs);
  child.stdin?.on('error', () => {});
  child.stdin?.end(input);
});

export function createAsyncD1MaintenanceQuery(database: 'ops', run: Execute = execute): (sql: string) => Promise<CommerceD1Row[]> {
  return async sql => {
    const output = await run({ file: process.execPath, input: sql, timeoutMs: 15_000, args: [
      '--no-warnings', '--require', commandInput, require.resolve('wrangler'),
      'd1', 'execute', `mons-shop-${database}`, '--remote', '--command', 'MONS_D1_SQL_STDIN',
      '--config', 'cloud/workers/api/wrangler.jsonc', '--env-file', 'cloud/workers/api/release.env', '--json',
    ] });
    const parsed: unknown = JSON.parse(output.trim());
    if (!Array.isArray(parsed) || parsed.length !== 1 || parsed[0]?.success !== true || !Array.isArray(parsed[0]?.results)) {
      throw new Error('Async D1 returned an invalid statement result.');
    }
    return parsed[0].results;
  };
}
