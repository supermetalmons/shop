import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';
import { Log, LogLevel, Miniflare, type MiniflareOptions } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';
import { buildEthereumRevealRegistration } from '../ops/ethereumRevealControl.ts';
import { ethereumSignerAddress, personalMessageHash, signDigest } from '../../shared/ethereum/crypto.ts';
import { ETHEREUM_OWNER_HATCHING_MESSAGE } from '../../shared/ethereum/ownerHatching.ts';
import { MIXED_MAINNET_BATCH_ID, type MixedAllocationMaintenanceResult } from '../../shared/ethereum/mixedAllocationMaintenance.ts';
import { getRevealCatalog } from '../../shared/ethereum/revealCatalogRegistry.ts';
import artworkTemplate from './templates/artwork.json';
import { inspectMixedAllocation } from './mixedAllocation.ts';

type Release = Awaited<ReturnType<typeof inspectMixedAllocation>>;
type Inventory = { revision: number; free: number; reserved: number; frozen: number; freeEggs: number };
type Snapshot = { inventory: Inventory; fingerprint: string; ready: number; hatched: number };
type AllocationCount = { collection: string; owner: number; future: number };
type Stage = { metadataStaged: number; generationSeeded: number; phase: string };

export async function rehearseMixedAllocation(release: Release) {
  const origin = getRevealCatalog('111k-v8');
  assert.ok(origin, 'The rehearsal requires the original mainnet v8 catalog.');
  const bindings: Record<string, unknown> = {
    'manifest.json': release.targetCatalog, 'revealCatalog.json': release.definition.target,
    'revealCatalogAncestors.json': [origin, release.predecessor],
    'ownerHatchingCatalog.json': release.ownerSupplement, 'collection-blocks.json': release.collectionBlocks
  };
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const workerName = 'local-mixed-review';
  const output = await build({
    entryPoints: [resolve(root, 'cloud/workers/api/runtime-test/mixedAllocationFixtureWorker.ts')],
    bundle: true, write: false, target: 'es2022', platform: 'neutral', format: 'esm', external: ['cloudflare:workers', 'node:*'],
    plugins: [{
      name: 'local-candidate-catalog', setup(plugin) {
        plugin.onLoad({ filter: /\/(?:111k_devnet\/manifest|revealCatalog(?:Ancestors)?|ownerHatchingCatalog|collection-blocks)\.json$/ }, args => ({
          loader: 'json', contents: JSON.stringify(bindings[basename(args.path)]),
        }));
      }
    }]
  });
  const ownerKey = `0x${'11'.repeat(32)}`;
  const options = (restart: number): MiniflareOptions => ({
    log: new Log(LogLevel.WARN), workers: [{
      config: {
        name: workerName, compatibilityDate: '2026-08-08',
        compatibilityFlags: ['nodejs_compat', 'enable_request_signal'],
        manifest: { mainModule: 'fixture.mjs', modulesRoot: root, modules: { 'fixture.mjs': { type: 'esm', contents: `${output.outputFiles[0].text}\nvoid ${restart};` } } },
        env: {
          POOL: { type: 'durable-object', worker: workerName, exportName: 'LocalMixedPool' },
          ETHEREUM_REVEAL: { type: 'durable-object', worker: workerName, exportName: 'LocalMixedPool' },
          ETHEREUM_REVEAL_PUBLISHER: { type: 'durable-object', worker: workerName, exportName: 'LocalPublisher' }, OPS_DB: { type: 'd1', name: 'local-mixed-ops' },
          ETHEREUM_REVEAL_METADATA: { type: 'r2', name: 'local-mixed-metadata' },
          DEFINITION: { type: 'text', value: JSON.stringify(release.definition) }, WALLET: { type: 'text', value: ethereumSignerAddress(ownerKey) }
        },
        exports: { LocalPublisher: { type: 'durable-object', storage: 'sqlite' }, LocalMixedPool: { type: 'durable-object', storage: 'sqlite' } },
      }
    }]
  });
  let runtimeRevision = 0;
  const runtime = new Miniflare(options(runtimeRevision));
  const request = async <T = Stage>(path: string, body: object = {}, fixture = 'full'): Promise<T> => {
    const response = await runtime.dispatchFetch(`https://fixture.test/${path}?fixture=${fixture}`, { method: 'POST', body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`${path}: ${await response.text()}`);
    return response.json() as Promise<T>;
  };
  const contractAddress = '0x08cded8258730bda384ff198001e47a1b50f7f9d';
  const restart = () => runtime.setOptions(options(++runtimeRevision));
  try {
    const db = await runtime.getD1Database('OPS_DB');
    for (const migration of ['0009_ethereum_reveal_deployments', '0011_ethereum_reveal_retirement', '0012_ethereum_reveal_catalog_updates']) {
      const sql = await readFile(resolve(root, `cloud/workers/api/ops-migrations/${migration}.sql`), 'utf8');
      await db.batch(unstable_splitSqlQuery(sql).map(statement => db.prepare(statement)));
    }
    const templateJson = JSON.stringify(artworkTemplate);
    await db.prepare(buildEthereumRevealRegistration({
      deploymentId: 'mainnet-v1', dropId: '111k', chainId: 1, contractAddress,
      metadataBaseUri: 'https://cdn.mons.shop/111k/', deploymentBlock: 26387160, catalogVersion: '111k-v8', templateJson,
      templateSha256: createHash('sha256').update(templateJson).digest('hex')
    })).run();
    await db.prepare("UPDATE ethereum_reveal_deployments SET state='active',revision=2,provisioned_at_ms=2,activated_at_ms=3,catalog_update_id='fixture-v9',catalog_update_started_at_ms=2 WHERE deployment_id='mainnet-v1'").run();
    await db.prepare('UPDATE ethereum_reveal_deployments SET revision=3,catalog_revision=1,effective_catalog_version=?,effective_catalog_sha256=?,catalog_update_id=NULL,catalog_update_started_at_ms=NULL')
      .bind(release.definition.predecessor.catalogVersion, release.definition.predecessor.manifestSha256).run();
    const registry = async () => (await runtime.getD1Database('OPS_DB')).prepare('SELECT state,revision,catalog_update_id,catalog_revision FROM ethereum_reveal_deployments').first();
    const failTransition = async (condition: string) => (await runtime.getD1Database('OPS_DB')).prepare(`CREATE TRIGGER fixture_registry_failure BEFORE UPDATE ON ethereum_reveal_deployments
      WHEN ${condition} BEGIN SELECT RAISE(ABORT,'fixture registry failure'); END`).run();
    const unlock = async () => (await runtime.getD1Database('OPS_DB')).prepare('DROP TRIGGER fixture_registry_failure').run();
    const original = await request<Inventory>('seed');
    await request('seed-metadata');
    assert.equal(original.revision, 1);
    const firstAttempt = { expectedRevision: 3 };
    assert.equal((await request<MixedAllocationMaintenanceResult>('operation/status', firstAttempt)).phase, 'unstarted');
    await db.prepare(`CREATE TRIGGER fixture_registry_failure BEFORE UPDATE ON ethereum_reveal_deployments
      WHEN NEW.catalog_update_id IS NOT NULL BEGIN
        UPDATE ethereum_reveal_deployments SET revision=revision+1 WHERE deployment_id=OLD.deployment_id;
        SELECT RAISE(IGNORE); END`).run();
    await assert.rejects(request('operation/begin', firstAttempt), /registry transition needs retry/);
    assert.deepEqual(await registry(), { state: 'active', revision: 4, catalog_update_id: null, catalog_revision: 1 });
    await assert.rejects(request('operation/begin', firstAttempt), /Initial mixed claim lost/);
    assert.equal((await request<MixedAllocationMaintenanceResult>('operation/status')).phase, 'unstarted');
    await unlock();
    await restart();
    await request('operation/begin');
    assert.deepEqual(await registry(), { state: 'active', revision: 5, catalog_update_id: MIXED_MAINNET_BATCH_ID, catalog_revision: 1 });
    const draw = await request<string>('draw-fingerprint');
    await restart();
    await request('begin-reordered');
    assert.equal(await request('draw-fingerprint'), draw);
    let operation = await request<MixedAllocationMaintenanceResult>('operation/scan');
    assert.equal(operation.scanned, 100);
    await request('reorg');
    await assert.rejects(request('operation/scan'), /Ethereum changed while reading your items/);
    operation = await request('operation/refresh-scan');
    assert.equal(operation.scanned, 0);
    while (operation.phase === 'scanning') operation = await request('operation/scan');
    assert.equal(operation.candidates, 429);
    assert.equal((await request<MixedAllocationMaintenanceResult>('operation/stage')).staged, 8);
    assert.equal((await request('traits', { offset: 0 })).metadataStaged, 128);
    await restart();
    assert.equal((await request('traits', { offset: 0 })).metadataStaged, 128);
    const totalNew = release.definition.groups.reduce((sum, group) => sum + group.lastId - group.firstId + 1, 0);
    for (let offset = 128; offset < totalNew; offset += 128) {
      assert.equal((await request('traits', { offset })).metadataStaged, Math.min(offset + 128, totalNew));
    }
    let stage = await request('inventory');
    assert.ok(stage.generationSeeded > 0 && stage.generationSeeded < 111111);
    await restart();
    assert.equal((await request<Inventory>('stage-traffic')).revision, 1);
    while (stage.generationSeeded < 111111) {
      const prior = stage.generationSeeded;
      stage = await request('inventory');
      assert.ok(stage.generationSeeded > prior);
    }
    assert.equal((await request<MixedAllocationMaintenanceResult>('operation/stage')).phase, 'prepared');
    await restart();
    assert.equal(await request('draw-fingerprint'), draw);
    await request('reserve-raced-egg');
    assert.equal((await request<MixedAllocationMaintenanceResult>('operation/activate')).phase, 'activating');
    assert.equal((await request<MixedAllocationMaintenanceResult>('operation/activate')).activationChecked, 100);
    const firstCandidates = await request<string>('activation-draw');
    await request('reorg');
    await assert.rejects(request('operation/activate'), /Ethereum changed while reading your items/);
    const attemptedCandidates = await request<string>('activation-draw');
    assert.notEqual(attemptedCandidates, firstCandidates);
    assert.equal((await request<MixedAllocationMaintenanceResult>('operation/refresh-activation')).activationChecked, 0);
    assert.equal(await request('activation-draw'), attemptedCandidates);
    await restart();
    for (let pages = 1; pages <= 4; pages++) {
      assert.equal((await request<MixedAllocationMaintenanceResult>('operation/activate')).activationChecked, pages * 100);
    }
    const before = await request<Snapshot>('snapshot');
    assert.equal(before.ready, 0);
    await assert.rejects(request('too-few-minted'), /candidate|minted|owner|eligible/i);
    assert.deepEqual(await request('snapshot'), before);
    await assert.rejects(request('interrupt-activation'), /fixture activation interruption/);
    assert.deepEqual(await request('snapshot'), before);
    const acceptanceBlock = await request<number>('redeem-selected');
    await restart();
    const refill = await request<MixedAllocationMaintenanceResult>('operation/activate');
    assert.equal(refill.phase, 'activating');
    assert.equal(refill.activationSelected, 423);
    assert.deepEqual(await request('snapshot'), before);
    const activationStarted = performance.now();
    await failTransition('NEW.catalog_revision>OLD.catalog_revision');
    await assert.rejects(request('operation/activate'), /fixture registry failure/);
    const localActivationMs = Math.round(performance.now() - activationStarted);
    assert.equal((await request<MixedAllocationMaintenanceResult>('operation/status')).phase, 'publishing');
    assert.deepEqual(await registry(), { state: 'active', revision: 5, catalog_update_id: MIXED_MAINNET_BATCH_ID, catalog_revision: 1 });
    await unlock();
    await restart();
    assert.equal((await request<MixedAllocationMaintenanceResult>('operation/activate')).phase, 'publishing');
    assert.deepEqual(await registry(), { state: 'active', revision: 6, catalog_update_id: MIXED_MAINNET_BATCH_ID, catalog_revision: 2 });
    const activated = await request<Snapshot>('snapshot');
    assert.equal(activated.inventory.revision, 2);
    assert.equal(activated.ready, 424);
    assert.equal(activated.hatched, 0);
    assert.equal(activated.fingerprint, before.fingerprint);
    assert.equal(before.inventory.freeEggs - activated.inventory.freeEggs, 6162);
    assert.equal(activated.inventory.reserved, before.inventory.reserved);
    assert.equal(activated.inventory.frozen, before.inventory.frozen);
    const allocation = await request<AllocationCount[]>('assert-allocation');
    await restart();
    await request('activate');
    assert.deepEqual(await request('snapshot'), activated);
    await assert.rejects(request('changed-activation-replay'), /replay changed/);
    assert.deepEqual(await request('snapshot'), activated);
    await request('crate-claim');
    await request('legacy-claim');
    const digest = personalMessageHash(ETHEREUM_OWNER_HATCHING_MESSAGE);
    const signature = signDigest(ownerKey, digest);
    const other = signDigest(`0x${'22'.repeat(32)}`, digest);
    const beforeUnauthorized = await request('snapshot');
    await assert.rejects(request('owner-claim', { kind: 'animated', signature: other }), /current token owner/);
    assert.deepEqual(await request('snapshot'), beforeUnauthorized);
    type Publication = { cratePublished: boolean; published: number; ready: number; hatched: number; conflicts: number };
    let publication = await request<Publication>('publish-page');
    for (let page = 0; page < 256 && (!publication.cratePublished || publication.published < 424); page++) publication = await request('publish-page');
    assert.deepEqual([publication.published, publication.ready, publication.hatched, publication.conflicts], [424, 424, 0, 0]);
    assert.ok(publication.cratePublished);
    await restart();
    await request('crate-metadata');
    for (let page = 0; page < Math.floor(424 / 16); page++) {
      operation = await request('operation/verify');
      assert.equal(operation.verificationInProgress, true);
    }
    const claim = await request<string>('owner-claim', { kind: 'animated', signature });
    assert.equal(await request('owner-claim', { kind: 'animated', signature }), claim);
    while ((await request<Publication>('publish-page')).published < 424) {}
    await restart();
    operation = await request('operation/verify');
    assert.equal(operation.verificationPasses, 0);
    assert.equal(operation.verificationInProgress, true);
    while (operation.verificationInProgress) operation = await request('operation/verify');
    assert.equal(operation.phase, 'observing');
    await assert.rejects(request('operation/complete'), /scheduler interval/);
    await request('advance-clock');
    operation = await request('operation/verify');
    while (operation.verificationInProgress) operation = await request('operation/verify');
    assert.equal(operation.published, 424);
    assert.equal(operation.verificationPasses, 2);
    const painting = await request<string>('owner-claim', { kind: 'painting', signature });
    while ((await request<Publication>('publish-page')).published < 424) {}
    await restart();
    operation = await request('operation/complete');
    assert.equal(operation.complete, false);
    assert.equal(operation.verificationInProgress, true);
    assert.equal(operation.retrying, 0);
    assert.equal(await request('owner-claim', { kind: 'painting', signature }), painting);
    await restart();
    do { operation = await request('operation/verify'); } while (operation.verificationInProgress);
    assert.equal(operation.verificationPasses, 3);
    await failTransition('NEW.catalog_update_id IS NULL');
    await assert.rejects(async () => {
      for (let page = 0; page < 1000 && !operation.complete; page++) operation = await request('operation/complete');
    }, /fixture registry failure/);
    assert.deepEqual(await registry(), { state: 'active', revision: 6, catalog_update_id: MIXED_MAINNET_BATCH_ID, catalog_revision: 2 });
    assert.equal((await request<MixedAllocationMaintenanceResult>('operation/status')).complete, false);
    await unlock();
    await restart();
    assert.equal((await request<MixedAllocationMaintenanceResult>('operation/complete')).complete, true);
    assert.equal((await request<MixedAllocationMaintenanceResult>('operation/complete')).complete, true);
    assert.deepEqual(await registry(), { state: 'active', revision: 7, catalog_update_id: null, catalog_revision: 2 });
    const audit = await request<{ verification_passes: number }>('complete-audit');
    assert.equal(audit.verification_passes, 3);
    const final = await request<Snapshot>('snapshot');
    const next = await request<{ catalogVersion: string; manifestSha256: string }>('later-catalog');
    const laterDb = await runtime.getD1Database('OPS_DB');
    await laterDb.prepare("UPDATE ethereum_reveal_deployments SET revision=8,catalog_update_id='fixture-next',catalog_update_started_at_ms=8").run();
    await laterDb.prepare('UPDATE ethereum_reveal_deployments SET revision=9,catalog_revision=3,effective_catalog_version=?,effective_catalog_sha256=?')
      .bind(next.catalogVersion,next.manifestSha256).run();
    await restart();
    const laterRegistry = await registry();
    assert.equal((await request<MixedAllocationMaintenanceResult>('operation/status')).complete, true);
    do { operation = await request('operation/verify'); } while (operation.verificationInProgress);
    assert.equal(operation.verificationPasses, 4);
    assert.equal(operation.catalogUpdateId, 'fixture-next');
    await assert.rejects(request('operation/complete'), /registry owner, catalog, or revision changed/);
    assert.deepEqual(await registry(), laterRegistry);
    await request('seed', {}, 'limited');
    const enough = await request<Inventory>('near-capacity', {}, 'limited');
    assert.equal(enough.freeEggs, 6162);
    await request('capacity-before-begin', {}, 'limited');
    assert.deepEqual(await request('inventory-only', {}, 'limited'), enough);
    await request('operation/begin', {}, 'limited');
    for (let offset = 0; offset < totalNew; offset += 128) await request('traits', { offset }, 'limited');
    let seeded = 0;
    while (seeded < 111111) {
      const next = (await request('inventory', {}, 'limited')).generationSeeded;
      assert.ok(next > seeded);
      seeded = next;
    }
    await request('seal', {}, 'limited');
    await request('reserve-raced-egg', {}, 'limited');
    const limited = await request<Inventory>('inventory-only', {}, 'limited');
    assert.equal(limited.freeEggs, 6161);
    await assert.rejects(request('capacity-activate', {}, 'limited'), /free egg/i);
    assert.deepEqual(await request('inventory-only', {}, 'limited'), limited);
    let cancellation = await request<{ cancelled: boolean; remaining: number }>('cancel', {}, 'limited');
    while (cancellation.remaining) {
      const next = await request<typeof cancellation>('cancel', {}, 'limited');
      assert.ok(next.remaining < cancellation.remaining);
      cancellation = next;
    }
    assert.equal(cancellation.cancelled, true);
    assert.deepEqual(await request('inventory-only', {}, 'limited'), limited);
    return {
      runtime: 'local Miniflare with SQLite, D1, and R2', registryOrigin: '111k-v8', fixturePredecessor: '111k-v9', sourceSha256: release.definition.sourceSha256, ...release.summary,
      allocation, atActivation: activated.inventory, exchangedFreeEggs: before.inventory.freeEggs - activated.inventory.freeEggs,
      automaticFrozenOrReservedConversions: 0, publishedInFixture: publication.published, ordinaryCrateMetadataVerified: publication.cratePublished,
      fixtureVerificationPasses: audit.verification_passes, acceptanceBlock, localActivationMs, observationClockAdvancedMs: 300001, stagingCleaned: true,
      afterTwoOwnerClaims: { ready: final.ready, hatched: final.hatched, inventory: final.inventory },
      exercised: ['D1 initial claim loss, mirror and release retries under active traffic', 'canonical minted scan and activation snapshot reorg recovery', 'reordered begin replay', 'redeemed candidate replaced at a fresh canonical cutoff', 'local R2 verification across a scheduler interval, concurrent hatch at completion and later catalog audit', 'staging restart', 'ordinary reveal, release, and earlier hatch during staging', 'reservation after sealing',
        'insufficient eligible minted eggs', 'rollback after injected activation failure', 'activation replay after restart',
        'future crate and earlier owner draw from shared additions', 'unauthorized owner rejection', 'signed GAN and painting claims with idempotent replay',
        'free-egg capacity checks before begin and at cutover', 'cancelled candidate with intact predecessor']
    };
  } finally { await runtime.dispose(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { source: { type: 'string' } } });
  if (!values.source) throw new Error('Usage: rehearseMixedAllocation --source /path/to/111k.json');
  const report = await rehearseMixedAllocation(await inspectMixedAllocation(resolve(values.source)));
  console.log(JSON.stringify(report, null, 2));
}
