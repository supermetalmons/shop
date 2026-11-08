import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { cleanup111kReplacementArtifacts, uses111kMetadataNamespace, type ReplacementArtifactScope } from '../scripts/shared/ethereum111kReplacementArtifacts.ts';
import { record111kReleaseLocation } from '../scripts/shared/ethereum111kReleaseLocations.ts';

const old: ReplacementArtifactScope = { deploymentId: 'v16', chainId: 11155111,
  contractAddress: `0x${'16'.repeat(20)}`, metadataBaseUri: 'https://cdn.mons.shop/111k-sepolia/v16/' };
const current: ReplacementArtifactScope = { deploymentId: 'v17', chainId: 11155111,
  contractAddress: `0x${'17'.repeat(20)}`, metadataBaseUri: 'https://cdn.mons.shop/111k-sepolia/v17/' };
const manifest = (scope: ReplacementArtifactScope) => ({ chainId: scope.chainId, deploymentId: scope.deploymentId,
  contractAddress: scope.contractAddress, metadataBaseURI: scope.metadataBaseUri });
const retiredRow = (scope: ReplacementArtifactScope = old) => ({ deployment_id: scope.deploymentId, drop_id: '111k_devnet',
  chain_id: scope.chainId, contract_address: scope.contractAddress, metadata_base_uri: scope.metadataBaseUri,
  deployment_block: 1, catalog_version: '111k-v5', template_json: JSON.stringify({ name: '111k', description: '', image: 'image', attributes: [] }),
  template_sha256: 'a'.repeat(64), state: 'paused', revision: 3, created_at_ms: 1, updated_at_ms: 3,
  activated_at_ms: 2, provisioned_at_ms: 1, last_error: null, retired_at_ms: 3, replacement_deployment_id: 'v17' });

function fixture(t: { after: (callback: () => void) => void }, queryRetiredDeployments: (sql: string) => Record<string, unknown>[] = () => []) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), '111k-replacement-artifacts-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const repositoryRoot = path.join(directory, 'repository');
  const homeRoot = path.join(directory, 'home');
  fs.mkdirSync(repositoryRoot); fs.mkdirSync(homeRoot);
  const write = (name: string, value: unknown, root = repositoryRoot) => {
    const filename = path.join(root, name);
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    fs.writeFileSync(filename, typeof value === 'string' ? value : JSON.stringify(value));
    return filename;
  };
  const releaseDirectory = path.join(repositoryRoot, '.cache/111k-v17-release/contract');
  write('.gitignore', '.cache/\nonchain/ethereum/.local/\n');
  write('.cache/111k-v17-release/contract/manifest.json', { ...manifest(current), previousContract: old.contractAddress });
  const signedJournal = write('.cache/111k-v17-release/contract/transactions.private.json', { previousContract: old.contractAddress, signed: 'preserve-current' });
  write('releases/111k-sepolia-v16/deployment.json', manifest(old));
  write('releases/111k-sepolia-v16/README.md', '# Old release\n');
  write('.cache/111k-v16-release/contract/manifest.json', manifest(old));
  write('.cache/111k-v16-release/contract/transactions.private.json', { signed: 'old' });
  write('.cache/111k-metadata/v16/upload-sepolia-test.json', { network: 'sepolia', bucket: 'cdn-mons-shop', prefix: '111k-sepolia/v16/' });
  write('.cache/111k-metadata/v16/1.json', { image: 'public' });
  write('.cache/111k-metadata/v17/upload-sepolia-test.json', { network: 'sepolia', bucket: 'cdn-mons-shop', prefix: '111k-sepolia/v17/' });
  const newMetadata = write('.cache/111k-metadata/v17/1.json', { image: 'current' });
  write('.mons-shop-backups/ethereum111k/old.json', { scope: { chainId: old.chainId, contractAddress: old.contractAddress }, rows: ['old'] }, homeRoot);
  const mainnet = write('.mons-shop-backups/ethereum111k/mainnet.json', { scope: { chainId: 1, contractAddress: old.contractAddress } }, homeRoot);
  const newBackup = write('.mons-shop-backups/ethereum111k/current.json', { scope: { chainId: current.chainId, contractAddress: current.contractAddress } }, homeRoot);
  const unrelated = write('onchain/ethereum/.local/pre111k-mainnet-v2/manifest.json', { previousContract: old.contractAddress });
  write('README.md', '[Previous deployment](releases/111k-sepolia-v16/README.md)\n');
  const git = (args: string[]) => execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '-q']); git(['remote', 'add', 'origin', 'https://github.com/supermetalmons/shop.git']);
  git(['add', '.gitignore', 'README.md', 'releases']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Fixture']);
  const context = { oldDeployment: old, newDeployment: current, journalPath: path.join(releaseDirectory, 'cleanup-finalization.json') };
  const authorize = (plan: { planPath: string; planSha256: string }, cleanupContext = context) => {
    const cleanupDirectory = path.dirname(cleanupContext.journalPath);
    const frozen = JSON.parse(fs.readFileSync(path.join(cleanupDirectory, 'manifest.json'), 'utf8'));
    fs.writeFileSync(cleanupContext.journalPath, JSON.stringify({ version: 2, kind: '111k-replacement-cleanup', backendVerifiedAtMs: 1,
      oldDeployment: cleanupContext.oldDeployment, newDeployment: cleanupContext.newDeployment, release: { releaseDirectory: cleanupDirectory,
        manifestSha256: createHash('sha256').update(`${JSON.stringify(frozen, null, 2)}\n`).digest('hex') },
      artifacts: { planPath: plan.planPath, planSha256: plan.planSha256 } }));
  };
  const run = async (write = false) => {
    if (write && !fs.existsSync(context.journalPath)) authorize(await cleanup111kReplacementArtifacts(context, { repositoryRoot, homeRoot, queryRetiredDeployments }));
    return cleanup111kReplacementArtifacts(context, { repositoryRoot, homeRoot, write, queryRetiredDeployments });
  };
  return { repositoryRoot, homeRoot, releaseDirectory, context, run, authorize, write, git, signedJournal, newMetadata, mainnet, newBackup, unrelated };
}

