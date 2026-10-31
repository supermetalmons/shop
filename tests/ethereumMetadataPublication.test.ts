import assert from 'node:assert/strict';
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import {
  fileSha256, loadMetadataTemplates, md5, metadataBody, metadataCounts, metadataIdentities, sha256,
  type MetadataManifest,
} from '../scripts/ethereum-metadata/catalog.ts';
import { uploadMetadata, verifyMetadata } from '../scripts/ethereum-metadata/remote.ts';
import { type MetadataStorage } from '../scripts/ethereum-metadata/storage.ts';
import { runEthereumRevealControl } from '../scripts/ops/ethereumRevealControl.ts';

async function publicationFixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), '111k-publication-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { templates, sources, hashes } = await loadMetadataTemplates();
  await mkdir(join(directory, 'templates'));
  await Promise.all(Object.entries(sources).map(([kind, source]) => writeFile(join(directory, 'templates', `${kind}.json`), source)));
  const placeholder = Buffer.from(JSON.stringify({ name: 'Synthetic metadata', image: 'https://example.com/fixture.png' }));
  const bodies = new Map<string, Buffer>();
  const digest = (body: Buffer) => ({ bytes: body.length, md5: md5(body), sha256: sha256(body) });
  const placeholderDigest = digest(placeholder);
  const digests = new Map<string, ReturnType<typeof digest>>();
  const files: string[] = [];
  const monumentIds: string[] = [];
  const monumentReceiptIds: string[] = [];
  const ledger = await open(join(directory, 'objects.jsonl'), 'w');
  let rows: string[] = [];
  let totalBytes = 0;
  try {
    for (const identity of metadataIdentities()) {
      let checksum = placeholderDigest;
      if (identity.kind === 'monument' || identity.kind === 'monument_receipt') {
        const body = Buffer.from(metadataBody(identity, templates));
        bodies.set(identity.file, body);
        digests.set(identity.file, checksum = digest(body));
        (identity.kind === 'monument' ? monumentIds : monumentReceiptIds).push(identity.tokenId);
      }
      files.push(identity.file);
      totalBytes += checksum.bytes;
      rows.push(JSON.stringify({ ...identity, ...checksum }));
      if (rows.length === 4096) { await ledger.writeFile(rows.join('\n') + '\n'); rows = []; }
    }
    if (rows.length) await ledger.writeFile(rows.join('\n') + '\n');
  } finally { await ledger.close(); }
  const bodyFor = (file: string) => bodies.get(file) ?? placeholder;
  const digestFor = (file: string) => digests.get(file) ?? placeholderDigest;
  const publicSamples = ['1', '55556', '111111', '111112', '116666', '116667', '117171',
    '1000001', '1111111', '1111112', '1222222', '2000001', '2005555', ...monumentIds, ...monumentReceiptIds];
  await Promise.all(publicSamples.map(id => writeFile(join(directory, `${id}.json`), bodyFor(`${id}.json`))));
  const manifest: MetadataManifest = { version: 1, objectCount: files.length, totalBytes, counts: metadataCounts(),
    objectsFile: 'objects.jsonl', objectsSha256: await fileSha256(join(directory, 'objects.jsonl')),
    templateSha256: hashes, sourceSha256: { fixture: sha256('synthetic publication fixture') } };
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(directory, 'validation.json'), JSON.stringify({
    manifestSha256: await fileSha256(join(directory, 'manifest.json')), objectsSha256: manifest.objectsSha256,
    objectCount: manifest.objectCount, totalBytes,
  }));
  files.sort();
  return { directory, manifest, files, monumentIds, monumentReceiptIds, bodyFor, digestFor };
}

