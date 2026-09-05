import { pathToFileURL } from 'node:url';
import {
  acquireCommerceAuthorityLease,
  COMMERCE_D1_NOW_MS_SQL,
  parseCommerceD1DocumentRow,
  queryRemoteCommerceD1,
  releaseCommerceAuthorityLease,
  renewCommerceAuthorityLease,
  safeInteger,
  sqlString,
  type CommerceAuthorityQuery,
  type CommerceD1Document,
} from '../shared/commerceD1Maintenance.ts';
import {
  inventoryDropConfigs,
  planInventoryBackfill,
  type InventoryBackfillPlan,
  type InventoryDropConfig,
} from '../shared/dudeInventoryMaintenance.ts';

type Command = 'status' | 'prepare' | 'activate';
type Options = { command: Command; dropId?: string; expectedRevision?: number; write: boolean };
type ControlState = {
  mode: 'legacy' | 'rows';
  paused: boolean;
  revision: number;
  documentsRevision: number;
};
type Dependencies = {
  query: CommerceAuthorityQuery;
  configs: readonly InventoryDropConfig[];
  uuid: () => string;
};

export function parseDudeInventoryControlArgs(argv: string[]): Options {
  const command = argv[0];
  if (!['status', 'prepare', 'activate'].includes(command)) {
    throw new Error('Usage: npm run dude-inventory-control -- <status|prepare|activate> [--drop <id>] [--expected-revision <n> --write]');
  }
  const options: Options = { command: command as Command, write: false };
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--write') options.write = true;
    else if (flag === '--drop' && argv[index + 1]) options.dropId = argv[++index];
    else if (flag === '--expected-revision' && argv[index + 1]) {
      options.expectedRevision = safeInteger(argv[++index], 'Expected authority revision');
      if (options.expectedRevision < 1) throw new Error('Expected authority revision must be positive.');
    } else throw new Error(`Invalid inventory-control argument: ${flag}`);
  }
  if (command === 'status') {
    if (options.write || options.expectedRevision !== undefined) throw new Error('Status is read-only.');
  } else if (!options.write || options.expectedRevision === undefined) {
    throw new Error(`${command} requires --write and --expected-revision.`);
  }
  if (command === 'activate' && options.dropId) throw new Error('Activation verifies every configured drop; --drop is unsupported.');
  return options;
}

async function readState(query: CommerceAuthorityQuery): Promise<ControlState> {
  const rows = await query(`SELECT authority_state, revision, documents_revision, paused_at_ms, dude_inventory_mode
    FROM commerce_authority_control WHERE singleton = 1`);
  const row = rows[0];
  if (rows.length !== 1 || !['legacy', 'rows'].includes(String(row.dude_inventory_mode)) ||
    !['d1', 'paused'].includes(String(row.authority_state))) {
    throw new Error('Invalid inventory authority state; apply the inventory schema first.');
  }
  return {
    mode: row.dude_inventory_mode as ControlState['mode'],
    paused: row.authority_state === 'paused' && row.paused_at_ms !== null,
    revision: safeInteger(row.revision, 'Authority revision'),
    documentsRevision: safeInteger(row.documents_revision, 'Documents revision'),
  };
}

async function readDocuments(query: CommerceAuthorityQuery): Promise<CommerceD1Document[]> {
  return (await query(`SELECT document_path, document_kind, drop_id, document_id, document_json,
      version, create_time, update_time FROM commerce_documents
    WHERE document_kind IN ('dude_pool', 'dude_assignment', 'box_assignment')
    ORDER BY document_path`)).map(parseCommerceD1DocumentRow);
}

async function readAvailable(query: CommerceAuthorityQuery, dropId: string) {
  return (await query(`SELECT dude_id, pool_position FROM commerce_available_dudes
    WHERE drop_id = ${sqlString(dropId)} ORDER BY pool_position`)).map((row) => ({
    dudeId: safeInteger(row.dude_id, 'Figure id'),
    poolPosition: safeInteger(row.pool_position, 'Pool position'),
  }));
}

async function readDrop(query: CommerceAuthorityQuery, dropId: string) {
  const rows = await query(`SELECT * FROM commerce_inventory_drops WHERE drop_id = ${sqlString(dropId)}`);
  if (rows.length > 1) throw new Error(`Duplicate inventory metadata for ${dropId}.`);
  return rows[0];
}

function requireConfig(row: Record<string, unknown> | undefined, config: InventoryDropConfig): void {
  if (!row || row.ready !== 1 || row.drop_family !== config.dropFamily ||
    row.items_per_box !== config.itemsPerBox || row.max_dude_id !== config.maxDudeId) {
    throw new Error(`Inventory for ${config.dropId} is missing, incomplete, or differs from the registry. Run prepare while paused.`);
  }
}

