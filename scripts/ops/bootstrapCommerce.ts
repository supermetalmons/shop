import { pathToFileURL } from 'node:url';
import { checkCurrentCommerceSchema } from '../shared/currentCommerceSchema.ts';
import {
  COMMERCE_D1_NOW_MS_SQL, queryRemoteCommerceD1, safeInteger, sqlString, withCommerceMaintenanceLease,
} from '../shared/commerceD1Maintenance.ts';
import { COMMERCE_STORAGE_CONTROLS, type CommerceStorageControl } from '../shared/commerceStateControl.ts';
import {
  initializeInventoryDrop, inventoryDropConfigs, readInventoryDrop, requireInitialInventory, requireInventoryConfig,
  type InventoryDropConfig,
} from '../shared/dudeInventoryMaintenance.ts';

type Options = { expectedRevision: number; write: true };
type Dependencies = { query: typeof queryRemoteCommerceD1; configs: readonly InventoryDropConfig[]; uuid: () => string };
const EMPTY_TABLES = [
  'commerce_documents', 'commerce_document_path_revisions', 'commerce_delivery_owner_revisions',
  'commerce_commit_guards', 'commerce_wipe_guards', 'commerce_delivery_recovery', 'commerce_notification_outbox',
  'commerce_notification_outbox_pending_owners', 'commerce_notification_outbox_stripe_due', 'commerce_pack_status_outbox',
  'commerce_preorder_claims', 'commerce_preorder_orders', 'commerce_stripe_checkout_state', 'stripe_order_disputes',
] as const;
const emptyPredicate = EMPTY_TABLES.map((table) => `NOT EXISTS (SELECT 1 FROM ${table})`).join(' AND ');

export function parseBootstrapCommerceArgs(argv: string[]): Options {
  let expectedRevision: number | undefined;
  let write = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--write' && !write) write = true;
    else if (argv[index] === '--expected-revision' && expectedRevision === undefined && argv[index + 1]) {
      expectedRevision = safeInteger(argv[++index], 'Expected authority revision');
    } else throw new Error(`Invalid bootstrap argument: ${argv[index]}`);
  }
  if (!write || expectedRevision === undefined || expectedRevision < 1) {
    throw new Error('Usage: npm run bootstrap:commerce -- --expected-revision <n> --write');
  }
  return { expectedRevision, write: true };
}

function requireEmptyPaused(query: Dependencies['query'], expectedRevision: number) {
  const rows = query(`SELECT authority_state, paused_at_ms, revision, documents_revision, dude_inventory_mode
    FROM commerce_authority_control WHERE singleton = 1`);
  const row = rows[0];
  if (rows.length !== 1 || row.authority_state !== 'paused' || row.paused_at_ms === null || row.revision !== expectedRevision) {
    throw new Error('Bootstrap requires the expected authority revision and a completed Commerce pause/drain.');
  }
  if (row.documents_revision !== 0 || !['legacy', 'rows'].includes(String(row.dude_inventory_mode))) {
    throw new Error('Bootstrap requires an empty database with no business history.');
  }
  const counts = query(EMPTY_TABLES.map((table) => `SELECT '${table}' AS table_name, COUNT(*) AS count FROM ${table}`).join(' UNION ALL '));
  if (counts.length !== EMPTY_TABLES.length || counts.some((item) => item.count !== 0)) {
    throw new Error('Bootstrap refuses business data, revision tombstones, unfinished maintenance, or state rows.');
  }
  return row;
}

function readControl(query: Dependencies['query'], table: CommerceStorageControl) {
  const rows = query(`SELECT * FROM ${table} WHERE singleton = 1`);
  const row = rows[0];
  if (rows.length !== 1 || !['legacy', 'table'].includes(String(row.storage_mode)) ||
    !['idle', 'preparing', 'ready'].includes(String(row.preparation_state)) ||
    (row.preparation_state === 'idle' && (row.source_documents_revision !== null || row.prepared_at_ms !== null)) ||
    (row.preparation_state !== 'idle' && row.source_documents_revision !== 0) ||
    (row.preparation_state === 'preparing' && row.prepared_at_ms !== null) ||
    (row.preparation_state === 'ready' && (typeof row.prepared_at_ms !== 'number' || !Number.isSafeInteger(row.prepared_at_ms) || row.prepared_at_ms < 0)) ||
    (row.storage_mode === 'table' && row.preparation_state !== 'ready')) {
    throw new Error(`Unexpected bootstrap state in ${table}.`);
  }
  return row;
}

