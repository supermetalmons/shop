import assert from 'node:assert/strict';
import test from 'node:test';
import bs58 from 'bs58';
import type { DecodedBoxMinterConfigData } from '../../../../shared/boxMinterConfigCodec.ts';
import { DEPLOYMENT_DROPS, projectDeploymentPaymentRouting } from '../../../../shared/deploymentRegistry.ts';
import { API_DROPS } from '../src/dropConfig.ts';
import { matchesCommittedDropConfig, type CommittedDropConfig } from '../src/committedDropConfig.ts';

function decodedConfig(expected: CommittedDropConfig): DecodedBoxMinterConfigData {
  const treasury = bs58.decode(expected.treasury);
  return {
    admin: new Uint8Array(32), treasury, coreCollection: bs58.decode(expected.collectionMint),
    priceLamports: 0n, discountPriceLamports: 0n, discountMerkleRoot: new Uint8Array(32),
    discountMintsPerWallet: expected.discountMintsPerWallet, maxSupply: expected.maxSupply,
    maxPerTx: 1, itemsPerBox: expected.itemsPerBox, started: true, minted: 0,
    namePrefix: '', figureNamePrefix: '', symbol: '', uriBase: expected.metadataBase,
    bump: 0, mintVariantKind: 0, mintVariantStartIds: [0, 0, 0],
    mintVariantEndIds: [0, 0, 0], mintVariantNextIds: [0, 0, 0],
    paymentRouting: expected.paymentRouting ? {
      schema: 'split-payments-v1', version: 1,
      deliveryPaymentReceiver: bs58.decode(expected.paymentRouting.deliveryPaymentReceiver),
      mintProceeds: expected.paymentRouting.mintProceeds.map((recipient) => ({
        address: bs58.decode(recipient.address), percentage: recipient.percentage,
      })),
    } : { schema: 'legacy', deliveryPaymentReceiver: treasury, mintProceeds: [{ address: treasury, percentage: 100 }] },
  };
}

test('committed configuration matches API projections and reveal payment adapters for every registered drop', () => {
  for (const [dropId, drop] of Object.entries(DEPLOYMENT_DROPS)) {
    const decoded = decodedConfig(API_DROPS[dropId]);
    assert.equal(matchesCommittedDropConfig(decoded, API_DROPS[dropId]), true, dropId);
    assert.equal(matchesCommittedDropConfig(decoded, { ...drop, ...projectDeploymentPaymentRouting(drop) }), true, dropId);
  }
});

test('committed configuration rejects each shared field mismatch and accepts configured metadata aliases', () => {
  const expected = { ...Object.values(API_DROPS)[0], metadataBaseAliases: ['https://example.com/prior/'] };
  const decoded = decodedConfig(expected);
  const differentKey = new Uint8Array(32).fill(7);
  for (const changed of [
    { coreCollection: differentKey }, { treasury: differentKey },
    { itemsPerBox: decoded.itemsPerBox + 1 }, { maxSupply: decoded.maxSupply + 1 },
    { discountMintsPerWallet: decoded.discountMintsPerWallet + 1 },
    { uriBase: 'https://example.com/unrelated/' }, { paymentRouting: undefined },
  ]) assert.equal(matchesCommittedDropConfig({ ...decoded, ...changed }, expected), false, JSON.stringify(changed));
  assert.equal(matchesCommittedDropConfig({ ...decoded, uriBase: 'https://example.com/prior/' }, expected), true);
});

test('committed configuration checks routing schema, receiver, ordered recipients and percentages', () => {
  const expected = Object.values(API_DROPS).find((drop) => drop.paymentRouting)!;
  assert.ok(expected);
  const decoded = decodedConfig(expected);
  const routing = decoded.paymentRouting!;
  assert.equal(routing.schema, 'split-payments-v1');
  const differentKey = new Uint8Array(32).fill(7);
  const recipients = routing.mintProceeds;
  for (const paymentRouting of [
    { ...routing, schema: 'legacy' as const },
    { ...routing, deliveryPaymentReceiver: differentKey },
    { ...routing, mintProceeds: recipients.slice(1) },
    { ...routing, mintProceeds: [...recipients].reverse() },
    { ...routing, mintProceeds: recipients.map((recipient, index) => index ? recipient : { ...recipient, address: differentKey }) },
    { ...routing, mintProceeds: recipients.map((recipient, index) => index ? recipient : { ...recipient, percentage: recipient.percentage + 1 }) },
  ]) assert.equal(matchesCommittedDropConfig({ ...decoded, paymentRouting }, expected), false);
  assert.equal(matchesCommittedDropConfig(decoded, { ...expected, paymentRouting: undefined }), false);
});
