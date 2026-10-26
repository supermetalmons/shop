import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createTestHarness, unstable_splitSqlQuery } from 'wrangler';

test('local D1 evaluates populated frozen-metadata UUID guards within its GLOB limit', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'mons-frozen-metadata-guards-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const main = join(directory, 'worker.js');
  const { compatibility_date } = JSON.parse(readFileSync('cloud/workers/api/wrangler.jsonc', 'utf8'));
  writeFileSync(main, "export default { fetch() { return new Response('ok'); } };\n");
  const server = createTestHarness({ root: resolve('.'), workers: [{ config: {
    name: 'frozen-metadata-guards', main, compatibility_date,
    d1_databases: [{ binding: 'DB', database_name: 'frozen-metadata-guards',
      database_id: '00000000-0000-4000-8000-000000000046', remote: false }],
  } }] });
  try {
    await server.listen();
    const { DB: db } = await server.getWorker<{ DB: D1Database }>('frozen-metadata-guards').getEnv();
    const statements = unstable_splitSqlQuery(readFileSync(resolve('cloud/workers/api/commerce-migrations/0046_frozen_commerce_metadata_cleanup.sql'), 'utf8'));
    const uuid = 'ABCDEFAB-CDEF-4ABC-BDEF-ABCDEFABCDEF';
    const document = { document_path: 'drops/drop/deliveryOrders/1', document_kind: 'delivery_order', drop_id: 'drop', document_id: '1' };
    const pack = { parent_path: document.document_path, drop_id: 'drop', generation: uuid };
    const notification = { parent_path: document.document_path, drop_id: 'drop', family: 'ready', generation: uuid,
      claim_id: uuid, claim_expires_at_ms: 300, next_attempt_at_ms: 300, state: 'pending', outcome: null,
      entries_json: JSON.stringify([{ kind: 'buyer_order_received', jobId: uuid, idempotencyKey: 'drop:1:received', state: 'pending' }]) };
    const inputs = { commerce_documents: document, commerce_pack_status_outbox: pack, commerce_notification_outbox: notification };
    const columns = Object.keys(inputs);
    const source = `WITH inputs AS (SELECT ${columns.map((name) => `? AS ${name}`).join(', ')}), ` +
      Object.entries(inputs).map(([table, row]) => `${table} AS (SELECT ${Object.keys(row)
        .map((name) => `json_extract(${table}, '$.${name}') AS ${name}`).join(', ')} FROM inputs)`).join(', ');
    for (const [queryPart, invalid] of [
      ['SELECT 1 FROM commerce_pack_status_outbox AS outbox LEFT JOIN', { ...pack, generation: uuid.replace('-4ABC-', '-1ABC-') }],
      ['SELECT 1 FROM commerce_notification_outbox AS outbox LEFT JOIN', { ...notification, claim_id: uuid.replace('-BDEF-', '-CDEF-') }],
      ['SELECT 1 FROM commerce_notification_outbox AS outbox, json_each', { ...notification,
        entries_json: JSON.stringify([{ kind: 'buyer_order_received', jobId: uuid.replace('-4ABC-', '-0ABC-'), idempotencyKey: 'drop:1:received', state: 'pending' }]) }],
    ] as const) {
      const statement = statements.find((sql) => sql.includes(queryPart))!;
      const query = source + ' ' + statement.replace(/^INSERT INTO commerce_frozen_metadata_cleanup_guard \(allowed, complete\)\s*SELECT 1, /,
        'SELECT ') + ' AS valid';
      assert.deepEqual(await db.prepare(query).bind(...Object.values(inputs).map((row) => JSON.stringify(row))).first(), { valid: 1 });
      const changed = queryPart.includes('commerce_pack_status_outbox')
        ? { ...inputs, commerce_pack_status_outbox: invalid }
        : { ...inputs, commerce_notification_outbox: invalid };
      assert.deepEqual(await db.prepare(query).bind(...Object.values(changed).map((row) => JSON.stringify(row))).first(), { valid: 0 });
    }
  } finally { await server.close(); }
});
