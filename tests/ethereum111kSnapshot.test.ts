import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createCommerceD1Harness } from '../cloud/workers/api/test/commerceD1Harness.ts';
import { buildEthereum111kResetPlan, readEthereum111kSnapshot, type Ethereum111kQueryBatch } from '../scripts/shared/ethereum111kMaintenance.ts';
import { writeEthereum111kResetBackup } from '../scripts/ops/resetEthereum111k.ts';
import { ethereumAssetId } from '../shared/ethereum/protocol.ts';

const SCOPE = { chainId: 11155111, contractAddress: `0x${'11'.repeat(20)}` };
const NOW = Math.floor(Date.now() / 1000) * 1000;
const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const counts = { documents: 0, recovery: 0, notifications: 0, pack_outbox: 0, inventory: 0,
  available_dudes: 0, inventory_initializations: 0, linked_documents: 0 };
const control = { paused: 1, revision: 3, paused_at_ms: NOW - 65_000, chain_id: SCOPE.chainId,
  contract_address: SCOPE.contractAddress, reset_guard_id: null, last_reset_id: null, updated_at_ms: NOW, database_now_ms: NOW };

function checkout(number: number, itemsJson = '[]') {
  return { checkout_id: id(number), request_id: id(number + 10_000), origin: 'https://mons.shop', drop_id: '111k_devnet',
    chain_id: SCOPE.chainId, contract_address: SCOPE.contractAddress, token_ids_json: '["111112"]', items_json: itemsJson,
    callback_url: 'https://mons.shop/111k_devnet', callback_state: null, created_block: 1,
    created_at_ms: NOW - 1000, expires_at_ms: NOW + 86_400_000 };
}

function fixture(context: test.TestContext, count = 40) {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  harness.database.prepare(`UPDATE ethereum_111k_control SET paused = 0, paused_at_ms = NULL,
    chain_id = ?, contract_address = ?, revision = 2, updated_at_ms = ?`).run(SCOPE.chainId, SCOPE.contractAddress, NOW);
  const rows = Array.from({ length: count }, (_, index) => checkout(index + 1, JSON.stringify([{ preview: `complete-preview-${index}` }])));
  const insert = (row: ReturnType<typeof checkout>) => harness.database.prepare(`INSERT INTO ethereum_delivery_checkouts
    (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`).run(...Object.values(row));
  for (const row of [...rows].reverse()) insert(row);
  harness.database.prepare(`UPDATE ethereum_111k_control SET paused = 1, paused_at_ms = ?, revision = 3`).run(NOW - 65_000);
  const batches: Record<string, string>[] = [];
  const queryBatch: Ethereum111kQueryBatch = queries => {
    batches.push(queries);
    harness.database.exec('BEGIN');
    try {
      const result = Object.fromEntries(Object.entries(queries).map(([key, sql]) => [key, harness.database.prepare(sql).all()]));
      harness.database.exec('COMMIT');
      return result;
    } catch (error) { harness.database.exec('ROLLBACK'); throw error; }
  };
  return { harness, rows, insert, queryBatch, batches };
}

function cratePreviewJson(): string {
  const fixtures = JSON.parse(readFileSync('onchain/ethereum/fixtures/metadata.json', 'utf8'));
  const uri = fixtures.find((value: { kind: number; displayId: number }) => value.kind === 2 && value.displayId === 42).tokenURI;
  const metadata = JSON.parse(Buffer.from(uri.split(',')[1], 'base64').toString());
  const svg = Buffer.from(metadata.image.split(',')[1], 'base64').toString();
  return JSON.stringify(Array.from({ length: 50 }, (_, index) => {
    const displayId = index + 1;
    const tokenId = String(111111 + displayId);
    return { tokenId, kind: 'crate', displayId, owner: `0x${'22'.repeat(20)}`, name: `111K Crate #${displayId}`,
      image: `data:image/svg+xml;base64,${Buffer.from(svg.replace('>42</text>', `>${displayId}</text>`)).toString('base64')}`,
      description: metadata.description,
      attributes: metadata.attributes.map((attribute: { trait_type: string; value: unknown }) =>
        attribute.trait_type === 'Item number' ? { ...attribute, value: displayId } : attribute),
      id: ethereumAssetId(SCOPE.chainId, SCOPE.contractAddress, tokenId), ...SCOPE };
  }));
}

for (const kind of ['current-crates', 'maximum-escaping'] as const) test(`checkout snapshot pages retain ${kind} previews below the process output limit`, async () => {
  const previews = JSON.parse(cratePreviewJson());
  const itemsJson = JSON.stringify(kind === 'current-crates' ? previews :
    previews.map((item: object) => ({ ...item, name: '"'.repeat(9000) })));
  assert.ok(Buffer.byteLength(itemsJson) <= 1024 * 1024);
  const tokenIds = JSON.stringify(previews.map((item: { tokenId: string }) => item.tokenId));
  const rows = Array.from({ length: kind === 'current-crates' ? 1000 : 40 }, (_, index) =>
    ({ ...checkout(index + 1, itemsJson), token_ids_json: tokenIds }));
  let maxOutputBytes = 0;
  let totalOutputBytes = 0;
  let pages = 0;
  const queryBatch: Ethereum111kQueryBatch = queries => {
    const result = Object.fromEntries(Object.entries(queries).map(([key, sql]) => {
      if (key === 'control') return [key, [control]];
      if (key === 'counts') return [key, [counts]];
      if (key === 'checkoutBounds') return [key, [{ count: rows.length, last_checkout_id: rows.at(-1)!.checkout_id }]];
      if (key !== 'checkouts') return [key, []];
      const after = sql.match(/checkout_id > '([^']*)'/)![1];
      const highWater = sql.match(/checkout_id <= '([^']*)'/)![1];
      const limit = Number(sql.match(/LIMIT (\d+)/)![1]);
      assert.ok(limit <= 16);
      assert.equal(highWater, rows.at(-1)!.checkout_id);
      pages++;
      return [key, rows.filter(row => row.checkout_id > after && row.checkout_id <= highWater).slice(0, limit)];
    }));
    const bytes = Buffer.byteLength(JSON.stringify(Object.values(result).map(results => ({ success: true, results }))));
    maxOutputBytes = Math.max(maxOutputBytes, bytes);
    totalOutputBytes += bytes;
    return result;
  };
  const snapshot = await readEthereum111kSnapshot(queryBatch, SCOPE);
  assert.equal(pages, Math.ceil(rows.length / 16));
  assert.ok(totalOutputBytes > 64 * 1024 * 1024);
  assert.ok(maxOutputBytes < 64 * 1024 * 1024);
  assert.deepEqual(snapshot.checkouts, rows);
  assert.equal(buildEthereum111kResetPlan(snapshot, SCOPE, control.revision, id(20_000)).snapshot.checkouts.length, rows.length);
});

