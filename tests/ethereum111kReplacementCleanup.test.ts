import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { metadataIdentities, sha256 } from '../scripts/ethereum-metadata/catalog.ts';
import { parse111kReplacementCleanupArgs } from '../scripts/ops/cleanupEthereum111k.ts';
import { execute111kReplacementCleanup, run111kReplacementCleanup, parseReplacementRelease, replacementCleanupPolicy, validateReplacementSnapshot,
  verify111kReplacementTransactions,
  type ReplacementCleanupDependencies, type ReplacementCleanupJournal, type ReplacementDeployment, type ReplacementRelease,
  type ReplacementSnapshot } from '../scripts/shared/ethereum111kReplacementCleanup.ts';
import { deleteCleanupPrefix as deleteScopedPrefix, type CleanupObject, type CleanupStorage } from '../scripts/shared/ethereum111kCleanupStorage.ts';
import { PublicMetadataHashMismatch, read111kReplacementPublicSamples } from '../scripts/shared/ethereum111kReplacementPublicVerification.ts';
import type { EthereumRevealReplacementInspection, EthereumRevealRetirementResult } from '../shared/ethereum/revealMaintenance.ts';

const CDN = 'https://cdn.mons.shop/';
const ROOT = '111k-sepolia/';
const FILES = [...metadataIdentities()].map(identity => identity.file).sort();
const NEW_ADDRESS = `0x${'ab'.repeat(20)}`;
const OLD_ADDRESS = `0x${'cd'.repeat(20)}`;
const OLD_PREFIX = `${ROOT}v98/`;
const NEW_PREFIX = `${ROOT}v99/`;
const CURRENT_KEYS = FILES.map(file => `${NEW_PREFIX}${file}`);
const HASH = 'a'.repeat(64);
const ETAG = `"${'b'.repeat(32)}"`;
const mediaAvailable = async () => {};
const object = (key: string): CleanupObject => ({ key, bytes: 1, etag: ETAG });
const release = (): ReplacementRelease => ({ releaseDirectory: '/private/new-release', manifestSha256: HASH,
  chainId: 11155111, deploymentId: 'v99', contractAddress: NEW_ADDRESS, previousContract: OLD_ADDRESS,
  metadataBaseUri: `${CDN}${NEW_PREFIX}`, deploymentBlock: 12345, deploymentTransactionHash: `0x${'1'.repeat(64)}`,
  artifactSha256: HASH, standardInputSha256: HASH });
const scope = (current: boolean): ReplacementDeployment => ({ deploymentId: current ? 'v99' : 'v98', chainId: 11155111,
  contractAddress: current ? NEW_ADDRESS : OLD_ADDRESS, metadataBaseUri: `${CDN}${current ? NEW_PREFIX : OLD_PREFIX}`,
  deploymentBlock: current ? 12345 : 12000, catalogVersion: '111k-v5', revision: current ? 3 : 4,
  state: current ? 'active' : 'paused', retiredAtMs: null, replacementDeploymentId: null });
const rpcIdentity = (value: ReplacementDeployment) => ({ deploymentId: value.deploymentId, chainId: value.chainId,
  contractAddress: value.contractAddress, metadataBaseUri: value.metadataBaseUri, revision: value.revision });

