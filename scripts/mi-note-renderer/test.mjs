import path from 'node:path';
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { TOOL_DIRECTORY, ROOT } from './run-state.mjs';

const directory = path.join(TOOL_DIRECTORY, 'tests');
const tests = readdirSync(directory).filter(file => file.endsWith('.test.mjs')).sort().map(file => path.join(directory, file));
const environment = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };
for (const [command, args] of [
  [process.execPath, ['--test', ...tests]],
  [process.env.MI_NOTE_RENDER_PYTHON || 'python3', ['-m', 'unittest', 'discover', '-s', directory, '-p', 'test_*.py', '-v']],
]) {
  const result = spawnSync(command, args, { cwd: ROOT, env: environment, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) { process.exitCode = result.status || 1; break; }
}
