import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';
import { NEW_DROP_INPUT as PACK_INPUT } from '../scripts/templates/newDrops/dedicatedPack.ts';
import { NEW_DROP_INPUT as VARIANTS_INPUT } from '../scripts/templates/newDrops/directVariants.ts';
import { NEW_DROP_INPUT as RECEIPTS_INPUT } from '../scripts/templates/newDrops/pooledReceiptOnly.ts';
import { defineNewDropConfig, type NewDropConfigInput } from '../scripts/shared/newDropConfig.ts';
import { loadNewDropConfigById } from '../scripts/shared/newDropLoader.ts';

const TEST_MINT_RECIPIENT_A = new PublicKey(new Uint8Array(32).fill(17)).toBase58();
const TEST_MINT_RECIPIENT_B = new PublicKey(new Uint8Array(32).fill(18)).toBase58();
const TEST_TREASURY = new PublicKey(new Uint8Array(32).fill(19)).toBase58();

test('new-drop templates default to equal prices without requiring a discount CSV', () => {
  for (const template of [PACK_INPUT, VARIANTS_INPUT, RECEIPTS_INPUT]) {
    assert.equal(template.onchain.discountPriceSol, template.onchain.priceSol);
    assert.equal(Object.hasOwn(template.onchain, 'discountWhitelistCsvRelativePath'), false);
  }
});

function customizedPackInput(): NewDropConfigInput {
  return {
    ...PACK_INPUT,
    onchain: {
      ...PACK_INPUT.onchain,
      dropId: 'template_pack_test',
      metadataBase: 'https://example.com/template_pack_test/json/',
      discountWhitelistCsvRelativePath: 'test-fixtures/template_pack_test.csv',
      collectionMetadata: {
        name: 'Template Pack Test',
        image: 'https://example.com/template_pack_test/cover.png',
      },
      paymentRouting: {
        mintProceeds: [
          { address: TEST_MINT_RECIPIENT_A, percentage: 70 },
          { address: TEST_MINT_RECIPIENT_B, percentage: 30 },
        ],
        deliveryPaymentReceiver: TEST_TREASURY,
      },
    },
  };
}

test('dedicated pack template normalizes customized split routing and collection policy', () => {
  const input = customizedPackInput();
  const before = structuredClone(input);
  const drop = defineNewDropConfig(input);

  assert.equal(drop.deploy.solanaCluster, 'devnet');
  assert.equal(drop.deploy.reuseProgramId, false);
  assert.equal(drop.onchain.dropId, 'template_pack_test');
  assert.equal(drop.onchain.metadataBase, 'https://example.com/template_pack_test/json');
  assert.equal(drop.onchain.itemsPerBox, 3);
  assert.equal(drop.onchain.treasury, undefined);
  assert.deepEqual(drop.onchain.paymentRouting, input.onchain.paymentRouting);
  assert.notEqual(drop.onchain.paymentRouting, input.onchain.paymentRouting);
  assert.equal(drop.onchain.collectionMetadata?.symbol, 'pack');
  assert.equal(drop.onchain.collectionMetadata?.sellerFeeBasisPoints, 500);
  assert.equal(drop.onchain.coreCollectionRoyaltiesBps, 500);
  assert.equal(drop.onchain.receiptPoolId, undefined);
  assert.deepEqual(input, before);
  assert.equal(PACK_INPUT.onchain.paymentRouting.deliveryPaymentReceiver, 'REPLACE_DELIVERY_RECEIVER');
});

test('direct variant template retains contiguous size ranges and a single treasury', () => {
  const input = {
    ...VARIANTS_INPUT,
    onchain: {
      ...VARIANTS_INPUT.onchain,
      dropId: 'template_variants_test',
      metadataBase: 'https://example.com/template_variants_test/json/',
      discountWhitelistCsvRelativePath: 'test-fixtures/template_variants_test.csv',
      collectionMetadata: { name: 'Template Variants Test' },
      treasury: TEST_TREASURY,
    },
  } satisfies NewDropConfigInput;
  const drop = defineNewDropConfig(input);

  assert.equal(drop.deploy.solanaCluster, 'devnet');
  assert.equal(drop.onchain.dropId, 'template_variants_test');
  assert.equal(drop.onchain.metadataBase, 'https://example.com/template_variants_test/json');
  assert.equal(drop.onchain.itemsPerBox, 0);
  assert.equal(drop.onchain.treasury, TEST_TREASURY);
  assert.equal(drop.onchain.paymentRouting, undefined);
  assert.equal(drop.onchain.collectionMetadata?.symbol, 'item');
  assert.equal(drop.onchain.mintSelection?.kind, 'size');
  const options = drop.onchain.mintSelection!.options;
  assert.equal(options.length, 3);
  assert.equal(options[0].startId, 1);
  assert.equal(options.at(-1)!.endId, drop.onchain.maxSupply);
  options.slice(1).forEach((option, index) => {
    assert.equal(option.startId, options[index].endId + 1);
  });
});

