import assert from 'node:assert/strict';
import test from 'node:test';
import {
  summarizePayloadShape,
  summarizeValueShape,
} from '../functions/src/shared/logSummaries.ts';

test('shared log summaries preserve value shape labels', () => {
  assert.equal(summarizeValueShape(null), 'null');
  assert.equal(summarizeValueShape(['a', 'b']), 'array(2)');
  assert.equal(summarizeValueShape('hello'), 'string(5)');
  assert.equal(summarizeValueShape(3), 'number');
  assert.equal(summarizeValueShape(undefined), 'undefined');
});

test('shared payload summaries preserve the 30-key truncation boundary', () => {
  assert.deepEqual(summarizePayloadShape('hello'), {
    type: 'string(5)',
  });

  const payload = Object.fromEntries(
    Array.from({ length: 31 }, (_, index) => [
      `key${index}`,
      index === 0 ? ['a', 'b'] : index,
    ]),
  );
  const summary = summarizePayloadShape(payload);
  assert.equal(summary.keys?.length, 30);
  assert.equal(summary.types?.key0, 'array(2)');
  assert.equal(summary.types?.key29, 'number');
  assert.equal(summary.types?.key30, undefined);
  assert.equal(summary.truncated, true);
});