test('replacement artifact planning is scoped and application removes only approved old evidence', async t => {
  const f = fixture(t);
  const before = fs.readFileSync(f.signedJournal);
  const planned = await f.run();
  assert.equal(planned.planned, true);
  assert.equal(planned.complete, false);
  assert.equal(planned.targets, 4);
  assert.ok(fs.existsSync(path.join(f.repositoryRoot, 'releases/111k-sepolia-v16/deployment.json')));
  const complete = await f.run(true);
  assert.equal(complete.complete, true);
  assert.equal(complete.planPath, planned.planPath);
  assert.equal(complete.planSha256, planned.planSha256);
  assert.deepEqual(fs.readFileSync(f.signedJournal), before);
  for (const file of [f.newMetadata, f.mainnet, f.newBackup, f.unrelated]) assert.ok(fs.existsSync(file));
  assert.match(fs.readFileSync(path.join(f.repositoryRoot, 'README.md'), 'utf8'),
    /https:\/\/github\.com\/supermetalmons\/shop\/blob\/[0-9a-f]{40}\/releases\/111k-sepolia-v16\/README.md/);
  assert.equal(fs.readdirSync(f.releaseDirectory).filter(name => name.endsWith('.jsonl')).length, 0);
  assert.equal((await f.run(true)).complete, true);
});

test('interrupted per-file deletion resumes from checksum-proven remaining files', async t => {
  const f = fixture(t);
  const planned = await f.run();
  const original = fs.unlinkSync;
  let removed = 0;
  const mocked = t.mock.method(fs, 'unlinkSync', filename => {
    if (String(filename).includes('releases/111k-sepolia-v16')) {
      if (++removed === 2) throw new Error('Fixture interrupted deletion');
    }
    original(filename);
  });
  await assert.rejects(f.run(true), /Fixture interrupted deletion/);
  mocked.mock.restore();
  assert.equal(fs.existsSync(path.join(f.repositoryRoot, 'releases/111k-sepolia-v16/README.md')), false);
  const result = await f.run(true);
  assert.equal(result.complete, true);
  assert.equal(result.planSha256, planned.planSha256);
  assert.ok(fs.existsSync(f.signedJournal));
});

test('changed, injected and symlinked old artifacts abort before any deletion', async t => {
  const f = fixture(t);
  await f.run();
  const oldMetadata = path.join(f.repositoryRoot, '.cache/111k-metadata/v16/1.json');
  const original = fs.readFileSync(oldMetadata);
  fs.writeFileSync(oldMetadata, '{"image":"changed"}');
  await assert.rejects(f.run(true), /Unapproved or changed artifact/);
  fs.writeFileSync(oldMetadata, original);
  const unknown = f.write('.cache/111k-metadata/v16/new.json', '{}');
  await assert.rejects(f.run(true), /Unapproved or changed artifact/);
  fs.unlinkSync(unknown);
  fs.symlinkSync(f.newMetadata, unknown);
  await assert.rejects(f.run(true), /Refusing artifact symlink/);
  assert.ok(fs.existsSync(path.join(f.repositoryRoot, 'releases/111k-sepolia-v16/deployment.json')));
});

