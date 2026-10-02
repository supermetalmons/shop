import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { parseDeliveryRecoveryRow, deliveryRecoveryRow, type DeliveryRecoveryRecord } from '../../shared/deliveryRecoveryState.ts';
import {
  COMMERCE_D1_NOW_MS_SQL,
  parseCommerceD1DocumentRow,
  queryRemoteCommerceD1,
  safeInteger,
  sqlString,
  withCommerceMaintenanceLease,
  type CommerceAuthorityQuery,
  type CommerceD1Document,
} from '../shared/commerceD1Maintenance.ts';
import { LEGACY_DELIVERY_RECOVERY_JSON_SQL, planDeliveryRecoveryStateBackfill } from '../shared/deliveryRecoveryStateMaintenance.ts';

type Options = { command: 'status' | 'prepare' | 'activate'; write: boolean; expectedRevision?: number; workerDeployed: boolean };
type Dependencies = { query: CommerceAuthorityQuery; uuid: () => string };
type ControlState = {
  mode: 'legacy' | 'table'; preparation: 'idle' | 'preparing' | 'ready'; paused: boolean;
  revision: number; documentsRevision: number; sourceDocumentsRevision: number | null; preparedAtMs: number | null;
};
// Five parent/recovery pairs (2 MB per row, up to 2x JSON escaping) fit the 64 MiB runner buffer.
const PAGE_SIZE = 5;
const VALIDATION_GENERATION = '00000000-0000-4000-8000-000000000001';
type SourceDocument = { document: CommerceD1Document; receiptRecoveryJson: string | null; state: DeliveryRecoveryRecord | null };

export function parseDeliveryRecoveryStateControlArgs(argv: string[]): Options {
  const command = argv[0];
  if (command !== 'status' && command !== 'prepare' && command !== 'activate') {
    throw new Error('Usage: npm run delivery-recovery-state-control -- <status|prepare|activate> [--expected-revision <n> --write] [--worker-deployed]');
  }
  const options: Options = { command, write: false, workerDeployed: false };
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--write') options.write = true;
    else if (flag === '--worker-deployed') options.workerDeployed = true;
    else if (flag === '--expected-revision' && argv[index + 1]) {
      options.expectedRevision = safeInteger(argv[++index], 'Expected authority revision');
      if (options.expectedRevision < 1) throw new Error('Expected authority revision must be positive.');
    } else throw new Error(`Invalid delivery recovery state argument: ${flag}`);
  }
  if (command === 'status' && (options.write || options.expectedRevision !== undefined || options.workerDeployed)) {
    throw new Error('Status is read-only.');
  }
  if (command !== 'status' && (!options.write || options.expectedRevision === undefined)) throw new Error(`${command} requires --write and --expected-revision.`);
  if (command === 'activate' && !options.workerDeployed) throw new Error('Activation requires --worker-deployed after compatible Worker publication succeeds.');
  if (command !== 'activate' && options.workerDeployed) throw new Error('--worker-deployed applies only to activation.');
  return options;
}

async function state(query: CommerceAuthorityQuery): Promise<ControlState> {
  const rows = await query(`SELECT authority.authority_state, authority.paused_at_ms, authority.revision,
      authority.documents_revision, recovery.storage_mode, recovery.preparation_state,
      recovery.source_documents_revision, recovery.prepared_at_ms
    FROM commerce_authority_control AS authority
    JOIN commerce_delivery_recovery_control AS recovery ON recovery.singleton = authority.singleton
    WHERE authority.singleton = 1`);
  const row = rows[0];
  if (rows.length !== 1 || !['legacy', 'table'].includes(String(row.storage_mode)) ||
    !['idle', 'preparing', 'ready'].includes(String(row.preparation_state))) throw new Error('Invalid delivery recovery state control; apply migration 0030 first.');
  return {
    mode: row.storage_mode as ControlState['mode'], preparation: row.preparation_state as ControlState['preparation'],
    paused: row.authority_state === 'paused' && row.paused_at_ms !== null,
    revision: safeInteger(row.revision, 'Authority revision'), documentsRevision: safeInteger(row.documents_revision, 'Documents revision'),
    sourceDocumentsRevision: row.source_documents_revision === null ? null : safeInteger(row.source_documents_revision, 'Recovery source revision'),
    preparedAtMs: row.prepared_at_ms === null ? null : safeInteger(row.prepared_at_ms, 'Recovery preparation timestamp'),
  };
}

