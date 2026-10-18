import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '../..');
const checksum = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const check = (condition, message) => { if (!condition) throw new Error(message); };
export const runtimeContract = Object.freeze(JSON.parse(readFileSync(join(directory, 'contract.json'), 'utf8')).runtime);
export const expectedIccSha256 = '0ff6958f98684c61f6bbdce1368ddeaf3873baf84545baba482e920d92a914c0';
export const preservedHashes = Object.freeze({
  runtimeReceipt: '245e4a945f28034b830e722a59bf12af47915b99f046bf4b24cf6fb0f2429893',
  node: 'b468fb9c67427c9d3aec07ee1105e63020923a631a9a2a00beb71a7ba3768bfd',
  srgb: '2b3aa1645779a9e634744faf9b01e9102b0c9b88fd6deced7934df86b949af7e',
  packageLock: '30787c9a98225aa3ca68ecc788afbd881be7b6f6be170c2a90a7e1d9e5724a6d',
});
export const nativeAppHashes = Object.freeze({
  app: '9de42b40930d75c9e2713aae53f77eedfca3daf936a47d82b8ddcd463807d8d6',
  appInfo: '72a6fe00768dd3fef9aa4d1e9ed272c44557bc84bfec76f93a5d3e25d0b0e8e7',
  swift: 'aba9c684966c5b711f6560a0f836f166c3dc16402e6926be88e0082d593f6407',
  build: '727a16aebc0164528c9db3e95586c089672ff73076b39470be7bfe72994276b5',
});

export function runtimePaths() {
  const runtime = join(homedir(), 'Library/Application Support/Mons Mi Note Render/host/runtime');
  return { root: runtime, node: join(runtime, 'node/bin/node'), python: join(runtime, 'python/bin/python3.12'),
    ffmpeg: join(runtime, 'media/bin/ffmpeg'), ffprobe: join(runtime, 'media/bin/ffprobe'),
    app: join(root, '.cache/native-webview-background/MiNoteCapture.app/Contents/MacOS/MiNoteCapture') };
}

export function nativeEnvironment(paths = runtimePaths(), input = process.env) {
  const env = { ...input };
  for (const name of Object.keys(env)) {
    if (name.startsWith('PYTHON') || name.startsWith('DYLD_') || ['NODE_OPTIONS', 'NODE_PATH'].includes(name)) delete env[name];
  }
  return { ...env, PATH: [dirname(paths.node), dirname(paths.python), dirname(paths.ffmpeg), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
    MI_NOTE_FFMPEG: paths.ffmpeg, MI_NOTE_FFPROBE: paths.ffprobe, PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' };
}

export function environmentMatches(input, expected) {
  return [...new Set([...Object.keys(input), ...Object.keys(expected)])].every(name => input[name] === expected[name]);
}

function regular(path) {
  check(lstatSync(path).isFile() && realpathSync(path) === resolve(path), `Expected a regular file without symbolic links: ${path}`);
  return path;
}

export function verifyPinnedNode(paths = runtimePaths()) {
  check(checksum(regular(paths.node)) === preservedHashes.node, 'The preserved Node executable changed.');
  return paths.node;
}

export function verifyRuntimeInventory(runtime, { receiptHash = preservedHashes.runtimeReceipt, contract = runtimeContract } = {}) {
  runtime = resolve(runtime);
  check(lstatSync(runtime).isDirectory() && realpathSync(runtime) === runtime, 'The native runtime must be a real directory.');
  const receiptPath = regular(join(runtime, 'runtime.json'));
  check(checksum(receiptPath) === receiptHash, 'The preserved native runtime receipt changed.');
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  const canonical = object => JSON.stringify(Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b))));
  check(receipt.version === 1 && canonical(receipt.contract) === canonical(contract), 'The native runtime version contract differs.');
  check(receipt.files && typeof receipt.files === 'object' && !Array.isArray(receipt.files), 'The native runtime inventory is missing.');
  for (const name of Object.keys(receipt.files)) {
    check(name && !isAbsolute(name) && !name.split(/[\\/]/).some(part => !part || part === '.' || part === '..'), 'Unsafe native runtime inventory path.');
  }
  const actual = {};
  const ignoredFinderFiles = [];
  function visit(path) {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = join(path, entry.name), name = relative(runtime, child).split('\\').join('/');
      if (name === 'runtime.json' || name.split('/').includes('__pycache__') || name.endsWith('.pyc')) continue;
      if (entry.name === '.DS_Store' && !Object.hasOwn(receipt.files, name) && entry.isFile()) { ignoredFinderFiles.push(name); continue; }
      if (entry.isSymbolicLink()) {
        const target = relative(runtime, realpathSync(child));
        check(target && !isAbsolute(target) && !target.split(/[\\/]/).includes('..'), `Native runtime link escapes its directory: ${name}`);
        actual[name] = { symlink: readlinkSync(child) };
      } else if (entry.isDirectory()) visit(child);
      else { check(entry.isFile(), `Unsupported native runtime entry: ${name}`); actual[name] = { sha256: checksum(child) }; }
    }
  }
  visit(runtime);
  check(canonical(actual) === canonical(receipt.files), 'Native runtime files differ from the preserved receipt.');
  return { root: runtime, receiptSha256: receiptHash, verifiedEntries: Object.keys(actual).length, ignoredFinderFiles };
}