test('artifact deletion requires the verified backend journal and immutable plan binding', async t => {
  const f = fixture(t);
  const planned = await f.run();
  const apply = () => cleanup111kReplacementArtifacts(f.context, { repositoryRoot: f.repositoryRoot, homeRoot: f.homeRoot, write: true });
  await assert.rejects(apply(), /Backend verification journal/);
  f.authorize(planned);
  const journal = JSON.parse(fs.readFileSync(f.context.journalPath, 'utf8'));
  fs.writeFileSync(f.context.journalPath, JSON.stringify({ ...journal, backendVerifiedAtMs: undefined }));
  await assert.rejects(apply(), /Backend verification is required/);
  fs.writeFileSync(f.context.journalPath, JSON.stringify(journal));
  const plan = JSON.parse(fs.readFileSync(planned.planPath, 'utf8'));
  fs.writeFileSync(planned.planPath, JSON.stringify({ ...plan, createdAt: 'changed' }));
  await assert.rejects(apply(), /Artifact plan changed after backend verification/);
  assert.ok(fs.existsSync(path.join(f.repositoryRoot, 'releases/111k-sepolia-v16/deployment.json')));
});

test('mainnet, current, forged predecessor and nested replacement scopes are rejected', async t => {
  const f = fixture(t);
  const options = { repositoryRoot: f.repositoryRoot, homeRoot: f.homeRoot, write: true };
  await assert.rejects(cleanup111kReplacementArtifacts({ ...f.context, oldDeployment: { ...old, chainId: 1 } }, options), /Only Sepolia/);
  await assert.rejects(cleanup111kReplacementArtifacts({ ...f.context, oldDeployment: current }, options), /protected/);
  await assert.rejects(cleanup111kReplacementArtifacts({ ...f.context,
    oldDeployment: { ...old, contractAddress: `0x${'55'.repeat(20)}` } }, options), /Frozen predecessor/);
  const nested = path.join(f.repositoryRoot, '.cache/111k-v16-release/new');
  f.write('.cache/111k-v16-release/new/manifest.json', { ...manifest(current), previousContract: old.contractAddress });
  await assert.rejects(cleanup111kReplacementArtifacts({ ...f.context, journalPath: path.join(nested, 'cleanup-finalization.json') }, options),
    /contains the replacement release directory/);
  assert.ok(fs.existsSync(f.signedJournal));
});

test('runtime dependencies and links without Git provenance stop retirement planning', async t => {
  const f = fixture(t);
  const runtime = f.write('src/artwork.ts', 'export const source = "releases/111k-sepolia-v16/deployment.json";');
  await assert.rejects(f.run(), /still required by src\/artwork.ts/);
  fs.unlinkSync(runtime);
  const untracked = f.write('releases/111k-sepolia-v16/uncommitted.json', '{}');
  f.write('README.md', '[Latest report](releases/111k-sepolia-v16/uncommitted.json)\n');
  await assert.rejects(f.run(), /absent from Git history/);
  assert.ok(fs.existsSync(untracked));
});

test('shared metadata cache publications remain intact and unknown backup identities fail closed', async t => {
  const f = fixture(t);
  f.write('.cache/111k-metadata/v16/upload-mainnet-test.json', { network: 'mainnet', bucket: 'cdn-mons-shop', prefix: '111k/mainnet-v1/' });
  const invalid = f.write('.mons-shop-backups/ethereum111k/unknown.json', { rows: [] }, f.homeRoot);
  await assert.rejects(f.run(), /Unknown backup identity/);
  fs.unlinkSync(invalid);
  const plan = await f.run();
  assert.deepEqual(plan.preservedShared, ['.cache/111k-metadata/v16']);
  assert.equal(plan.targets, 3);
  assert.equal((await f.run(true)).complete, true);
  assert.ok(fs.existsSync(path.join(f.repositoryRoot, '.cache/111k-metadata/v16/1.json')));
});

for (const evidence of ['root-report', 'journal', 'snapshot', 'interrupted-snapshot'] as const) {
  test(`mainnet ${evidence} ownership preserves a shared metadata cache`, async t => {
    const f = fixture(t);
    const directory = '.cache/111k-metadata/v16';
    let protectedFile: string;
    if (evidence === 'root-report') {
      f.write(`${directory}/upload-mainnet.json`, { network: 'mainnet', bucket: 'cdn-mons-shop', prefix: '111k/' });
      protectedFile = f.write(`${directory}/snapshots/mainnet/objects.jsonl.gz`, 'mainnet rollback bytes');
    } else if (evidence === 'journal') {
      protectedFile = f.write(`${directory}/uploads/mainnet.jsonl`, `${JSON.stringify({ version: 1,
        network: 'mainnet', bucket: 'cdn-mons-shop', sourceHash: 'a'.repeat(64) })}\n`);
    } else {
      if (evidence === 'snapshot') f.write(`${directory}/snapshots/mainnet/manifest.json`, {
        network: 'mainnet', prefix: '111k/', destination: { bucket: 'cdn-mons-shop' },
      });
      protectedFile = f.write(`${directory}/snapshots/mainnet/objects.jsonl.gz${evidence === 'interrupted-snapshot' ? '.partial' : ''}`,
        'mainnet snapshot bytes');
    }
    const before = fs.readFileSync(protectedFile);
    const planned = await f.run();
    assert.deepEqual(planned.preservedShared, [directory]);
    assert.equal(planned.targets, 3);
    assert.equal((await f.run(true)).complete, true);
    assert.deepEqual(fs.readFileSync(protectedFile), before);
  });
}

