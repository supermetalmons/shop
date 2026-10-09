import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { ROOT, TOOL_DIRECTORY, acquireRunLock, digest, readJson } from './run-state.mjs';

const execute = promisify(execFile);
const require = createRequire(import.meta.url);
const HELP = `Usage: npm run render:mi-note-cards -- --output DIRECTORY [options]

Capture all 1,430 Mi Note cards with the calibrated native Safari renderer.

  --output DIRECTORY       Required collection output directory
  --cache DIRECTORY        Run state (default: .cache/mi-note-renderer/<output hash>)
  --python EXECUTABLE       Python 3.11+ with pinned requirements
                           (default: MI_NOTE_RENDER_PYTHON or python3)
  --resume                 Verify and continue the same output/cache run
  --publish-only           Validate and publish an existing complete run;
                           does not start Safari, Vite, or CDN preflight
  --stop-after N           Stop after N cards; resume later to finish
  --stop-after-startup     Stop after startup calibration/control checks
  --vite-port PORT         Local Vite port (default: 5174; strict port)
  --help                   Show this help without starting a run

Use empty output/cache directories for a new run. Within the repository,
generated directories must be below .cache/ or renderer-samples/.
See scripts/mi-note-renderer/README.md for calibration and permission setup.
`;

export function parseOptions(argv, { cwd = process.cwd(), env = process.env } = {}) {
  const values = new Map();
  const flags = new Set(['resume', 'publish-only', 'stop-after-startup', 'help']);
  const parameters = new Set(['output', 'cache', 'python', 'stop-after', 'vite-port']);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const match = /^--([^=]+)(?:=(.*))?$/.exec(argument);
    if (!match || (!flags.has(match[1]) && !parameters.has(match[1]))) {
      throw new Error(`Unknown option: ${argument}`);
    }
    const [, name, inline] = match;
    if (values.has(name)) throw new Error(`Option supplied more than once: --${name}`);
    if (flags.has(name)) {
      if (inline !== undefined) throw new Error(`--${name} does not accept a value`);
      values.set(name, true);
    } else {
      const value = inline ?? argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`);
      values.set(name, value);
    }
  }
  if (values.has('help')) return { help: true };
  if (!values.has('output')) throw new Error('--output is required');
  const integer = (name, fallback, maximum) => {
    const value = values.get(name);
    if (value === undefined) return fallback;
    const number = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 1 || number > maximum) {
      throw new Error(`--${name} must be an integer from 1 to ${maximum}`);
    }
    return number;
  };
  const output = path.resolve(cwd, values.get('output'));
  const cache = values.has('cache')
    ? path.resolve(cwd, values.get('cache'))
    : path.join(ROOT, '.cache', 'mi-note-renderer', digest(output).slice(0, 16));
  const python = values.get('python') ?? env.MI_NOTE_RENDER_PYTHON ?? 'python3';
  const options = {
    output, cache,
    python: python.includes(path.sep) ? path.resolve(cwd, python) : python,
    resume: values.has('resume'),
    publishOnly: values.has('publish-only'),
    stopAfter: integer('stop-after', Infinity, 1430),
    stopAfterStartup: values.has('stop-after-startup'),
    vitePort: integer('vite-port', 5174, 65535),
    help: false,
  };
  if (!options.python.trim()) throw new Error('Python executable cannot be empty');
  if (options.publishOnly && (Number.isFinite(options.stopAfter) || options.stopAfterStartup)) {
    throw new Error('--publish-only cannot be combined with capture stop options');
  }
  if (Number.isFinite(options.stopAfter) && options.stopAfterStartup) {
    throw new Error('Choose either --stop-after or --stop-after-startup');
  }
  options.baseUrl = `http://localhost:${options.vitePort}`;
  return options;
}

function canonicalPath(file) {
  try { return fs.realpathSync(file); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error(`Broken symbolic link: ${file}`);
    }
    const parent = path.dirname(file);
    if (parent === file) throw error;
    return path.join(canonicalPath(parent), path.basename(file));
  }
}