function fixture() {
  const snapshot: ReplacementSnapshot = { oldDeployment: scope(false), newDeployment: scope(true), commerceRevision: 52 };
  const objects = new Map([1, 2].map(id => [`${OLD_PREFIX}${id}.json`, object(`${OLD_PREFIX}${id}.json`)]));
  const calls: string[] = [];
  const waits: number[] = [];
  let journal: ReplacementCleanupJournal | null = null;
  let now = 1_000_000;
  let retired = false, purged = false, leaseExists = true, artifactsComplete = false;
  let failRetirementOnce = false, partialDeleteOnce = false, failArtifacts = false, recreate = false, recreateArtifacts = false,
    corruptNew = false, wrongBaseline = false;
  let chainReady = true, replacementReady = true;
  let currentKeys = CURRENT_KEYS;
  let retireTransitions = 0;
  let currentInventoryScans = 0;
  const baseline: EthereumRevealReplacementInspection = { ...rpcIdentity(snapshot.newDeployment), ready: true, frozenThroughMs: now - 1,
    frozenArtworks: 1, frozenMetadataSha256: HASH, frozenSamples: [{ tokenId: '87', metadataSha256: sha256(`${NEW_PREFIX}87.json`) }] };
  const storage: CleanupStorage = {
    async list(prefix, cursor, startAfter) {
      if (prefix === NEW_PREFIX && cursor === undefined && startAfter === undefined) currentInventoryScans++;
      const all = prefix === NEW_PREFIX ? currentKeys
        : [...objects.keys()].sort().filter(key => key.startsWith(prefix) && !key.slice(prefix.length).includes('/'));
      const filtered = startAfter ? all.filter(key => key > startAfter) : all;
      const start = Number(cursor ?? 0), end = Math.min(start + 1000, filtered.length);
      return { objects: filtered.slice(start, end).map(key => prefix === NEW_PREFIX ? object(key) : objects.get(key)!),
        prefixes: [], cursor: end < filtered.length ? String(end) : undefined };
    },
    async get(key) { assert(key.startsWith(NEW_PREFIX)); return Buffer.from(corruptNew ? `corrupt:${key}` : key); },
    async delete(keys) {
      calls.push('delete');
      assert(retired && purged);
      assert(now >= snapshot.oldDeployment.retiredAtMs! + 65000);
      assert(journal?.deletionInventory, 'Deletion inventory must be durably sealed before the first delete');
      assert(journal.deletionStartedAtMs, 'Deletion start must be journaled before dispatch');
      assert(keys.every(key => key.startsWith(OLD_PREFIX) && !key.startsWith(NEW_PREFIX)));
      if (partialDeleteOnce) {
        partialDeleteOnce = false;
        objects.delete(keys[0]);
        return { deleted: [keys[0]], errors: keys.slice(1).map(key => ({ key, code: 'failed' })) };
      }
      keys.forEach(key => objects.delete(key));
      return { deleted: keys, errors: [] };
    }, close() { calls.push('close'); },
  };
  const deps: ReplacementCleanupDependencies = {
    readRelease: async () => release(), snapshot: async () => structuredClone(snapshot),
    async verifyChain() { calls.push('chain'); if (!chainReady) throw new Error('Old onchain sale is still open'); },
    async publicSamples(deployment, sampleHashes) {
      calls.push('public-samples');
      assert.equal(deployment.contractAddress, NEW_ADDRESS);
      assert.equal(sampleHashes['87.json'], baseline.frozenSamples[0]?.metadataSha256);
      return mediaAvailable;
    },
    storage: async policy => { assert.equal(policy.mayDeletePrefix(NEW_PREFIX), false); assert.equal(policy.mayDeletePrefix(OLD_PREFIX), true); return storage; },
    maintenance: async work => work({
      async inspectReplacement(request) {
        calls.push('inspect-new');
        assert.equal(request.deploymentId, 'v99');
        assert.equal(request.expectedRevision, snapshot.newDeployment.revision);
        if (!replacementReady) throw new Error('Replacement reveal deployment is unhealthy');
        if (request.frozenThroughMs !== undefined) assert.equal(request.frozenThroughMs, baseline.frozenThroughMs);
        return { ...baseline, revision: snapshot.newDeployment.revision,
          frozenMetadataSha256: wrongBaseline ? 'f'.repeat(64) : baseline.frozenMetadataSha256 };
      },
      async retireForReplacement(request) {
        calls.push('retire');
        assert.equal(request.deploymentId, 'v98');
        assert.equal(request.expectedRevision, snapshot.oldDeployment.revision - (retired ? 1 : 0));
        assert.equal(request.replacementDeploymentId, 'v99'); assert.equal(request.expectedReplacementRevision, 3);
        if (!retired) {
          retired = true; retireTransitions++;
          snapshot.oldDeployment = { ...snapshot.oldDeployment, revision: snapshot.oldDeployment.revision + 1,
            retiredAtMs: now, replacementDeploymentId: 'v99' };
        }
        if (failRetirementOnce) { failRetirementOnce = false; throw new Error('retirement response lost'); }
        return { ...rpcIdentity(snapshot.oldDeployment), retiredAtMs: snapshot.oldDeployment.retiredAtMs!,
          replacementDeploymentId: 'v99', replacementRevision: 3, quiesced: true } satisfies EthereumRevealRetirementResult;
      },
      async cancelRetirement(request) {
        calls.push('cancel');
        assert.equal(request.deploymentId, 'v98');
        if (!retired) snapshot.oldDeployment.revision++;
        return { deploymentId: 'v98', replacementDeploymentId: 'v99', revision: snapshot.oldDeployment.revision,
          cancelled: !retired, retired };
      },
      async purgeRetired(request) {
        calls.push('purge');
        assert(retired && now >= snapshot.oldDeployment.retiredAtMs! + 65000);
        assert.equal(request.expectedRevision, snapshot.oldDeployment.revision);
        purged = true;
        return { ...rpcIdentity(snapshot.oldDeployment), purged: true, storageEmpty: true, alarmCleared: true };
      },
      async inspectRetired(request) {
        calls.push('inspect-old'); assert.equal(request.expectedRevision, snapshot.oldDeployment.revision);
        return { ...rpcIdentity(snapshot.oldDeployment), storageEmpty: purged, alarmCleared: purged };
      },
    }),
    async artifacts(context) {
      calls.push(context.write ? 'artifacts-write' : 'artifacts-plan');
      assert.equal(context.oldDeployment.contractAddress, OLD_ADDRESS);
      assert.equal(context.newDeployment.contractAddress, NEW_ADDRESS);
      if (context.write) { assert.equal(objects.size, 0); assert(purged); if (failArtifacts) throw new Error('artifact removal failed'); artifactsComplete = true; }
      return { planPath: '/private/new-release/cleanup-artifacts.json', planSha256: HASH, complete: artifactsComplete };
    },
    async oldLease(deployment, write, requireAbsent) {
      assert.equal(deployment.contractAddress, OLD_ADDRESS);
      if (write) { calls.push('lease-delete'); leaseExists = false; }
      if (requireAbsent) assert.equal(leaseExists, false);
    },
    loadJournal: async () => structuredClone(journal),
    async saveJournal(_path, value) { journal = structuredClone(value); },
    async clearJournal() { calls.push('clear-journal'); journal = null; },
    now: () => now,
    async wait(ms) {
      assert(ms > 0 && ms <= 30000);
      waits.push(ms); now += ms;
      if (recreate && journal?.metadataDeletedAtMs) objects.set(`${OLD_PREFIX}3.json`, object(`${OLD_PREFIX}3.json`));
      if (recreateArtifacts && journal?.artifacts.report?.complete) artifactsComplete = false;
    }, progress() {},
  };
  return { deps, snapshot, objects, calls, waits, baseline, journal: () => journal!, transitions: () => retireTransitions,
    currentInventoryScans: () => currentInventoryScans,
    run: (write = true) => execute111kReplacementCleanup({ releaseDirectory: release().releaseDirectory, write }, deps),
    failRetirementOnce: () => { failRetirementOnce = true; }, partialDeleteOnce: () => { partialDeleteOnce = true; },
    failArtifacts: (value = true) => { failArtifacts = value; }, recreate: () => { recreate = true; },
    recreateArtifacts: () => { recreateArtifacts = true; },
    corruptNew: () => { corruptNew = true; }, wrongBaseline: () => { wrongBaseline = true; },
    replacementUnhealthy: () => { replacementReady = false; },
    chainUnavailable: () => { chainReady = false; }, omitCurrent: (file: string) => { currentKeys = CURRENT_KEYS.filter(key => key !== `${NEW_PREFIX}${file}`); } };
}

test('finalize CLI is explicit and defaults to a read-only plan', () => {
  assert.equal(parse111kReplacementCleanupArgs(['finalize', '--release-directory', '/private/release']).write, false);
  assert.equal(parse111kReplacementCleanupArgs(['finalize', '--release-directory', '/private/release', '--write']).write, true);
  assert.deepEqual(parse111kReplacementCleanupArgs(['cancel', '--release-directory', '/private/release']),
    { releaseDirectory: '/private/release', write: false, cancel: true });
  for (const argv of [[], ['finalize'], ['finalize', '--manifest', '/x'], ['finalize', '--release-directory', '/x', '--release-directory', '/y']]) {
    assert.throws(() => parse111kReplacementCleanupArgs(argv));
  }
});

test('cancellation is read-only by default and an uncommitted fence can be cancelled while replacement health is unavailable', async () => {
  const f = fixture();
  await f.run(false);
  f.chainUnavailable();
  const before = f.calls.length;
  const options = { releaseDirectory: release().releaseDirectory, cancel: true };
  assert.equal((await execute111kReplacementCleanup(options, f.deps)).planned, true);
  assert.deepEqual(f.calls.slice(before), []);
  const result = await execute111kReplacementCleanup({ ...options, write: true }, f.deps);
  assert.equal(result.cancelled, true);
  assert.equal(result.retired, false);
  assert.equal(result.journalRetained, false);
  assert.deepEqual(f.calls.slice(before), ['cancel', 'clear-journal']);
  assert.equal(f.journal(), null);
  assert.equal(f.objects.size, 2);
});

test('a cancelled unstarted cleanup replans with the new revision', async () => {
  const f = fixture();
  await f.run(false);
  await execute111kReplacementCleanup({ releaseDirectory: release().releaseDirectory, cancel: true, write: true }, f.deps);
  await f.run(false);
  assert.equal(f.journal().oldDeployment.revision, 5);
  assert.equal((await f.run()).complete, true);
  assert.equal(f.journal().retirement?.revision, 6);
});

test('cancellation preserves the journal when retirement won the race', async () => {
  const f = fixture();
  f.failRetirementOnce();
  await assert.rejects(f.run(), /response lost/);
  const before = structuredClone(f.journal());
  const result = await execute111kReplacementCleanup({ releaseDirectory: release().releaseDirectory, cancel: true, write: true }, f.deps);
  assert.equal(result.retired, true);
  assert.equal(result.cancelled, false);
  assert.equal(result.journalRetained, true);
  assert.deepEqual(f.journal(), before);
  assert.equal(f.calls.includes('clear-journal'), false);
  assert.equal((await f.run()).complete, true);
  await assert.rejects(execute111kReplacementCleanup({ releaseDirectory: release().releaseDirectory, cancel: true, write: true }, f.deps), /already committed/);
});