export function runtimeVersions(paths = runtimePaths(), run = (command, args) => execFileSync(command, args, { encoding: 'utf8', env: nativeEnvironment(paths), maxBuffer: 4 * 1024 * 1024 }).trim()) {
  return {
    node: run(paths.node, ['--version']),
    python: JSON.parse(run(paths.python, ['-B', '-c', 'import json,platform;from PIL import Image,features;import numpy;print(json.dumps({"python":platform.python_version(),"pillow":Image.__version__,"littlecms":features.version("littlecms2"),"numpy":numpy.__version__}))'])),
    ffmpeg: run(paths.ffmpeg, ['-version']).split('\n')[0],
    ffprobe: run(paths.ffprobe, ['-version']).split('\n')[0],
  };
}

export function verifyNativeEnvironment(paths = runtimePaths()) {
  verifyPinnedNode(paths);
  check(realpathSync(process.execPath) === realpathSync(paths.node) && process.version === `v${runtimeContract.node}`, 'Use cli.mjs to launch with the preserved Node runtime.');
  check(environmentMatches(process.env, nativeEnvironment(paths)), 'Use cli.mjs to launch with the preserved native environment.');
  const runtime = verifyRuntimeInventory(paths.root);
  const versions = runtimeVersions(paths);
  check(versions.node === `v${runtimeContract.node}`, 'Native Node version differs.');
  for (const key of ['python', 'pillow', 'numpy', 'littlecms']) check(versions.python[key] === runtimeContract[key], `Native ${key} version differs.`);
  for (const key of ['ffmpeg', 'ffprobe']) check(versions[key].startsWith(`${key} version ${runtimeContract[key]} `), `Native ${key} version differs.`);
  const binding = {
    app: [paths.app, nativeAppHashes.app], appInfo: [join(dirname(paths.app), '../Info.plist'), nativeAppHashes.appInfo],
    swift: [join(directory, 'native-webview.swift'), nativeAppHashes.swift], build: [join(directory, 'build-native-webview.sh'), nativeAppHashes.build],
    packageLock: [join(directory, 'package-lock.json'), preservedHashes.packageLock],
    p3: ['/System/Library/ColorSync/Profiles/Display P3.icc', expectedIccSha256],
    srgb: ['/System/Library/ColorSync/Profiles/sRGB Profile.icc', preservedHashes.srgb],
  };
  for (const [name, [path, expected]] of Object.entries(binding)) check(checksum(regular(path)) === expected, `Preserved native ${name} binding differs.`);
  const dependencies = JSON.parse(readFileSync(join(directory, 'package-lock.json'), 'utf8')).packages[''].dependencies;
  for (const [name, version] of Object.entries(dependencies)) {
    const installed = JSON.parse(readFileSync(join(directory, 'node_modules', name, 'package.json'), 'utf8'));
    check(installed.version === version, `Native dependency ${name} differs from the pinned lockfile.`);
  }
  const executables = Object.fromEntries([paths.node, paths.python, paths.ffmpeg, paths.ffprobe].map(path => [path, checksum(regular(path))]));
  return { runtime, versions: { ...versions, dependencies, colorProfiles: { p3: expectedIccSha256, srgb: preservedHashes.srgb } },
    executables, app: { path: paths.app, sha256: nativeAppHashes.app, infoSha256: nativeAppHashes.appInfo,
      sourceSha256: nativeAppHashes.swift, buildSha256: nativeAppHashes.build } };
}
