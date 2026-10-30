import assert from 'node:assert/strict';
import test from 'node:test';
import { parseProceedsConfig } from './proceeds-config.mjs';

const address = value => `0x${value.toString(16).padStart(40, '0')}`;
const configuration = count => ({
  mintRecipients: Array.from({ length: count }, (_, index) => address(0xabc000 + index)),
  mintSharesBps: Array.from({ length: count }, (_, index) => Math.floor(10_000 / count) + (index < 10_000 % count ? 1 : 0)),
  deliveryPaymentReceiver: address(0xdef000),
});

test('accepts all supported recipient counts with exact total shares', () => {
  for (let count = 2; count <= 32; count++) {
    const input = configuration(count);
    const parsed = parseProceedsConfig(input);
    assert.deepEqual(parsed, input);
    assert.notEqual(parsed.mintRecipients, input.mintRecipients);
    assert.notEqual(parsed.mintSharesBps, input.mintSharesBps);
  }
});

test('rejects unsupported counts and invalid basis point allocations', () => {
  for (const count of [0, 1, 33]) {
    assert.throws(() => parseProceedsConfig(configuration(count)), /Invalid mint proceeds split/);
  }
  for (const shares of [[5000], [5000, 0], [5000, 5001], [5000.5, 4999.5], [10001, -1]]) {
    assert.throws(() => parseProceedsConfig({ ...configuration(2), mintSharesBps: shares }), /Invalid mint proceeds split/);
  }
});

test('normalizes receiver casing and rejects duplicates or delivery overlap at the maximum count', () => {
  const input = configuration(32);
  const mixedCase = value => `0x${value.slice(2).toUpperCase()}`;
  assert.deepEqual(parseProceedsConfig({
    ...input,
    mintRecipients: input.mintRecipients.map(mixedCase),
    deliveryPaymentReceiver: mixedCase(input.deliveryPaymentReceiver),
  }), input);
  const duplicate = [...input.mintRecipients];
  duplicate[31] = mixedCase(duplicate[0]);
  assert.throws(() => parseProceedsConfig({ ...input, mintRecipients: duplicate }), /must be distinct/);
  assert.throws(() => parseProceedsConfig({ ...input, deliveryPaymentReceiver: mixedCase(input.mintRecipients[31]) }), /must be distinct/);
});

test('rejects invalid, zero, and collection receiver addresses', () => {
  const input = configuration(32);
  for (const invalid of [address(0), '0x1234', 'not-an-address']) {
    const recipients = [...input.mintRecipients];
    recipients[31] = invalid;
    assert.throws(() => parseProceedsConfig({ ...input, mintRecipients: recipients }), /Invalid proceeds receiver/);
    assert.throws(() => parseProceedsConfig({ ...input, deliveryPaymentReceiver: invalid }), /Invalid proceeds receiver/);
  }
  assert.throws(() => parseProceedsConfig(input, input.mintRecipients[31]), /Invalid proceeds receiver/);
  assert.throws(() => parseProceedsConfig(input, input.deliveryPaymentReceiver), /Invalid proceeds receiver/);
});