test('planning canonicalizes release roots and cannot follow a pre-existing journal temporary symlink', async t => {
  const directory = mkdtempSync(join(tmpdir(), '111k-cleanup-journal-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const canonical = realpathSync(directory);
  const evidence = join(directory, 'transactions.private.json');
  writeFileSync(evidence, 'preserve signed release evidence');
  symlinkSync(evidence, join(directory, 'cleanup-finalization.json.tmp'));
  const f = fixture();
  const overrides: Partial<ReplacementCleanupDependencies> = { ...f.deps,
    readRelease: async location => {
      assert.equal(location, canonical);
      return { ...release(), releaseDirectory: location };
    } };
  delete overrides.saveJournal;
  const result = await run111kReplacementCleanup({ releaseDirectory: directory, write: false }, overrides);
  assert.equal(result.planned, true);
  assert.equal(readFileSync(evidence, 'utf8'), 'preserve signed release evidence');
  const journal = JSON.parse(readFileSync(join(directory, 'cleanup-finalization.json'), 'utf8'));
  assert.equal(journal.release.releaseDirectory, canonical);
  assert.equal(readdirSync(directory).some(name => /^cleanup-finalization\.json\.[a-f0-9-]+\.tmp$/.test(name)), false);
  assert.equal(f.calls.includes('retire'), false);
});

test('frozen release identity is bound to the signed deployment and exact creation block', () => {
  const manifest = { version: 1, network: 'sepolia', chainId: 11155111, deploymentId: 'v99', contractAddress: NEW_ADDRESS,
    previousContract: OLD_ADDRESS, metadataBaseURI: `${CDN}${NEW_PREFIX}`, artifactSha256: HASH, standardInputSha256: HASH };
  const manifestSha256 = sha256(`${JSON.stringify(manifest, null, 2)}\n`);
  const deployed = { ...manifest, deploymentBlock: 12345, transactionHash: `0x${'1'.repeat(64)}`, manifestSha256 };
  const signed = { manifestSha256, actions: { deploy: { hash: deployed.transactionHash,
    receipt: { status: '0x1', blockNumber: '0x3039', contractAddress: NEW_ADDRESS } } } };
  assert.equal(parseReplacementRelease('/private/new', manifest, deployed, signed).previousContract, OLD_ADDRESS);
  for (const changed of [{ ...deployed, deploymentBlock: 12344 }, { ...deployed, contractAddress: OLD_ADDRESS },
    { ...deployed, manifestSha256: 'b'.repeat(64) }]) assert.throws(() => parseReplacementRelease('/private/new', manifest, changed, signed), /evidence/);
  assert.throws(() => parseReplacementRelease('/private/new', { ...manifest, previousContract: NEW_ADDRESS }, deployed, signed), /frozen/);
});

function signedVerifierFixture() {
  const manifest = { deployer: `0x${'12'.repeat(20)}`, owner: `0x${'12'.repeat(20)}`, quoteSigner: `0x${'34'.repeat(20)}`,
    previousContract: OLD_ADDRESS, constructorArgs: '0x1234', creationCode: '0x5678' };
  const frozen = { ...release(), manifestSha256: sha256(`${JSON.stringify(manifest, null, 2)}\n`) };
  const verified = { verified: true, chainId: frozen.chainId, contractAddress: frozen.contractAddress,
    deploymentId: frozen.deploymentId, metadataBaseURI: frozen.metadataBaseUri,
    transactions: [{ action: 'deploy', hash: frozen.deploymentTransactionHash, blockNumber: frozen.deploymentBlock }], state: { saleActive: true } };
  return { manifest, frozen, verified };
}

test('chain verification delegates frozen transactions and constructor checks to read-only deployment verify', async () => {
  const f = signedVerifierFixture();
  const calls: string[] = [];
  await verify111kReplacementTransactions(f.frozen, async method => { calls.push(method); return '0xaa36a7'; }, {
    readManifest: async () => f.manifest,
    verify: async (argv, overrides) => {
      assert.deepEqual(argv, ['verify', '--directory', f.frozen.releaseDirectory, '--network', 'sepolia', '--deployment-id', 'v99']);
      assert.deepEqual(overrides.configuration, { chainId: 11155111, deployer: f.manifest.deployer,
        owner: f.manifest.owner, quoteSigner: f.manifest.quoteSigner, previousContract: OLD_ADDRESS });
      assert.equal(await overrides.rpc('eth_chainId'), '0xaa36a7');
      assert.throws(() => overrides.rpc('eth_sendRawTransaction', ['0x1234']), /cannot submit/);
      return f.verified;
    },
  });
  assert.deepEqual(calls, ['eth_chainId']);
  await assert.rejects(verify111kReplacementTransactions(f.frozen, async () => null, {
    readManifest: async () => f.manifest, verify: async () => ({ ...f.verified, transactions: [] }),
  }), /not verified/);
});

test('a tampered actual deployment transaction fails before artifact planning or retirement', async () => {
  const fixtureState = fixture(), signed = signedVerifierFixture();
  fixtureState.deps.readRelease = async () => signed.frozen;
  fixtureState.deps.verifyChain = async frozen => verify111kReplacementTransactions(frozen, async () => null, {
    readManifest: async () => signed.manifest,
    verify: async () => { throw new Error('Confirmed transaction calldata differs from frozen creation code'); },
  });
  await assert.rejects(fixtureState.run(), /calldata differs/);
  assert.equal(fixtureState.calls.includes('artifacts-plan'), false);
  assert.equal(fixtureState.calls.includes('retire'), false);
  assert.equal(fixtureState.calls.includes('delete'), false);
});

test('frozen constructor changes are rejected before calling the chain verifier', async () => {
  const f = signedVerifierFixture();
  let invoked = false;
  await assert.rejects(verify111kReplacementTransactions(f.frozen, async () => null, {
    readManifest: async () => ({ ...f.manifest, constructorArgs: '0xffff' }),
    verify: async () => { invoked = true; return f.verified; },
  }), /constructor evidence changed/);
  assert.equal(invoked, false);
});

test('new plan derives the replacement and full model coverage without fixed v16 or fixed first-twenty artwork samples', async () => {
  const f = fixture();
  const result = await f.run(false);
  assert.equal(result.planned, true); assert.equal(result.complete, false);
  assert.equal(result.newObjectCount, FILES.length);
  assert.equal(f.journal().version, 2);
  assert.equal(f.journal().newDeployment.deploymentId, 'v99');
  assert.equal(f.journal().oldDeployment.catalogVersion, f.journal().newDeployment.catalogVersion);
  assert.equal(f.journal().metadataSamples['87.json'], sha256(`${NEW_PREFIX}87.json`));
  assert.equal(f.journal().metadataSamples['1.json'], undefined);
  assert.equal(f.objects.size, 2);
  assert.equal(f.calls.includes('retire'), false); assert.equal(f.calls.includes('delete'), false);
  assert.equal(f.calls.includes('artifacts-write'), false);
});

test('same-catalog retirement drains, purges only old scope, cleans artifacts, and observes five minutes before completion', async () => {
  const f = fixture();
  const result = await f.run();
  assert.equal(result.complete, true);
  assert.equal(f.objects.size, 0);
  assert.equal(f.transitions(), 1);
  assert.equal(f.journal().retirement?.revision, 5);
  assert.equal(f.journal().oldDeployment.revision, 4);
  assert.equal(f.journal().newDeployment.revision, 3);
  assert(f.journal().verifiedAtMs! - f.journal().metadataDeletedAtMs! >= 300000);
  assert.equal(f.waits.reduce((sum, ms) => sum + ms, 0), 365000);
  assert(f.calls.indexOf('purge') < f.calls.indexOf('delete'));
  assert(f.calls.indexOf('artifacts-plan') < f.calls.indexOf('retire'));
  assert(f.calls.indexOf('artifacts-write') > f.calls.indexOf('delete'));
  assert.equal(f.currentInventoryScans(), 2, 'The final scheduler audit rechecks frozen samples and scope without a third full new-prefix scan');
});

test('lost retirement responses replay the original revision idempotently', async () => {
  const f = fixture(); f.failRetirementOnce();
  await assert.rejects(f.run(), /retirement response lost/);
  assert.equal(f.journal().retirement, undefined);
  assert.equal(f.snapshot.oldDeployment.revision, 5);
  assert.equal(f.calls.includes('delete'), false);
  assert.equal((await f.run()).complete, true);
  assert.equal(f.transitions(), 1);
});

for (const timing of ['writer drain', 'post-drain CDN verification']) test(`a replacement conflict during ${timing} blocks purge`, async () => {
  const f = fixture();
  if (timing === 'writer drain') {
    const wait = f.deps.wait;
    f.deps.wait = async ms => { await wait(ms); f.replacementUnhealthy(); };
  } else {
    const publicSamples = f.deps.publicSamples;
    f.deps.publicSamples = async (...args) => {
      const media = await publicSamples(...args);
      if (f.journal()?.retirement) f.replacementUnhealthy();
      return media;
    };
  }
  await assert.rejects(f.run(), /deployment is unhealthy/);
  assert.ok(f.journal().retirement);
  assert.equal(f.calls.includes('purge'), false);
  assert.equal(f.objects.size, 2);
});

for (const resumed of [false, true]) test(`recheck sampled bytes immediately before deleting old metadata (resume=${resumed})`, async () => {
  const f = fixture();
  if (resumed) {
    f.partialDeleteOnce();
    await assert.rejects(f.run(), /incomplete/);
    const publicSamples = f.deps.publicSamples;
    f.deps.publicSamples = async (deployment, hashes) => {
      const media = await publicSamples(deployment, hashes);
      f.corruptNew();
      return media;
    };
  } else {
    const save = f.deps.saveJournal;
    f.deps.saveJournal = async (path, journal) => { await save(path, journal); if (journal.deletionInventory) f.corruptNew(); };
  }
  const remaining = f.objects.size;
  await assert.rejects(f.run(), /not published correctly/);
  assert.ok(f.journal().purge);
  assert.equal(f.objects.size, remaining);
});

test('finishing old publications may grow discovery metadata before retirement is sealed, including after a lost reply', async () => {
  const f = fixture(); f.failRetirementOnce();
  await assert.rejects(f.run(), /retirement response lost/);
  assert.equal(f.journal().oldInventory.objectCount, 2);
  assert.equal(f.journal().oldInventory.totalBytes, 2);
  assert.equal(f.journal().deletionInventory, undefined);
  f.objects.set(`${OLD_PREFIX}1.json`, { ...object(`${OLD_PREFIX}1.json`), bytes: 8000, etag: `"${'d'.repeat(32)}"` });
  f.objects.set(`${OLD_PREFIX}3.json`, { ...object(`${OLD_PREFIX}3.json`), bytes: 15000 });
  const result = await f.run();
  assert.equal(result.complete, true);
  assert.equal(result.deletedObjects, 3);
  assert.equal(f.journal().oldInventory.objectCount, 2);
  assert.equal(f.journal().deletionInventory?.objectCount, 3);
  assert.equal(f.journal().deletionInventory?.totalBytes, 23001);
  assert.equal(f.objects.size, 0);
  assert.equal(f.transitions(), 1);
});

test('no delete starts without a durable seal/start checkpoint, and pre-delete seal drift fails closed', async () => {
  const f = fixture();
  const save = f.deps.saveJournal;
  f.deps.saveJournal = async (path, journal) => {
    if (journal.deletionStartedAtMs) throw new Error('Deletion start checkpoint unavailable');
    await save(path, journal);
  };
  await assert.rejects(f.run(), /checkpoint unavailable/);
  assert(f.journal().deletionInventory);
  assert.equal(f.journal().deletionStartedAtMs, undefined);
  assert.equal(f.calls.includes('delete'), false);
  f.deps.saveJournal = save;
  f.objects.set(`${OLD_PREFIX}1.json`, { ...object(`${OLD_PREFIX}1.json`), etag: `"${'d'.repeat(32)}"` });
  await assert.rejects(f.run(), /after sealing/);
  assert.equal(f.calls.includes('delete'), false);
});

test('growth after a partial sealed deletion is rejected on resume', async () => {
  const f = fixture(); f.partialDeleteOnce();
  await assert.rejects(f.run(), /incomplete/);
  assert.equal(f.journal().deletionInventory?.objectCount, 2);
  f.objects.set(`${OLD_PREFIX}2.json`, { ...object(`${OLD_PREFIX}2.json`), bytes: 8000 });
  const calls = f.calls.filter(call => call === 'delete').length;
  await assert.rejects(f.run(), /after sealing/);
  assert.equal(f.calls.filter(call => call === 'delete').length, calls);
});

test('partial R2 failure resumes without re-retiring or re-purging completed storage', async () => {
  const f = fixture(); f.partialDeleteOnce();
  await assert.rejects(f.run(), /incomplete/);
  assert.equal(f.objects.size, 1);
  assert.equal(f.journal().metadataDeletedAtMs, undefined);
  assert.equal(f.journal().complete, undefined);
  assert.equal((await f.run()).complete, true);
  assert.equal(f.calls.filter(call => call === 'retire').length, 1);
  assert.equal(f.calls.filter(call => call === 'purge').length, 1);
  assert.equal(f.journal().recovery, undefined);
});

for (const controls of ['commerce', 'registry', 'both'] as const) {
  test(`committed cleanup resumes after replacement ${controls} pause and resume without rewriting original evidence`, async () => {
    const f = fixture(); f.partialDeleteOnce();
    await assert.rejects(f.run(), /incomplete/);
    const original = structuredClone(f.journal());
    if (controls !== 'registry') f.snapshot.commerceRevision += 2;
    if (controls !== 'commerce') f.snapshot.newDeployment.revision += 2;
    const save = f.deps.saveJournal;
    let checkpointSaved = false;
    f.deps.saveJournal = async (path, journal) => {
      await save(path, journal);
      if (journal.recovery) {
        checkpointSaved = true;
        assert(f.currentInventoryScans() >= 2);
        assert.equal(journal.recovery.replacementRevision, f.snapshot.newDeployment.revision);
        assert.equal(journal.recovery.commerceRevision, f.snapshot.commerceRevision);
        assert.equal(journal.recovery.retiredAtMs, original.retirement!.retiredAtMs);
      }
    };
    const createStorage = f.deps.storage;
    f.deps.storage = async policy => {
      const storage = await createStorage(policy);
      return { ...storage, async delete(keys) { assert(checkpointSaved); return storage.delete(keys); } };
    };
    assert.equal((await f.run()).complete, true);
    for (const key of ['oldDeployment', 'newDeployment', 'commerceRevision', 'retirement', 'replacementBaseline',
      'release', 'model', 'oldInventory', 'metadataSamples', 'deletionInventory', 'deletionStartedAtMs'] as const) {
      assert.deepEqual(f.journal()[key], original[key], key);
    }
    assert.equal(f.transitions(), 1);
    assert.equal(f.calls.filter(call => call === 'retire').length, 1);
    assert.equal(f.calls.filter(call => call === 'purge').length, 1);
  });
}

test('a lost retirement response replays its original request after replacement revision changes', async () => {
  const f = fixture(); f.failRetirementOnce();
  await assert.rejects(f.run(), /response lost/);
  const original = structuredClone(f.journal());
  f.snapshot.newDeployment.revision += 2;
  f.snapshot.commerceRevision += 2;
  const maintenance = f.deps.maintenance;
  f.deps.maintenance = async work => maintenance(transport => work({ ...transport,
    async retireForReplacement(request) {
      assert.equal(f.journal().recovery?.replacementRevision, 5);
      assert.equal(f.journal().recovery?.commerceRevision, 54);
      assert.equal(request.expectedReplacementRevision, original.newDeployment.revision);
      return transport.retireForReplacement!(request);
    } }));
  assert.equal((await f.run()).complete, true);
  assert.equal(f.transitions(), 1);
  assert.equal(f.journal().retirement!.replacementRevision, 3);
  assert.equal(f.journal().retirement!.revision, original.oldDeployment.revision + 1);
  assert.deepEqual(f.journal().oldDeployment, original.oldDeployment);
  assert.deepEqual(f.journal().newDeployment, original.newDeployment);
  assert.deepEqual(f.journal().replacementBaseline, original.replacementBaseline);
  assert.equal(f.journal().commerceRevision, original.commerceRevision);
});

test('recovery planning leaves the checkpoint untouched and failed checkpoint persistence blocks further writes', async () => {
  const f = fixture(); f.partialDeleteOnce();
  await assert.rejects(f.run(), /incomplete/);
  const original = structuredClone(f.journal());
  f.snapshot.newDeployment.revision += 2;
  f.snapshot.commerceRevision += 2;
  const writes = () => f.calls.filter(call => ['retire', 'purge', 'delete', 'lease-delete', 'artifacts-write'].includes(call));
  const before = writes();
  assert.equal((await f.run(false)).planned, true);
  assert.deepEqual(f.journal(), original);
  const save = f.deps.saveJournal;
  f.deps.saveJournal = async (path, journal) => {
    if (journal.recovery) throw new Error('Recovery checkpoint unavailable');
    await save(path, journal);
  };
  await assert.rejects(f.run(), /Recovery checkpoint unavailable/);
  assert.deepEqual(f.journal(), original);
  assert.deepEqual(writes(), before);
  f.deps.saveJournal = save;
  assert.equal((await f.run()).complete, true);
});

for (const invalid of ['marker-time', 'marker-target', 'marker-revision', 'marker-removed', 'wrong-scope', 'registry-backward',
  'commerce-backward', 'paused', 'unhealthy', 'frozen-baseline', 'metadata-coverage', 'chain'] as const) {
  test(`committed revision recovery rejects ${invalid} before checkpointing or deleting`, async () => {
    const f = fixture(); f.partialDeleteOnce();
    await assert.rejects(f.run(), /incomplete/);
    const original = structuredClone(f.journal());
    f.snapshot.newDeployment.revision += 2;
    f.snapshot.commerceRevision += 2;
    if (invalid === 'marker-time') f.snapshot.oldDeployment.retiredAtMs!++;
    if (invalid === 'marker-target') f.snapshot.oldDeployment.replacementDeploymentId = 'v100';
    if (invalid === 'marker-revision') f.snapshot.oldDeployment.revision++;
    if (invalid === 'marker-removed') f.snapshot.oldDeployment = structuredClone(original.oldDeployment);
    if (invalid === 'wrong-scope') f.snapshot.newDeployment.contractAddress = `0x${'12'.repeat(20)}`;
    if (invalid === 'registry-backward') f.snapshot.newDeployment.revision = 2;
    if (invalid === 'commerce-backward') f.snapshot.commerceRevision = 51;
    if (invalid === 'paused') f.snapshot.newDeployment.state = 'paused';
    if (invalid === 'unhealthy') f.replacementUnhealthy();
    if (invalid === 'frozen-baseline') f.wrongBaseline();
    if (invalid === 'metadata-coverage') f.omitCurrent('117189.json');
    if (invalid === 'chain') f.chainUnavailable();
    const before = f.calls.filter(call => ['retire', 'purge', 'delete', 'artifacts-write'].includes(call));
    await assert.rejects(f.run());
    assert.deepEqual(f.journal(), original);
    assert.deepEqual(f.calls.filter(call => ['retire', 'purge', 'delete', 'artifacts-write'].includes(call)), before);
  });
}

for (const timing of ['verification', 'after-checkpoint'] as const) {
  test(`another replacement revision change during ${timing} aborts the recovery attempt`, async () => {
    const f = fixture(); f.partialDeleteOnce();
    await assert.rejects(f.run(), /incomplete/);
    f.snapshot.newDeployment.revision += 2;
    f.snapshot.commerceRevision += 2;
    const before = f.calls.filter(call => call === 'delete').length;
    if (timing === 'verification') {
      const verify = f.deps.publicSamples;
      f.deps.publicSamples = async (deployment, samples) => {
        const media = await verify(deployment, samples);
        f.snapshot.commerceRevision += 2;
        return media;
      };
    } else {
      const save = f.deps.saveJournal;
      f.deps.saveJournal = async (path, journal) => {
        await save(path, journal);
        if (journal.recovery) f.snapshot.newDeployment.revision += 2;
      };
    }
    await assert.rejects(f.run(), /revisions changed/);
    assert.equal(f.calls.filter(call => call === 'delete').length, before);
    assert.equal(f.journal().recovery?.replacementRevision, timing === 'verification' ? undefined : 5);
  });
}

for (const control of ['registry', 'commerce'] as const) {
  test(`later recovery cannot move ${control} backward from the durable checkpoint`, async () => {
    const f = fixture(); f.partialDeleteOnce();
    await assert.rejects(f.run(), /incomplete/);
    f.snapshot.newDeployment.revision += 2;
    f.snapshot.commerceRevision += 2;
    f.failArtifacts();
    await assert.rejects(f.run(), /artifact removal failed/);
    const original = structuredClone(f.journal());
    if (control === 'registry') f.snapshot.newDeployment.revision--;
    else f.snapshot.commerceRevision--;
    await assert.rejects(f.run(), /revisions changed/);
    assert.deepEqual(f.journal(), original);
  });
}

for (const timing of ['first-public-audit', 'final-public-audit', 'final-artifacts'] as const) {
  test(`revision recovery refuses completion when controls drift during ${timing}`, async () => {
    const f = fixture(); f.partialDeleteOnce();
    await assert.rejects(f.run(), /incomplete/);
    f.snapshot.newDeployment.revision += 2;
    f.snapshot.commerceRevision += 2;
    if (timing === 'final-artifacts') {
      const artifacts = f.deps.artifacts;
      let inspections = 0;
      f.deps.artifacts = async context => {
        const result = await artifacts(context);
        if (!context.write && ++inspections === 2) f.snapshot.commerceRevision += 2;
        return result;
      };
    } else {
      const publicSamples = f.deps.publicSamples;
      let audits = 0;
      f.deps.publicSamples = async (deployment, samples) => {
        const media = await publicSamples(deployment, samples);
        if (f.journal().metadataDeletedAtMs && ++audits === (timing === 'first-public-audit' ? 1 : 2)) f.snapshot.newDeployment.revision += 2;
        return media;
      };
    }
    await assert.rejects(f.run(), /revisions changed/);
    assert.equal(f.journal().complete, undefined);
    assert.equal(f.journal().verifiedAtMs, undefined);
    assert.equal(f.journal().recovery!.replacementRevision, 5);
    assert.equal(f.journal().recovery!.commerceRevision, 54);
    if (timing === 'first-public-audit') {
      assert.equal(f.journal().backendVerifiedAtMs, undefined);
      assert.equal(f.calls.includes('artifacts-write'), false);
    } else {
      assert(f.journal().backendVerifiedAtMs);
      assert.equal(f.calls.filter(call => call === 'artifacts-write').length, 1);
    }
  });
}

test('artifact failure blocks completion and can resume after backend deletion', async () => {
  const f = fixture(); f.failArtifacts();
  await assert.rejects(f.run(), /artifact removal failed/);
  assert.equal(f.objects.size, 0);
  assert(f.journal().backendVerifiedAtMs);
  assert.equal(f.journal().complete, undefined);
  f.failArtifacts(false);
  assert.equal((await f.run()).complete, true);
  assert.equal(f.transitions(), 1);
});

test('post-cleanup recreation fails the scheduler observation audit', async () => {
  const f = fixture(); f.recreate();
  await assert.rejects(f.run(), /recreated/);
  assert.equal(f.journal().complete, undefined);
  assert.equal(f.journal().artifacts.report?.complete, true);
});

for (const timing of ['final media check', 'final artifact check']) test(`a replacement conflict during the ${timing} blocks completion`, async () => {
  const f = fixture();
  if (timing === 'final media check') {
    const publicSamples = f.deps.publicSamples;
    f.deps.publicSamples = async (...args) => {
      const media = await publicSamples(...args);
      return async () => {
        await media();
        if (f.journal()?.artifacts.report?.complete) f.replacementUnhealthy();
      };
    };
  } else {
    const artifacts = f.deps.artifacts;
    f.deps.artifacts = async context => {
      const result = await artifacts(context);
      if (!context.write && f.journal()?.artifacts.report?.complete) f.replacementUnhealthy();
      return result;
    };
  }
  await assert.rejects(f.run(), /deployment is unhealthy/);
  assert.equal(f.journal().artifacts.report?.complete, true);
  assert.equal(f.journal().complete, undefined);
});

test('local artifact recreation during the observation interval blocks final completion', async () => {
  const f = fixture(); f.recreateArtifacts();
  await assert.rejects(f.run(), /local artifacts were recreated/);
  assert.equal(f.objects.size, 0);
  assert(f.journal().backendVerifiedAtMs);
  assert.equal(f.journal().complete, undefined);
  assert.equal(f.calls.filter(call => call === 'artifacts-write').length, 1);
  assert.equal(f.calls.at(-2), 'artifacts-plan');
  assert.equal(f.calls.at(-1), 'close');
});

test('new frozen metadata or ledger changes stop resume before old deletion', async () => {
  const f = fixture(); await f.run(false); f.corruptNew();
  await assert.rejects(f.run(), /frozen metadata/);
  assert.equal(f.calls.includes('retire'), false);
  const g = fixture(); await g.run(false); g.wrongBaseline();
  await assert.rejects(g.run(), /baseline changed/);
  assert.equal(g.calls.includes('retire'), false);
});

test('resume accepts a staged revision published between R2 and CDN reads, preserves the original proof and rejects a downgrade', async () => {
  const f = fixture();
  await f.run(false);
  const original = structuredClone(f.journal());
  const file = '87.json', key = `${NEW_PREFIX}${file}`, target = 'frozen metadata with appended attributes', sha = sha256(target);
  let body = key, upgraded = false;
  const openStorage = f.deps.storage;
  f.deps.storage = async policy => {
    const storage = await openStorage(policy);
    return { ...storage, get: objectKey => objectKey === key ? Promise.resolve(Buffer.from(body)) : storage.get(objectKey) };
  };
  f.deps.publicSamples = async (_deployment, hashes) => {
    if (!upgraded) {
      upgraded = true;
      f.baseline.frozenSamples = [{ ...f.baseline.frozenSamples[0], enrichment: { version: 'v0', sha256: sha, published: false } }];
      body = target;
      throw new PublicMetadataHashMismatch({ [file]: sha });
    }
    assert.equal(hashes[file], sha);
    return mediaAvailable;
  };
  f.failRetirementOnce();
  await assert.rejects(f.run(), /retirement response lost/);
  assert.deepEqual(f.journal().replacementBaseline, original.replacementBaseline);
  assert.deepEqual(f.journal().metadataSamples, original.metadataSamples);
  assert.equal(f.journal().enrichmentCheckpoint?.metadataSamples[file], sha);
  body = key;
  await assert.rejects(f.run(), /samples changed/);
  assert.equal(f.calls.includes('delete'), false);
  body = target;
  f.baseline.frozenSamples[0].enrichment!.published = true;
  assert.equal((await f.run()).complete, true);
  assert.equal(f.journal().enrichmentCheckpoint?.frozenSamples[0].enrichment?.published, true);
  f.baseline.frozenSamples[0].enrichment!.published = false;
  await assert.rejects(f.run(), /baseline changed/);
});

test('a published enrichment requires the recorded target before the first journal is created', async () => {
  const f = fixture();
  f.baseline.frozenSamples[0].enrichment = { version: 'v0', sha256: sha256('recorded revision'), published: true };
  await assert.rejects(f.run(false), /frozen metadata/);
  assert.equal(f.journal(), null);
});

test('every enrichment observed in a concurrent CDN check fences the following R2 read', async () => {
  const f = fixture();
  const files = ['87.json', '88.json'];
  f.baseline.frozenArtworks = files.length;
  f.baseline.frozenSamples = files.map(file => ({ tokenId: file.split('.')[0], metadataSha256: sha256(NEW_PREFIX + file),
    enrichment: { version: 'v0', sha256: sha256('enriched ' + file), published: false } }));
  let verifiedCdn = false;
  const storage = f.deps.storage;
  f.deps.storage = async policy => {
    const db = await storage(policy);
    return { ...db, get: async key => verifiedCdn && key === NEW_PREFIX + files[0] ? Buffer.from('enriched ' + files[0]) : db.get(key) };
  };
  f.deps.publicSamples = async (scope, hashes) => {
    assert.equal(verifiedCdn, false, 'The second token downgraded before the next public check.');
    verifiedCdn = true;
    return read111kReplacementPublicSamples(scope, Object.fromEntries(files.map(file => [file, hashes[file]])), {
      fetch: async url => new Response('enriched ' + String(url).split('/').at(-1), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
      }),
    });
  };
  await assert.rejects(f.run(), /samples changed/);
  assert.equal(verifiedCdn, true);
  assert.equal(f.calls.includes('retire'), false);
});

for (const downgraded of [true, false]) test(`a sample refresh rechecks a published sibling before retirement (downgrade=${downgraded})`, async () => {
  const f = fixture();
  const keyA = `${NEW_PREFIX}87.json`, keyB = `${NEW_PREFIX}88.json`;
  const targetA = 'enriched A', targetB = 'enriched B';
  const a = { tokenId: '87', metadataSha256: sha256(keyA),
    enrichment: { version: 'v0' as const, sha256: sha256(targetA), published: false } };
  const b = { tokenId: '88', metadataSha256: sha256(keyB) };
  f.baseline.frozenArtworks = 2;
  f.baseline.frozenSamples = [a, b];
  let readsA = 0;
  const storage = f.deps.storage;
  f.deps.storage = async policy => {
    const db = await storage(policy);
    return { ...db, async get(key) {
      if (key === keyA) return Buffer.from(++readsA === 1 || downgraded ? keyA : targetA);
      if (key === keyB) {
        f.baseline.frozenSamples = [
          { ...a, enrichment: { ...a.enrichment, published: true } },
          { ...b, enrichment: { version: 'v0', sha256: sha256(targetB), published: true } },
        ];
        return Buffer.from(targetB);
      }
      return db.get(key);
    } };
  };
  f.deps.publicSamples = async (_scope, hashes) => {
    assert.equal(hashes['87.json'], sha256(downgraded ? keyA : targetA));
    assert.equal(hashes['88.json'], sha256(targetB));
    return mediaAvailable;
  };
  if (downgraded) {
    await assert.rejects(f.run(), /not published correctly for token 87/);
    assert.equal(f.journal(), null);
    assert.equal(f.calls.includes('retire'), false);
    assert.equal(f.calls.includes('delete'), false);
  } else {
    assert.equal((await f.run()).complete, true);
    assert.equal(f.journal().metadataSamples['87.json'], sha256(targetA));
  }
  assert.ok(readsA >= 2);
});

for (const rpcFailure of [false, true]) test(`resume checkpoints verified enrichment before later fallible checks (RPC failure=${rpcFailure})`, async () => {
  const f = fixture();
  await f.run(false);
  const original = structuredClone(f.journal());
  const file = '87.json', key = `${NEW_PREFIX}${file}`, target = 'staged attributes visible on R2 and CDN';
  f.baseline.frozenSamples = [{ ...f.baseline.frozenSamples[0], enrichment: { version: 'v0', sha256: sha256(target), published: false } }];
  let body = target;
  const storage = f.deps.storage;
  f.deps.storage = async policy => {
    const db = await storage(policy);
    return { ...db, get: objectKey => objectKey === key ? Promise.resolve(Buffer.from(body)) : db.get(objectKey) };
  };
  f.deps.publicSamples = async (_scope, hashes) => { assert.equal(hashes[file], sha256(body)); return mediaAvailable; };
  if (rpcFailure) {
    const verifyChain = f.deps.verifyChain;
    let reads = 0;
    f.deps.verifyChain = async (...args) => {
      if (++reads === 2) throw new Error('Temporary chain read failure');
      return verifyChain(...args);
    };
    await assert.rejects(f.run(), /Temporary chain read failure/);
  } else assert.equal((await f.run(false)).planned, true);
  assert.deepEqual(f.journal().metadataSamples, original.metadataSamples);
  assert.deepEqual(f.journal().replacementBaseline, original.replacementBaseline);
  assert.equal(f.journal().enrichmentCheckpoint?.metadataSamples[file], sha256(target));
  body = key;
  await assert.rejects(f.run(), /samples changed/);
  assert.equal(f.calls.includes('retire'), false);
  assert.equal(f.calls.includes('delete'), false);
});

test('missing replacement metadata and old open-chain state fail before retirement', async () => {
  const f = fixture(); f.omitCurrent('117189.json');
  await assert.rejects(f.run(), /coverage/);
  assert.equal(f.calls.includes('retire'), false);
  const g = fixture(); g.chainUnavailable();
  await assert.rejects(g.run(), /onchain sale/);
  assert.equal(g.calls.includes('artifacts-plan'), false);
});

for (const resumed of [false, true]) for (const sibling of ['unavailable', 'advanced'] as const)
  test(`an individually verified enrichment survives a sibling GET ${sibling} (resume=${resumed})`, async () => {
    const f = fixture();
    const base = JSON.stringify({ name: 'Sample', image: 'https://cdn.lil.org/nft/111k/paintings/1.png', attributes: [] });
    const target = JSON.stringify({ ...JSON.parse(base), attributes: [{ trait_type: 'collection block', value: 'Sample' }] });
    const sha = sha256(target);
    let artwork = base, fail = false;
    const storage = f.deps.storage;
    const fileName = (key: string) => key.split('/').at(-1)!;
    const body = (file: string) => file === '1.json' || file === '3.json' ? artwork : base;
    f.deps.storage = async policy => ({ ...await storage(policy), get: async key => Buffer.from(body(fileName(key))) });
    f.baseline.frozenArtworks = 3;
    f.baseline.frozenSamples = ['1', '2', '3'].map(tokenId => ({ tokenId, metadataSha256: sha256(base) }));
    const save = f.deps.saveJournal;
    let writing = false;
    f.deps.saveJournal = async (...args) => {
      assert.equal(writing, false);
      writing = true;
      await new Promise(done => setImmediate(done));
      await save(...args);
      writing = false;
    };
    f.deps.publicSamples = async (deployment, hashes, options) => read111kReplacementPublicSamples(deployment, hashes, {
      ...options, wait: async () => {}, fetch: async (url, init) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
        if (init?.method === 'HEAD') return new Response(null, { headers: { ...headers, 'Content-Type': 'image/png' } });
        const file = fileName(String(url));
        if (fail && file === '3000018.json' && sibling === 'unavailable') return new Response(null, { status: 503 });
        if (fail && file === '2.json' && sibling === 'advanced') return new Response(target, { headers });
        return new Response(body(file), { headers });
      },
    });
    if (resumed) await f.run(false);
    for (const sample of f.baseline.frozenSamples) sample.enrichment = { version: 'v0', sha256: sha, published: false };
    artwork = target;
    fail = true;
    await assert.rejects(f.run(), sibling === 'unavailable' ? /GET returned HTTP 503/ : /samples changed/);
    const progress = f.journal()?.enrichmentCheckpoint ?? f.journal();
    assert.equal(progress?.metadataSamples['1.json'], sha);
    assert.equal(progress?.metadataSamples['3.json'], sha);
    fail = false;
    artwork = base;
    await assert.rejects(f.run(), /metadata samples changed/);
    assert.equal(f.calls.includes('retire'), false);
    assert.equal(f.objects.size, 2);
    artwork = target;
    assert.equal((await f.run()).complete, true);
  });