async function eachPage(query: CommerceAuthorityQuery, visit: (sources: SourceDocument[]) => Promise<void>): Promise<void> {
  let cursor = '';
  for (;;) {
    const rows = await query(`SELECT document.document_path, document.document_kind, document.drop_id,
        document.document_id, json_remove(document.document_json, '$.receiptRecovery') AS document_json,
        document.version, document.create_time, document.update_time,
        ${LEGACY_DELIVERY_RECOVERY_JSON_SQL} AS legacy_receipt_recovery_json, recovery.*
      FROM commerce_documents AS document
      LEFT JOIN commerce_delivery_recovery AS recovery ON recovery.parent_path = document.document_path
      WHERE document.document_kind = 'delivery_order' AND document.document_path > ${sqlString(cursor)}
      ORDER BY document.document_path LIMIT ${PAGE_SIZE}`);
    const sources = rows.map((row) => {
      const receiptRecoveryJson = row.legacy_receipt_recovery_json;
      if (receiptRecoveryJson !== null && typeof receiptRecoveryJson !== 'string') throw new Error('Invalid legacy recovery projection.');
      const document = parseCommerceD1DocumentRow(row);
      const state = row.parent_path === null ? null : parseDeliveryRecoveryRow(row);
      if (state && state.parentPath !== document.path) throw new Error(`Delivery recovery state parent is invalid: ${document.path}.`);
      return { document, receiptRecoveryJson: receiptRecoveryJson as string | null, state };
    });
    await visit(sources);
    if (rows.length < PAGE_SIZE) return;
    cursor = String(rows.at(-1)!.document_path);
  }
}

function guard(current: ControlState, token: string): string {
  return `EXISTS (SELECT 1 FROM commerce_authority_control AS authority
    JOIN commerce_authority_control_lease AS lease ON lease.singleton = authority.singleton
    JOIN commerce_delivery_recovery_control AS recovery ON recovery.singleton = authority.singleton
    WHERE authority.singleton = 1 AND authority.authority_state = 'paused' AND authority.paused_at_ms IS NOT NULL
      AND authority.revision = ${current.revision} AND authority.documents_revision = ${current.documentsRevision}
      AND recovery.storage_mode = ${sqlString(current.mode)}
      AND lease.lease_token = ${sqlString(token)} AND lease.expires_at_ms > ${COMMERCE_D1_NOW_MS_SQL})`;
}

async function mutate(query: CommerceAuthorityQuery, sql: string): Promise<void> {
  if ((await query(sql)).length !== 1) throw new Error('Delivery recovery state mutation was not confirmed; keep Commerce paused and rerun the command.');
}

async function importRecords(query: CommerceAuthorityQuery, records: DeliveryRecoveryRecord[], mutationGuard: string): Promise<void> {
  if (!records.length) return;
  const rows = records.map(deliveryRecoveryRow);
  const columns = Object.keys(rows[0]);
  const metadataColumns = columns.filter((column) => column !== 'receipt_recovery_json');
  const selections = rows.map((row, index) => `SELECT ${metadataColumns.map((column) => {
    const value = row[column];
    const sql = value === null ? 'NULL' : typeof value === 'number' ? String(value) : sqlString(value);
    return index === 0 ? `${sql} AS ${column}` : sql;
  }).join(', ')}`).join(' UNION ALL ');
  const confirmed = await query(`INSERT INTO commerce_delivery_recovery (${columns.join(', ')})
    SELECT ${columns.map((column) => column === 'receipt_recovery_json'
      ? `document.${LEGACY_DELIVERY_RECOVERY_JSON_SQL}` : `imported.${column}`).join(', ')} FROM (${selections}) AS imported
    JOIN commerce_documents AS document ON document.document_path = imported.parent_path
    WHERE ${mutationGuard}
    ON CONFLICT(parent_path) DO UPDATE SET ${columns.filter((column) => column !== 'parent_path')
      .map((column) => `${column} = excluded.${column}`).join(', ')}
    RETURNING parent_path`);
  const expectedPaths = new Set(records.map((record) => record.parentPath));
  if (confirmed.length !== records.length || new Set(confirmed.map((row) => row.parent_path)).size !== records.length ||
    confirmed.some((row) => !expectedPaths.has(String(row.parent_path)))) {
    throw new Error('Delivery recovery state mutation was not confirmed; keep Commerce paused and rerun the command.');
  }
}