test('both deployment networks require the complete seven-kind publication before reveal registration', async t => {
  const publication = await publicationFixture(t);
  assert.equal(publication.manifest.objectCount, 344984);
  assert.deepEqual(publication.monumentIds, Array.from({ length: 18 }, (_, index) => String(117172 + index)));
  assert.deepEqual(publication.monumentReceiptIds, Array.from({ length: 18 }, (_, index) => String(3000001 + index)));
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  database.exec(await readFile(new URL('../cloud/workers/api/ops-migrations/0009_ethereum_reveal_deployments.sql', import.meta.url), 'utf8'));
  for (const [network, chainId, root] of [['sepolia', 11155111, '111k-sepolia'], ['mainnet', 1, '111k']] as const) {
    await t.test(network, async t => {
      const deploymentId = `${network}-monuments-test`;
      const prefix = `${root}/${deploymentId}/`;
      const keys = publication.files.map(file => prefix + file);
      const indices = new Map(keys.map((key, index) => [key, index]));
      const uploaded = new Map<string, Buffer>();
      let complete = false;
      let missing: string | undefined;
      let corrupted: string | undefined;
      const storage: MetadataStorage = {
        destination: { endpoint: 'https://example.invalid', bucket: 'cdn-mons-shop' },
        async *list(selectedPrefix, range = {}) {
          assert.equal(selectedPrefix, prefix);
          const start = range.startAfter === undefined ? 0 : indices.get(range.startAfter)! + 1;
          const end = range.endAt === undefined ? keys.length : indices.get(range.endAt)! + 1;
          for (let index = start; index < end; index++) {
            const key = keys[index];
            if (key === missing || !complete && !uploaded.has(key)) continue;
            const checksum = publication.digestFor(publication.files[index]);
            yield { key, bytes: checksum.bytes, md5: key === corrupted ? '0'.repeat(32) : checksum.md5 };
          }
        },
        async get(key) {
          assert.ok(indices.has(key));
          assert.ok(complete || uploaded.has(key));
          return uploaded.get(key) ?? publication.bodyFor(key.slice(prefix.length));
        },
        async put(key, body, expectedEtag) {
          assert.ok(indices.has(key));
          assert.equal(expectedEtag, null);
          assert.deepEqual(body, publication.bodyFor(key.slice(prefix.length)));
          uploaded.set(key, body);
        },
        close() {},
      };
      t.mock.method(globalThis, 'fetch', async input => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        assert.equal(url.origin, 'https://cdn.mons.shop');
        const body = await storage.get(url.pathname.slice(1));
        return new Response(body.toString('utf8'), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' } });
      });
      const [sampleUpload] = await uploadMetadata(publication.directory, network, { storage, prefix, tokenIds: publication.monumentIds });
      assert.equal(sampleUpload.uploaded, 18);
      assert.equal(sampleUpload.complete, false);
      assert.deepEqual([...uploaded.keys()].sort(), publication.monumentIds.map(id => `${prefix}${id}.json`));
      const [sample] = await verifyMetadata(publication.directory, network, { storage, prefix, tokenIds: publication.monumentIds });
      assert.equal(sample.objectCount, 18);
      assert.equal(sample.complete, false);
      assert.deepEqual(sample.samples.map(value => value.tokenId), publication.monumentIds);

      const deploymentFile = join(publication.directory, `deployment-${network}.json`);
      const deployment = { deploymentId, dropId: '111k_devnet', chainId,
        contractAddress: `0x${'ab'.repeat(20)}`, metadataBaseUri: `https://cdn.mons.shop/${prefix}`,
        deploymentBlock: 1, catalogVersion: '111k-v1', publicationDirectory: '.' };
      await writeFile(deploymentFile, JSON.stringify(deployment));
      let verified: Awaited<ReturnType<typeof verifyMetadata>> | undefined;
      let chainChecks = 0;
      const register = () => runEthereumRevealControl(['register', '--manifest', deploymentFile, '--write'], {
        query: sql => database.prepare(sql).all(),
        verifyPublication: async (directory, selectedNetwork, options) => {
          assert.equal(selectedNetwork, network);
          assert.equal(options.prefix, prefix);
          assert.equal(options.tokenIds, undefined);
          return verified = await verifyMetadata(directory, selectedNetwork, { ...options, storage });
        },
        verifyDeployment: async value => { assert.equal(value.chainId, chainId); chainChecks++; },
      });
      const existingDeployments = network === 'sepolia' ? 0 : 1;
      if (network === 'mainnet') {
        await writeFile(deploymentFile, JSON.stringify({ ...deployment, deploymentId: 'sepolia-monuments-test',
          metadataBaseUri: 'https://cdn.mons.shop/111k/sepolia-monuments-test/' }));
        await assert.rejects(register(), /already registered with different immutable settings/);
        assert.equal(chainChecks, 0);
        assert.equal(verified, undefined);
        await writeFile(deploymentFile, JSON.stringify(deployment));
      }
      await assert.rejects(register(), /inventory is incomplete: 18\/344984/);
      assert.equal(chainChecks, 0);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ethereum_reveal_deployments').get()!.count, existingDeployments);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ethereum_metadata_publication_leases').get()!.count, 0);
      complete = true;
      missing = `${prefix}117186.json`;
      await assert.rejects(verifyMetadata(publication.directory, network, { storage, prefix }), /inventory is incomplete: 344983\/344984/);
      missing = `${prefix}3000018.json`;
      await assert.rejects(verifyMetadata(publication.directory, network, { storage, prefix }), /inventory is incomplete: 344983\/344984/);
      missing = undefined;
      corrupted = `${prefix}117186.json`;
      await assert.rejects(verifyMetadata(publication.directory, network, { storage, prefix }), /Remote metadata checksum mismatch: .*117186\.json/);
      corrupted = undefined;
      const registered = await register();
      assert.equal('deployment' in registered && 'state' in registered.deployment && registered.deployment.state, 'provisioning');
      assert.equal(chainChecks, 1);
      assert.equal(verified![0].complete, true);
      assert.equal(verified![0].objectCount, 344984);
      assert.equal(verified![0].totalBytes, publication.manifest.totalBytes);
      assert.deepEqual(verified![0].samples.filter(value => Number(value.tokenId) >= 117172 && Number(value.tokenId) <= 117189)
        .map(value => value.tokenId), ['117172', '117189']);
      assert.deepEqual(verified![0].samples.filter(value => Number(value.tokenId) >= 3000001)
        .map(value => value.tokenId), ['3000001', '3000018']);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ethereum_metadata_publication_leases').get()!.count, 0);
    });
  }
  assert.deepEqual(database.prepare('SELECT deployment_id, chain_id FROM ethereum_reveal_deployments ORDER BY chain_id').all()
    .map(row => [row.deployment_id, row.chain_id]), [['mainnet-monuments-test', 1], ['sepolia-monuments-test', 11155111]]);
});
