import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { auditManifestInventory } from '../scripts/shared/commerceInventoryAudit.ts';
import type { CommerceD1Row } from '../scripts/shared/commerceD1Maintenance.ts';
import type { InventoryDropConfig } from '../scripts/shared/dudeInventoryMaintenance.ts';

function fixture(t: TestContext, ids = [2, 3, 1401, 1430], itemsPerBox = 1) {
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  database.exec(`CREATE TABLE commerce_available_dudes (
      drop_id TEXT, dude_id INTEGER, pool_position INTEGER, PRIMARY KEY (drop_id, dude_id));
    CREATE TABLE commerce_documents (
      document_path TEXT PRIMARY KEY, document_kind TEXT, drop_id TEXT, document_id TEXT,
      document_json TEXT, version INTEGER, create_time TEXT, update_time TEXT);
    CREATE INDEX commerce_documents_claim_code ON commerce_documents (document_kind, drop_id, document_path);
    CREATE INDEX commerce_documents_kind_path ON commerce_documents (document_kind, document_path)`);
  const config: InventoryDropConfig = {
    dropId: 'sparse', dropFamily: 'card_nft', itemsPerBox, maxDudeId: Math.max(1, ...ids),
    inventoryManifest: { sha256: 'a'.repeat(64), cardIds: ids },
  };
  ids.forEach((id, position) => database.prepare('INSERT INTO commerce_available_dudes VALUES (?, ?, ?)')
    .run(config.dropId, id, position));
  const document = (kind: 'dude_assignment' | 'box_assignment' | 'dude_pool', id: string, data: unknown) => {
    const collection = kind === 'dude_assignment' ? 'dudeAssignments' : kind === 'box_assignment' ? 'boxAssignments' : 'meta';
    const path = `drops/${config.dropId}/${collection}/${id}`;
    database.prepare(`INSERT INTO commerce_documents VALUES (?, ?, ?, ?, ?, 1,
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`)
      .run(path, kind, config.dropId, id, JSON.stringify(data));
    return path;
  };
  const assign = (assigned: number[], box: string, createBox = true) => {
    database.exec('BEGIN');
    for (const id of assigned) {
      database.prepare('DELETE FROM commerce_available_dudes WHERE drop_id = ? AND dude_id = ?').run(config.dropId, id);
      document('dude_assignment', String(id), { dudeId: id, boxAssetId: box });
    }
    if (createBox) document('box_assignment', box, { dudeIds: assigned });
    database.exec('COMMIT');
  };
  const query = (sql: string): CommerceD1Row[] => database.prepare(sql).all().map((row) => ({ ...row }));
  return { database, config, document, assign, query, audit: () => auditManifestInventory(query, config) };
}

for (const count of [0, 100, 101, 200, 205]) {
  test(`manifest audit bounds availability and ownership pages for ${count} cards`, (t) => {
    const f = fixture(t, Array.from({ length: count }, (_, index) => index * 2 + 2));
    const pageSizes = (assigned: boolean) => {
      const manifests: number[] = [];
      const documents: number[] = [];
      auditManifestInventory((sql) => {
        const rows = f.query(sql);
        if (sql.endsWith('LIMIT 100')) {
          assert.ok(rows.length <= 100);
          (sql.startsWith('SELECT expected.value') ? manifests : documents).push(rows.length);
        }
        return rows;
      }, f.config);
      assert.equal(manifests.length, Math.ceil(count / 100));
      assert.equal(manifests.reduce((sum, size) => sum + size, 0), count);
      assert.equal(documents.reduce((sum, size) => sum + size, 0), assigned ? count * 2 : 0);
      assert.equal(documents.length, assigned ? 2 * Math.ceil(count / 100) : 0);
    };
    pageSizes(false);
    for (const id of f.config.inventoryManifest!.cardIds) f.assign([id], `box-${id}`);
    pageSizes(true);
  });
}