async function verifyState(query: CommerceAuthorityQuery, legacy: boolean, renew: () => Promise<void>): Promise<number> {
  let count = 0;
  await eachPage(query, async (sources) => {
    for (const { document, receiptRecoveryJson, state: actual } of sources) {
      if (!actual) throw new Error(`Delivery recovery state is missing: ${document.path}.`);
      if (legacy && !isDeepStrictEqual(actual, planDeliveryRecoveryStateBackfill(document, receiptRecoveryJson, actual.generation))) {
        throw new Error(`Delivery recovery state differs from source: ${document.path}; keep Commerce paused and rerun prepare.`);
      }
    }
    count += sources.length;
    await renew();
  });
  const invalid = await query(`SELECT COUNT(*) AS count FROM commerce_delivery_recovery AS recovery
    LEFT JOIN commerce_documents AS document ON document.document_path = recovery.parent_path
    WHERE document.document_kind IS NOT 'delivery_order'`);
  if (invalid.length !== 1 || safeInteger(invalid[0].count, 'Invalid delivery recovery count') !== 0) {
    throw new Error('Delivery recovery state has unexpected records; keep Commerce paused.');
  }
  return count;
}

async function summary(
  query: CommerceAuthorityQuery,
  renew: () => Promise<void> = async () => undefined,
  verifiedDeliveryCount?: number,
) {
  const current = await state(query);
  let deliveryCount = verifiedDeliveryCount ?? 0;
  let validationError: string | null = null;
  if (verifiedDeliveryCount === undefined) try {
    if (current.mode === 'legacy' && current.preparation !== 'ready') {
      await eachPage(query, async (sources) => {
        for (const { document, receiptRecoveryJson } of sources) {
          planDeliveryRecoveryStateBackfill(document, receiptRecoveryJson, VALIDATION_GENERATION);
        }
        deliveryCount += sources.length;
        await renew();
      });
    } else {
      if (current.mode === 'legacy' && current.sourceDocumentsRevision !== current.documentsRevision) {
        throw new Error('Delivery recovery state preparation is stale.');
      }
      deliveryCount = await verifyState(query, current.mode === 'legacy', renew);
    }
  } catch (error) { validationError = error instanceof Error ? error.message : 'Invalid delivery recovery state.'; }
  const groups = await query(`SELECT document.status, COUNT(*) AS count,
      MIN(recovery.processing_retry_at_ms) AS oldest_retry_at_ms,
      SUM(CASE WHEN recovery.lease_expires_at_ms <= ${COMMERCE_D1_NOW_MS_SQL} THEN 1 ELSE 0 END) AS expired_leases,
      SUM(CASE WHEN recovery.lease_expires_at_ms > ${COMMERCE_D1_NOW_MS_SQL} THEN 1 ELSE 0 END) AS active_leases
    FROM commerce_delivery_recovery AS recovery
    JOIN commerce_documents AS document ON document.document_path = recovery.parent_path
    GROUP BY document.status ORDER BY document.status`);
  const legacyMetadata = await query(`SELECT COUNT(*) AS count FROM commerce_documents
    WHERE document_kind = 'delivery_order' AND json_type(document_json, '$.receiptRecovery') IS NOT NULL`);
  if (legacyMetadata.length !== 1) throw new Error('Invalid legacy delivery recovery metadata count.');
  const legacyMetadataCount = safeInteger(legacyMetadata[0].count, 'Legacy delivery recovery metadata count');
  return { ...current, deliveryCount, legacyMetadataCount, validationError, groups };
}