test('old-only publication journals permit cleanup while unproven journal evidence blocks it', async t => {
  const f = fixture(t);
  const journal = f.write('.cache/111k-metadata/v16/uploads/sepolia-old.jsonl', `${JSON.stringify({ version: 1,
    network: 'sepolia', bucket: 'cdn-mons-shop', prefix: '111k-sepolia/v16/', sourceHash: 'a'.repeat(64) })}\n`);
  assert.equal((await f.run()).targets, 4);
  fs.writeFileSync(journal, '{"network":"mainnet"');
  await assert.rejects(f.run(true), /Unapproved or changed artifact/);
  assert.ok(fs.existsSync(journal));

  const incomplete = fixture(t);
  incomplete.write('.cache/111k-metadata/v16/uploads/mainnet.jsonl', '{"network":"mainnet"');
  await assert.rejects(incomplete.run(), /Incomplete publication journal header/);
  const unknown = fixture(t);
  unknown.write('.cache/111k-metadata/v16/other-backup/mainnet/objects.jsonl.gz.partial', 'unknown snapshot');
  await assert.rejects(unknown.run(), /Unknown metadata cache directory ownership/);
});

test('retained historical cleanup evidence is not a runtime dependency', async t => {
  const f = fixture(t);
  const history = JSON.parse(fs.readFileSync(new URL('../releases/111k-testnet-cleanup-2026-11-08/local-artifacts.json', import.meta.url), 'utf8'));
  f.write('releases/111k-testnet-cleanup-2026-11-08/local-artifacts.json', history);
  assert.equal((await f.run()).planned, true);
  f.write('shared/runtime-assets.json', { directory: '.cache/111k-v16-release' });
  await assert.rejects(f.run(true), /still required by shared\/runtime-assets.json/);
  assert.ok(fs.existsSync(path.join(f.repositoryRoot, '.cache/111k-v16-release/contract/manifest.json')));
});

test('trusted root aliases are canonicalized while descendant symlinks remain forbidden', async t => {
  const f = fixture(t);
  const alias = path.join(path.dirname(f.repositoryRoot), 'root-alias');
  fs.symlinkSync(path.dirname(f.repositoryRoot), alias, 'dir');
  const context = { ...f.context, journalPath: path.join(alias, 'repository/.cache/111k-v17-release/contract/cleanup-finalization.json') };
  const options = { repositoryRoot: path.join(alias, 'repository'), homeRoot: path.join(alias, 'home') };
  const planned = await cleanup111kReplacementArtifacts(context, options);
  assert.equal(planned.planPath, path.join(f.releaseDirectory, 'cleanup-artifacts.json'));
  f.authorize(planned);
  assert.equal((await cleanup111kReplacementArtifacts(context, { ...options, write: true })).complete, true);
  assert.ok(fs.existsSync(f.signedJournal));

  const second = fixture(t);
  const actualManifest = path.join(second.releaseDirectory, 'manifest.json');
  fs.renameSync(actualManifest, `${actualManifest}.real`);
  fs.symlinkSync(`${actualManifest}.real`, actualManifest);
  await assert.rejects(second.run(), /Refusing artifact symlink/);
});

test('standard QA caches require matching old release evidence', async t => {
  const f = fixture(t);
  for (const [local, published] of [['verification.json', 'scene-verification.json'], ['ui-verification.json', 'scene-ui-verification.json'],
    ['interactive-verification.json', 'scene-interactive-verification.json']]) {
    f.write(`.cache/111k-v16-scenes/${local}`, { checked: true, local });
    f.write(`releases/111k-sepolia-v16/${published}`, { checked: true, local });
  }
  const report = { contractAddress: old.contractAddress, configurations: [{ metadataBaseUri: old.metadataBaseUri }] };
  f.write('.cache/111k-v16-live-ui/verification.json', report);
  f.write('releases/111k-sepolia-v16/live-ui-verification.json', report);
  const changed = f.write('.cache/111k-v16-scenes/verification.json', { changed: true });
  await assert.rejects(f.run(), /does not match scoped release evidence/);
  fs.writeFileSync(changed, JSON.stringify({ checked: true, local: 'verification.json' }));
  const plan = await f.run();
  assert.equal(plan.targets, 6);
  assert.equal((await f.run(true)).complete, true);
  assert.equal(fs.existsSync(path.join(f.repositoryRoot, '.cache/111k-v16-scenes')), false);
});

