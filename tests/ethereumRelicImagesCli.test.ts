import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyRelicImages, prepareRelicImages, readRelicImagesJournal, verifyRelicImages } from '../scripts/ethereum-metadata/relicImages.ts';
import { parseRelicImagesArgs } from '../scripts/ethereum-metadata/relicImagesCli.ts';
import { parseRelicImagesRequest, prepareRelicImagePatch, RELIC_IMAGE_TOKEN_IDS, relicImageSha256,
  type RelicImagesRequest, type RelicImagesResult } from '../shared/ethereum/relicImages.ts';

const scope = { deploymentId: 'v17', chainId: 11155111, contractAddress: `0x${'a'.repeat(40)}`,
  metadataBaseUri: 'https://cdn.mons.shop/111k-sepolia/v17/', expectedRevision: 7 };
const jsonHeaders = { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': 'https://mons.shop', 'Cache-Control': 'no-store' };
const metadata = (tokenId: string) => `${JSON.stringify({ name: `Relic #${Number(tokenId) - 117171}`, description: '',
  image: `https://cdn.lil.org/nft/111k/relics/${Number(tokenId) - 117171}.webp`, attributes: [{ trait_type: 'type', value: 'relic' }] }, null, 2)}\n`;

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'relic-images-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'update');
  const bodies = new Map(RELIC_IMAGE_TOKEN_IDS.map(tokenId => [tokenId, metadata(tokenId)]));
  const requests: RelicImagesRequest[] = [];
  const fetches: string[] = [];
  let revision = scope.expectedRevision;
  let failedToken: string | undefined;
  let foreignCdnToken: string | undefined;
  let failConfig = false;
  let queryCalls = 0;
  const transport = async (input: RelicImagesRequest): Promise<RelicImagesResult> => {
    const request = parseRelicImagesRequest(input);
    requests.push(request);
    assert.deepEqual(request.scope, scope);
    if (request.scope.expectedRevision !== revision) throw new Error('Revision changed.');
    if (request.action === 'inspect') return { action: 'inspect', objects: RELIC_IMAGE_TOKEN_IDS.map(tokenId =>
      prepareRelicImagePatch(tokenId, bodies.get(tokenId)!, relicImageSha256(bodies.get(tokenId)!), request.field)) };
    const patch = request.patch;
    if (failedToken === patch.tokenId) { failedToken = undefined; throw new Error('Simulated write interruption.'); }
    const previous = bodies.get(patch.tokenId)!;
    if (previous === patch.afterJson) return { action: 'apply', tokenId: patch.tokenId, status: 'unchanged' };
    if (previous !== patch.beforeJson || relicImageSha256(previous) !== patch.etag) throw new Error('Conditional write conflict.');
    bodies.set(patch.tokenId, patch.afterJson);
    return { action: 'apply', tokenId: patch.tokenId, status: 'updated' };
  };
  const fetcher = (async (input, init) => {
    const url = new URL(String(input));
    fetches.push(url.href);
    assert.equal(init?.cache, 'no-store');
    assert.equal(init?.redirect, 'manual');
    assert.equal(new Headers(init?.headers).get('origin'), 'https://mons.shop');
    assert(init?.signal instanceof AbortSignal);
    if (url.pathname.endsWith('/config')) return Response.json({ ...scope, ...(failConfig ? { deploymentId: 'v18' } : {}) }, { headers: jsonHeaders });
    if (url.hostname === 'cdn.mons.shop') {
      const tokenId = url.pathname.split('/').at(-1)!.replace('.json', '');
      const body = bodies.get(tokenId)!;
      return new Response(tokenId === foreignCdnToken ? body.replace('Relic #', 'Changed relic #') : body, { headers: jsonHeaders });
    }
    assert.equal(url.pathname, '/ethereum/111k/metadata');
    assert.equal(url.searchParams.get('kind'), 'relic');
    assert.equal(url.searchParams.get('chainId'), String(scope.chainId));
    assert.equal(url.searchParams.get('contractAddress'), scope.contractAddress);
    const tokenId = String(Number(url.searchParams.get('displayId')) + 117171);
    return Response.json({ ...JSON.parse(bodies.get(tokenId)!), deploymentId: scope.deploymentId, dropId: '111k_devnet',
      chainId: scope.chainId, contractAddress: scope.contractAddress, catalogRevision: 3 }, { headers: jsonHeaders });
  }) as typeof fetch;
  const query = async (sql: string) => {
    queryCalls++;
    assert.match(sql, /WHERE deployment_id = 'v17'/);
    return [{ deployment_id: scope.deploymentId, drop_id: '111k_devnet', chain_id: scope.chainId,
      contract_address: scope.contractAddress, metadata_base_uri: scope.metadataBaseUri, deployment_block: 100,
      catalog_version: '111k-v8', template_json: JSON.stringify({ name: '{{tokenId}}', description: '',
        image: 'https://cdn.lil.org/nft/111k/placeholder.png', attributes: [] }), template_sha256: 'f'.repeat(64),
      state: 'active', revision, created_at_ms: 1, updated_at_ms: 1, activated_at_ms: 1, provisioned_at_ms: 1, last_error: null }];
  };
  return { directory, bodies, requests, fetches, dependencies: { query, transport, fetch: fetcher, now: () => new Date('2026-11-11T12:00:00.000Z') },
    queryCalls: () => queryCalls, setRevision: (value: number) => { revision = value; },
    failOnce: (tokenId: string) => { failedToken = tokenId; }, foreignCdn: (tokenId: string) => { foreignCdnToken = tokenId; },
    changePublicScope: () => { failConfig = true; } };
}

test('relic image CLI requires an explicit preparation target and reuses only the frozen target for apply and verify', () => {
  assert.equal(parseRelicImagesArgs(['prepare', '--directory', '/tmp/relics', '--deployment-id', 'mainnet-v1'])?.deploymentId, 'mainnet-v1');
  assert.equal(parseRelicImagesArgs(['prepare', '--names', '--directory', '/tmp/relics', '--deployment-id', 'mainnet-v1'])?.field, 'name');
  assert.equal(parseRelicImagesArgs(['apply', '--directory', '/tmp/relics'])?.command, 'apply');
  assert.equal(parseRelicImagesArgs(['verify', '--directory', '/tmp/relics'])?.command, 'verify');
  assert.equal(parseRelicImagesArgs(['--help']), null);
  for (const args of [[], ['prepare', '--directory', 'x'], ['prepare', '--directory', 'x', '--deployment-id', '../x'],
    ['apply', '--directory', 'x', '--deployment-id', 'v17'], ['verify', '--directory', ''],
    ['prepare', '--directory', 'x', '--directory', 'y', '--deployment-id', 'v17'], ['apply', '--directory', 'x', '--write'],
    ['apply', '--directory', 'x', '--names'], ['verify', '--directory', 'x', '--names']]) {
    assert.throws(() => parseRelicImagesArgs(args));
  }
});

test('preparation freezes all 18 objects and reuses the immutable journal without rediscovering a new revision', async t => {
  const f = await fixture(t);
  const first = await prepareRelicImages(f.directory, scope.deploymentId, f.dependencies);
  const bytes = await readFile(join(f.directory, 'journal.json'), 'utf8');
  assert.equal(Object.hasOwn(JSON.parse(bytes), 'field'), false);
  assert.equal(first.field, undefined);
  assert.equal(first.objects.length, 18);
  assert.equal(first.scope.expectedRevision, scope.expectedRevision);
  assert.equal(f.requests.filter(request => request.action === 'apply').length, 0);
  assert(first.objects.every(object => object.afterJson.includes(`relics/${Number(object.tokenId) - 117171}.png`)));
  assert.deepEqual(await prepareRelicImages(f.directory, scope.deploymentId, f.dependencies), first);
  assert.equal(f.queryCalls(), 1);
  assert.equal(await readFile(join(f.directory, 'journal.json'), 'utf8'), bytes);
  await assert.rejects(prepareRelicImages(f.directory, scope.deploymentId, f.dependencies, 'name'), /different update field/);
  f.setRevision(8);
  await assert.rejects(prepareRelicImages(f.directory, scope.deploymentId, f.dependencies), /Revision changed/);
  await assert.rejects(prepareRelicImages(f.directory, 'mainnet-v1', f.dependencies), /different deployment/);
});

test('name preparation freezes the chosen field and resumes a name-only update without changing images', async t => {
  const f = await fixture(t);
  for (const [tokenId, body] of f.bodies) f.bodies.set(tokenId, body.replace('.webp', '.png'));
  const originals = new Map(f.bodies);
  const { displayNames } = JSON.parse(await readFile(new URL('../scripts/ethereum-metadata/templates/relic.json', import.meta.url), 'utf8'));
  const journal = await prepareRelicImages(f.directory, scope.deploymentId, f.dependencies, 'name');
  const frozen = await readFile(join(f.directory, 'journal.json'), 'utf8');
  assert.equal(journal.field, 'name');
  assert.deepEqual(await readRelicImagesJournal(f.directory), journal);
  assert.deepEqual(await prepareRelicImages(f.directory, scope.deploymentId, f.dependencies, 'name'), journal);
  await assert.rejects(prepareRelicImages(f.directory, scope.deploymentId, f.dependencies), /different update field/);
  for (const [index, patch] of journal.objects.entries()) {
    assert.equal(patch.afterJson, originals.get(patch.tokenId)!.replace(JSON.stringify(`Relic #${index + 1}`), JSON.stringify(displayNames[index])));
  }
  f.failOnce('117174');
  await assert.rejects(applyRelicImages(f.directory, f.dependencies), /write interruption/);
  const result = await applyRelicImages(f.directory, f.dependencies);
  assert.equal(result.updated, 16);
  assert.equal(result.unchanged, 2);
  const verified = await verifyRelicImages(f.directory, f.dependencies);
  assert.equal(verified.complete, true);
  assert.equal(verified.field, 'name');
  assert.equal(verified.objectCount, 18);
  assert(f.requests.every(request => request.field === 'name'));
  assert.equal(await readFile(join(f.directory, 'journal.json'), 'utf8'), frozen);
  assert.equal((await applyRelicImages(f.directory, f.dependencies)).unchanged, 18);
  const edited = { ...journal, field: 'image' };
  await writeFile(join(f.directory, 'journal.json'), JSON.stringify(edited));
  await assert.rejects(readRelicImagesJournal(f.directory), /Invalid relic image journal/);
});

