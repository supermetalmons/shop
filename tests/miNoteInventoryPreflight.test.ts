import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import test from 'node:test';
import {
  BOX_MINTER_CONFIG_ACCOUNT_SIZE_DROP_SEED, BOX_MINTER_CONFIG_ACCOUNT_SIZE_SPLIT_PAYMENTS_V1,
  BOX_MINTER_CONFIG_DISCRIMINATOR, BOX_MINTER_SPLIT_PAYMENTS_V1_MAGIC, type DecodedBoxMinterConfigData,
} from '../shared/boxMinterConfigCodec.ts';
import { PREORDER_PAYMENT_RECIPIENTS } from '../shared/preorders.ts';
import type { DeploymentRegistryDrop } from '../shared/deploymentRegistry.ts';
import { validateNewMiNoteDropConfigs } from '../scripts/shared/miNoteInventoryPreflight.ts';
import { miNoteDropFixture } from './helpers/miNoteDropFixture.ts';
import { miNoteManifestFixture } from './helpers/miNoteManifest.ts';

function integer(value: number | bigint, bytes: 4 | 8): Buffer {
  const result = Buffer.alloc(bytes);
  if (bytes === 8) result.writeBigUInt64LE(BigInt(value));
  else result.writeUInt32LE(Number(value));
  return result;
}

function string(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([integer(bytes.length, 4), bytes]);
}

function encode(config: DecodedBoxMinterConfigData): Buffer {
  const base = Buffer.concat([
    Buffer.from(BOX_MINTER_CONFIG_DISCRIMINATOR), Buffer.from(config.admin), Buffer.from(config.treasury), Buffer.from(config.coreCollection),
    integer(config.priceLamports, 8), integer(config.discountPriceLamports, 8), Buffer.from(config.discountMerkleRoot),
    integer(config.maxSupply, 4), Buffer.from([config.maxPerTx, config.itemsPerBox]), integer(config.minted, 4),
    string(config.namePrefix), string(config.symbol), string(config.uriBase),
    Buffer.from([Number(config.started), config.bump, config.discountMintsPerWallet]), string(config.figureNamePrefix),
    Buffer.from([config.mintVariantKind]), ...config.mintVariantStartIds.map((id) => integer(id, 4)),
    ...config.mintVariantEndIds.map((id) => integer(id, 4)), ...config.mintVariantNextIds.map((id) => integer(id, 4)),
    ...(config.dropSeed ? [Buffer.from(config.dropSeed)] : []),
  ]);
  assert.ok(base.length <= BOX_MINTER_CONFIG_ACCOUNT_SIZE_DROP_SEED);
  const padded = Buffer.concat([base, Buffer.alloc(BOX_MINTER_CONFIG_ACCOUNT_SIZE_DROP_SEED - base.length)]);
  const routing = config.paymentRouting;
  if (routing?.schema !== 'split-payments-v1') return padded;
  const extension = Buffer.alloc(BOX_MINTER_CONFIG_ACCOUNT_SIZE_SPLIT_PAYMENTS_V1 - padded.length);
  Buffer.from(BOX_MINTER_SPLIT_PAYMENTS_V1_MAGIC).copy(extension);
  extension[8] = routing.version;
  extension[9] = routing.mintProceeds.length;
  routing.mintProceeds.forEach((recipient, index) => {
    Buffer.from(recipient.address).copy(extension, 10 + index * 32);
    extension[106 + index] = recipient.percentage;
  });
  return Buffer.concat([padded, extension]);
}

