import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { Keypair, SystemProgram } from '@solana/web3.js';
import { buildDiscountMerkleData, prepareInitDropInputs } from '../scripts/deploy-all-onchain.ts';
import { resolveDeploymentDiscountAddresses } from '../scripts/shared/deploymentDiscounts.ts';
import { validateDiscountMerkleFamilyRootInvariant } from '../scripts/shared/discountMerkleDataset.ts';
import type { NewDropOnchainConfig } from '../scripts/shared/newDropConfig.ts';

const SENTINEL = SystemProgram.programId.toBase58();
const SENTINEL_ROOT = createHash('sha256').update(SystemProgram.programId.toBuffer()).digest('hex');

function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), 'deployment-discounts-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'whitelist.csv');
  const equal = { priceSol: 0.25, discountPriceSol: 0.25 };
  const configured = { ...equal, discountWhitelistCsvRelativePath: 'whitelist.csv' };
  return { root, file, equal, configured };
}

test('omitted, empty, and explicit stub CSVs produce the same deployable no-discount dataset', t => {
  const f = fixture(t);
  const omitted = resolveDeploymentDiscountAddresses({ root: f.root, config: f.equal });
  assert.deepEqual(omitted, [SENTINEL]);
  const expected = { root: SENTINEL_ROOT, proofs: { [SENTINEL]: [] } };
  for (const csv of ['', '\n \r\n\t\n', `${SENTINEL}\n`, `${SENTINEL}\n${SENTINEL}\n`]) {
    writeFileSync(f.file, csv);
    const addresses = resolveDeploymentDiscountAddresses({ root: f.root, config: f.configured });
    assert.deepEqual(addresses, omitted);
    const dataset = buildDiscountMerkleData(addresses);
    assert.deepEqual({ root: dataset.root.toString('hex'), proofs: dataset.proofs }, expected);
  }
  assert.equal(buildDiscountMerkleData([]).root.toString('hex'), '0'.repeat(64));
});

test('a named missing or blank CSV path never silently becomes a stub', t => {
  const f = fixture(t);
  assert.throws(() => resolveDeploymentDiscountAddresses({ root: f.root, config: f.configured }), /Missing discount whitelist CSV/);
  assert.throws(() => resolveDeploymentDiscountAddresses({ root: f.root, config: { ...f.equal, discountWhitelistCsvRelativePath: '' } }), /must name a CSV file/);
});

test('a lower price without real eligible wallets fails clear preflight', t => {
  const f = fixture(t);
  const discounted = { ...f.equal, discountPriceSol: 0.2 };
  assert.throws(() => resolveDeploymentDiscountAddresses({ root: f.root, config: discounted }), /discounted price requires.*real wallets/);
  for (const csv of ['', '\n', `${SENTINEL}\n`]) {
    writeFileSync(f.file, csv);
    assert.throws(() => resolveDeploymentDiscountAddresses({ root: f.root,
      config: { ...f.configured, discountPriceSol: 0.2 } }), /discounted price requires.*real wallets/);
  }
});

test('nonempty real whitelists keep their normalized addresses, Merkle root, and proofs', t => {
  const f = fixture(t);
  const addresses = [Keypair.generate().publicKey.toBase58(), Keypair.generate().publicKey.toBase58()];
  writeFileSync(f.file, ` ${addresses[0]} \n${addresses[1]}\n${addresses[0]}\n`);
  const actual = resolveDeploymentDiscountAddresses({ root: f.root, config: { ...f.configured, discountPriceSol: 0.2 } });
  assert.deepEqual(actual, addresses);
  assert.deepEqual(buildDiscountMerkleData(actual), buildDiscountMerkleData(addresses));
  assert.notEqual(buildDiscountMerkleData(actual).root.toString('hex'), SENTINEL_ROOT);
  writeFileSync(f.file, 'not-a-wallet');
  assert.throws(() => resolveDeploymentDiscountAddresses({ root: f.root, config: f.configured }));
});

test('generic initialization uses normalization before producing any initialization inputs', t => {
  const f = fixture(t);
  const dropCfg: NewDropOnchainConfig = {
    dropId: 'no_discount_test', dropFamily: 'default', metadataBase: 'https://example.com/json',
    ...f.equal, discountMintsPerWallet: 1, maxSupply: 10, itemsPerBox: 2, maxPerTx: 1,
    namePrefix: 'pack', figureNamePrefix: 'card',
  };
  const prepare = (config: NewDropOnchainConfig) => prepareInitDropInputs({ root: f.root, dropCfg: config, dropMetadataBase: dropCfg.metadataBase });
  assert.equal(prepare(dropCfg).discountMerkle.root.toString('hex'), SENTINEL_ROOT);
  writeFileSync(f.file, '');
  assert.equal(prepare({ ...dropCfg, discountWhitelistCsvRelativePath: 'whitelist.csv' }).discountMerkle.root.toString('hex'), SENTINEL_ROOT);
  assert.throws(() => prepare({ ...dropCfg, discountPriceSol: 0.1 }), /discounted price requires.*real wallets/);
});

test('normalized no-discount roots can span families but ordinary roots remain unique', t => {
  const f = fixture(t);
  const rootHex = buildDiscountMerkleData(resolveDeploymentDiscountAddresses({ root: f.root, config: f.equal })).root.toString('hex');
  assert.equal(validateDiscountMerkleFamilyRootInvariant([
    { dropFamily: 'first_drop', rootHex }, { dropFamily: 'second_drop', rootHex },
  ]).length, 2);
  const ordinaryRoot = buildDiscountMerkleData([Keypair.generate().publicKey.toBase58()]).root.toString('hex');
  assert.throws(() => validateDiscountMerkleFamilyRootInvariant([
    { dropFamily: 'first_drop', rootHex: ordinaryRoot }, { dropFamily: 'second_drop', rootHex: ordinaryRoot },
  ]), /conflicting families/);
});