test('apply resumes an interrupted migration and verify checks all stored, CDN and API metadata', async t => {
  const f = await fixture(t);
  const journal = await prepareRelicImages(f.directory, scope.deploymentId, f.dependencies);
  const frozen = await readFile(join(f.directory, 'journal.json'), 'utf8');
  f.failOnce('117174');
  await assert.rejects(applyRelicImages(f.directory, f.dependencies), /write interruption/);
  const partial = JSON.parse(await readFile(join(f.directory, 'progress.json'), 'utf8'));
  assert.equal(partial.completed.length, 2);
  assert.equal(partial.complete, false);
  const applied = await applyRelicImages(f.directory, f.dependencies);
  assert.equal(applied.updated, 16);
  assert.equal(applied.unchanged, 2);
  assert.equal(applied.complete, false);
  const verified = await verifyRelicImages(f.directory, f.dependencies);
  assert.equal(verified.complete, true);
  assert.equal(verified.storageVerified, 18);
  assert.equal(verified.cdnVerified, 18);
  assert.equal(verified.apiVerified, 18);
  assert.equal(verified.journalSha256, journal.journalSha256);
  assert.equal(f.fetches.filter(url => url.includes('/metadata?')).length, 18);
  assert.equal(f.fetches.filter(url => url.startsWith(scope.metadataBaseUri)).length, 18);
  assert.equal(await readFile(join(f.directory, 'journal.json'), 'utf8'), frozen);
  assert.equal((await applyRelicImages(f.directory, f.dependencies)).unchanged, 18);
  await assert.rejects(readFile(join(f.directory, 'verification.json')), { code: 'ENOENT' });
});