function contains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function validateRunPaths(options, { ownLock = false } = {}) {
  const root = canonicalPath(ROOT);
  const output = canonicalPath(options.output);
  const cache = canonicalPath(options.cache);
  for (const [name, directory] of [['output', output], ['cache', cache]]) {
    if (contains(directory, root)) throw new Error(`--${name} cannot contain the repository: ${directory}`);
    if (contains(root, directory)) {
      const allowed = ['.cache', 'renderer-samples'].some(folder => {
        const parent = path.join(root, folder);
        return directory !== parent && contains(parent, directory);
      });
      if (!allowed) throw new Error(`--${name} inside the repository must be below .cache/ or renderer-samples/`);
    }
    if (fs.existsSync(directory) && !fs.statSync(directory).isDirectory()) {
      throw new Error(`--${name} is not a directory: ${directory}`);
    }
  }
  if (contains(output, cache) || contains(cache, output)) throw new Error('Output and cache directories must not overlap');
  const archivePaths = ['.zip', '.zip.partial', '.zip.json'].map(suffix => `${output}${suffix}`);
  if (archivePaths.some(file => contains(cache, file) || contains(file, cache))) {
    throw new Error('Cache must not overlap the adjacent output archive files');
  }
  if (options.resume || options.publishOnly) {
    if (!fs.existsSync(output) || !fs.existsSync(cache)) throw new Error('Resume/publish requires existing output and cache directories');
    const configFile = path.join(cache, 'run-config.json');
    const checkpointFile = path.join(cache, 'checkpoint.json');
    if (!fs.existsSync(configFile) || !fs.existsSync(checkpointFile)) {
      throw new Error('Resume/publish requires run-config.json and checkpoint.json in the selected cache');
    }
    const config = readJson(configFile);
    const checkpoint = readJson(checkpointFile);
    for (const [name, directory] of [['output', output], ['cache', cache]]) {
      if (typeof config[name] !== 'string' || !path.isAbsolute(config[name]) || canonicalPath(config[name]) !== directory) {
        throw new Error(`Run configuration ${name} does not match the selected path`);
      }
    }
    if (!config.runFingerprint || checkpoint.runFingerprint !== config.runFingerprint) {
      throw new Error('Checkpoint run fingerprint does not match the selected run configuration');
    }
  } else {
    for (const [name, directory] of [['output', output], ['cache', cache]]) {
      const entries = fs.existsSync(directory) ? fs.readdirSync(directory) : [];
      if (entries.some(entry => !(ownLock && name === 'cache' && entry === '.run.lock'))) {
        throw new Error(`Fresh --${name} must be empty; use --resume for an existing run: ${directory}`);
      }
    }
    for (const file of archivePaths) {
      if (fs.existsSync(file)) throw new Error(`Fresh output has an existing archive artifact: ${file}`);
    }
  }
  return { ...options, output, cache };
}

async function runtimeVersions(python) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 15)) throw new Error('Node.js 22.15 or newer is required');
  const script = `import json, platform, sys
import PIL, numpy
if sys.version_info < (3, 11): raise SystemExit('Python 3.11 or newer is required')
if PIL.__version__ != '12.3.0' or numpy.__version__ != '2.3.5':
    raise SystemExit('Install pinned requirements: Pillow==12.3.0 and numpy==2.3.5')
print(json.dumps({'python': platform.python_version(), 'pillow': PIL.__version__, 'numpy': numpy.__version__}))
`;
  let result;
  try {
    result = await execute(python, ['-c', script], {
      cwd: ROOT, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, timeout: 30_000,
    });
  } catch (error) {
    throw new Error(`Python environment check failed for ${python}: ${error.stderr?.trim() || error.message}`);
  }
  return { node: process.version, ...JSON.parse(result.stdout), vite: readJson(require.resolve('vite/package.json')).version };
}

function runPython(python, filename, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [path.join(TOOL_DIRECTORY, filename), ...args], {
      cwd: ROOT, stdio: 'inherit', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    });
    const interrupt = () => child.kill('SIGINT');
    const terminate = () => child.kill('SIGTERM');
    const cleanup = () => {
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', terminate);
    };
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', terminate);
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', (code, signal) => {
      cleanup();
      if (code === 0) resolve();
      else reject(new Error(`${filename} failed (${signal ?? `exit ${code}`})`));
    });
  });
}

async function main() {
  const parsed = parseOptions(process.argv.slice(2));
  if (parsed.help) { process.stdout.write(HELP); return; }
  const options = validateRunPaths(parsed);
  options.runtime = await runtimeVersions(options.python);
  if (!options.publishOnly && process.platform !== 'darwin') {
    throw new Error('Native Safari capture requires macOS; --publish-only works without Safari');
  }
  fs.mkdirSync(options.cache, { recursive: true });
  const release = acquireRunLock(options.cache);
  try {
    validateRunPaths(options, { ownLock: true });
    const publish = () => runPython(options.python, 'publish_collection.py', ['--output', options.output, '--cache', options.cache]);
    if (options.publishOnly) { await publish(); return; }
    fs.mkdirSync(options.output, { recursive: true });
    await runPython(options.python, 'preflight_assets.py', ['--output', path.join(options.cache, 'assets-preflight.current.json')]);
    const { createServer } = await import('vite');
    const server = await createServer({
      root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'),
      server: { host: '127.0.0.1', port: options.vitePort, strictPort: true, open: false },
    });
    let state;
    try {
      await server.listen();
      const { capture } = await import('./batch.mjs');
      state = await capture(options);
    } finally {
      await server.close();
    }
    if (state.status === 'captured') await publish();
    else if (state.status !== 'stopped') throw new Error(`Capture ended in unexpected state: ${state.status}`);
  } finally {
    release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stderr.write(`Mi Note renderer: ${error.message}\n`);
    process.exitCode = 1;
  });
}
