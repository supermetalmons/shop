import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import {
  readFrontendDropRegistry,
  readFunctionsDropRegistry,
  renderFrontendDeploymentRegistryFile,
  renderFunctionsDeploymentRegistryFile,
} from '../scripts/shared/deploymentRegistry.ts';

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