export async function runBootstrapCommerce(argv: string[], overrides: Partial<Dependencies> = {}) {
  const options = parseBootstrapCommerceArgs(argv);
  const dependencies: Dependencies = { query: queryRemoteCommerceD1, configs: inventoryDropConfigs(), uuid: () => crypto.randomUUID(), ...overrides };
  const { query, configs } = dependencies;
  checkCurrentCommerceSchema(query);
  requireEmptyPaused(query, options.expectedRevision);
  return withCommerceMaintenanceLease({ query, token: dependencies.uuid(),
    releaseFailureMessage: 'Bootstrap failed and its lease release could not be confirmed; keep Commerce paused.',
  }, async ({ token, renew }) => {
    requireEmptyPaused(query, options.expectedRevision);
    const known = new Set(configs.map((config) => config.dropId));
    const inventory = query('SELECT * FROM commerce_inventory_drops ORDER BY drop_id');
    if (inventory.some((row) => !known.has(String(row.drop_id)))) throw new Error('Bootstrap found unconfigured inventory.');
    for (const row of inventory) {
      const config = configs.find((candidate) => candidate.dropId === row.drop_id)!;
      requireInventoryConfig(row, config);
      await requireInitialInventory(query, config, row.ready === 1);
    }
    for (const table of COMMERCE_STORAGE_CONTROLS) readControl(query, table);
    const guard = `EXISTS (SELECT 1 FROM commerce_authority_control AS authority
      JOIN commerce_authority_control_lease AS lease ON lease.singleton = authority.singleton
      WHERE authority.singleton = 1 AND authority.authority_state = 'paused' AND authority.paused_at_ms IS NOT NULL
        AND authority.revision = ${options.expectedRevision} AND authority.documents_revision = 0
        AND lease.lease_token = ${sqlString(token)} AND lease.expires_at_ms > ${COMMERCE_D1_NOW_MS_SQL}) AND ${emptyPredicate}`;
    for (const config of configs) {
      await initializeInventoryDrop({ query, config, guard, uuid: dependencies.uuid, renew });
    }
    await renew();
    if (requireEmptyPaused(query, options.expectedRevision).dude_inventory_mode !== 'rows') {
      try {
        const rows = query(`UPDATE commerce_authority_control SET dude_inventory_mode = 'rows'
          WHERE singleton = 1 AND dude_inventory_mode = 'legacy' AND ${guard} RETURNING singleton`);
        if (rows.length !== 1) throw new Error('Inventory activation was not confirmed.');
      } catch (error) {
        if (requireEmptyPaused(query, options.expectedRevision).dude_inventory_mode !== 'rows') throw error;
      }
    }
    for (const table of COMMERCE_STORAGE_CONTROLS) {
      for (;;) {
        await renew();
        const current = readControl(query, table);
        if (current.storage_mode === 'table') break;
        const next = current.preparation_state === 'idle' ? 'preparing' : current.preparation_state === 'preparing' ? 'ready' : 'table';
        const update = next === 'preparing'
          ? "preparation_state = 'preparing', source_documents_revision = 0, prepared_at_ms = NULL"
          : next === 'ready' ? `preparation_state = 'ready', prepared_at_ms = ${COMMERCE_D1_NOW_MS_SQL}` : "storage_mode = 'table'";
        try {
          const rows = query(`UPDATE ${table} SET ${update} WHERE singleton = 1 AND storage_mode = 'legacy'
            AND preparation_state = ${sqlString(String(current.preparation_state))} AND ${guard} RETURNING singleton`);
          if (rows.length !== 1) throw new Error(`${table} initialization was not confirmed.`);
        } catch (error) {
          const observed = readControl(query, table);
          if (next === 'table' ? observed.storage_mode !== 'table' : observed.preparation_state !== next) throw error;
        }
      }
    }
    const finalAuthority = requireEmptyPaused(query, options.expectedRevision);
    for (const config of configs) {
      const row = await readInventoryDrop(query, config.dropId);
      requireInventoryConfig(row, config);
      if (row?.ready !== 1) throw new Error(`Inventory readiness is incomplete for ${config.dropId}.`);
      await requireInitialInventory(query, config, true);
    }
    return { authorityState: finalAuthority.authority_state, authorityRevision: finalAuthority.revision,
      inventoryMode: finalAuthority.dude_inventory_mode, inventoryDrops: configs.length,
      controls: Object.fromEntries(COMMERCE_STORAGE_CONTROLS.map((table) => [table, readControl(query, table).storage_mode])),
    };
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  console.log(JSON.stringify(await runBootstrapCommerce(process.argv.slice(2)), null, 2));
}