test('foreign metadata or a changed public deployment prevents writes', async t => {
  const f = await fixture(t);
  await prepareRelicImages(f.directory, scope.deploymentId, f.dependencies);
  f.bodies.set('117189', metadata('117189').replace('Relic #18', 'Another name'));
  await assert.rejects(applyRelicImages(f.directory, f.dependencies), /differs from the frozen/);
  assert.equal(f.requests.filter(request => request.action === 'apply').length, 0);
  f.changePublicScope();
  await assert.rejects(applyRelicImages(f.directory, f.dependencies), /public configuration/);
});

test('journal checksum and deterministic patches reject altered local metadata before any remote write', async t => {
  const f = await fixture(t);
  const journal = await prepareRelicImages(f.directory, scope.deploymentId, f.dependencies);
  await writeFile(join(f.directory, 'journal.json'), JSON.stringify({ ...journal, preparedAt: '2026-11-12T12:00:00.000Z' }));
  await assert.rejects(readRelicImagesJournal(f.directory), /checksum mismatch/);
  journal.objects[0].afterJson = journal.objects[0].afterJson.replace('Relic #1', 'Changed name');
  await writeFile(join(f.directory, 'journal.json'), JSON.stringify(journal));
  await assert.rejects(applyRelicImages(f.directory, f.dependencies), /patch content or checksum/);
  assert.equal(f.requests.filter(request => request.action === 'apply').length, 0);
});