async function verifyDrop(
  query: CommerceAuthorityQuery,
  config: InventoryDropConfig,
  documents: readonly CommerceD1Document[],
  mode: ControlState['mode'],
): Promise<void> {
  requireConfig(await readDrop(query, config.dropId), config);
  const available = await readAvailable(query, config.dropId);
  const plan = planInventoryBackfill(config, documents);
  if (available.some((row) => row.dudeId < 1 || row.dudeId > config.maxDudeId)) {
    throw new Error(`Invalid inventory range for ${config.dropId}.`);
  }
  const assigned = new Set(documents.filter((document) =>
    document.dropId === config.dropId && document.kind === 'dude_assignment').map((document) => Number(document.documentId)));
  if (available.some((row) => assigned.has(row.dudeId))) {
    throw new Error(`Assigned figures remain available for ${config.dropId}.`);
  }
  if (mode === 'legacy' && JSON.stringify(available) !== JSON.stringify(plan.available)) {
    throw new Error(`Inventory backfill differs from the current pool for ${config.dropId}; rerun prepare while paused.`);
  }
}

function mutationGuard(state: ControlState, token: string): string {
  return `EXISTS (SELECT 1 FROM commerce_authority_control AS authority
    JOIN commerce_authority_control_lease AS lease ON lease.singleton = authority.singleton
    WHERE authority.singleton = 1 AND authority.authority_state = 'paused'
      AND authority.paused_at_ms IS NOT NULL AND authority.revision = ${state.revision}
      AND authority.documents_revision = ${state.documentsRevision}
      AND authority.dude_inventory_mode = ${sqlString(state.mode)}
      AND lease.lease_token = ${sqlString(token)} AND lease.expires_at_ms > ${COMMERCE_D1_NOW_MS_SQL})`;
}

async function mutate(query: CommerceAuthorityQuery, sql: string, expectedRows: number): Promise<void> {
  if ((await query(sql)).length !== expectedRows) {
    throw new Error('Inventory mutation was not confirmed; keep Commerce paused and rerun the same command.');
  }
}

async function prepareDrop(args: {
  dependencies: Dependencies;
  plan: InventoryBackfillPlan;
  state: ControlState;
  token: string;
  renew: () => Promise<void>;
}): Promise<void> {
  const { dependencies, plan, state } = args;
  const existing = await readDrop(dependencies.query, plan.dropId);
  if (state.mode === 'rows' && existing?.ready === 1) return;
  const guard = mutationGuard(state, args.token);
  if (existing) {
    await mutate(dependencies.query, `DELETE FROM commerce_inventory_drops
      WHERE drop_id = ${sqlString(plan.dropId)} AND ${guard} RETURNING drop_id`, 1);
  }
  const generation = dependencies.uuid();
  await mutate(dependencies.query, `INSERT INTO commerce_inventory_drops (
      drop_id, generation, ready, drop_family, items_per_box, max_dude_id, initialized_at_ms
    ) SELECT ${sqlString(plan.dropId)}, ${sqlString(generation)}, 0, ${sqlString(plan.dropFamily)},
      ${plan.itemsPerBox}, ${plan.maxDudeId}, ${COMMERCE_D1_NOW_MS_SQL}
    WHERE ${guard} RETURNING drop_id`, 1);
  for (let offset = 0; offset < plan.available.length; offset += 1000) {
    await args.renew();
    const chunk = plan.available.slice(offset, offset + 1000);
    const values = sqlString(JSON.stringify(chunk.map((row) => [row.dudeId, row.poolPosition])));
    await mutate(dependencies.query, `INSERT INTO commerce_available_dudes (drop_id, dude_id, pool_position)
      SELECT ${sqlString(plan.dropId)}, json_extract(value, '$[0]'), json_extract(value, '$[1]')
      FROM json_each(${values}) WHERE ${guard} RETURNING dude_id`, chunk.length);
  }
  const available = await readAvailable(dependencies.query, plan.dropId);
  if (JSON.stringify(available) !== JSON.stringify(plan.available)) {
    throw new Error(`Inventory verification failed for ${plan.dropId}; keep Commerce paused and rerun prepare.`);
  }
  await mutate(dependencies.query, `UPDATE commerce_inventory_drops SET ready = 1
    WHERE drop_id = ${sqlString(plan.dropId)} AND generation = ${sqlString(generation)}
      AND ready = 0 AND ${guard} RETURNING drop_id`, 1);
}

async function summary(dependencies: Dependencies, configs: readonly InventoryDropConfig[]) {
  const state = await readState(dependencies.query);
  const documents = await readDocuments(dependencies.query);
  const drops = [];
  for (const config of configs) {
    const plan = planInventoryBackfill(config, documents);
    const metadata = await readDrop(dependencies.query, config.dropId);
    const available = await readAvailable(dependencies.query, config.dropId);
    drops.push({
      dropId: config.dropId,
      ready: metadata?.ready === 1,
      configMatches: metadata?.drop_family === config.dropFamily &&
        metadata?.items_per_box === config.itemsPerBox && metadata?.max_dude_id === config.maxDudeId,
      generation: metadata?.generation ?? null,
      available: available.length,
      ...(state.mode === 'legacy' ? {
        plannedAvailable: plan.available.length,
        usedDefaultPool: plan.usedDefaultPool,
        matchesLegacyPool: JSON.stringify(available) === JSON.stringify(plan.available),
      } : {}),
      assigned: plan.assignedCount,
      orphanAssignments: plan.orphanAssignments,
    });
  }
  return { ...state, drops };
}

