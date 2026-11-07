import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseInitialDeliveryReceiver, parseProceedsConfig } from './proceeds-config.mjs';

const address = value => `0x${value.toString(16).padStart(40, '0')}`;
const configuration = count => ({
  mintRecipients: Array.from({ length: count }, (_, index) => address(0xabc000 + index)),
  mintSharesBps: Array.from({ length: count }, (_, index) => Math.floor(10_000 / count) + (index < 10_000 % count ? 1 : 0)),
});

test('committed mint split fixes all 14 receivers and allows repeated two-letter labels', () => {
  const input = JSON.parse(readFileSync(new URL('../config/proceeds.json', import.meta.url), 'utf8'));
  const expected = [
    ['bi', '0x51Ec8729331E284c4B5e8EcA8e0D184FeD18632F', 2750],
    ['Pa', '0x8B573abc736c82216D738Af3024F3a45fC3b18E3', 2600],
    ['Me', '0xE938eBB66B92692Ab01F76C99cFAc1928482e7b9', 500],
    ['Tu', '0x1B591f88d9bFcF7d057DF2c5a50b59Da2cBa349f', 500],
    ['Gr', '0x07d2d89b4A6E3fdA8858Da3510b76e2219eE6969', 500],
    ['To', '0x603C39B3D0E0f33772d79695A4F6819FCc987113', 500],
    ['na', '0xa07E7932f5C981aA769A1Cf9400B5c94AdB944c4', 100],
    ['di', '0x2236Fb6C35f78A092F0DdA655f3b49d0e8Bf6581', 100],
    ['Lu', '0x71d0318BB33d961f323C81a7a4Ca095b549F7E6E', 100],
    ['ch', '0xc4275E6D4109e0288cDc9b064E32F3f54bcDA61F', 100],
    ['mo', '0x72D0c5623A05033F9eE4495D408BC6c05DF8367d', 500],
    ['vv', '0x0AdF7B78c952E038d4eA4B5bF84B9d3D22C60Ce9', 583],
    ['vv', '0xB0B4EC16bE55af47109947F0dC84C4561A020A4B', 583],
    ['vv', '0xd9488d6687d656a55B3F1a36998d149f9b1bE2Cc', 584],
  ];
  assert.deepEqual(input.mintRecipientLabels, expected.map(([label]) => label));
  assert.deepEqual(input.mintRecipients, expected.map(([, recipient]) => recipient));
  assert.deepEqual(input.mintSharesBps, expected.map(([, , share]) => share));
  assert.equal(input.mintSharesBps.reduce((total, share) => total + share, 0), 10_000);
  for (const label of input.mintRecipientLabels) assert.match(label, /^[A-Za-z]{2}$/);
  assert.deepEqual(parseProceedsConfig(input), {
    mintRecipients: expected.map(([, recipient]) => recipient.toLowerCase()),
    mintSharesBps: expected.map(([, , share]) => share),
  });
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

test('normalizes receiver casing and rejects duplicate mint recipients at the maximum count', () => {
  const input = configuration(32);
  const mixedCase = value => `0x${value.slice(2).toUpperCase()}`;
  assert.deepEqual(parseProceedsConfig({
    ...input,
    mintRecipients: input.mintRecipients.map(mixedCase),
  }), input);
  const duplicate = [...input.mintRecipients];
  duplicate[31] = mixedCase(duplicate[0]);
  assert.throws(() => parseProceedsConfig({ ...input, mintRecipients: duplicate }), /must be distinct/);
});

test('rejects invalid, zero, and collection receiver addresses', () => {
  const input = configuration(32);
  for (const invalid of [address(0), '0x1234', 'not-an-address']) {
    const recipients = [...input.mintRecipients];
    recipients[31] = invalid;
    assert.throws(() => parseProceedsConfig({ ...input, mintRecipients: recipients }), /Invalid proceeds receiver/);
  }
  assert.throws(() => parseProceedsConfig(input, input.mintRecipients[31]), /Invalid proceeds receiver/);
});


test('initial delivery receiver normalizes casing', () => {
  const initialReceiver = address(0xdef000);
  assert.equal(parseInitialDeliveryReceiver({ initialReceiver: `0x${initialReceiver.slice(2).toUpperCase()}` }), initialReceiver);
});

test('initial delivery receiver rejects zero, malformed, collection, and mint recipient addresses', () => {
  const collection = address(0xdef001);
  const mint = configuration(32).mintRecipients;
  for (const initialReceiver of [undefined, null, address(0), '0x1234', 'not-an-address', collection, mint[0], mint[31]]) {
    assert.throws(() => parseInitialDeliveryReceiver({ initialReceiver }, collection, mint), /Invalid initial delivery receiver/);
  }
});

test('initial delivery receiver accepts only the bootstrap receiver setting', () => {
  for (const value of [null, undefined, [], false, '', {}, { receiver1: address(0xdef000) }]) {
    assert.throws(() => parseInitialDeliveryReceiver(value), /Invalid initial delivery receiver/);
  }
  const initialReceiver = address(0xdef000);
  for (const extra of [{ receiver1: initialReceiver }, { receiver2: address(0) }, { receiver2Bps: 0 }, { configId: 1 }]) {
    assert.throws(() => parseInitialDeliveryReceiver({ initialReceiver, ...extra }), /Invalid initial delivery receiver configuration/);
  }
});