test('checkout keyset reads preserve all preview fields in the private reset backup', async context => {
  const f = fixture(context);
  const snapshot = await readEthereum111kSnapshot(f.queryBatch, SCOPE);
  const plan = buildEthereum111kResetPlan(snapshot, SCOPE, snapshot.control.revision, id(20_000));
  assert.deepEqual(snapshot.checkouts.map(row => ({ ...row })), f.rows);
  const pages = f.batches.filter(batch => 'checkouts' in batch);
  assert.equal(pages.length, 3);
  assert.equal('checkouts' in f.batches[0], false);
  assert.match(pages[1].checkouts, new RegExp(`checkout_id > '${id(16)}'`));
  assert.match(pages[2].checkouts, new RegExp(`checkout_id > '${id(32)}'`));
  const directory = mkdtempSync(join(tmpdir(), 'ethereum-checkout-snapshot-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const backup = writeEthereum111kResetBackup(plan, directory);
  assert.deepEqual(JSON.parse(readFileSync(backup, 'utf8')).snapshot.checkouts, f.rows);
});

for (const transition of ['resume', 'resume-pause', 'scope', 'reset-claim', 'reset-complete'] as const) {
  test(`checkout pagination rejects a ${transition} control transition`, async context => {
    const f = fixture(context);
    let pages = 0;
    await assert.rejects(readEthereum111kSnapshot(queries => {
      if ('checkouts' in queries && ++pages === 2) {
        if (transition === 'resume') f.harness.database.exec('UPDATE ethereum_111k_control SET paused = 0, paused_at_ms = NULL, revision = revision + 1');
        if (transition === 'resume-pause') f.harness.database.exec(`UPDATE ethereum_111k_control SET paused = 0, paused_at_ms = NULL, revision = revision + 1;
          UPDATE ethereum_111k_control SET paused = 1, paused_at_ms = ${NOW - 65_000}, revision = revision + 1`);
        if (transition === 'scope') f.harness.database.prepare('UPDATE ethereum_111k_control SET contract_address = ?').run(`0x${'33'.repeat(20)}`);
        if (transition === 'reset-claim') f.harness.database.prepare('UPDATE ethereum_111k_control SET reset_guard_id = ?').run(id(20_000));
        if (transition === 'reset-complete') f.harness.database.prepare('UPDATE ethereum_111k_control SET last_reset_id = ?, revision = revision + 1').run(id(20_000));
      }
      return f.queryBatch(queries);
    }, SCOPE), /control changed/);
    assert.equal(pages, 2);
  });
}

test('checkout pagination checks control once more after the last page', async context => {
  const f = fixture(context);
  await assert.rejects(readEthereum111kSnapshot(queries => {
    if ('checkoutBounds' in queries && !('documents' in queries)) f.harness.database.exec('UPDATE ethereum_111k_control SET revision = revision + 1');
    return f.queryBatch(queries);
  }, SCOPE), /control changed/);
});

for (const change of ['added', 'removed'] as const) test(`checkout pagination rejects ${change} rows without returning a partial snapshot`, async context => {
  const f = fixture(context);
  let pages = 0;
  await assert.rejects(readEthereum111kSnapshot(queries => {
    if ('checkouts' in queries && ++pages === 2) {
      if (change === 'added') {
        f.harness.database.exec('DROP TRIGGER ethereum_delivery_checkouts_control_insert');
        f.insert(checkout(41));
      } else {
        f.harness.database.exec('DROP TRIGGER ethereum_delivery_checkouts_control_delete');
        f.harness.database.prepare('DELETE FROM ethereum_delivery_checkouts WHERE checkout_id = ?').run(id(40));
      }
    }
    return f.queryBatch(queries);
  }, SCOPE), /snapshot.*changed|snapshot is incomplete/);
});

for (const malformed of ['duplicate', 'reversed', 'beyond-high-water', 'empty'] as const) {
  test(`checkout pagination rejects a ${malformed} page`, async context => {
    const f = fixture(context);
    await assert.rejects(readEthereum111kSnapshot(async queries => {
      const result = await f.queryBatch(queries);
      if ('checkouts' in queries) {
        if (malformed === 'duplicate') result.checkouts[1] = result.checkouts[0];
        if (malformed === 'reversed') result.checkouts.reverse();
        if (malformed === 'beyond-high-water') result.checkouts[0] = checkout(41);
        if (malformed === 'empty') result.checkouts = [];
      }
      return result;
    }, SCOPE), /snapshot is incomplete/);
  });
}