for (const literal of ['2', '2.0', '2e0']) {
  test(`manifest audit preserves equivalent numeric JSON assignment ${literal}`, (t) => {
    const f = fixture(t);
    f.assign([2], 'box');
    f.database.prepare("UPDATE commerce_documents SET document_json = ? WHERE document_kind = 'box_assignment'")
      .run(`{"dudeIds":[${literal}]}`);
    f.database.prepare("UPDATE commerce_documents SET document_json = ? WHERE document_kind = 'dude_assignment'")
      .run(`{"dudeId":${literal},"boxAssetId":"box"}`);
    f.audit();
  });
}

test('manifest audit accepts orphan reservations and checks optional owning boxes', (t) => {
  const f = fixture(t);
  f.assign([2], 'orphan', false);
  f.audit();
  f.document('box_assignment', 'orphan', { dudeIds: [3] });
  assert.throws(f.audit, /figure 2 is absent from box orphan/);
});

for (const phase of ['manifest', 'ownership'] as const) {
  test(`manifest audit rejects conflicting owner keys during ${phase} validation`, (t) => {
    const f = fixture(t);
    f.assign([2], 'missing', false);
    f.assign([3], 'box');
    const corrupt = () => f.database.prepare(`UPDATE commerce_documents SET document_json = ?
      WHERE document_kind = 'dude_assignment' AND document_id = '2'`)
      .run('{"dudeId":2,"boxAssetId":"missing","boxAssetId":"box"}');
    if (phase === 'manifest') corrupt();
    assert.throws(() => auditManifestInventory((sql) => {
      const rows = f.query(sql);
      if (phase === 'ownership' && sql.startsWith('SELECT expected.value')) corrupt();
      return rows;
    }, f.config), /invalid figure marker/);
  });
}

for (const [name, corrupt, expected] of [
  ['missing card', (f) => f.database.exec('DELETE FROM commerce_available_dudes WHERE dude_id = 2'), /exactly match/],
  ['overlap', (f) => f.document('dude_assignment', '2', { dudeId: 2, boxAssetId: 'box' }), /exactly match/],
  ['bad pool position', (f) => f.database.exec('UPDATE commerce_available_dudes SET pool_position = 99 WHERE dude_id = 2'), /exactly match/],
  ['out-of-manifest marker', (f) => f.document('dude_assignment', '1', { dudeId: 1, boxAssetId: 'box' }), /invalid figure marker/],
  ['noncanonical marker id', (f) => f.document('dude_assignment', '02', { dudeId: 2, boxAssetId: 'box' }), /invalid figure marker/],
  ['numeric string marker', (f) => {
    f.assign([2], 'box', false);
    f.database.exec(`UPDATE commerce_documents SET document_json = '{"dudeId":"2","boxAssetId":"box"}'`);
  }, /invalid figure marker/],
  ['missing box marker', (f) => f.document('box_assignment', 'box', { dudeIds: [2] }), /box box and figure 2 disagree/],
  ['mismatched marker owner', (f) => {
    f.assign([2], 'other', false);
    f.document('box_assignment', 'box', { dudeIds: [2] });
  }, /box box and figure 2 disagree/],
  ['out-of-manifest box', (f) => f.document('box_assignment', 'box', { dudeIds: [1] }), /invalid box assignment/],
  ['numeric string box', (f) => f.document('box_assignment', 'box', { dudeIds: ['2'] }), /invalid box assignment/],
  ['invalid pool metadata', (f) => {
    f.document('dude_pool', 'dudePool', {});
    f.database.exec('UPDATE commerce_documents SET version = 0');
  }, /version is invalid/],
] satisfies Array<[string, (f: ReturnType<typeof fixture>) => unknown, RegExp]>) {
  test(`manifest audit rejects ${name}`, (t) => {
    const f = fixture(t);
    corrupt(f);
    assert.throws(f.audit, expected);
  });
}

