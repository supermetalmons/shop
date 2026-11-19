import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.ts';
import { backfillRevealAttributePage } from '../src/ethereumRevealAttributeBackfill.ts';
import { acknowledgeRevealArtistAnnotation, initializeRevealArtistAnnotations, stageRevealArtistAnnotation, validateRevealArtistEnrichment } from '../src/ethereumRevealArtistAnnotations.ts';
import { EthereumRevealStore, type RevealSql } from '../src/ethereumRevealStore.ts';

const digest = (body: string) => createHash('sha256').update(body).digest('hex');
const templateJson = '{"name":"{{tokenId}}","image":"https://cdn.lil.org/nft/111k/placeholder.png"}';
const collectionBlock = { trait_type: 'collection block', value: 'plane of existence' };
const artists = ['evil biscuit', 'meinong'];
const artistTraits = artists.map(value => ({ trait_type: 'artist', value }));
const base = '{"name":"1","category":"painting","attributes":[{"trait_type":"collection block","value":"plane of existence"},{"trait_type":"artist","value":"upstream"}]}\n';

test('artist amendment survives fresh native enrichment without changing its recorded predecessor or traits', t => {
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  const sql: RevealSql = { exec<T extends Record<string, string | number | null | ArrayBuffer>>(query: string,
    ...bindings: Array<string | number | null | ArrayBuffer>) {
    const statement = database.prepare(query);
    const values = bindings.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value);
    const rows = statement.columns().length ? statement.all(...values) : (statement.run(...values), []);
    return { toArray: () => rows as T[] };
  } };
  const deployment: EthereumRevealDeployment = { deploymentId: 'mainnet-v1', dropId: '111k', chainId: 1,
    contractAddress: `0x${'ab'.repeat(20)}`, metadataBaseUri: 'https://cdn.mons.shop/111k/', deploymentBlock: 100,
    catalogVersion: '111k-v9', templateJson, templateSha256: digest(templateJson), state: 'active', revision: 1,
    createdAtMs: 1, updatedAtMs: 1, provisionedAtMs: 1, activatedAtMs: 1, lastError: null };
  const store = new EthereumRevealStore(sql, action => action());
  store.configure(deployment);
  const artwork = { ...JSON.parse(base), tokenId: '1', crateTokenId: '111112', image: 'https://cdn.lil.org/nft/111k/paintings/1.png' };
  database.exec("INSERT INTO crates(crate_token_id) VALUES('111112')");
  database.prepare(`INSERT INTO assignments(category,asset_id,crate_token_id,slot,token_id,artwork_json,metadata_json,placeholder_json,frozen_at_ms)
    VALUES('painting',1,'111112',0,'1',?,?,?,1000)`).run(JSON.stringify(artwork), base, templateJson);
  database.exec("INSERT INTO publication(token_id,status) VALUES('1','published')");

  const reader = store.catalogUpdate.reader;
  const [before] = reader.canonicalMetadata(['1']);
  initializeRevealArtistAnnotations(sql);
  const row = stageRevealArtistAnnotation(sql, before, collectionBlock.value, artists, 'artist-test', 'etag-original')!;
  const [amended] = reader.canonicalMetadata(['1']);
  assert.deepEqual(JSON.parse(amended.metadataJson).attributes, [collectionBlock, ...artistTraits]);
  assert.deepEqual(reader.canonicalArtworks(['1'])[0].attributes, [collectionBlock, ...artistTraits]);
  assert.equal(amended.metadataRevision, before.metadataRevision + 2);
  assert.equal(amended.targetSha256, row.target_sha256);
  assert.deepEqual(amended.expectedJsons, [base]);
  const audit = () => backfillRevealAttributePage(sql, { audit: true, afterTokenId: null, write: false, frozenThroughMs: 2000 });
  assert.throws(audit, /complete artist metadata publication/);
  assert.equal(acknowledgeRevealArtistAnnotation(sql, '1', 'artist-test'), true);
  assert.equal(acknowledgeRevealArtistAnnotation(sql, '1', 'artist-test'), false);
  assert.equal(audit().tokens?.[0].metadataSha256, amended.targetSha256);

  const enrichment = base.replace(']}', ',{"trait_type":"score","value":1.230000000000000000001},{"trait_type":"good twin","value":true}]}');
  assert.equal(validateRevealArtistEnrichment(sql, '1', enrichment), true);
  database.prepare("INSERT INTO reveal_enrichment(token_id,version,target_json,target_sha256) VALUES('1','v0',?,?)")
    .run(enrichment, digest(enrichment));
  const [enriched] = reader.canonicalMetadata(['1']);
  assert.equal(enriched.metadataRevision, amended.metadataRevision + 1);
  assert.deepEqual(enriched.expectedJsons, [enrichment, base, amended.metadataJson]);
  assert.deepEqual(reader.canonicalMetadataBeforeArtists(['1'])[0].metadataJson, enrichment);
  assert.match(enriched.metadataJson, /1\.230000000000000000001/);
  assert.deepEqual(JSON.parse(enriched.metadataJson).attributes, [collectionBlock, ...artistTraits,
    { trait_type: 'score', value: 1.23 }, { trait_type: 'good twin', value: true }]);
  assert.equal(reader.validateMetadataWrite(enriched), true);
  assert.equal(reader.validateMetadataWrite(amended), false);
  assert.equal(reader.validateMetadataWrite({ ...enriched, expectedJsons: [templateJson] }), false);
  assert.equal(audit().tokens?.[0].frozenMetadataSha256, digest(base));
});
