import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCommerceD1DocumentRow } from '../scripts/shared/commerceD1Maintenance.ts';

function row(overrides: Record<string, unknown> = {}) {
  return {
    document_path: 'drops/card_nft_2/deliveryOrders/123',
    document_kind: 'delivery_order',
    drop_id: 'card_nft_2',
    document_id: '123',
    document_json: JSON.stringify({ deliveryId: 123, status: 'processing' }),
    version: 2,
    create_time: '2026-08-25T10:00:00.000000000Z',
    update_time: '2026-08-25T10:01:00.000000002Z',
    ...overrides,
  };
}

test('Commerce D1 document rows decode exact identity and JSON data', () => {
  const document = parseCommerceD1DocumentRow(row());
  assert.equal(document.path, 'drops/card_nft_2/deliveryOrders/123');
  assert.equal(document.kind, 'delivery_order');
  assert.equal(document.dropId, 'card_nft_2');
  assert.equal(document.documentId, '123');
  assert.equal(document.version, 2);
  assert.deepEqual(document.data, { deliveryId: 123, status: 'processing' });
});

test('Commerce D1 document rows reject malformed data and inconsistent identity', () => {
  assert.throws(() => parseCommerceD1DocumentRow(row({ document_json: '{' })), /JSON is invalid/);
  assert.throws(() => parseCommerceD1DocumentRow(row({ document_json: '[]' })), /JSON is invalid/);
  assert.throws(() => parseCommerceD1DocumentRow(row({ drop_id: 'other' })), /identity is inconsistent/);
  assert.throws(() => parseCommerceD1DocumentRow(row({ document_kind: 'claim_code' })), /identity is inconsistent/);
  assert.throws(() => parseCommerceD1DocumentRow(row({ version: 0 })), /version is invalid/);
  assert.throws(() => parseCommerceD1DocumentRow(row({ update_time: 'invalid' })), /identity is inconsistent/);
  assert.throws(() => parseCommerceD1DocumentRow(row({ document_path: 'unsupported/path' })), /path is unsupported/);
});