for (const resumed of [false, true]) test(`confirmed metadata survives a failed media check (resume=${resumed})`, async () => {
  const f = fixture(), file = '87.json';
  const metadata = { name: '87', image: 'https://cdn.lil.org/nft/111k/eggs/87.png', attributes: [] };
  const base = JSON.stringify(metadata), target = JSON.stringify({ ...metadata, attributes: [{ trait_type: 'type', value: 'painting' }] });
  const targetSha = sha256(target);
  let current = base;
  const body = (key: string) => key.endsWith('/' + file) ? current : base;
  const storage = f.deps.storage;
  f.deps.storage = async policy => ({ ...await storage(policy), get: async key => Buffer.from(body(key)) });
  f.deps.publicSamples = (deployment, hashes) => read111kReplacementPublicSamples(deployment, hashes, {
    wait: async () => {},
    fetch: async (url, init) => {
      if (init?.method === 'GET') return new Response(body(String(url)), { headers: {
        'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' } });
      if (current === base) return new Response(null, { headers: { 'Content-Type': 'image/png', 'Access-Control-Allow-Origin': '*' } });
      const proof = f.journal().enrichmentCheckpoint ?? f.journal();
      assert.equal(proof.metadataSamples[file], targetSha);
      return new Response(null, { status: 503 });
    },
  });
  f.baseline.frozenSamples = [{ tokenId: '87', metadataSha256: sha256(base) }];
  if (resumed) await f.run(false);
  f.baseline.frozenSamples[0].enrichment = { version: 'v0', sha256: targetSha, published: false };
  current = target;
  await assert.rejects(f.run(), /HEAD returned HTTP 503/);
  current = base;
  await assert.rejects(f.run(), /metadata samples changed/);
  assert.equal(f.calls.includes('retire'), false);
  assert.equal(f.objects.size, 2);
});

