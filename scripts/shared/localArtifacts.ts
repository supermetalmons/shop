import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export const LOCAL_ARTIFACT_MANIFEST = {
  version: 1,
  evidenceRoot: '.operations',
  retained: [
    '.cache/111k-mainnet-v1-release',
    '.cache/111k-v17-release',
    '.cache/111k-metadata',
    '.cache/111k-release-locations',
    'onchain/ethereum/.local',
    'releases',
    'output',
  ],
  caches: [
    { id: 'video-sources', directory: '.cache/video-frames/sources/cdn-lil-111k', files: /^([1-9]\d*)\.mp4$/, maximumId: 58,
      regenerate: 'npm run render:video-frames -- --ids <ids>' },
    { id: 'animation-sources', directory: '.cache/video-frames/animated/sources/cdn-lil-111k', files: /^([1-9]\d*)\.mp4$/, maximumId: 421,
      regenerate: 'npm run render:video-frames -- --collection animated --ids <ids>' },
    { id: 'knife-sources', directory: '.cache/video-frames/knives/sources/cdn-lil-111k', files: /^([1-9]\d*)\.glb$/, maximumId: 3000,
      regenerate: 'npm run render:knives -- --ids <ids>' },
    { id: 'canvas-sources', directory: '.cache/painting-canvas/sources/cdn-lil-111k', files: /^([1-9]\d*)\.png$/, maximumId: 30990,
      regenerate: 'npm run render:canvases -- --ids <ids>' },
    { id: 'egg-sources', directory: '.cache/egg-render/sources/cdn-lil-111k', files: /^([1-9]\d*)\.webp$/, maximumId: 76700,
      regenerate: 'npm run render:eggs -- --ids <ids>' },
  ],
} as const;

type FileIdentity = { device: string; inode: string; size: number; modified: string; changed: string };
type CacheFile = { path: string; cache: string; identity: FileIdentity };
export type LocalCachePlan = {
  version: 1;
  repositoryRoot: string;
  selected: string[];
  files: CacheFile[];
  bytes: number;
  preserved: string[];
};

function regularPath(root: string, relative: string, allowMissing = false): boolean {
  assert.ok(relative && !path.isAbsolute(relative) && relative.split('/').every(part => part && part !== '.' && part !== '..'),
    'Artifact paths must be repository-relative');
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    try {
      assert.ok(!fs.lstatSync(current).isSymbolicLink(), `Artifact path cannot be a symlink: ${relative}`);
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
  return true;
}

function identity(filename: string): FileIdentity {
  const stat = fs.lstatSync(filename, { bigint: true });
  assert.ok(stat.isFile(), 'Cache cleanup only removes regular files');
  assert.ok(stat.size <= BigInt(Number.MAX_SAFE_INTEGER), 'Cache file is too large');
  return { device: String(stat.dev), inode: String(stat.ino), size: Number(stat.size),
    modified: String(stat.mtimeNs), changed: String(stat.ctimeNs) };
}

export function initializeOperationsDirectory(repositoryRoot: string): string {
  const root = fs.realpathSync(repositoryRoot);
  const relative = LOCAL_ARTIFACT_MANIFEST.evidenceRoot;
  regularPath(root, relative, true);
  const directory = path.join(root, relative);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assert.ok(fs.lstatSync(directory).isDirectory() && (fs.statSync(directory).mode & 0o077) === 0,
    'Operations evidence directory must be private (mode 0700)');
  return directory;
}

export function planLocalCacheCleanup(repositoryRoot: string, selected?: readonly string[]): LocalCachePlan {
  const root = fs.realpathSync(repositoryRoot);
  const all = LOCAL_ARTIFACT_MANIFEST.caches;
  const names = selected ? [...selected] : all.map(entry => entry.id);
  assert.ok(names.length && new Set(names).size === names.length && names.every(name => all.some(entry => entry.id === name)),
    'Select distinct cache IDs from the local artifact manifest');
  const files: CacheFile[] = [];
  const preserved = LOCAL_ARTIFACT_MANIFEST.retained.filter(relative => fs.existsSync(path.join(root, relative))) as string[];
  if (fs.existsSync(path.join(root, LOCAL_ARTIFACT_MANIFEST.evidenceRoot))) preserved.push(LOCAL_ARTIFACT_MANIFEST.evidenceRoot);
  for (const entry of all.filter(entry => names.includes(entry.id))) {
    if (!regularPath(root, entry.directory, true)) continue;
    assert.ok(fs.lstatSync(path.join(root, entry.directory)).isDirectory(), `Cache root must be a directory: ${entry.directory}`);
    const visit = (relative: string) => {
      const full = path.join(root, entry.directory, relative);
      const stat = fs.lstatSync(full);
      if (stat.isDirectory()) {
        for (const name of fs.readdirSync(full).sort()) visit(relative ? `${relative}/${name}` : name);
      } else if (stat.isFile() && entry.files.test(relative) && Number(entry.files.exec(relative)![1]) <= entry.maximumId) {
        files.push({ path: `${entry.directory}/${relative}`, cache: entry.id, identity: identity(full) });
      } else preserved.push(`${entry.directory}/${relative}`);
    };
    visit('');
  }
  return { version: 1, repositoryRoot: root, selected: names, files,
    bytes: files.reduce((sum, file) => sum + file.identity.size, 0), preserved: preserved.sort() };
}

export function applyLocalCacheCleanup(plan: LocalCachePlan): { files: number; bytes: number } {
  assert.equal(plan.version, 1, 'Unsupported cache plan');
  const current = planLocalCacheCleanup(plan.repositoryRoot, plan.selected);
  assert.deepEqual(current, plan, 'Cache contents changed after planning; inspect a fresh plan before cleaning');
  for (const file of plan.files) {
    regularPath(plan.repositoryRoot, file.path);
    const filename = path.join(plan.repositoryRoot, file.path);
    assert.deepEqual(identity(filename), file.identity, `Cache file changed after planning: ${file.path}`);
    fs.unlinkSync(filename);
  }
  return { files: plan.files.length, bytes: plan.bytes };
}