test('scoped local deployment and backup layouts retire without touching mainnet siblings', async t => {
  const f = fixture(t);
  f.write('onchain/ethereum/.local/111k-sepolia-v16/manifest.json', manifest(old));
  f.write('.mons-shop-backups/ethereum111k-acceptance/old.json', { chainId: old.chainId, oldContract: old.contractAddress }, f.homeRoot);
  f.write('.mons-shop-backups/111k-metadata/old/sepolia/manifest.json', { network: 'sepolia', prefix: '111k-sepolia/v16/' }, f.homeRoot);
  f.write('.mons-shop-backups/111k-metadata/old/sepolia/objects.jsonl.gz', 'old fixture bytes', f.homeRoot);
  const shared = f.write('.mons-shop-backups/111k-metadata/old/mainnet/manifest.json', { network: 'mainnet', prefix: '111k/' }, f.homeRoot);
  assert.equal((await f.run()).targets, 7);
  assert.equal((await f.run(true)).complete, true);
  assert.ok(fs.existsSync(shared));
});

test('an old release operation lock blocks artifact planning', async t => {
  const f = fixture(t);
  f.write('.cache/111k-v16-release/contract/operation.lock/owner.json', { pid: process.pid });
  await assert.rejects(f.run(), /Old release operation lock remains/);
  assert.ok(fs.existsSync(path.join(f.repositoryRoot, '.cache/111k-v16-release/contract/manifest.json')));
});

test('bound custom private releases are removed without a broad home scan', async t => {
  const f = fixture(t);
  fs.rmSync(path.join(f.repositoryRoot, '.cache/111k-v16-release'), { recursive: true });
  const oldDirectory = path.join(f.homeRoot, 'custom-private-v16');
  f.write('custom-private-v16/manifest.json', manifest(old), f.homeRoot);
  const oldJournal = f.write('custom-private-v16/transactions.private.json', { signed: 'retire' }, f.homeRoot);
  const unrelated = f.write('other-private/manifest.json', { unrelated: true }, f.homeRoot);
  const location = await record111kReleaseLocation(oldDirectory, old, { repositoryRoot: f.repositoryRoot, homeRoot: f.homeRoot });
  f.write('.cache/111k-v17-release/contract/manifest.json', { ...manifest(current), previousContract: old.contractAddress,
    previousReleaseDirectory: location.directory, previousReleaseManifestSha256: location.manifestSha256 });
  const plan = await f.run();
  assert.equal(plan.targets, 4);
  const unlink = fs.unlinkSync;
  const interruption = t.mock.method(fs, 'unlinkSync', filename => {
    if (String(filename) === oldJournal) throw new Error('Interrupted custom release cleanup');
    return unlink(filename);
  });
  await assert.rejects(f.run(true), /Interrupted custom release cleanup/);
  interruption.mock.restore();
  assert.equal(fs.existsSync(path.join(oldDirectory, 'manifest.json')), false);
  assert.equal((await f.run(true)).complete, true);
  assert.equal(fs.existsSync(oldJournal), false);
  assert.ok(fs.existsSync(unrelated)); assert.ok(fs.existsSync(f.signedJournal));
  assert.equal((await f.run(true)).complete, true);
});

test('unknown custom predecessor locations cannot produce a false complete result', async t => {
  const f = fixture(t);
  fs.rmSync(path.join(f.repositoryRoot, '.cache/111k-v16-release'), { recursive: true });
  const directory = path.join(f.homeRoot, 'custom-private-v16');
  f.write('custom-private-v16/manifest.json', manifest(old), f.homeRoot);
  f.write('custom-private-v16/transactions.private.json', { signed: 'retire' }, f.homeRoot);
  await assert.rejects(f.run(), /Previous private release location is unknown/);
  await record111kReleaseLocation(directory, old, { repositoryRoot: f.repositoryRoot, homeRoot: f.homeRoot });
  assert.equal((await f.run(true)).complete, true);
  assert.equal(fs.existsSync(directory), false);
});

