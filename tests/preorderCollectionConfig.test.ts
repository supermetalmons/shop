import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  loadPreorderCollectionConfig,
  preparePreorderCollectionConfig,
  preorderCollectionUsage,
  type PreorderCollectionConfig,
} from '../scripts/shared/preorderCollectionConfig.ts';

const AUTHORITY = 'kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx';
const RECIPIENT = 'AmzcjtuzXkSziYHRqmavPiTsbJveW13wiRhCTRnuheiq';
const SECOND_RECIPIENT = 'AWmNR6t5g5zipT2NMkSPRBXxB9Th8LsZcJX71yNyzsgE';

function validConfig(): PreorderCollectionConfig {
  return {
    collectionId: 'mi_note_cards',
    isMainnet: true,
    authority: AUTHORITY,
    collectionMetadataUri: 'https://cdn.lil.org/nft/mi_note_cards/collection.json',
    collectionMetadata: {
      name: 'Mi Note Cards',
      symbol: 'MINOTE',
      description: 'Cards for Mi Note collectors',
      image: 'https://cdn.lil.org/nft/mi_note_cards/cover.png',
      externalUrl: 'https://mons.shop',
      sellerFeeBasisPoints: 500,
      creators: [{ address: RECIPIENT, share: 100 }],
    },
  };
}

test('prepares mainnet and devnet configurations with explicit zero royalties', () => {
  const input = validConfig();
  const mainnet = preparePreorderCollectionConfig(input, input.collectionId);
  assert.equal(mainnet.solanaCluster, 'mainnet-beta');
  assert.equal(mainnet.authority, AUTHORITY);
  assert.equal('isMainnet' in mainnet, false);
  assert.equal('solanaRpcUrl' in mainnet, false);
  assert.deepEqual(mainnet.collectionMetadata, input.collectionMetadata);
  input.isMainnet = false;
  input.solanaRpcUrl = 'http://127.0.0.1:8899';
  input.collectionMetadata.sellerFeeBasisPoints = 0;
  const devnet = preparePreorderCollectionConfig(input, input.collectionId);
  assert.equal(devnet.solanaCluster, 'devnet');
  assert.equal(devnet.solanaRpcUrl, input.solanaRpcUrl);
  assert.equal(devnet.collectionMetadata.sellerFeeBasisPoints, 0);
});

test('unfinished configurations cannot be prepared for deployment', () => {
  const unfinished = validConfig();
  unfinished.authority = '';
  unfinished.collectionMetadataUri = '';
  unfinished.collectionMetadata.sellerFeeBasisPoints = null;
  assert.throws(
    () => preparePreorderCollectionConfig(unfinished, unfinished.collectionId),
    /authority is required/,
  );
});

test('rejects unsafe IDs before attempting to load a config', async () => {
  for (const collectionId of ['../private', 'foo/bar', 'foo\\bar', '%2e%2e', '.hidden', 'x'.repeat(65), 'constructor']) {
    await assert.rejects(
      loadPreorderCollectionConfig({ root: '/does/not/exist', collectionId }),
      /Invalid collectionId/,
    );
  }
  await assert.rejects(
    loadPreorderCollectionConfig({ root: '/does/not/exist', collectionId: '' }),
    /Missing collectionId[\s\S]*npm run deploy-preorder-collection/,
  );
});

test('requires a matching ID and explicit network', () => {
  assert.throws(() => preparePreorderCollectionConfig(validConfig(), 'other_collection'), /file name must match collectionId/);
  assert.throws(() => preparePreorderCollectionConfig({ ...validConfig(), isMainnet: 'true' }, 'mi_note_cards'), /isMainnet/);
});

test('reports each unfinished required metadata field', () => {
  for (const field of ['name', 'symbol', 'description', 'image', 'externalUrl'] as const) {
    const config = validConfig();
    config.collectionMetadata[field] = '';
    assert.throws(() => preparePreorderCollectionConfig(config, config.collectionId), new RegExp(`collectionMetadata\\.${field} is required`));
  }
  const config = validConfig();
  config.collectionMetadata.description = 'TODO: collection description';
  assert.throws(() => preparePreorderCollectionConfig(config, config.collectionId), /description is required/);
  config.collectionMetadata.description = 'Cards';
  config.collectionMetadataUri = '';
  assert.throws(() => preparePreorderCollectionConfig(config, config.collectionId), /collectionMetadataUri is required/);
});