test('verify never reports completion for unapplied or stale public metadata', async t => {
  const f = await fixture(t);
  await prepareRelicImages(f.directory, scope.deploymentId, f.dependencies);
  await assert.rejects(verifyRelicImages(f.directory, f.dependencies), /frozen target/);
  await applyRelicImages(f.directory, f.dependencies);
  await verifyRelicImages(f.directory, f.dependencies);
  f.foreignCdn('117189');
  await assert.rejects(verifyRelicImages(f.directory, f.dependencies), /Public relic metadata differs/);
  await assert.rejects(readFile(join(f.directory, 'verification.json')), { code: 'ENOENT' });
});

test('verification rejects a public CDN body with extra UTF-8 BOM bytes', async t => {
  const f = await fixture(t);
  await prepareRelicImages(f.directory, scope.deploymentId, f.dependencies);
  await applyRelicImages(f.directory, f.dependencies);
  const fetcher = (async (input, init) => {
    const response = await f.dependencies.fetch(input, init);
    return String(input) === `${scope.metadataBaseUri}117172.json`
      ? new Response(`\uFEFF${await response.text()}`, { headers: response.headers }) : response;
  }) as typeof fetch;
  await assert.rejects(verifyRelicImages(f.directory, { ...f.dependencies, fetch: fetcher }), SyntaxError);
  await assert.rejects(readFile(join(f.directory, 'verification.json')), { code: 'ENOENT' });
});

test('preparation rejects incomplete or duplicate remote inspections', async t => {
  const f = await fixture(t);
  await assert.rejects(prepareRelicImages(f.directory, scope.deploymentId, { ...f.dependencies,
    transport: async () => ({ action: 'inspect', objects: [] }) }), /all 18 objects/);
  await assert.rejects(readFile(join(f.directory, 'journal.json')), { code: 'ENOENT' });
  const patch = prepareRelicImagePatch('117172', metadata('117172'), 'etag');
  await assert.rejects(prepareRelicImages(f.directory, scope.deploymentId, { ...f.dependencies,
    transport: async () => ({ action: 'inspect', objects: Array.from({ length: 18 }, () => patch) }) }), /duplicate token IDs/);
});