test('pooled receipt template retains Stripe-only sentinel pricing without dedicated resources', () => {
  const input = {
    ...RECEIPTS_INPUT,
    onchain: {
      ...RECEIPTS_INPUT.onchain,
      dropId: 'template_receipts_test',
      displayName: 'Template Receipts Test',
      receiptPoolId: ' TEMPLATE_RECEIPT_POOL_TEST ',
      metadataBase: 'https://example.com/template_receipts_test/json/',
      discountWhitelistCsvRelativePath: 'test-fixtures/template_receipts_test.csv',
      treasury: TEST_TREASURY,
      stripeLiveUnitAmountCents: 2500,
      stripeProductTaxCode: 'txcd_99999999',
    },
  } satisfies NewDropConfigInput;
  const drop = defineNewDropConfig(input);

  assert.equal(drop.deploy.solanaCluster, 'devnet');
  assert.equal(drop.onchain.dropId, 'template_receipts_test');
  assert.equal(drop.onchain.receiptPoolId, 'template_receipt_pool_test');
  assert.equal(drop.onchain.metadataBase, 'https://example.com/template_receipts_test/json');
  assert.equal(drop.onchain.salesMode, 'stripe_receipt_only');
  assert.equal(drop.onchain.stripeCheckoutEnabled, true);
  assert.equal(drop.onchain.stripeLiveUnitAmountCents, 2500);
  assert.equal(drop.onchain.priceSol, 1_000_000);
  assert.equal(drop.onchain.discountPriceSol, 1_000_000);
  assert.equal(drop.onchain.itemsPerBox, 0);
  assert.equal(drop.onchain.maxPerTx, 1);
  assert.equal(drop.onchain.mintSelection, undefined);
  assert.equal(drop.onchain.symbol, undefined);
  assert.equal(drop.onchain.collectionMetadata, undefined);
  assert.equal(drop.onchain.coreCollectionRoyaltiesBps, undefined);
  assert.equal(drop.onchain.receiptsTree, undefined);
});

test('new-drop discovery excludes templates and reads only explicitly created drop configs', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'mons-shop-template-discovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const templatesDirectory = path.join(root, 'scripts', 'templates', 'newDrops');
  const configsDirectory = path.join(root, 'scripts', 'newDrops');
  mkdirSync(templatesDirectory, { recursive: true });
  mkdirSync(configsDirectory, { recursive: true });
  writeFileSync(path.join(configsDirectory, 'README.md'), 'New drop configuration\n');

  for (const name of ['dedicatedPack', 'directVariants', 'pooledReceiptOnly']) {
    copyFileSync(
      new URL(`../scripts/templates/newDrops/${name}.ts`, import.meta.url),
      path.join(templatesDirectory, `${name}.ts`),
    );
    await assert.rejects(
      loadNewDropConfigById({ root, dropId: name.toLowerCase() }),
      /Could not find a new drop config[\s\S]*Known drop configs: \(none\)/,
    );
  }

  const config = defineNewDropConfig(customizedPackInput());
  const configPath = path.join(configsDirectory, `${config.onchain.dropId}.ts`);
  writeFileSync(configPath, `export const NEW_DROP = ${JSON.stringify(config)};\n`);
  const loaded = await loadNewDropConfigById({ root, dropId: config.onchain.dropId });
  assert.deepEqual(loaded.config, config);
  assert.deepEqual(loaded.knownDropIds, ['template_pack_test']);
  assert.equal(loaded.configPath, configPath);
});
