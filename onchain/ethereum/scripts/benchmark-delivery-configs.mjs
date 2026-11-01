import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const candidateCommit = 'b184cb4cbed24e0f306ee27d18c06d84debe3018';
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(packageRoot, '../..');
if (process.argv.length > 3) throw new Error('Usage: node --import tsx scripts/benchmark-delivery-configs.mjs [output.json]');
const defaultOutput = join(packageRoot, 'benchmarks/v10-registered-delivery-reproduction.json');
const outputPath = resolve(process.argv[2] || defaultOutput);
const repositoryStat = statSync(repositoryRoot);
let ancestor = outputPath;
while (!existsSync(ancestor)) ancestor = dirname(ancestor);
let insideRepository = false;
for (ancestor = realpathSync(ancestor);; ancestor = dirname(ancestor)) {
  const entry = statSync(ancestor);
  if (entry.dev === repositoryStat.dev && entry.ino === repositoryStat.ino) {
    insideRepository = true;
    break;
  }
  if (ancestor === dirname(ancestor)) break;
}
const outputStat = lstatSync(outputPath, { throwIfNoEntry: false });
const defaultDirectory = statSync(dirname(defaultOutput));
const outputDirectory = statSync(dirname(outputPath), { throwIfNoEntry: false });
const isDefaultOutput = basename(outputPath) === basename(defaultOutput) &&
  outputDirectory?.dev === defaultDirectory.dev && outputDirectory?.ino === defaultDirectory.ino;
assert.ok((!outputStat || (outputStat.isFile() && outputStat.nlink === 1)) &&
  (isDefaultOutput || !insideRepository),
  'Historical delivery reports are protected; use the reproduction output or a path outside the repository');
const directory = mkdtempSync(join(tmpdir(), '111k-historical-delivery-'));
const checkout = join(directory, 'checkout');
const git = args => execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
try {
  git(['cat-file', '-e', `${candidateCommit}^{commit}`]);
  const pinnedPackage = JSON.parse(git(['show', `${candidateCommit}:onchain/ethereum/package.json`]));
  const pinnedRoot = JSON.parse(git(['show', `${candidateCommit}:package.json`]));
  for (const [name, version] of Object.entries(pinnedPackage.devDependencies)) {
    assert.equal(JSON.parse(readFileSync(join(packageRoot, 'node_modules', name, 'package.json'), 'utf8')).version,
      version, `Historical contract dependency changed: ${name}`);
  }
  for (const name of ['@noble/curves', '@noble/hashes']) {
    assert.equal(JSON.parse(readFileSync(join(repositoryRoot, 'node_modules', name, 'package.json'), 'utf8')).version,
      pinnedRoot.dependencies[name], `Historical signing dependency changed: ${name}`);
  }
  git(['clone', '--quiet', '--shared', '--no-checkout', repositoryRoot, checkout]);
  git(['-C', checkout, 'sparse-checkout', 'set', 'onchain/ethereum', 'shared/ethereum']);
  git(['-C', checkout, 'checkout', '--quiet', '--detach', candidateCommit]);
  symlinkSync(join(repositoryRoot, 'node_modules'), join(checkout, 'node_modules'), 'dir');
  symlinkSync(join(packageRoot, 'node_modules'), join(checkout, 'onchain/ethereum/node_modules'), 'dir');
  process.stderr.write(`Reproducing the historical registered-delivery comparison at ${candidateCommit}.\n`);
  execFileSync(process.execPath, ['--import', 'tsx', 'scripts/benchmark-delivery-configs.mjs', outputPath], {
    cwd: join(checkout, 'onchain/ethereum'), env: process.env, stdio: 'inherit',
  });
} finally {
  rmSync(directory, { recursive: true, force: true });
}