test('new inventory preflight requires both exact unstarted role configurations', async () => {
  const fixture = miNoteManifestFixture();
  const manifest = await fixture.manifest();
  const { treasury: _treasury, ...base } = miNoteDropFixture();
  const drop: DeploymentRegistryDrop = { ...base, maxSupply: manifest.packCount,
    paymentRouting: { deliveryPaymentReceiver: fixture.config.authority, mintProceeds: [
      { address: PREORDER_PAYMENT_RECIPIENTS[0], percentage: 50 }, { address: PREORDER_PAYMENT_RECIPIENTS[1], percentage: 50 },
    ] } };
  const configuration = (role: 'mint' | 'operations'): DecodedBoxMinterConfigData => ({
    admin: bs58.decode(fixture.config.authority), treasury: bs58.decode(drop.paymentRouting!.deliveryPaymentReceiver), coreCollection: bs58.decode(drop.collectionMint),
    priceLamports: 250_000_000n, discountPriceLamports: 250_000_000n, discountMerkleRoot: new Uint8Array(32), discountMintsPerWallet: 1,
    maxSupply: role === 'mint' ? manifest.packCount : 715, maxPerTx: 15, itemsPerBox: role === 'mint' ? 0 : 2,
    started: false, minted: 0, namePrefix: 'pack', figureNamePrefix: 'card', symbol: 'minote', uriBase: drop.metadataBase,
    bump: 1, mintVariantKind: 0, mintVariantStartIds: [0, 0, 0], mintVariantEndIds: [0, 0, 0], mintVariantNextIds: [0, 0, 0],
    dropSeed: createHash('sha256').update(role === 'mint' ? drop.dropId : drop.operationsConfig!.configId).digest(),
    paymentRouting: { schema: 'split-payments-v1', version: 1, deliveryPaymentReceiver: bs58.decode(drop.paymentRouting!.deliveryPaymentReceiver),
      mintProceeds: drop.paymentRouting!.mintProceeds.map(({ address, percentage }) => ({ address: bs58.decode(address), percentage })) },
  });
  const mint = configuration('mint');
  const operations = configuration('operations');
  validateNewMiNoteDropConfigs(drop, manifest, [mint, operations].map(encode));
  for (const index of [0, 1]) {
    const mismatches: Partial<DecodedBoxMinterConfigData>[] = [
      { started: true }, { minted: 1 }, { maxSupply: 123 }, { itemsPerBox: 3 },
      { admin: new Uint8Array(32) }, { coreCollection: new Uint8Array(32) }, { uriBase: `${drop.metadataBase}/other` },
      { priceLamports: 249_999_999n }, { discountPriceLamports: 1n }, { maxPerTx: 14 },
      { namePrefix: 'other' }, { figureNamePrefix: 'figure' }, { symbol: 'other' },
      { discountMintsPerWallet: 2 }, { discountMerkleRoot: new Uint8Array(32).fill(9) },
      { treasury: bs58.decode(PREORDER_PAYMENT_RECIPIENTS[0]) },
      { dropSeed: new Uint8Array(32).fill(9) }, { dropSeed: undefined },
      { mintVariantKind: 1 }, { mintVariantStartIds: [1, 0, 0] }, { mintVariantEndIds: [1, 0, 0] }, { mintVariantNextIds: [1, 0, 0] },
      { paymentRouting: { schema: 'legacy', deliveryPaymentReceiver: mint.treasury,
        mintProceeds: [{ address: mint.treasury, percentage: 100 }] } },
      { paymentRouting: { ...mint.paymentRouting!, schema: 'split-payments-v1', version: 1,
        mintProceeds: [...mint.paymentRouting!.mintProceeds].reverse() } },
      { paymentRouting: { ...mint.paymentRouting!, schema: 'split-payments-v1', version: 1,
        mintProceeds: mint.paymentRouting!.mintProceeds.map((recipient, recipientIndex) => ({ ...recipient, percentage: recipientIndex ? 40 : 60 })) } },
    ];
    for (const changed of mismatches) {
      const rows = [mint, operations];
      rows[index] = { ...rows[index], ...changed };
      assert.throws(() => validateNewMiNoteDropConfigs(drop, manifest, rows.map(encode)), /both correct configurations/);
    }
  }
  assert.throws(() => validateNewMiNoteDropConfigs(drop, manifest, [operations, mint].map(encode)), /both correct configurations/);
  assert.throws(() => validateNewMiNoteDropConfigs(drop, manifest, [encode(mint)]), /Both Mi Note role/);
  assert.throws(() => validateNewMiNoteDropConfigs({ ...drop, operationsConfig: undefined }, manifest, [mint, operations].map(encode)), /matching mint and operations/);
  assert.throws(() => validateNewMiNoteDropConfigs({ ...drop, solanaCluster: 'mainnet-beta' }, manifest, [mint, operations].map(encode)), /preorder cluster/);
  assert.throws(() => validateNewMiNoteDropConfigs({ ...drop,
    metadataBaseAliases: [`${drop.metadataBase}/alias`] }, manifest,
  [mint, { ...operations, uriBase: `${drop.metadataBase}/alias` }].map(encode)), /both correct configurations/);
});