test('rejects invalid and zero public keys for authority and royalty recipients', () => {
  for (const address of ['not-a-public-key', '11111111111111111111111111111111']) {
    const config = validConfig();
    config.authority = address;
    assert.throws(() => preparePreorderCollectionConfig(config, config.collectionId), /authority must/);
    config.authority = AUTHORITY;
    config.collectionMetadata.creators = [{ address, share: 100 }];
    assert.throws(() => preparePreorderCollectionConfig(config, config.collectionId), /creators\[0\]\.address must/);
  }
});

test('allows HTTPS or IPFS asset URLs and rejects unsupported or incomplete URLs', () => {
  const config = validConfig();
  config.collectionMetadataUri = 'ipfs://bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku/collection.json';
  config.collectionMetadata.image = 'ipfs://bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku/cover.png';
  assert.equal(preparePreorderCollectionConfig(config, config.collectionId).collectionMetadataUri, config.collectionMetadataUri);
  for (const uri of ['http://cdn.lil.org/collection.json', '/collection.json', 'ipfs://', 'https://name:secret@cdn.lil.org/collection.json', 'https://cdn.lil.org/some file.json']) {
    config.collectionMetadataUri = uri;
    assert.throws(() => preparePreorderCollectionConfig(config, config.collectionId), /collectionMetadataUri must/);
  }
  config.collectionMetadataUri = validConfig().collectionMetadataUri;
  config.collectionMetadata.externalUrl = 'ipfs://example';
  assert.throws(() => preparePreorderCollectionConfig(config, config.collectionId), /externalUrl must/);
  config.collectionMetadata.externalUrl = 'https://mons.shop';
  config.solanaRpcUrl = 'file:///tmp/rpc';
  assert.throws(() => preparePreorderCollectionConfig(config, config.collectionId), /solanaRpcUrl must/);
});

test('requires explicit integer royalties and complete unique creator percentages', () => {
  const config = validConfig();
  for (const bps of [null, undefined, '500', -1, 10_001, 0.5, NaN]) {
    assert.throws(
      () => preparePreorderCollectionConfig({ ...config, collectionMetadata: { ...config.collectionMetadata, sellerFeeBasisPoints: bps } }, config.collectionId),
      /sellerFeeBasisPoints must be an explicit integer/,
    );
  }
  for (const creators of [
    [],
    [{ address: RECIPIENT, share: 70 }],
    [{ address: RECIPIENT, share: 50 }, { address: RECIPIENT, share: 50 }],
    [{ address: RECIPIENT, share: 100 }, { address: SECOND_RECIPIENT, share: 0 }],
    [{ address: RECIPIENT, share: 70.5 }, { address: SECOND_RECIPIENT, share: 29.5 }],
  ]) {
    config.collectionMetadata.creators = creators;
    assert.throws(() => preparePreorderCollectionConfig(config, config.collectionId), /creators/);
  }
  config.collectionMetadata.creators = [{ address: RECIPIENT, share: 70 }, { address: SECOND_RECIPIENT, share: 30 }];
  assert.deepEqual(preparePreorderCollectionConfig(config, config.collectionId).collectionMetadata.creators, config.collectionMetadata.creators);
});

test('loads named exports and reports known config IDs for missing files', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'preorder-config-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'scripts', 'newPreorderCollections');
  await mkdir(directory, { recursive: true });
  const configPath = path.join(directory, 'mi_note_cards.ts');
  await writeFile(configPath, `export const NEW_PREORDER_COLLECTION = ${JSON.stringify(validConfig())};\n`);
  const loaded = await loadPreorderCollectionConfig({ root, collectionId: 'mi_note_cards' });
  assert.equal(loaded.configPath, configPath);
  assert.equal(loaded.config.collectionId, 'mi_note_cards');
  await assert.rejects(
    loadPreorderCollectionConfig({ root, collectionId: 'unknown' }),
    /Known collection configs: mi_note_cards/,
  );
  await writeFile(path.join(directory, 'missing_export.ts'), 'export const other = {};\n');
  await assert.rejects(
    loadPreorderCollectionConfig({ root, collectionId: 'missing_export' }),
    /export NEW_PREORDER_COLLECTION/,
  );
  await writeFile(path.join(directory, 'wrong_id.ts'), `export const NEW_PREORDER_COLLECTION = ${JSON.stringify(validConfig())};\n`);
  await assert.rejects(
    loadPreorderCollectionConfig({ root, collectionId: 'wrong_id' }),
    /file name must match collectionId/,
  );
});

test('usage shows the npm collection deployment command', () => {
  assert.match(preorderCollectionUsage(), /npm run deploy-preorder-collection -- <collectionId>/);
});
