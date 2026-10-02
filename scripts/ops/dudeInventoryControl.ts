import { pathToFileURL } from 'node:url';
import {
  COMMERCE_D1_NOW_MS_SQL,
  parseCommerceD1DocumentRow,
  queryRemoteCommerceD1,
  withCommerceMaintenanceLease,
  safeInteger,
  sqlString,
  type CommerceAuthorityQuery,
  type CommerceD1Document,
} from '../shared/commerceD1Maintenance.ts';
import {
  inventoryDropConfigs,
  initializeInventoryDrop,
  readAvailableInventory,
  readInventoryDrop,
  requireInventoryConfig,
  validateInventoryOwnership,
  type InventoryDropConfig,
} from '../shared/dudeInventoryMaintenance.ts';

type Command = 'status' | 'prepare';
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
  if (!['status', 'prepare'].includes(command)) {
    throw new Error('Usage: npm run dude-inventory-control -- <status|prepare> [--drop <id>] [--expected-revision <n> --write]');
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

async function verifyDrop(
  query: CommerceAuthorityQuery,
  config: InventoryDropConfig,
  documents: readonly CommerceD1Document[],
): Promise<void> {
  const metadata = await readInventoryDrop(query, config.dropId);
  requireInventoryConfig(metadata, config);
  if (metadata.ready !== 1) throw new Error(`Inventory for ${config.dropId} is not ready.`);
  const available = await readAvailableInventory(query, config.dropId);
  const ownership = validateInventoryOwnership(config, documents);
  if (available.some((row) => !Number.isSafeInteger(row.dudeId) || row.dudeId < 1 || row.dudeId > config.maxDudeId ||
    !Number.isSafeInteger(row.poolPosition) || row.poolPosition < 0 || row.poolPosition >= config.maxDudeId)) {
    throw new Error(`Invalid inventory range for ${config.dropId}.`);
  }
  if (available.some((row) => ownership.assignedIds.has(row.dudeId))) {
    throw new Error(`Assigned figures remain available for ${config.dropId}.`);
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

async function summary(dependencies: Dependencies, configs: readonly InventoryDropConfig[]) {
  const state = await readState(dependencies.query);
  const documents = await readDocuments(dependencies.query);
  const drops = [];
  for (const config of configs) {
    const ownership = validateInventoryOwnership(config, documents);
    const metadata = await readInventoryDrop(dependencies.query, config.dropId);
    const available = await readAvailableInventory(dependencies.query, config.dropId);
    drops.push({
      dropId: config.dropId,
      ready: metadata?.ready === 1,
      configMatches: metadata?.drop_family === config.dropFamily &&
        metadata?.items_per_box === config.itemsPerBox && metadata?.max_dude_id === config.maxDudeId,
      generation: metadata?.generation ?? null,
      available: available.length,
      assigned: ownership.assignedCount,
      orphanAssignments: ownership.orphanAssignments,
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
    if (unknown.length) throw new Error(`Unconfigured inventory ownership exists for: ${unknown.join(', ')}. Resolve before inventory maintenance.`);
  };
  requireKnownOwnership(await readDocuments(dependencies.query));
  if (options.command === 'status') return summary(dependencies, configs);
  const requirePause = (state: ControlState) => {
    if (state.mode !== 'rows') throw new Error('Inventory preparation requires rows mode. Initialize an empty database with bootstrap:commerce.');
    if (!state.paused || state.revision !== options.expectedRevision) {
      throw new Error('Inventory changes require the expected authority revision and a completed Commerce pause/drain.');
    }
  };
  requirePause(await readState(dependencies.query));
  return withCommerceMaintenanceLease({ query: dependencies.query, token: dependencies.uuid(),
    releaseFailureMessage: 'Inventory operation failed and its lease release could not be confirmed; keep Commerce paused.',
  }, async ({ token, renew }) => {
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
    const documents = await readDocuments(dependencies.query);
    requireKnownOwnership(documents);
    for (const config of configs) {
      await renew();
      const existing = await readInventoryDrop(dependencies.query, config.dropId);
      if (existing?.ready === 1) {
        await verifyDrop(dependencies.query, config, documents);
        continue;
      }
      if (documents.some((document) => document.dropId === config.dropId)) {
        throw new Error(`Cannot initialize inventory for ${config.dropId} with existing ownership or pool documents.`);
      }
      await initializeInventoryDrop({ query: dependencies.query, config, guard: mutationGuard(state, token), uuid: dependencies.uuid, renew });
      await verifyDrop(dependencies.query, config, documents);
    }
    return summary(dependencies, configs);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  console.log(JSON.stringify(await runDudeInventoryControl(process.argv.slice(2)), null, 2));
}
