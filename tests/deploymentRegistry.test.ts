import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import {
  canonicalizeDropAssetUrl,
  dropPathsFromBase as dropPathsFromRegistryBase,
  normalizeAndValidateMetadataBaseInput,
  normalizeDropBase as normalizeRegistryDropBase,
  resolveDropAssetUrl,
  readFrontendDropRegistry,
  readFunctionsDropRegistry,
  renderFrontendDeploymentRegistryFile,
  renderFunctionsDeploymentRegistryFile,
} from '../scripts/shared/deploymentRegistry.ts';
import { defineNewDropConfig } from '../scripts/shared/newDropConfig.ts';
import {
  boxIdFromMetadataUri as frontendBoxIdFromMetadataUri,
  canonicalMetadataBase as frontendCanonicalMetadataBase,
  dudeIdFromMetadataUri as frontendDudeIdFromMetadataUri,
  metadataBaseFromMetadataUri as frontendMetadataBaseFromMetadataUri,
  metadataKindFromUri as frontendMetadataKindFromUri,
  selectMetadataUri as frontendSelectMetadataUri,
} from '../src/lib/dropMetadataUri.ts';
import {
  boxIdFromMetadataUri as functionsBoxIdFromMetadataUri,
  canonicalMetadataBase as functionsCanonicalMetadataBase,
  dudeIdFromMetadataUri as functionsDudeIdFromMetadataUri,
  metadataBaseFromMetadataUri as functionsMetadataBaseFromMetadataUri,
  metadataKindFromUri as functionsMetadataKindFromUri,
  selectMetadataUri as functionsSelectMetadataUri,
} from '../functions/src/dropMetadataUri.ts';

const VALID_IPFS_CID = 'bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku';

