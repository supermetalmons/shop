import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseDiscountCapConfigJson } from './discount-cap-config.mjs';

const defaults = readFileSync(new URL('../config/discount-caps.json', import.meta.url), 'utf8');
const config = values => JSON.stringify({ mainnet: 500, sepolia: 5555, local: 5555, ...values });

test('committed configuration caps mainnet at 500 and retains test network capacity', () => {
  assert.equal(parseDiscountCapConfigJson(defaults, 1), 500);
  assert.equal(parseDiscountCapConfigJson(defaults, 11155111), 5555);
  assert.equal(parseDiscountCapConfigJson(defaults, 31337), 5555);
});

test('selects independent network caps including zero and the supply maximum', () => {
  const json = config({ mainnet: 0, sepolia: 42, local: 5555 });
  assert.equal(parseDiscountCapConfigJson(json, 1), 0);
  assert.equal(parseDiscountCapConfigJson(json, 11155111), 42);
  assert.equal(parseDiscountCapConfigJson(json, 31337), 5555);
  for (const chainId of [0, 10, 11155112, '1', null, undefined]) {
    assert.throws(() => parseDiscountCapConfigJson(json, chainId), /Unsupported/);
  }
});

test('rejects malformed configurations and invalid caps on every network', () => {
  for (const json of ['null', '[]', '{}', 'false', '1', '"500"', '{"mainnet":500,"sepolia":5555}',
    '{"mainnet":500,"sepolia":5555,"local":5555,"extra":1}']) {
    assert.throws(() => parseDiscountCapConfigJson(json, 1), /configuration/);
  }
  for (const network of ['mainnet', 'sepolia', 'local']) {
    for (const maximum of [-1, 5556, 1.5, '500', true, false, null, [], {}]) {
      assert.throws(() => parseDiscountCapConfigJson(config({ [network]: maximum }), 1), /integers/);
    }
  }
});

test('JSON caps use decimal integer literals consistently with Foundry', () => {
  for (const literal of ['500.0', '5e2', '5E+2']) {
    assert.throws(() => parseDiscountCapConfigJson(defaults.replace('500', literal), 1), /decimal integer/);
  }
});

test('normalizes signed zero and uses the last duplicate value like Foundry', () => {
  const fixture = readFileSync(new URL('../fixtures/discount-caps.json', import.meta.url), 'utf8');
  assert.equal(parseDiscountCapConfigJson(fixture, 1), 0);
  assert.equal(parseDiscountCapConfigJson(fixture, 11155111), 500);
  assert.equal(parseDiscountCapConfigJson(fixture, 31337), 5555);
});
