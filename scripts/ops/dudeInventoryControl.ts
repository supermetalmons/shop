import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
  initializeNewInventoryDrop,
  readAvailableInventory,
  readInventoryDrop,
  requireInventoryConfig,
  validateInventoryOwnership,
  validateManifestInventory,
  type InventoryDropConfig,
} from '../shared/dudeInventoryMaintenance.ts';
import { parseMiNoteDropManifest, verifyMiNoteDropManifest, type MiNoteDropManifest } from '../shared/miNoteDropManifest.ts';
import { verifyNewMiNoteInventoryDrop } from '../shared/miNoteInventoryPreflight.ts';

type Command = 'status' | 'prepare' | 'initialize-new';
type Options = { command: Command; dropId?: string; expectedRevision?: number; manifestPath?: string; write: boolean };
type ControlState = {
  mode: 'legacy' | 'rows';
  paused: boolean;
  active: boolean;
  revision: number;
  documentsRevision: number;
};
type Dependencies = {
  query: CommerceAuthorityQuery;
  configs: readonly InventoryDropConfig[];
  uuid: () => string;
  readManifest: (path: string) => MiNoteDropManifest;
  verifyManifest: (manifest: MiNoteDropManifest) => Promise<unknown>;
  verifyNewDrop: (dropId: string, manifest: MiNoteDropManifest) => Promise<void>;
};

export function parseDudeInventoryControlArgs(argv: string[]): Options {
  const command = argv[0];
  if (!['status', 'prepare', 'initialize-new'].includes(command)) {
    throw new Error('Usage: npm run dude-inventory-control -- <status|prepare|initialize-new> [--drop <id>] [--manifest <path>] [--expected-revision <n> --write]');
  }
  const options: Options = { command: command as Command, write: false };
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--write') options.write = true;
    else if (flag === '--drop' && argv[index + 1]) options.dropId = argv[++index];
    else if (flag === '--manifest' && argv[index + 1]) options.manifestPath = resolve(argv[++index]);
    else if (flag === '--expected-revision' && argv[index + 1]) {
      options.expectedRevision = safeInteger(argv[++index], 'Expected authority revision');
      if (options.expectedRevision < 1) throw new Error('Expected authority revision must be positive.');
    } else throw new Error(`Invalid inventory-control argument: ${flag}`);
  }
  if (command === 'status') {
    if (options.write || options.expectedRevision !== undefined || options.manifestPath) throw new Error('Status is read-only.');
  } else if (command === 'initialize-new') {
    if (!options.dropId || !options.manifestPath || options.expectedRevision !== undefined) {
      throw new Error('initialize-new requires --drop and --manifest, with optional --write.');
    }
  } else if (!options.write || options.expectedRevision === undefined) {
    throw new Error(`${command} requires --write and --expected-revision.`);
  } else if (options.manifestPath) {
    throw new Error('--manifest is only supported by initialize-new.');
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
    active: row.authority_state === 'd1' && row.paused_at_ms === null,
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
  let available: Awaited<ReturnType<typeof readAvailableInventory>>;
  if (config.inventoryManifest) {
    const rows = await query(`SELECT
      (SELECT COALESCE(json_group_array(json_object('dudeId', dude_id, 'poolPosition', pool_position)), '[]')
        FROM (SELECT dude_id, pool_position FROM commerce_available_dudes
          WHERE drop_id = ${sqlString(config.dropId)} ORDER BY pool_position)) AS available_json,
      (SELECT COALESCE(json_group_array(json_object(
        'document_path', document_path, 'document_kind', document_kind, 'drop_id', drop_id, 'document_id', document_id,
        'document_json', document_json, 'version', version, 'create_time', create_time, 'update_time', update_time
      )), '[]') FROM commerce_documents WHERE drop_id = ${sqlString(config.dropId)}
        AND document_kind IN ('dude_pool', 'dude_assignment', 'box_assignment')) AS documents_json,
      generation, manifest_sha256, eligible_card_ids_json, completed_at_ms
      FROM commerce_inventory_initializations WHERE drop_id = ${sqlString(config.dropId)}`);
    const row = rows[0];
    if (rows.length !== 1 || row.generation !== metadata.generation || row.manifest_sha256 !== config.inventoryManifest.sha256 ||
      row.eligible_card_ids_json !== JSON.stringify(config.inventoryManifest.cardIds) || row.completed_at_ms === null ||
      typeof row.available_json !== 'string' || typeof row.documents_json !== 'string') {
      throw new Error(`Committed inventory manifest differs for ${config.dropId}.`);
    }
    available = JSON.parse(row.available_json);
    documents = JSON.parse(row.documents_json).map(parseCommerceD1DocumentRow);
  } else {
    available = await readAvailableInventory(query, config.dropId);
  }
  const ownership = validateInventoryOwnership(config, documents);
  if (available.some((row) => !Number.isSafeInteger(row.dudeId) || row.dudeId < 1 || row.dudeId > config.maxDudeId ||
    !Number.isSafeInteger(row.poolPosition) || row.poolPosition < 0 || row.poolPosition >= config.maxDudeId)) {
    throw new Error(`Invalid inventory range for ${config.dropId}.`);
  }
  if (available.some((row) => ownership.assignedIds.has(row.dudeId))) {
    throw new Error(`Assigned figures remain available for ${config.dropId}.`);
  }
  validateManifestInventory(config, available, ownership.assignedIds);
}