test('manifest audit rejects duplicate box cards', (t) => {
  const f = fixture(t, [2, 3], 2);
  f.assign([2, 3], 'box');
  f.database.exec(`UPDATE commerce_documents SET document_json = '{"dudeIds":[2,2]}' WHERE document_kind = 'box_assignment'`);
  assert.throws(f.audit, /invalid box assignment/);
});

test('manifest audit retains document validation beyond its first ownership page', (t) => {
  const f = fixture(t, Array.from({ length: 205 }, (_, index) => index + 1));
  for (const id of f.config.inventoryManifest!.cardIds) f.assign([id], `box-${String(id).padStart(3, '0')}`);
  let corrupted = false;
  assert.throws(() => auditManifestInventory((sql) => f.query(sql).map((row) => {
    if (sql.includes('AS markers_json') && sql.includes(' > ') && row.document_id === 'box-150') {
      corrupted = true;
      return { ...row, update_time: 'invalid' };
    }
    return row;
  }), f.config), /document identity is inconsistent/);
  assert.equal(corrupted, true);
});

test('manifest ownership pages seek by path without rescanning earlier rows', (t) => {
  const f = fixture(t, Array.from({ length: 205 }, (_, index) => index + 1));
  for (const id of f.config.inventoryManifest!.cardIds) f.assign([id], `box-${String(id).padStart(3, '0')}`);
  let pages = 0;
  let visited = 0;
  f.database.function('audit_visit', (_path) => { visited += 1; return 1; });
  auditManifestInventory((sql) => {
    if (sql.includes('AS markers_json')) {
      pages += 1;
      const plan = f.query(`EXPLAIN QUERY PLAN ${sql}`).map((row) => String(row.detail));
      const search = plan.find((detail) => detail.includes('SEARCH document USING INDEX commerce_documents_claim_code'));
      assert.ok(search);
      assert.match(search, sql.includes(' > ')
        ? /document_kind=\? AND drop_id=\? AND document_path>\? AND document_path<\?/
        : /document_kind=\? AND drop_id=\? AND document_path<\?/);
      assert.ok(plan.every((detail) => !detail.includes('USE TEMP B-TREE')));
      sql = sql.replace('WHERE (', 'WHERE audit_visit(document.document_path) AND (');
    }
    return f.query(sql);
  }, f.config);
  assert.equal(pages, 6);
  assert.equal(visited, 410);
});

for (const phase of ['manifest', 'ownership'] as const) {
  test(`manifest audit accepts atomic allocation between ${phase} pages`, (t) => {
    const f = fixture(t, Array.from({ length: 205 }, (_, index) => index + 1));
    if (phase === 'ownership') {
      for (let id = 1; id <= 101; id += 1) f.assign([id], `box-${String(id).padStart(3, '0')}`);
    }
    let allocated = false;
    auditManifestInventory((sql) => {
      const rows = f.query(sql);
      if (!allocated && sql.endsWith('LIMIT 100') &&
        (phase === 'manifest' ? sql.startsWith('SELECT expected.value') : sql.includes('AS markers_json'))) {
        allocated = true;
        f.assign([150], 'box-150');
      }
      return rows;
    }, f.config);
    assert.equal(allocated, true);
    f.audit();
  });
}

test('manifest audit rejects malformed, reordered, duplicated and truncated manifest pages', (t) => {
  const f = fixture(t);
  for (const corrupt of [
    () => [],
    (rows: CommerceD1Row[]) => rows.slice(1),
    (rows: CommerceD1Row[]) => rows.reverse(),
    (rows: CommerceD1Row[]) => [rows[0], ...rows],
    (rows: CommerceD1Row[]) => rows.map((row) => ({ ...row, manifest_position: 0 })),
  ]) {
    assert.throws(() => auditManifestInventory((sql) => {
      const rows = f.query(sql);
      return sql.startsWith('SELECT expected.value') ? corrupt(rows) : rows;
    }, f.config), /exactly match/);
  }
});