test('a custom predecessor location must retain its frozen identity and stay outside current state', async t => {
  const f = fixture(t);
  const directory = path.join(f.homeRoot, 'custom-private-v16');
  f.write('custom-private-v16/manifest.json', manifest(old), f.homeRoot);
  const location = await record111kReleaseLocation(directory, old, { repositoryRoot: f.repositoryRoot, homeRoot: f.homeRoot });
  const frozen = { ...manifest(current), previousContract: old.contractAddress,
    previousReleaseDirectory: location.directory, previousReleaseManifestSha256: location.manifestSha256 };
  f.write('.cache/111k-v17-release/contract/manifest.json', frozen);
  f.write('custom-private-v16/manifest.json', { ...manifest(old), changed: true }, f.homeRoot);
  await assert.rejects(f.run(), /Previous release manifest changed/);
  f.write('custom-private-v16/manifest.json', manifest(old), f.homeRoot);
  f.write('.cache/111k-v17-release/contract/manifest.json', { ...frozen, previousReleaseDirectory: f.releaseDirectory });
  await assert.rejects(f.run(), /Recorded predecessor location changed/);
  assert.ok(fs.existsSync(f.signedJournal));
});

test('the replacement parent manifest protects a reused metadata cache until shared ownership is recorded', async t => {
  const f = fixture(t);
  f.write('.cache/111k-v17-release/reveal-manifest.json', { ...current, publicationDirectory: '../111k-metadata/v16' });
  await assert.rejects(f.run(), /Replacement still requires an old metadata cache/);
  f.write('.cache/111k-metadata/v16/upload-sepolia-current.json', { network: 'sepolia', bucket: 'cdn-mons-shop', prefix: '111k-sepolia/v17/' });
  const planned = await f.run();
  assert.deepEqual(planned.preservedShared, ['.cache/111k-metadata/v16']);
  assert.equal((await f.run(true)).complete, true);
  assert.ok(fs.existsSync(path.join(f.repositoryRoot, '.cache/111k-metadata/v16/1.json')));
});

test('two completed replacements remove a reused cache after every publication owner retires', async t => {
  const queries: string[] = [];
  const queryRetiredDeployments = (sql: string) => { queries.push(sql); return [retiredRow()]; };
  const f = fixture(t, queryRetiredDeployments);
  const reused = '.cache/111k-metadata/v16';
  fs.rmSync(path.join(f.repositoryRoot, '.cache/111k-metadata/v17'), { recursive: true });
  f.write(`${reused}/upload-sepolia-current.json`, { network: 'sepolia', bucket: 'cdn-mons-shop', prefix: '111k-sepolia/v17/' });
  for (const id of ['v16', 'v17']) f.write(`${reused}/uploads/sepolia-${id}.jsonl`, `${JSON.stringify({ version: 1,
    network: 'sepolia', bucket: 'cdn-mons-shop', prefix: `111k-sepolia/${id}/`, sourceHash: 'b'.repeat(64) })}\n`);
  f.write('.cache/111k-v17-release/reveal-manifest.json', { ...current, publicationDirectory: '../111k-metadata/v16' });
  const first = await f.run(true);
  assert.equal(first.complete, true);
  assert.deepEqual(first.preservedShared, [reused]);
  assert.ok(fs.existsSync(path.join(f.repositoryRoot, `${reused}/1.json`)));
  assert.ok(fs.existsSync(f.signedJournal));
  assert.equal(queries.length, 0);

  const next = { deploymentId: 'v18', chainId: 11155111, contractAddress: `0x${'18'.repeat(20)}`,
    metadataBaseUri: 'https://cdn.mons.shop/111k-sepolia/v18/' };
  f.write('releases/111k-sepolia-v17/deployment.json', manifest(current));
  f.write('.cache/111k-v18-release/contract/manifest.json', { ...manifest(next), previousContract: current.contractAddress });
  const signed = f.write('.cache/111k-v18-release/contract/transactions.private.json', { signed: 'preserve-v18' });
  f.write('.cache/111k-v18-release/reveal-manifest.json', { ...next, publicationDirectory: '../111k-metadata/v18' });
  f.write('.cache/111k-metadata/v18/upload-sepolia-test.json', { network: 'sepolia', bucket: 'cdn-mons-shop', prefix: '111k-sepolia/v18/' });
  const newMetadata = f.write('.cache/111k-metadata/v18/1.json', { image: 'v18' });
  const context = { oldDeployment: current, newDeployment: next,
    journalPath: path.join(f.repositoryRoot, '.cache/111k-v18-release/contract/cleanup-finalization.json') };
  const options = { repositoryRoot: f.repositoryRoot, homeRoot: f.homeRoot, queryRetiredDeployments };
  const second = await cleanup111kReplacementArtifacts(context, options);
  assert.deepEqual(second.preservedShared, []);
  assert.equal(queries.length, 1);
  assert.match(queries[0], /^SELECT \* FROM ethereum_reveal_deployments WHERE retired_at_ms IS NOT NULL$/);
  f.authorize(second, context);
  assert.equal((await cleanup111kReplacementArtifacts(context, { ...options, write: true })).complete, true);
  assert.equal(fs.existsSync(path.join(f.repositoryRoot, reused)), false);
  assert.equal(fs.existsSync(f.signedJournal), false);
  for (const filename of [newMetadata, signed, f.mainnet, f.unrelated]) assert.ok(fs.existsSync(filename));
  assert.equal((await cleanup111kReplacementArtifacts(context, options)).complete, true);
});

