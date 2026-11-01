import assert from 'node:assert/strict';
import test from 'node:test';
import { assertRepeatedGas, compareGas, summarizeGas } from './gas-comparison.mjs';

test('gas comparison accepts decreases, unchanged gas and strictly less than one percent', () => {
  const rows = compareGas({ decrease: 1000, equal: 1000, increase: 1000 },
    { decrease: 900, equal: 1000, increase: 1009 }, ['decrease', 'equal', 'increase'], 'test');
  assert.equal(rows[2].delta, 9);
  assert.equal(rows[2].percent, 0.9);
  assert.equal(summarizeGas(rows).worstPercentage.name, 'increase');
});

test('exactly one percent and larger increases fail', () => {
  for (const gas of [1010, 1011, 2000]) {
    assert.throws(() => compareGas({ operation: 1000 }, { operation: gas }, ['operation'], 'test'), /at least 1%/);
  }
});

test('integer arithmetic preserves the strict threshold at large gas values', () => {
  const reference = 8_000_000_000_000_000;
  compareGas({ operation: reference }, { operation: 8_079_999_999_999_999 }, ['operation'], 'test');
  assert.throws(() => compareGas({ operation: reference }, { operation: 8_080_000_000_000_000 }, ['operation'], 'test'), /at least 1%/);
});

test('missing or extra operation coverage cannot hide a regression', () => {
  for (const values of [{ one: 100 }, { one: 100, two: 100, extra: 100 }]) {
    assert.throws(() => compareGas({ one: 100, two: 100 }, values, ['one', 'two'], 'test'), /coverage changed/);
    assert.throws(() => compareGas(values, { one: 100, two: 100 }, ['one', 'two'], 'test'), /coverage changed/);
  }
});

test('empty, nonpositive and noninteger measurements fail', () => {
  for (const value of [0, -1, 1.5, '100', Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => compareGas({ operation: 100 }, { operation: value }, ['operation'], 'test'), /invalid gas/);
  }
  assert.throws(() => compareGas({}, {}, [], 'test'), /no measurements/);
});

test('repeat measurements require the exact same operations and values', () => {
  assertRepeatedGas({ one: 100, two: 200 }, { two: 200, one: 100 }, ['one', 'two'], 'test');
  assert.throws(() => assertRepeatedGas({ one: 100 }, { one: 101 }, ['one'], 'test'), /repeated gas changed/);
  assert.throws(() => assertRepeatedGas({ one: 100 }, {}, ['one'], 'test'), /no measurements/);
});
