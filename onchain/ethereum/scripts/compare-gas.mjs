import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const candidateCommit = 'd37e03bc17db5fb6b08463f6a61c84c6a7335c2c';
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(packageRoot, '../..');
if (process.argv.length > 3) throw new Error('Usage: node --import tsx scripts/compare-gas.mjs [output.json]');
const outputPath = resolve(process.argv[2] || join(packageRoot, 'benchmarks/optimizer-500-reproduction.json'));
assert.notEqual(outputPath, join(packageRoot, 'benchmarks/optimizer-500-comparison.json'),
  'The original optimizer report is historical; choose a separate reproduction output');
const directory = mkdtempSync(join(tmpdir(), '111k-historical-optimizer-'));
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
  process.stderr.write(`Reproducing the historical optimizer comparison at ${candidateCommit}.\n`);
  execFileSync(process.execPath, ['--import', 'tsx', 'scripts/compare-gas.mjs', outputPath], {
    cwd: join(checkout, 'onchain/ethereum'), env: process.env, stdio: 'inherit',
  });
} finally {
  rmSync(directory, { recursive: true, force: true });
}