test('permanent retired ownership removes backlog caches without an immediate predecessor publication', async t => {
  let queries = 0;
  const historical = { ...old, deploymentId: 'v15', contractAddress: `0x${'15'.repeat(20)}`,
    metadataBaseUri: 'https://cdn.mons.shop/111k-sepolia/v15/' };
  const legacy = { ...historical, deploymentId: 'sepolia-8b4044db', contractAddress: `0x${'14'.repeat(20)}`,
    metadataBaseUri: 'https://cdn.mons.shop/111k-sepolia/' };
  const f = fixture(t, () => { queries++; return [retiredRow(historical), retiredRow(legacy)]; });
  const caches = ['historical-generated-cache', 'legacy-generated-cache'];
  for (const [index, owner] of [historical, legacy].entries()) {
    f.write(`.cache/111k-metadata/${caches[index]}/upload-sepolia-history.json`, {
      network: 'sepolia', bucket: 'cdn-mons-shop', prefix: owner.metadataBaseUri.slice('https://cdn.mons.shop/'.length),
    });
  }
  assert.equal((await f.run()).targets, 6);
  assert.equal(queries, 1);
  assert.equal((await f.run(true)).complete, true);
  for (const cache of caches) assert.equal(fs.existsSync(path.join(f.repositoryRoot, '.cache/111k-metadata', cache)), false);
});

for (const owner of ['mainnet', 'current', 'unknown', 'unmarked'] as const) {
  test(`${owner} ownership preserves a cache even with permanent historical retirement evidence`, async t => {
    let queries = 0;
    const historical = { ...old, deploymentId: 'v15', contractAddress: `0x${'15'.repeat(20)}`,
      metadataBaseUri: 'https://cdn.mons.shop/111k-sepolia/v15/' };
    const f = fixture(t, () => { queries++; return [retiredRow(historical)]; });
    const cache = '.cache/111k-metadata/v16';
    f.write(`${cache}/upload-sepolia-historical.json`, { network: 'sepolia', bucket: 'cdn-mons-shop', prefix: '111k-sepolia/v15/' });
    f.write(`${cache}/uploads/${owner === 'mainnet' ? 'mainnet' : 'sepolia'}-additional.jsonl`, `${JSON.stringify({
      network: owner === 'mainnet' ? 'mainnet' : 'sepolia', bucket: 'cdn-mons-shop',
      prefix: { mainnet: '111k/', current: '111k-sepolia/v17/', unknown: 'unknown/', unmarked: '111k-sepolia/v14/' }[owner],
    })}\n`);
    assert.deepEqual((await f.run()).preservedShared, [cache]);
    assert.equal(queries, owner === 'unmarked' ? 1 : 0);
    assert.equal((await f.run(true)).complete, true);
    assert.ok(fs.existsSync(path.join(f.repositoryRoot, cache, '1.json')));
  });
}

for (const forged of [
  { retired_at_ms: null, replacement_deployment_id: null },
  { state: 'active' },
  { chain_id: 1, metadata_base_uri: 'https://cdn.mons.shop/111k/v15/' },
  { drop_id: '111k' },
  { metadata_base_uri: 'https://cdn.mons.shop/unrelated/v15/' },
]) {
  test(`invalid OPS retirement evidence fails closed: ${JSON.stringify(forged)}`, async t => {
    const historical = { ...old, deploymentId: 'v15', contractAddress: `0x${'15'.repeat(20)}`,
      metadataBaseUri: 'https://cdn.mons.shop/111k-sepolia/v15/' };
    const f = fixture(t, () => [{ ...retiredRow(historical), ...forged }]);
    f.write('.cache/111k-metadata/v16/upload-sepolia-historical.json', { network: 'sepolia', bucket: 'cdn-mons-shop', prefix: '111k-sepolia/v15/' });
    await assert.rejects(f.run(), /Invalid reveal|Invalid Ethereum metadata|permanent Sepolia retirement marker/);
    assert.equal(fs.existsSync(path.join(f.releaseDirectory, 'cleanup-artifacts.json')), false);
    assert.ok(fs.existsSync(path.join(f.repositoryRoot, '.cache/111k-metadata/v16/1.json')));
  });
}