for (const failure of ['cdn', 'media'] as const) {
  test(`a failed public replacement ${failure} check blocks retirement`, async () => {
    const f = fixture();
    const body = `${JSON.stringify({ name: 'Sample', image: 'https://cdn.lil.org/nft/111k/eggs/87.png', attributes: [] })}\n`;
    f.baseline.frozenSamples[0].metadataSha256 = sha256(body);
    const createStorage = f.deps.storage;
    f.deps.storage = async policy => ({ ...await createStorage(policy), get: async () => Buffer.from(body) });
    f.deps.publicSamples = (deployment, hashes) => read111kReplacementPublicSamples(deployment, hashes, {
      fetch: (async (_input, init) => {
        if (failure === 'cdn' || init?.method === 'HEAD') return new Response(null, { status: 404 });
        return new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' } });
      }) as typeof fetch,
    });
    await assert.rejects(f.run(), /verification failed/);
    assert.equal(f.calls.includes('retire'), false);
    assert.equal(f.calls.includes('purge'), false);
    assert.equal(f.calls.includes('delete'), false);
    assert.equal(f.calls.includes('artifacts-write'), false);
  });
}

for (const boundary of ['purge', 'delete']) test(`an unavailable replacement image blocks ${boundary}`, async () => {
  const f = fixture(), read = f.deps.publicSamples;
  f.deps.publicSamples = async (...args) => {
    await read(...args);
    return async () => {
      const checkpoint = f.journal();
      if (boundary === 'purge' ? checkpoint.retirement : checkpoint.purge) throw new Error('Image unavailable.');
    };
  };
  await assert.rejects(f.run(), /Image unavailable/);
  assert.equal(f.calls.includes('purge'), boundary === 'delete');
  assert.equal(f.calls.includes('delete'), false);
  assert.equal(f.objects.size, 2);
});