export async function runDudeInventoryControl(
  argv: string[],
  overrides: Partial<Dependencies> = {},
) {
  const options = parseDudeInventoryControlArgs(argv);
  const dependencies: Dependencies = {
    query: queryRemoteCommerceD1,
    configs: inventoryDropConfigs(),
    uuid: () => crypto.randomUUID(),
    ...overrides,
  };
  const configs = dependencies.configs.filter((config) => !options.dropId || config.dropId === options.dropId);
  if (!configs.length) throw new Error('No matching assignable drops in the deployment registry.');
  const known = new Set(dependencies.configs.map((config) => config.dropId));
  const requireKnownOwnership = (documents: readonly CommerceD1Document[]) => {
    const unknown = [...new Set(documents.filter((document) => !known.has(document.dropId || '')).map((document) => document.dropId))];
    if (unknown.length) throw new Error(`Unconfigured inventory ownership exists for: ${unknown.join(', ')}. Resolve before cutover.`);
  };
  requireKnownOwnership(await readDocuments(dependencies.query));
  if (options.command === 'status') return summary(dependencies, configs);
  const requirePause = (state: ControlState) => {
    if (!state.paused || state.revision !== options.expectedRevision) {
      throw new Error('Inventory changes require the expected authority revision and a completed Commerce pause/drain.');
    }
  };
  requirePause(await readState(dependencies.query));
  let lease = await acquireCommerceAuthorityLease(dependencies.query, dependencies.uuid());
  const renew = async () => {
    lease = await renewCommerceAuthorityLease(dependencies.query, lease);
  };
  let operationError: unknown;
  try {
    const state = await readState(dependencies.query);
    requirePause(state);
    if ((await dependencies.query('SELECT guard_id FROM commerce_wipe_guards LIMIT 1')).length) {
      throw new Error('A drop wipe is unfinished; complete it before inventory changes.');
    }
    const active = await dependencies.query(`SELECT document_path FROM commerce_documents
      WHERE document_kind = 'admin_irl_redeem_request' AND (
        json_extract(document_json, '$.status') = 'processing' OR (
          json_type(document_json, '$.workflowFinalizeV1') = 'object' AND
          COALESCE(json_extract(document_json, '$.status'), '') <> 'complete'
        )) LIMIT 1`);
    if (active.length) throw new Error(`Admin finalization must finish or be reconciled before inventory changes: ${active[0].document_path}`);
    const lockedDocuments = await readDocuments(dependencies.query);
    requireKnownOwnership(lockedDocuments);
    if (options.command === 'prepare') {
      for (const config of configs) {
        await renew();
        const existing = await readDrop(dependencies.query, config.dropId);
        if (state.mode === 'rows' && existing?.ready === 1) {
          await verifyDrop(dependencies.query, config, lockedDocuments, state.mode);
          continue;
        }
        if (state.mode === 'rows' && lockedDocuments.some((document) => document.dropId === config.dropId)) {
          throw new Error(`Cannot rebuild active inventory for ${config.dropId} from frozen legacy documents.`);
        }
        await prepareDrop({ dependencies, plan: planInventoryBackfill(config, lockedDocuments), state, token: lease.token, renew });
        await verifyDrop(dependencies.query, config, lockedDocuments, state.mode);
      }
    } else {
      for (const config of dependencies.configs) {
        await renew();
        await verifyDrop(dependencies.query, config, lockedDocuments, state.mode);
      }
      if (state.mode === 'legacy') {
        await renew();
        try {
          await mutate(dependencies.query, `UPDATE commerce_authority_control SET dude_inventory_mode = 'rows'
            WHERE singleton = 1 AND ${mutationGuard(state, lease.token)} RETURNING singleton`, 1);
        } catch (error) {
          const observed = await readState(dependencies.query);
          if (observed.mode !== 'rows' || !observed.paused || observed.revision !== state.revision ||
            observed.documentsRevision !== state.documentsRevision) throw error;
        }
      }
    }
    return await summary(dependencies, configs);
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      await releaseCommerceAuthorityLease(dependencies.query, lease);
    } catch (releaseError) {
      if (operationError !== undefined) {
        throw new AggregateError([operationError, releaseError],
          'Inventory operation failed and its authority lease release could not be confirmed; keep Commerce paused.');
      }
      throw releaseError;
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  console.log(JSON.stringify(await runDudeInventoryControl(process.argv.slice(2)), null, 2));
}