async function initializeNew(options: Options, dependencies: Dependencies, config: InventoryDropConfig) {
  const manifest = dependencies.readManifest(options.manifestPath!);
  if (!config.inventoryManifest || config.inventoryManifest.sha256 !== manifest.sha256 ||
    JSON.stringify(config.inventoryManifest.cardIds) !== JSON.stringify(manifest.eligibleCardIds) ||
    config.dropFamily !== manifest.dropFamily || config.itemsPerBox !== manifest.itemsPerPack || config.maxDudeId !== manifest.maxFigureId) {
    throw new Error('The target drop does not match the reviewed inventory manifest.');
  }
  const requireActive = async () => {
    const state = await readState(dependencies.query);
    if (!state.active || state.mode !== 'rows') throw new Error('Online inventory initialization requires active Commerce in rows mode.');
    return state;
  };
  await requireActive();
  const existing = await readInventoryDrop(dependencies.query, config.dropId);
  if (existing) {
    await initializeNewInventoryDrop({ query: dependencies.query, config, manifest, authorityRevision: 0, leaseToken: '', generation: '' });
    await verifyDrop(dependencies.query, config, await readDocuments(dependencies.query));
    return { ...(await summary(dependencies, [config])), initialized: false, manifestSha256: manifest.sha256 };
  }
  const preflight = async () => {
    await dependencies.verifyManifest(manifest);
    await dependencies.verifyNewDrop(config.dropId, manifest);
    const history = await dependencies.query(`SELECT
      ((SELECT COUNT(*) FROM commerce_documents WHERE drop_id = ${sqlString(config.dropId)}) +
        (SELECT COUNT(*) FROM commerce_documents WHERE document_kind = 'claim_code'
          AND json_extract(document_json, '$.dropId') = ${sqlString(config.dropId)})) AS documents,
      (SELECT COUNT(*) FROM commerce_document_path_revisions
        WHERE substr(document_path, 1, length(${sqlString(`drops/${config.dropId}/`)})) = ${sqlString(`drops/${config.dropId}/`)}) AS revisions`);
    if (history.length !== 1 || history[0].documents !== 0 || history[0].revisions !== 0) {
      throw new Error('Online initialization requires a new drop without public commerce history.');
    }
  };
  if (!options.write) {
    await preflight();
    return { ...(await summary(dependencies, [config])), initialized: false, write: false,
      eligibleCards: manifest.eligibleCardIds.length, packs: manifest.packCount, manifestSha256: manifest.sha256 };
  }
  return withCommerceMaintenanceLease({ query: dependencies.query, token: dependencies.uuid(),
    releaseFailureMessage: 'The inventory coordination lease could not be released; inspect it before retrying. Commerce was not paused.',
  }, async ({ token, renew }) => {
    const state = await requireActive();
    await preflight();
    await renew();
    await initializeNewInventoryDrop({ query: dependencies.query, config, manifest, authorityRevision: state.revision,
      leaseToken: token, generation: dependencies.uuid() });
    await verifyDrop(dependencies.query, config, await readDocuments(dependencies.query));
    return { ...(await summary(dependencies, [config])), initialized: true, manifestSha256: manifest.sha256 };
  });
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
    if (metadata?.ready === 1 && config.inventoryManifest) await verifyDrop(dependencies.query, config, documents);
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
    readManifest: (path) => parseMiNoteDropManifest(JSON.parse(readFileSync(path, 'utf8'))),
    verifyManifest: verifyMiNoteDropManifest,
    verifyNewDrop: verifyNewMiNoteInventoryDrop,
    ...overrides,
  };
  const configs = dependencies.configs.filter((config) => !options.dropId || config.dropId === options.dropId);
  if (!configs.length) throw new Error('No matching assignable drops in the deployment registry.');
  if (options.command === 'initialize-new') return initializeNew(options, dependencies, configs[0]);
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