export async function runDeliveryRecoveryStateControl(argv: string[], overrides: Partial<Dependencies> = {}) {
  const options = parseDeliveryRecoveryStateControlArgs(argv);
  const dependencies: Dependencies = { query: queryRemoteCommerceD1, uuid: () => crypto.randomUUID(), ...overrides };
  if (options.command === 'status') return summary(dependencies.query);
  const requirePause = (current: ControlState) => {
    if (!current.paused || current.revision !== options.expectedRevision) throw new Error('Delivery recovery state changes require the expected authority revision and completed Commerce pause/drain.');
  };
  requirePause(await state(dependencies.query));
  return withCommerceMaintenanceLease({
    query: dependencies.query,
    token: dependencies.uuid(),
    releaseFailureMessage: 'Delivery recovery state operation failed and its lease release could not be confirmed; keep Commerce paused.',
  }, async ({ token, renew }) => {
    const current = await state(dependencies.query);
    requirePause(current);
    if ((await dependencies.query('SELECT guard_id FROM commerce_wipe_guards LIMIT 1')).length) throw new Error('A drop wipe is unfinished; complete it before delivery recovery state changes.');
    if (current.mode === 'table') {
      const deliveryCount = await verifyState(dependencies.query, false, renew);
      return await summary(dependencies.query, renew, deliveryCount);
    }
    const mutationGuard = guard(current, token);
    let deliveryCount: number;
    if (options.command === 'prepare') {
      await eachPage(dependencies.query, async (sources) => {
        for (const { document, receiptRecoveryJson } of sources) {
          planDeliveryRecoveryStateBackfill(document, receiptRecoveryJson, VALIDATION_GENERATION);
        }
        await renew();
      });
      await mutate(dependencies.query, `UPDATE commerce_delivery_recovery_control SET preparation_state = 'preparing',
          source_documents_revision = ${current.documentsRevision}, prepared_at_ms = NULL
        WHERE singleton = 1 AND ${mutationGuard} RETURNING singleton`);
      await eachPage(dependencies.query, async (sources) => {
        await renew();
        const records = sources.flatMap(({ document, receiptRecoveryJson, state: actual }) => {
          const expected = planDeliveryRecoveryStateBackfill(document, receiptRecoveryJson, actual?.generation ?? dependencies.uuid());
          return actual && isDeepStrictEqual(actual, expected) ? [] : [expected];
        });
        await importRecords(dependencies.query, records, mutationGuard);
      });
      deliveryCount = await verifyState(dependencies.query, true, renew);
      await mutate(dependencies.query, `UPDATE commerce_delivery_recovery_control SET preparation_state = 'ready', prepared_at_ms = ${COMMERCE_D1_NOW_MS_SQL}
        WHERE singleton = 1 AND preparation_state = 'preparing' AND source_documents_revision = ${current.documentsRevision}
          AND ${mutationGuard} RETURNING singleton`);
    } else {
      if (current.preparation !== 'ready' || current.sourceDocumentsRevision !== current.documentsRevision) throw new Error('Delivery recovery state preparation is incomplete or stale; run prepare while paused.');
      deliveryCount = await verifyState(dependencies.query, true, renew);
      await renew();
      try {
        await mutate(dependencies.query, `UPDATE commerce_delivery_recovery_control SET storage_mode = 'table'
          WHERE singleton = 1 AND preparation_state = 'ready' AND ${mutationGuard} RETURNING singleton`);
      } catch (error) {
        const observed = await state(dependencies.query);
        if (observed.mode !== 'table' || !observed.paused || observed.revision !== current.revision ||
          observed.documentsRevision !== current.documentsRevision) throw error;
      }
    }
    return await summary(dependencies.query, renew, deliveryCount);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  console.log(JSON.stringify(await runDeliveryRecoveryStateControl(process.argv.slice(2)), null, 2));
}
