import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';

export const engineDirectory = dirname(fileURLToPath(import.meta.url));
export const sourceRoot = resolve(engineDirectory, '../..');
export const contract = JSON.parse(readFileSync(join(engineDirectory, 'contract.json'), 'utf8'));
export const hashFile = path => createHash('sha256').update(readFileSync(path)).digest('hex');
export const sourcePath = path => resolve(sourceRoot, path);
export const requireValue = (condition, message) => { if (!condition) throw new Error(message); };

export function catalogCount() {
  const source = readFileSync(join(sourceRoot, 'src/lib/miNoteCards.ts'), 'utf8');
  const count = Number(source.match(/\bMI_NOTE_CARD_COUNT\s*=\s*(\d+)\s*;/)?.[1]);
  requireValue(Number.isSafeInteger(count) && count > 0, 'The pinned source catalog count is unavailable.');
  return count;
}

export function assertNativeVM() {
  requireValue(process.platform === 'darwin' && execFileSync('/usr/sbin/sysctl', ['-n', 'hw.model'], { encoding: 'utf8' }).trim().startsWith('VirtualMac'),
    'Native rendering requires the configured macOS VM.');
}

export function profileFor(id) {
  const value = contract.profiles[id];
  requireValue(value && ['sideways-1980', 'upright-2160'].includes(id), `Unsupported profile: ${id}`);
  return { id, ...value };
}

export function motionFor(id) {
  requireValue(contract.motions.includes(id), `Unsupported motion: ${id}`);
  return id === 'original' ? undefined : id;
}

export function parseOptions(argv, kind) {
  const result = { python: process.env.MI_NOTE_VIDEO_PYTHON || 'python3', profile: contract.defaults.profile, motion: contract.defaults.motion };
  const values = kind === 'preflight' ? ['profile', 'motion', 'id', 'output', 'python'] : ['profile', 'motion', 'ids', 'output', 'cache', 'preflight', 'python'];
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help') return { help: true };
    if (kind === 'preflight' && flag === '--verify-resume') { result.verifyResume = true; continue; }
    if (kind === 'capture' && ['--resume', '--check-resume'].includes(flag)) {
      result.resume = true;
      if (flag === '--check-resume') result.checkResume = true;
      continue;
    }
    requireValue(flag.startsWith('--') && values.includes(flag.slice(2)), `Unknown option: ${flag}`);
    const value = argv[++index];
    requireValue(value && !value.startsWith('--'), `Missing value for ${flag}`);
    result[flag.slice(2)] = value;
  }
  const rawId = kind === 'preflight' ? result.id : result.ids;
  requireValue(typeof rawId === 'string' && /^\d+$/.test(rawId), 'Exactly one card ID is required.');
  result.id = Number(rawId);
  requireValue(Number.isInteger(result.id) && result.id >= 1 && result.id <= catalogCount(), `Card ID must be from 1 through ${catalogCount()}.`);
  result.ids = [result.id];
  profileFor(result.profile);
  motionFor(result.motion);
  for (const key of kind === 'preflight' ? ['output'] : ['output', 'cache', 'preflight']) {
    requireValue(result[key], `--${key} is required.`);
    result[key] = resolve(result[key]);
  }
  return result;
}

export function renderingSourceHashes() {
  const snapshotPath = join(sourceRoot, 'source-snapshot.json');
  if (existsSync(snapshotPath)) {
    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
    const files = snapshot.files;
    requireValue(files && !Array.isArray(files) && typeof files === 'object', 'Invalid source snapshot inventory.');
    const hashes = {};
    for (const [path, record] of Object.entries(files)) {
      const expected = typeof record === 'string' ? record : record.sha256;
      requireValue(!isAbsolute(path) && !path.split(/[\\/]/).includes('..') && /^[a-f0-9]{64}$/.test(expected || ''), 'Unsafe source snapshot entry.');
      requireValue(hashFile(join(sourceRoot, path)) === expected, `Source snapshot changed: ${path}`);
      hashes[path] = expected;
    }
    hashes['source-snapshot.json'] = hashFile(snapshotPath);
    return Object.fromEntries(Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b)));
  }
  const files = new Set();
  const queue = readdirSync(engineDirectory).filter(name => ['.mjs', '.ts', '.tsx', '.css', '.html', '.json', '.py', '.txt'].includes(extname(name))
    && !name.startsWith('test_')).map(name => join(engineDirectory, name));
  while (queue.length) {
    const path = queue.pop();
    if (files.has(path)) continue;
    files.add(path);
    if (!['.mjs', '.ts', '.tsx'].includes(extname(path))) continue;
    const source = readFileSync(path, 'utf8');
    for (const match of source.matchAll(/(?:from\s+|import\s*\(?\s*)['"](\.[^'"]+)['"]/g)) {
      const base = resolve(dirname(path), match[1]);
      const found = [base, ...['.ts', '.tsx', '.mjs', '.js', '.json', '.css'].map(suffix => base + suffix)].find(existsSync);
      requireValue(found && !relative(sourceRoot, found).startsWith('..'), `Missing local rendering dependency: ${match[1]}`);
      queue.push(found);
    }
  }
  return Object.fromEntries([...files].sort().map(path => [relative(sourceRoot, path), hashFile(path)]));
}

export function assertSourceHashes(hashes) {
  for (const [path, expected] of Object.entries(hashes)) requireValue(hashFile(join(sourceRoot, path)) === expected, `Rendering source changed: ${path}`);
}

export function assertPreflightBinding(identity, current) {
  for (const key of ['root', 'profile', 'motion', 'ids', 'sourceHashes', 'versions']) {
    requireValue(identity && JSON.stringify(identity[key]) === JSON.stringify(current[key]), `Preflight ${key} differs from the current capture.`);
  }
}

export function runtimeVersions(python) {
  const run = (name, args) => execFileSync(name, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }).trim();
  return {
    node: process.version,
    python: JSON.parse(run(python, ['-c', 'import json,platform;from PIL import Image,features;import numpy;print(json.dumps({"python":platform.python_version(),"pillow":Image.__version__,"littlecms":features.version("littlecms2"),"numpy":numpy.__version__}))'])),
    ffmpeg: run('ffmpeg', ['-version']).split('\n')[0],
    ffprobe: run('ffprobe', ['-version']).split('\n')[0],
    safariDriver: run('/usr/bin/safaridriver', ['--version']),
    colorProfiles: {
      p3: hashFile('/System/Library/ColorSync/Profiles/Display P3.icc'),
      srgb: hashFile('/System/Library/ColorSync/Profiles/sRGB Profile.icc'),
    },
  };
}

export function viteOptions(port) {
  return { root: sourceRoot, configFile: false, envDir: false, envPrefix: [], plugins: [react()],
    server: { host: '127.0.0.1', port, strictPort: true, hmr: false, watch: null },
    optimizeDeps: { include: ['react', 'react-dom/client', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime'] } };
}

export function assertProfileGrid(profile, grid) {
  requireValue(grid.xs.length === 1 && grid.ys.length === profile.tiles,
    `${profile.id} requires exactly ${profile.tiles} native viewport capture${profile.tiles === 1 ? '' : 's'} per frame.`);
}

export function warmupFrames() { return [...contract.capture.warmupFrames]; }

export async function warmNativeCapture(capture) {
  const results = [];
  for (const [index, frame] of warmupFrames().entries()) results.push(await capture(frame, index));
  return results;
}
