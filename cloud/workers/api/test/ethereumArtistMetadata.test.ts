import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { MAINNET_111K_ARTISTS_SHA256 } from '../../../../shared/ethereum/mainnet111kArtists.ts';
import { parseArtistMetadataRequest, type ArtistMetadataScope } from '../../../../shared/ethereum/artistMetadataMaintenance.ts';
import { getRevealCatalogDescriptor } from '../../../../shared/ethereum/revealCatalogRegistry.ts';
import type { EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.ts';
import { EthereumArtistMetadataOperation } from '../src/ethereumArtistMetadata.ts';
import { readRevealArtistAnnotation } from '../src/ethereumRevealArtistAnnotations.ts';
import { EthereumRevealStore, type RevealSql } from '../src/ethereumRevealStore.ts';

const sha = (body: string) => createHash('sha256').update(body).digest('hex');

test('artist publication resumes an interrupted conditional write and audits exact credits and unchanged eggs', async t => {
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  const sql: RevealSql = { exec<T extends Record<string, string | number | null | ArrayBuffer>>(query: string,
    ...bindings: Array<string | number | null | ArrayBuffer>) {
    const statement = database.prepare(query);
    const params = bindings.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value);
    const rows = statement.columns().length ? statement.all(...params) : (statement.run(...params), []);
    return { toArray: () => rows as T[] };
  } };
  const catalog = getRevealCatalogDescriptor('111k-v11')!;
  const templateJson = '{"name":"{{tokenId}}","image":"https://cdn.lil.org/nft/111k/placeholder.png"}';
  const deployment: EthereumRevealDeployment = { deploymentId: 'mainnet-v1', dropId: '111k', chainId: 1,
    contractAddress: `0x${'ab'.repeat(20)}`, metadataBaseUri: 'https://cdn.mons.shop/111k/', deploymentBlock: 42,
    catalogVersion: catalog.catalogVersion, effectiveCatalogVersion: catalog.catalogVersion, effectiveCatalogSha256: catalog.manifestSha256,
    catalogRevision: 0, templateJson, templateSha256: sha(templateJson), state: 'active', revision: 1,
    createdAtMs: 1, updatedAtMs: 1, provisionedAtMs: 1, activatedAtMs: 1, lastError: null };
  const scope: ArtistMetadataScope = { deploymentId: 'mainnet-v1', chainId: 1, contractAddress: deployment.contractAddress,
    metadataBaseUri: 'https://cdn.mons.shop/111k/', deploymentBlock: 42, expectedRevision: 1, catalogRevision: 0,
    catalogVersion: catalog.catalogVersion, catalogSha256: catalog.manifestSha256, mappingSha256: MAINNET_111K_ARTISTS_SHA256,
    operationId: `artist-${'c'.repeat(32)}`, frozenThroughMs: 5 };
  const store = new EthereumRevealStore(sql, action => action());
  store.configure(deployment);
  database.exec("UPDATE settings SET ready=1 WHERE id=1; INSERT INTO crates(crate_token_id) VALUES('111112')");
  const objects = new Map<string, string>();
  const insert = (tokenId: string, category: 'egg' | 'painting', assetId: number, traits: string, status = 'published') => {
    const body = `{"name":"${tokenId}","category":"${category}","attributes":${traits}}\n`;
    const artwork = { ...JSON.parse(body), tokenId, crateTokenId: '111112', image: 'https://cdn.lil.org/nft/111k/sample.png' };
    database.prepare(`INSERT INTO assignments(category,asset_id,crate_token_id,slot,token_id,artwork_json,metadata_json,placeholder_json,frozen_at_ms)
      VALUES(?,?,'111112',?,?,?,?,?,3)`).run(category, assetId, Number(tokenId) - 1, tokenId, JSON.stringify(artwork), body, templateJson);
    database.prepare('INSERT INTO publication(token_id,status) VALUES(?,?)').run(tokenId, status);
    objects.set(tokenId, body);
    return body;
  };
  const painting1 = insert('1', 'painting', 8889, '[{"trait_type":"collection block","value":"Collage Paintings"},' +
    '{"trait_type":"artist","value":"source artist"},{"trait_type":"score","value":1.23000000000000001},{"trait_type":"good twin","value":true}]');
  const egg = insert('2', 'egg', 1, '[{"trait_type":"type","value":"egg"}]');
  const foreignOriginal = insert('3', 'painting', 8890, '[{"trait_type":"collection block","value":"Collage Paintings"}]');
  insert('4', 'painting', 8891, '[{"trait_type":"collection block","value":"Collage Paintings"}]', 'pending');
  objects.set('3', '{"foreign":true}');
  const current = async () => deployment;
  const customMetadata = new Map([['1', { extra: 'preserved', sha256: sha(painting1) }]]);
  const stale = new Set<string>();
  let writes = 0;
  const operation = new EthereumArtistMetadataOperation({ sql, transaction: action => action(), reader: store.catalogUpdate.reader, current,
    bucket: {
      async get(key: string) {
        const tokenId = key.match(/(\d+)\.json$/)![1];
        const body = objects.get(tokenId);
        if (!body) return null;
        const data = new TextEncoder().encode(body);
        return { size: data.byteLength, etag: sha(body), httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: 'no-store' },
          customMetadata: customMetadata.get(tokenId), arrayBuffer: async () => data.buffer } as R2ObjectBody;
      },
      async put(key: string, body: string, options: R2PutOptions) {
        const tokenId = key.match(/(\d+)\.json$/)![1];
        assert.deepEqual(options.onlyIf, { etagMatches: sha(objects.get(tokenId)!) });
        assert.deepEqual(options.httpMetadata, { contentType: 'application/json; charset=utf-8', cacheControl: 'no-store' });
        assert.equal(options.customMetadata?.sha256, sha(body));
        if (tokenId === '1') assert.equal(options.customMetadata?.extra, 'preserved');
        if (stale.delete(tokenId)) return null;
        objects.set(tokenId, body);
        if (++writes === 1) throw new Error('Publisher lost acknowledgement after write');
        return { etag: sha(body) } as R2Object;
      },
    } as Pick<R2Bucket, 'get' | 'put'>,
  });

  const scan = { scope, action: 'apply', after: null, limit: 8 } as const;
  const plan = parseArtistMetadataRequest({ scope, action: 'plan', after: null, limit: 2 });
  const firstPlan = await operation.run(plan);
  assert.equal(firstPlan.started, false);
  assert.equal(firstPlan.scanned, 2);
  assert.equal(firstPlan.next, '2');
  assert.deepEqual(firstPlan.plannedTokenIds, ['1', '2']);
  assert.deepEqual(firstPlan.records, []);
  assert.deepEqual((await operation.run({ ...plan, after: '2', limit: 1024, frozenThroughMs: 6 })).plannedTokenIds, ['3', '4']);
  assert.throws(() => parseArtistMetadataRequest({ ...plan, limit: 1025 }), /artist maintenance scope/);
  assert.throws(() => parseArtistMetadataRequest({ ...plan, retryTokenIds: ['1'] }), /artist maintenance scope/);
  assert.equal(readRevealArtistAnnotation(sql, '1'), undefined);
  assert.equal(writes, 0);
  await assert.rejects(operation.run(scan), /prepared on-chain preflight/);
  assert.equal((await operation.run({ scope, action: 'start' })).started, true);
  const first = await operation.run(scan);
  assert.equal(first.scanned, 4);
  assert.equal(first.eggs, 1);
  assert.deepEqual(first.conflicts, ['3']);
  assert.deepEqual(first.deferred, ['1', '4']);
  assert.equal(readRevealArtistAnnotation(sql, '1')?.predecessor_sha256, sha(painting1));
  assert.equal(readRevealArtistAnnotation(sql, '1')?.published, 0);
  assert.equal(readRevealArtistAnnotation(sql, '3'), undefined);
  assert.equal(writes, 1);

  objects.set('3', foreignOriginal);
  database.exec("UPDATE publication SET status='published' WHERE token_id='4'");
  stale.add('3');
  const retry = await operation.run({ ...scan, retryTokenIds: ['1', '3', '4'] });
  assert.equal(retry.published, 2);
  assert.deepEqual(retry.deferred, ['3']);
  assert.equal(readRevealArtistAnnotation(sql, '3')?.published, 0);
  assert.equal((await operation.run({ ...scan, retryTokenIds: ['3'] })).published, 1);
  assert.equal(readRevealArtistAnnotation(sql, '1')?.published, 1);
  assert.equal(writes, 3);

  const verify = parseArtistMetadataRequest({ ...scan, action: 'verify', retryTokenIds: ['1', '2'], frozenThroughMs: 6 });
  const verified = await operation.run(verify);
  assert.equal(verified.credited, 1);
  assert.equal(verified.eggs, 1);
  assert.deepEqual(verified.records.map(row => row.artists), [['evil biscuit', 'turtle', 'meinong'], []]);
  assert.equal(verified.records[0].frozenMetadataSha256, sha(painting1));
  assert.equal(verified.records[1].metadataSha256, sha(egg));
  assert.match(objects.get('1')!, /1\.23000000000000001/);
  assert.match(objects.get('1')!, /"good twin","value":true/);
  assert.equal(objects.get('2'), egg);
});
