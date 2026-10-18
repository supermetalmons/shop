import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

export const defaultOutputDirectory = () => join(homedir(), 'Movies', 'Mi Note Native Renders');

export function nativeRunPaths({ output, cardIds }, stateRoot = join(homedir(), 'Library', 'Application Support', 'Mons Mi Note Render', 'native-runs')) {
  const key = createHash('sha256').update(JSON.stringify({ output: resolve(output), ids: cardIds })).digest('hex');
  const stateDirectory = join(stateRoot, key);
  return { stateDirectory, manifestPath: join(stateDirectory, 'native-run.json') };
}

function entry(path) {
  try { return lstatSync(path); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

function canonicalDirectory(path) {
  if (!isAbsolute(path) || resolve(path) !== path || !entry(path)?.isDirectory() || realpathSync(path) !== path) {
    throw new Error(`Expected a canonical directory without symbolic links: ${path}`);
  }
}

function createCanonicalDirectory(path) {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error(`Expected an absolute canonical directory: ${path}`);
  let ancestor = path;
  while (!entry(ancestor)) ancestor = dirname(ancestor);
  canonicalDirectory(ancestor);
  mkdirSync(path, { recursive: true });
  canonicalDirectory(path);
}

export function prepareNativeOutput(options, { stateDirectory, manifestPath }, initialManifest, { writeManifest = writeFileSync } = {}) {
  if (manifestPath !== join(stateDirectory, 'native-run.json')) throw new Error('Native manifest path does not match its state directory.');
  createCanonicalDirectory(options.output);
  if (options.resume) {
    if (!entry(stateDirectory)) throw new Error(`Native resume state directory is missing: ${stateDirectory}`);
    canonicalDirectory(stateDirectory);
    return;
  }
  for (const card of options.cardIds) {
    const video = join(options.output, `${card}.mp4`);
    if (entry(video)) throw new Error(`Native video already exists and will not be overwritten: ${video}`);
  }
  createCanonicalDirectory(dirname(stateDirectory));
  if (entry(stateDirectory)) canonicalDirectory(stateDirectory);
  if (!initialManifest || typeof initialManifest !== 'object' || Array.isArray(initialManifest)) throw new Error('An initial native run manifest is required.');
  const initializing = mkdtempSync(join(dirname(stateDirectory), `.${basename(stateDirectory)}.initializing-`));
  try {
    writeManifest(join(initializing, 'native-run.json'), JSON.stringify(initialManifest, null, 2) + '\n', { flag: 'wx', flush: true });
    renameSync(initializing, stateDirectory);
  } catch (error) {
    if (['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw new Error(`Native run state already exists; use resume with the same selection: ${stateDirectory}`);
    throw error;
  } finally { rmSync(initializing, { recursive: true, force: true }); }
  canonicalDirectory(stateDirectory);
}

export function pruneNativeIntermediates(cardDirectory) {
  canonicalDirectory(cardDirectory);
  const certificate = join(cardDirectory, 'certificate');
  if (entry(certificate)) canonicalDirectory(certificate);
  for (const name of ['native', 'prepared', 'proofs']) rmSync(join(cardDirectory, name), { recursive: true, force: true });
  rmSync(join(cardDirectory, '.video.staged.mp4'), { force: true });
  if (!entry(certificate)) return;
  for (const file of readdirSync(certificate, { withFileTypes: true })) {
    if (/^\d{4}\.yuv$/.test(file.name) && (file.isFile() || file.isSymbolicLink())) rmSync(join(certificate, file.name));
  }
}