async function withTempModule(source: string, run: (filePath: string) => Promise<void>, extension = '.mjs') {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'deployment-registry-test-'));
  const filePath = path.join(dir, `registry${extension}`);
  try {
    await writeFile(filePath, source, 'utf8');
    await run(filePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('readFrontendDropRegistry preserves explicit boxMinterConfigPda', async () => {
  await withTempModule(
    `export const FRONTEND_DROPS = {
      shared_drop: {
        solanaCluster: 'devnet',
        dropId: 'shared_drop',
        dropFamily: 'default',
        collectionName: 'Shared Drop',
        metadataBase: 'https://assets.example.com/drops/shared',
        treasury: 'Treasury11111111111111111111111111111111',
        priceSol: 1,
        discountPriceSol: 0.5,
        discountMintsPerWallet: 1,
        discountMerkleRoot: '00'.repeat(32),
        maxSupply: 10,
        itemsPerBox: 1,
        maxPerTx: 5,
        namePrefix: 'box',
        figureNamePrefix: 'figure',
        symbol: 'mons',
        boxMinterProgramId: 'Program1111111111111111111111111111111111',
        boxMinterConfigPda: 'Config11111111111111111111111111111111111',
        collectionMint: 'Collection11111111111111111111111111111111',
      },
    };`,
    async (filePath) => {
      const registry = await readFrontendDropRegistry(filePath);
      assert.equal(registry.drops.shared_drop.boxMinterConfigPda, 'Config11111111111111111111111111111111111');
      assert.equal(registry.drops.shared_drop.metadataPathFormat, 'legacy');
    },
  );
});

test('readFunctionsDropRegistry keeps legacy entries without boxMinterConfigPda', async () => {
  await withTempModule(
    `export const FUNCTIONS_DROPS = {
      legacy_drop: {
        solanaCluster: 'devnet',
        dropId: 'legacy_drop',
        dropFamily: 'default',
        collectionName: 'Legacy Drop',
        metadataBase: 'https://assets.example.com/drops/legacy',
        treasury: 'Treasury11111111111111111111111111111111',
        priceSol: 1,
        discountPriceSol: 0.5,
        discountMintsPerWallet: 1,
        discountMerkleRoot: '11'.repeat(32),
        maxSupply: 10,
        itemsPerBox: 1,
        maxPerTx: 5,
        namePrefix: 'box',
        figureNamePrefix: 'figure',
        symbol: 'mons',
        boxMinterProgramId: 'Program1111111111111111111111111111111111',
        collectionMint: 'Collection11111111111111111111111111111111',
        receiptsMerkleTree: 'Tree111111111111111111111111111111111111',
        deliveryLookupTable: 'Lookup1111111111111111111111111111111111',
      },
    };`,
    async (filePath) => {
      const registry = await readFunctionsDropRegistry(filePath);
      assert.equal(registry.drops.legacy_drop.boxMinterConfigPda, undefined);
      assert.equal(registry.drops.legacy_drop.boxMinterProgramId, 'Program1111111111111111111111111111111111');
      assert.equal(registry.drops.legacy_drop.metadataPathFormat, 'legacy');
    },
  );
});

test('renderFrontendDeploymentRegistryFile rejects shared-program drops without explicit boxMinterConfigPda', async () => {
  const source = renderFrontendDeploymentRegistryFile({
    drops: {
      alpha: {
        solanaCluster: 'devnet',
        dropId: 'alpha',
        dropFamily: 'default',
        collectionName: 'Alpha',
        metadataBase: 'https://assets.example.com/drops/alpha',
        metadataPathFormat: 'legacy',
        treasury: 'Treasury11111111111111111111111111111111',
        priceSol: 1,
        discountPriceSol: 0.5,
        discountMintsPerWallet: 1,
        discountMerkleRoot: 'aa'.repeat(32),
        maxSupply: 10,
        itemsPerBox: 1,
        maxPerTx: 5,
        namePrefix: 'box',
        figureNamePrefix: 'figure',
        symbol: 'mons',
        boxMinterProgramId: 'Program1111111111111111111111111111111111',
        collectionMint: 'Collection11111111111111111111111111111111',
      },
      beta: {
        solanaCluster: 'devnet',
        dropId: 'beta',
        dropFamily: 'default',
        collectionName: 'Beta',
        metadataBase: 'https://assets.example.com/drops/beta',
        metadataPathFormat: 'legacy',
        treasury: 'Treasury11111111111111111111111111111111',
        priceSol: 1,
        discountPriceSol: 0.5,
        discountMintsPerWallet: 1,
        discountMerkleRoot: 'bb'.repeat(32),
        maxSupply: 10,
        itemsPerBox: 1,
        maxPerTx: 5,
        namePrefix: 'box',
        figureNamePrefix: 'figure',
        symbol: 'mons',
        boxMinterProgramId: 'Program1111111111111111111111111111111111',
        collectionMint: 'Collection22222222222222222222222222222222',
      },
    },
  });

  await withTempModule(
    source,
    async (filePath) => {
      const moduleUrl = `${pathToFileURL(filePath).href}?t=${Date.now()}`;
      await assert.rejects(import(moduleUrl), /must set boxMinterConfigPda/);
    },
    '.ts',
  );
});

test('renderFunctionsDeploymentRegistryFile rejects shared-program drops without explicit boxMinterConfigPda', async () => {
  const source = renderFunctionsDeploymentRegistryFile({
    drops: {
      alpha: {
        solanaCluster: 'devnet',
        dropId: 'alpha',
        dropFamily: 'default',
        collectionName: 'Alpha',
        metadataBase: 'https://assets.example.com/drops/alpha',
        metadataPathFormat: 'legacy',
        treasury: 'Treasury11111111111111111111111111111111',
        priceSol: 1,
        discountPriceSol: 0.5,
        discountMintsPerWallet: 1,
        discountMerkleRoot: 'aa'.repeat(32),
        maxSupply: 10,
        itemsPerBox: 1,
        maxPerTx: 5,
        namePrefix: 'box',
        figureNamePrefix: 'figure',
        symbol: 'mons',
        boxMinterProgramId: 'Program1111111111111111111111111111111111',
        collectionMint: 'Collection11111111111111111111111111111111',
        receiptsMerkleTree: 'Tree111111111111111111111111111111111111',
        deliveryLookupTable: 'Lookup1111111111111111111111111111111111',
      },
      beta: {
        solanaCluster: 'devnet',
        dropId: 'beta',
        dropFamily: 'default',
        collectionName: 'Beta',
        metadataBase: 'https://assets.example.com/drops/beta',
        metadataPathFormat: 'legacy',
        treasury: 'Treasury11111111111111111111111111111111',
        priceSol: 1,
        discountPriceSol: 0.5,
        discountMintsPerWallet: 1,
        discountMerkleRoot: 'bb'.repeat(32),
        maxSupply: 10,
        itemsPerBox: 1,
        maxPerTx: 5,
        namePrefix: 'box',
        figureNamePrefix: 'figure',
        symbol: 'mons',
        boxMinterProgramId: 'Program1111111111111111111111111111111111',
        collectionMint: 'Collection22222222222222222222222222222222',
        receiptsMerkleTree: 'Tree222222222222222222222222222222222222',
        deliveryLookupTable: 'Lookup2222222222222222222222222222222222',
      },
    },
  });

  await withTempModule(
    source,
    async (filePath) => {
      const moduleUrl = `${pathToFileURL(filePath).href}?t=${Date.now()}`;
      await assert.rejects(import(moduleUrl), /must set boxMinterConfigPda/);
    },
    '.ts',
  );
});

test('normalizeDropBase canonicalizes raw IPFS CID and preserves explicit bases', () => {
  assert.equal(normalizeRegistryDropBase(VALID_IPFS_CID), `ipfs://${VALID_IPFS_CID}`);
  assert.equal(normalizeRegistryDropBase(`ipfs://${VALID_IPFS_CID}/`), `ipfs://${VALID_IPFS_CID}`);
  assert.equal(
    normalizeRegistryDropBase('https://assets.example.com/drops/alpha/'),
    'https://assets.example.com/drops/alpha',
  );
  assert.equal(normalizeRegistryDropBase('banana'), 'banana');
});

test('dropPathsFromBase derives compact metadata filenames', () => {
  const paths = dropPathsFromRegistryBase(VALID_IPFS_CID);
  assert.deepEqual(paths, {
    base: `ipfs://${VALID_IPFS_CID}`,
    collectionJson: `ipfs://${VALID_IPFS_CID}/collection.json`,
    boxesJsonBase: `ipfs://${VALID_IPFS_CID}/b`,
    figuresJsonBase: `ipfs://${VALID_IPFS_CID}/f`,
    receiptsBoxesJsonBase: `ipfs://${VALID_IPFS_CID}/rb`,
    receiptsFiguresJsonBase: `ipfs://${VALID_IPFS_CID}/rf`,
  });
});

test('dropPathsFromBase derives legacy metadata filenames when requested', () => {
  const paths = dropPathsFromRegistryBase('https://assets.example.com/drops/alpha', 'legacy');
  assert.deepEqual(paths, {
    base: 'https://assets.example.com/drops/alpha',
    collectionJson: 'https://assets.example.com/drops/alpha/collection.json',
    boxesJsonBase: 'https://assets.example.com/drops/alpha/json/boxes/',
    figuresJsonBase: 'https://assets.example.com/drops/alpha/json/figures/',
    receiptsBoxesJsonBase: 'https://assets.example.com/drops/alpha/json/receipts/boxes/',
    receiptsFiguresJsonBase: 'https://assets.example.com/drops/alpha/json/receipts/figures/',
  });
});

test('IPFS URL helpers canonicalize gateway URLs and resolve HTTP fetch URLs', () => {
  assert.equal(
    canonicalizeDropAssetUrl(`https://nftstorage.link/ipfs/${VALID_IPFS_CID}/f12.json`),
    `ipfs://${VALID_IPFS_CID}/f12.json`,
  );
  assert.equal(
    resolveDropAssetUrl(`ipfs://${VALID_IPFS_CID}/rf12.json`),
    `https://dweb.link/ipfs/${VALID_IPFS_CID}/rf12.json`,
  );
});

test('frontend metadata URI helpers accept legacy and compact formats', () => {
  assert.equal(frontendMetadataKindFromUri('https://assets.example.com/drops/alpha/json/boxes/12.json'), 'box');
  assert.equal(frontendMetadataKindFromUri(`ipfs://${VALID_IPFS_CID}/b12.json`), 'box');
  assert.equal(frontendMetadataKindFromUri(`ipfs://${VALID_IPFS_CID}/f34.json`), 'dude');
  assert.equal(frontendMetadataKindFromUri(`ipfs://${VALID_IPFS_CID}/rf56.json`), 'certificate');
  assert.equal(frontendBoxIdFromMetadataUri(`ipfs://${VALID_IPFS_CID}/rb12.json`), '12');
  assert.equal(frontendDudeIdFromMetadataUri(`ipfs://${VALID_IPFS_CID}/f34.json`), 34);
  assert.equal(
    frontendMetadataBaseFromMetadataUri(`https://nftstorage.link/ipfs/${VALID_IPFS_CID}/f34.json`),
    `ipfs://${VALID_IPFS_CID}`,
  );
  assert.equal(
    frontendMetadataBaseFromMetadataUri('https://assets.example.com/drops/alpha/json/figures/34.json'),
    'https://assets.example.com/drops/alpha',
  );
  assert.equal(
    frontendCanonicalMetadataBase(`https://nftstorage.link/ipfs/${VALID_IPFS_CID}`),
    `ipfs://${VALID_IPFS_CID}`,
  );
  assert.equal(
    frontendSelectMetadataUri(
      `https://dweb.link/ipfs/${VALID_IPFS_CID}/f34.json`,
      'https://assets.example.com/drops/alpha/json/figures/99.json',
    ),
    `ipfs://${VALID_IPFS_CID}/f34.json`,
  );
  assert.equal(
    frontendSelectMetadataUri(
      'https://assets.example.com/images/preview.webp',
      `https://dweb.link/ipfs/${VALID_IPFS_CID}/f34.json`,
    ),
    'https://assets.example.com/images/preview.webp',
  );
});

test('functions metadata URI helpers accept legacy and compact formats', () => {
  assert.equal(functionsMetadataKindFromUri('https://assets.example.com/drops/alpha/json/receipts/boxes/12.json'), 'certificate');
  assert.equal(functionsMetadataKindFromUri(`ipfs://${VALID_IPFS_CID}/rb12.json`), 'certificate');
  assert.equal(functionsBoxIdFromMetadataUri(`ipfs://${VALID_IPFS_CID}/b7.json`), '7');
  assert.equal(functionsDudeIdFromMetadataUri(`ipfs://${VALID_IPFS_CID}/rf9.json`), 9);
  assert.equal(
    functionsMetadataBaseFromMetadataUri(`https://dweb.link/ipfs/${VALID_IPFS_CID}/rf9.json`),
    `ipfs://${VALID_IPFS_CID}`,
  );
  assert.equal(
    functionsCanonicalMetadataBase(`https://nftstorage.link/ipfs/${VALID_IPFS_CID}`),
    `ipfs://${VALID_IPFS_CID}`,
  );
  assert.equal(
    functionsSelectMetadataUri(
      `https://dweb.link/ipfs/${VALID_IPFS_CID}/b7.json`,
      'https://assets.example.com/drops/alpha/json/boxes/12.json',
    ),
    `ipfs://${VALID_IPFS_CID}/b7.json`,
  );
  assert.equal(
    functionsSelectMetadataUri(
      'https://assets.example.com/images/preview.webp',
      `https://dweb.link/ipfs/${VALID_IPFS_CID}/rf9.json`,
    ),
    'https://assets.example.com/images/preview.webp',
  );
});

test('renderFrontendDeploymentRegistryFile derives legacy paths from metadataPathFormat', async () => {
  const source = renderFrontendDeploymentRegistryFile({
    drops: {
      legacy_alpha: {
        solanaCluster: 'devnet',
        dropId: 'legacy_alpha',
        dropFamily: 'default',
        collectionName: 'Legacy Alpha',
        metadataBase: 'https://assets.example.com/drops/alpha',
        metadataPathFormat: 'legacy',
        treasury: 'Treasury11111111111111111111111111111111',
        priceSol: 1,
        discountPriceSol: 0.5,
        discountMintsPerWallet: 1,
        discountMerkleRoot: 'aa'.repeat(32),
        maxSupply: 10,
        itemsPerBox: 1,
        maxPerTx: 5,
        namePrefix: 'box',
        figureNamePrefix: 'figure',
        symbol: 'mons',
        boxMinterProgramId: 'Program1111111111111111111111111111111111',
        collectionMint: 'Collection11111111111111111111111111111111',
      },
    },
  });

  await withTempModule(
    source,
    async (filePath) => {
      const moduleUrl = `${pathToFileURL(filePath).href}?t=${Date.now()}`;
      const mod = (await import(moduleUrl)) as { getFrontendDrop(dropId: string): { paths: { figuresJsonBase: string } } };
      const drop = mod.getFrontendDrop('legacy_alpha');
      assert.equal(drop.paths.figuresJsonBase, 'https://assets.example.com/drops/alpha/json/figures/');
    },
    '.ts',
  );
});

test('defineNewDropConfig rejects invalid bare metadataBase strings', () => {
  assert.throws(
    () =>
      defineNewDropConfig({
        shared: {
          isMainnet: false,
          dropSymbol: 'mons',
          sellerFeeBasisPoints: 500,
        },
        deploy: {
          reuseProgramId: false,
        },
        onchain: {
          dropId: 'bad_drop',
          dropFamily: 'default',
          metadataBase: 'banana',
          collectionMetadata: {
            name: 'Bad Drop',
          },
          discountWhitelistCsvRelativePath: 'discounts.csv',
          receiptsTree: {
            maxDepth: 14,
            maxBufferSize: 64,
            canopyDepth: 10,
          },
          priceSol: 1,
          discountPriceSol: 0.5,
          discountMintsPerWallet: 1,
          maxSupply: 10,
          itemsPerBox: 1,
          maxPerTx: 5,
          namePrefix: 'box',
          figureNamePrefix: 'figure',
        },
      }),
    /Invalid metadataBase/,
  );
});

test('normalizeAndValidateMetadataBaseInput rejects query strings and fragments', () => {
  assert.throws(
    () => normalizeAndValidateMetadataBaseInput('https://assets.example.com/drops/alpha?filename=drop'),
    /without query strings or fragments/,
  );
  assert.throws(
    () => normalizeAndValidateMetadataBaseInput('https://assets.example.com/drops/alpha#collection'),
    /without query strings or fragments/,
  );
  assert.throws(
    () => normalizeAndValidateMetadataBaseInput(`ipfs://${VALID_IPFS_CID}?filename=drop`),
    /without query strings or fragments/,
  );
  assert.throws(
    () => normalizeAndValidateMetadataBaseInput(`ipfs://${VALID_IPFS_CID}#collection`),
    /without query strings or fragments/,
  );
});

test('defineNewDropConfig accepts metadataBase roots with compact-like terminal segments', () => {
  const validBases = [
    'https://assets.example.com/drops/b',
    'https://assets.example.com/drops/f',
    `ipfs://${VALID_IPFS_CID}/rb`,
    `ipfs://${VALID_IPFS_CID}/rf`,
  ];

  validBases.forEach((metadataBase) => {
    const config = defineNewDropConfig({
      shared: {
        isMainnet: false,
        dropSymbol: 'mons',
        sellerFeeBasisPoints: 500,
      },
      deploy: {
        reuseProgramId: false,
      },
      onchain: {
        dropId: 'good_drop',
        dropFamily: 'default',
        metadataBase,
        collectionMetadata: {
          name: 'Good Drop',
        },
        discountWhitelistCsvRelativePath: 'discounts.csv',
        receiptsTree: {
          maxDepth: 14,
          maxBufferSize: 64,
          canopyDepth: 10,
        },
        priceSol: 1,
        discountPriceSol: 0.5,
        discountMintsPerWallet: 1,
        maxSupply: 10,
        itemsPerBox: 1,
        maxPerTx: 5,
        namePrefix: 'box',
        figureNamePrefix: 'figure',
      },
    });
    assert.equal(config.onchain.metadataBase, metadataBase);
  });
});