test('wrong scopes, current-target deletion and control drift are rejected', async () => {
  for (const mutation of [(value: ReplacementSnapshot) => { value.oldDeployment.contractAddress = NEW_ADDRESS; },
    (value: ReplacementSnapshot) => { value.oldDeployment.state = 'active'; },
    (value: ReplacementSnapshot) => { value.newDeployment.chainId = 1; },
    (value: ReplacementSnapshot) => { value.oldDeployment.metadataBaseUri = value.newDeployment.metadataBaseUri; }]) {
    const f = fixture(); mutation(f.snapshot);
    assert.throws(() => validateReplacementSnapshot(release(), f.snapshot));
    await assert.rejects(f.run()); assert.equal(f.calls.includes('retire'), false);
  }
  const f = fixture(); await f.run(false); f.snapshot.commerceRevision++;
  await assert.rejects(f.run(), /revisions changed/);
  assert.equal(f.calls.includes('retire'), false);
});

test('legacy-root retirement remains direct-only and never reaches replacement or mainnet keys', () => {
  const snapshot = { oldDeployment: { ...scope(false), metadataBaseUri: `${CDN}${ROOT}` }, newDeployment: scope(true), commerceRevision: 1 };
  validateReplacementSnapshot(release(), snapshot);
  const policy = replacementCleanupPolicy(snapshot);
  assert.equal(policy.mayDeletePrefix(ROOT), true);
  assert.equal(policy.mayDeletePrefix(NEW_PREFIX), false);
  assert.equal(policy.allowsFile!(ROOT, '123456789.json'), true);
  assert.equal(policy.allowsFile!(ROOT, 'v99/1.json'), false);
  assert.equal(policy.allowsFile!(ROOT, '../1.json'), false);
  assert.equal(policy.hasPrefix('111k/'), false);
  assert.equal(policy.allowsNestedPrefix(ROOT, NEW_PREFIX), true);
  assert.equal(policy.allowsNestedPrefix(OLD_PREFIX, `${OLD_PREFIX}nested/`), false);
});

