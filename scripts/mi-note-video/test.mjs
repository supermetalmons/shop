import { spawnSync } from 'node:child_process';
import { accessSync, constants, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(import.meta.url);
const directory = dirname(script);
const args = process.argv.slice(2);
const usage = 'Usage: test.mjs [--python /absolute/path/to/python-with-pinned-requirements]';
if (args.length === 1 && args[0] === '--help') {
  console.log(usage);
  process.exit(0);
}
const runtime = join(homedir(), 'Library/Application Support/Mons Mi Note Render/host/runtime');
const node = join(runtime, 'node/bin/node');
const ffmpeg = join(runtime, 'media/bin/ffmpeg');
const ffprobe = join(runtime, 'media/bin/ffprobe');
let python = join(runtime, 'python/bin/python3.12');
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--python' && args[index + 1] && isAbsolute(args[index + 1])) python = args[++index];
  else throw Error(usage);
}
for (const executable of [node, python, ffmpeg, ffprobe]) {
  try { accessSync(executable, constants.X_OK); }
  catch { throw Error(`Required native test executable is missing or not executable: ${executable}`); }
}
const env = { ...process.env, PYTHON: python, MI_NOTE_VIDEO_PYTHON: python,
  MI_NOTE_FFMPEG: ffmpeg, MI_NOTE_FFPROBE: ffprobe,
  PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1',
  PATH: [dirname(node), dirname(python), dirname(ffmpeg), process.env.PATH || ''].join(delimiter) };
const run = (command, arguments_, capture = false) => {
  const result = spawnSync(command, arguments_, { cwd: directory, env,
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
  return result.stdout;
};
if (realpathSync(process.execPath) !== realpathSync(node)) {
  run(node, [script, ...args]);
  process.exit(0);
}
const expected = JSON.parse(readFileSync(join(directory, 'contract.json'), 'utf8')).runtime;
if (process.versions.node !== expected.node) throw Error(`Native tests require Node ${expected.node}; found ${process.versions.node}.`);
run(python, ['-c', `import json,platform,sys
import numpy
from PIL import Image,features
expected=json.loads(sys.argv[1])
actual={"python":platform.python_version(),"numpy":numpy.__version__,"pillow":Image.__version__,"littlecms":features.version("littlecms2")}
for name,value in actual.items():
    if value != expected[name]: raise SystemExit(f"Native tests require {name} {expected[name]}; found {value}.")
print("Native Python test runtime verified: " + json.dumps(actual,sort_keys=True))`, JSON.stringify(expected)]);
for (const [name, executable] of [['ffmpeg', ffmpeg], ['ffprobe', ffprobe]]) {
  const version = run(executable, ['-version'], true).split('\n')[0].split(/\s+/)[2];
  if (version !== expected[name]) throw Error(`Native tests require ${name} ${expected[name]}; found ${version}.`);
}
const nodeTests = readdirSync(join(directory, 'tests')).filter(name => /\.test\.(ts|mjs)$/.test(name)).sort().map(name => join(directory, 'tests', name));
if (!nodeTests.length) throw Error('No native JavaScript tests were found.');
run(node, ['--import', 'tsx', '--test', ...nodeTests]);
run(python, ['-c', `import sys,unittest
suite=unittest.defaultTestLoader.discover(sys.argv[1],pattern="test_*.py")
if suite.countTestCases() == 0: raise SystemExit("No native Python tests were found.")
result=unittest.TextTestRunner(verbosity=2).run(suite)
if result.skipped:
    print("Native validation does not permit skipped Python tests:",file=sys.stderr)
    for test,reason in result.skipped: print(f"{test}: {reason}",file=sys.stderr)
sys.exit(0 if result.wasSuccessful() and not result.skipped else 1)`, join(directory, 'tests')]);
