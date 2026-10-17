import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
let python = process.env.PYTHON || 'python3';
let native = false;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--python' && args[index + 1]) { python = args[++index]; native = true; }
  else throw Error('Usage: test.mjs [--python /path/to/python-with-pinned-requirements]');
}
const run = (command, arguments_) => {
  const result = spawnSync(command, arguments_, { cwd: directory, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
};
const nodeTests = readdirSync(join(directory, 'tests')).filter(name => /\.test\.(ts|mjs)$/.test(name)).sort().map(name => join(directory, 'tests', name));
run(process.execPath, ['--import', 'tsx', '--test', ...nodeTests]);
const pythonTests = native ? ['test_*.py'] : ['test_vm.py', 'test_cli.py', 'test_prepare.py', 'test_backends.py', 'test_jobs.py', 'test_retention.py', 'test_host_receipts.py', 'test_catalog.py', 'test_pipeline.py', 'test_background.py', 'test_storage.py', 'test_audit.py'];
for (const pattern of pythonTests) run(python, ['-m', 'unittest', 'discover', '-s', join(directory, 'tests'), '-p', pattern, '-v']);