test('replacement deletion pipelines bounded batches and advances only after every prefetched batch settles', async () => {
  const f = fixture();
  const policy = replacementCleanupPolicy(f.snapshot);
  const objects = new Map(Array.from({ length: 10 }, (_, index) => `${OLD_PREFIX}${index + 1}.json`).sort().map(key => [key, object(key)]));
  const listCalls: Array<{ cursor?: string; startAfter?: string }> = [];
  let active = 0, maximumActive = 0, attempted = 0, failOnce = true;
  const storage: CleanupStorage = {
    async list(_prefix, cursor, startAfter) {
      listCalls.push({ cursor, startAfter });
      const after = cursor ?? startAfter;
      const keys = [...objects.keys()].sort().filter(key => after === undefined || key > after);
      return { objects: keys.slice(0, 2).map(object), prefixes: [], cursor: keys.length > 2 ? keys[1] : undefined };
    },
    async delete(keys) {
      const attempt = attempted++;
      active++; maximumActive = Math.max(maximumActive, active);
      try {
        await new Promise(done => setTimeout(done, 1));
        if (attempt === 1 && failOnce) {
          failOnce = false; objects.delete(keys[0]);
          return { deleted: [keys[0]], errors: [{ key: keys[1], code: 'InternalError' }] };
        }
        keys.forEach(key => objects.delete(key));
        return { deleted: keys, errors: [] };
      } finally { active--; }
    },
    get: async () => { throw new Error('unused'); }, close() {},
  };
  await assert.rejects(deleteScopedPrefix(policy, storage, OLD_PREFIX, 10, () => {}, undefined, { concurrency: 4 }), /incomplete/);
  assert.equal(maximumActive, 4);
  assert.equal(active, 0);
  assert.equal(attempted, 4);
  assert.equal(listCalls.length, 4);
  assert.equal(listCalls.filter(call => call.startAfter !== undefined).length, 0);
  assert.equal(objects.size, 3);
  const retryStart = listCalls.length;
  assert.equal(await deleteScopedPrefix(policy, storage, OLD_PREFIX, 3, () => {}, undefined, { concurrency: 4 }), 3);
  assert.deepEqual(listCalls[retryStart], { cursor: undefined, startAfter: undefined });
  assert.deepEqual(listCalls.at(-1), { cursor: undefined, startAfter: undefined });
  assert.equal(objects.size, 0);
});