test('unavailable OPS retirement evidence cannot approve a shared cache', async t => {
  const f = fixture(t, () => { throw new Error('OPS unavailable'); });
  f.write('.cache/111k-metadata/v16/upload-sepolia-historical.json', { network: 'sepolia', bucket: 'cdn-mons-shop', prefix: '111k-sepolia/v15/' });
  await assert.rejects(f.run(), /OPS unavailable/);
  assert.equal(fs.existsSync(path.join(f.releaseDirectory, 'cleanup-artifacts.json')), false);
});

test('newly retired owners cannot silently expand an already bound artifact plan', async t => {
  const historical = { ...old, deploymentId: 'v15', contractAddress: `0x${'15'.repeat(20)}`,
    metadataBaseUri: 'https://cdn.mons.shop/111k-sepolia/v15/' };
  let rows: Record<string, unknown>[] = [];
  const f = fixture(t, () => rows);
  const cache = '.cache/111k-metadata/v16';
  f.write(`${cache}/upload-sepolia-historical.json`, { network: 'sepolia', bucket: 'cdn-mons-shop', prefix: '111k-sepolia/v15/' });
  const complete = await f.run(true);
  assert.deepEqual(complete.preservedShared, [cache]);
  const plan = fs.readFileSync(complete.planPath);
  rows = [retiredRow(historical)];
  await assert.rejects(f.run(true), /Additional retired artifacts remain/);
  assert.deepEqual(fs.readFileSync(complete.planPath), plan);
  assert.ok(fs.existsSync(path.join(f.repositoryRoot, cache, '1.json')));
});

test('a replacement that starts using a planned cache blocks deletion before any file is removed', async t => {
  const f = fixture(t);
  await f.run();
  f.write('.cache/111k-v17-release/reveal-manifest.json', { ...current, publicationDirectory: '../111k-metadata/v16' });
  await assert.rejects(f.run(true), /Replacement still requires an old metadata cache/);
  assert.ok(fs.existsSync(path.join(f.repositoryRoot, '.cache/111k-metadata/v16/1.json')));
  assert.ok(fs.existsSync(path.join(f.repositoryRoot, 'releases/111k-sepolia-v16/deployment.json')));
});

test('both supported runtime defaults must move to the replacement namespace before artifact planning', async t => {
  const f = fixture(t);
  const config = (uri: string) => `export const baseURI = input.metadataBaseUri || '${uri}';`;
  const local = (uri: string) => `return vm.envOr("ETHEREUM_111K_METADATA_BASE_URI", "${uri}");`;
  f.write('shared/ethereum/config.ts', config(old.metadataBaseUri));
  f.write('onchain/ethereum/script/Deploy111K.s.sol', local(old.metadataBaseUri));
  await assert.rejects(f.run(), /still required by shared\/ethereum\/config.ts|still required by onchain\/ethereum\/script\/Deploy111K.s.sol/);
  f.write('shared/ethereum/config.ts', config(current.metadataBaseUri));
  await assert.rejects(f.run(), /still required by onchain\/ethereum\/script\/Deploy111K.s.sol/);
  f.write('onchain/ethereum/script/Deploy111K.s.sol', local('https://cdn.mons.shop/111k-sepolia/unrelated/'));
  await assert.rejects(f.run(), /supported metadata default.*Deploy111K.s.sol/);
  f.write('onchain/ethereum/script/Deploy111K.s.sol', local(current.metadataBaseUri));
  f.write('tests/historical.ts', config(old.metadataBaseUri));
  f.write('shared/ethereum/__tests__/historical.ts', config(old.metadataBaseUri));
  f.write('shared/migrations/history.ts', config(old.metadataBaseUri));
  f.write('scripts/docs/history.md', old.metadataBaseUri);
  f.write('releases/retained-history/evidence.json', { metadataBaseUri: old.metadataBaseUri });
  assert.equal((await f.run()).planned, true);
  assert.ok(fs.existsSync(path.join(f.repositoryRoot, 'releases/111k-sepolia-v16/deployment.json')));
});

test('namespace dependency matching is exact and ignores comment-only references', () => {
  const root = 'https://cdn.mons.shop/111k-sepolia/';
  assert.equal(uses111kMetadataNamespace(`const uri = '${current.metadataBaseUri}';`, root), false);
  assert.equal(uses111kMetadataNamespace(`const uri = '${root}';`, root), true);
  assert.equal(uses111kMetadataNamespace(`const uri = '${current.metadataBaseUri}';`, old.metadataBaseUri), false);
  assert.equal(uses111kMetadataNamespace(`const uri = \`${old.metadataBaseUri}\`;`, old.metadataBaseUri), true);
  assert.equal(uses111kMetadataNamespace(`// '${old.metadataBaseUri}'\n/* "${old.metadataBaseUri}" */\nconst uri = '${current.metadataBaseUri}';`, old.metadataBaseUri), false);
});
