import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { parsePackStatusOutboxRow, packStatusOutboxRow, type PackStatusOutboxRecord } from '../../shared/packStatusOutbox.ts';
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
import { LEGACY_PACK_STATUS_PROJECTION_FIELDS, planPackStatusOutboxBackfill } from '../shared/packStatusOutboxMaintenance.ts';

type Options = { command: 'status' | 'prepare' | 'activate'; write: boolean; expectedRevision?: number; workerDeployed: boolean };
type Dependencies = { query: CommerceAuthorityQuery; uuid: () => string };
type ControlState = {
  mode: 'legacy' | 'table'; preparation: 'idle' | 'preparing' | 'ready'; paused: boolean;
  revision: number; documentsRevision: number; sourceDocumentsRevision: number | null; preparedAtMs: number | null;
};
const PAGE_SIZE = 25;

function legacyProjectionPredicate(column = 'document_json'): string {
  return LEGACY_PACK_STATUS_PROJECTION_FIELDS.map((field) => `json_type(${column}, '$.${field}') IS NOT NULL`).join(' OR ');
}

export function parsePackStatusOutboxControlArgs(argv: string[]): Options {
  const command = argv[0];
  if (command !== 'status' && command !== 'prepare' && command !== 'activate') {
    throw new Error('Usage: npm run pack-status-outbox-control -- <status|prepare|activate> [--expected-revision <n> --write] [--worker-deployed]');
  }
  const options: Options = { command, write: false, workerDeployed: false };
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--write') options.write = true;
    else if (flag === '--worker-deployed') options.workerDeployed = true;
    else if (flag === '--expected-revision' && argv[index + 1]) {
      options.expectedRevision = safeInteger(argv[++index], 'Expected authority revision');
      if (options.expectedRevision < 1) throw new Error('Expected authority revision must be positive.');
    } else throw new Error(`Invalid pack-status outbox argument: ${flag}`);
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
      authority.documents_revision, outbox.storage_mode, outbox.preparation_state,
      outbox.source_documents_revision, outbox.prepared_at_ms
    FROM commerce_authority_control AS authority
    JOIN commerce_pack_status_outbox_control AS outbox ON outbox.singleton = authority.singleton
    WHERE authority.singleton = 1`);
  const row = rows[0];
  if (rows.length !== 1 || !['legacy', 'table'].includes(String(row.storage_mode)) ||
    !['idle', 'preparing', 'ready'].includes(String(row.preparation_state))) throw new Error('Invalid pack-status outbox control; apply migration 0029 first.');
  return {
    mode: row.storage_mode as ControlState['mode'], preparation: row.preparation_state as ControlState['preparation'],
    paused: row.authority_state === 'paused' && row.paused_at_ms !== null,
    revision: safeInteger(row.revision, 'Authority revision'), documentsRevision: safeInteger(row.documents_revision, 'Documents revision'),
    sourceDocumentsRevision: row.source_documents_revision === null ? null : safeInteger(row.source_documents_revision, 'Pack-status source revision'),
    preparedAtMs: row.prepared_at_ms === null ? null : safeInteger(row.prepared_at_ms, 'Pack-status preparation timestamp'),
  };
}

async function eachDocument(query: CommerceAuthorityQuery, visit: (document: CommerceD1Document) => Promise<void>): Promise<void> {
  let cursor = '';
  for (;;) {
    const rows = await query(`SELECT document_path, document_kind, drop_id, document_id, document_json,
        version, create_time, update_time FROM commerce_documents
      WHERE document_path > ${sqlString(cursor)} AND (
        ${legacyProjectionPredicate()}
      )
      ORDER BY document_path LIMIT ${PAGE_SIZE}`);
    for (const row of rows) await visit(parseCommerceD1DocumentRow(row));
    if (rows.length < PAGE_SIZE) return;
    cursor = String(rows.at(-1)!.document_path);
  }
}

function guard(current: ControlState, token: string): string {
  return `EXISTS (SELECT 1 FROM commerce_authority_control AS authority
    JOIN commerce_authority_control_lease AS lease ON lease.singleton = authority.singleton
    JOIN commerce_pack_status_outbox_control AS outbox ON outbox.singleton = authority.singleton
    WHERE authority.singleton = 1 AND authority.authority_state = 'paused' AND authority.paused_at_ms IS NOT NULL
      AND authority.revision = ${current.revision} AND authority.documents_revision = ${current.documentsRevision}
      AND outbox.storage_mode = ${sqlString(current.mode)}
      AND lease.lease_token = ${sqlString(token)} AND lease.expires_at_ms > ${COMMERCE_D1_NOW_MS_SQL})`;
}

async function mutate(query: CommerceAuthorityQuery, sql: string): Promise<void> {
  if ((await query(sql)).length !== 1) throw new Error('Pack-status outbox mutation was not confirmed; keep Commerce paused and rerun the command.');
}

async function importRecord(query: CommerceAuthorityQuery, record: PackStatusOutboxRecord, mutationGuard: string): Promise<void> {
  const row = packStatusOutboxRow(record);
  const columns = Object.keys(row);
  const values = Object.values(row).map((value) => value === null ? 'NULL' : typeof value === 'number' ? String(value) : sqlString(value));
  await mutate(query, `INSERT INTO commerce_pack_status_outbox (${columns.join(', ')})
    SELECT ${values.join(', ')} FROM commerce_documents
    WHERE document_path = ${sqlString(record.parentPath)} AND ${mutationGuard}
    ON CONFLICT(parent_path) DO UPDATE SET ${columns.filter((column) => column !== 'parent_path')
      .map((column) => `${column} = excluded.${column}`).join(', ')}
    RETURNING parent_path`);
}

async function verifyState(query: CommerceAuthorityQuery, legacy: boolean, renew: () => Promise<void>): Promise<number> {
  if (!legacy) {
    let cursor = '';
    let count = 0;
    for (;;) {
      const rows = await query(`SELECT outbox.*, document.document_kind AS parent_kind, document.drop_id AS parent_drop_id
        FROM commerce_pack_status_outbox AS outbox LEFT JOIN commerce_documents AS document
          ON document.document_path = outbox.parent_path
        WHERE outbox.parent_path > ${sqlString(cursor)} ORDER BY outbox.parent_path LIMIT ${PAGE_SIZE}`);
      for (const row of rows) {
        const actual = parsePackStatusOutboxRow(row);
        if (row.parent_kind !== 'delivery_order' || actual.dropId !== row.parent_drop_id) {
          throw new Error(`Pack-status outbox parent is invalid: ${actual.parentPath}.`);
        }
      }
      count += rows.length;
      await renew();
      if (rows.length < PAGE_SIZE) {
        const missing = await query(`SELECT document.document_path FROM commerce_documents AS document
          LEFT JOIN commerce_pack_status_outbox AS outbox ON outbox.parent_path = document.document_path
          WHERE document.document_kind = 'delivery_order' AND outbox.parent_path IS NULL
            AND (${legacyProjectionPredicate('document.document_json')}) LIMIT 1`);
        if (missing.length) throw new Error(`Pack-status outbox is missing: ${String(missing[0].document_path)}.`);
        return count;
      }
      cursor = String(rows.at(-1)!.parent_path);
    }
  }
  let count = 0;
  await eachDocument(query, async (document) => {
    const expected = planPackStatusOutboxBackfill(document);
    if (expected) {
      const rows = await query(`SELECT * FROM commerce_pack_status_outbox WHERE parent_path = ${sqlString(document.path)}`);
      if (rows.length !== 1 || !isDeepStrictEqual(parsePackStatusOutboxRow(rows[0]), expected)) {
        throw new Error(`Pack-status outbox differs from source: ${document.path}; keep Commerce paused and rerun prepare.`);
      }
      count += 1;
    }
    await renew();
  });
  const rows = await query('SELECT COUNT(*) AS count FROM commerce_pack_status_outbox');
  if (rows.length !== 1 || safeInteger(rows[0].count, 'Pack-status outbox count') !== count) {
    throw new Error('Pack-status outbox has unexpected records; keep Commerce paused.');
  }
  return count;
}

async function summary(query: CommerceAuthorityQuery) {
  const current = await state(query);
  let projectionCount = 0;
  let validationError: string | null = null;
  try {
    if (current.mode === 'legacy') {
      await eachDocument(query, async (document) => { if (planPackStatusOutboxBackfill(document)) projectionCount += 1; });
      if (current.preparation === 'ready') {
        if (current.sourceDocumentsRevision !== current.documentsRevision) throw new Error('Pack-status outbox preparation is stale.');
        await verifyState(query, true, async () => undefined);
      }
    } else projectionCount = await verifyState(query, false, async () => undefined);
  } catch (error) { validationError = error instanceof Error ? error.message : 'Invalid pack-status outbox.'; }
  const groups = await query(`SELECT state, COUNT(*) AS count,
      MIN(CASE WHEN state = 'pending' THEN created_at_ms END) AS oldest_pending_at_ms,
      MIN(next_attempt_at_ms) AS oldest_due_at_ms
    FROM commerce_pack_status_outbox GROUP BY state ORDER BY state`);
  const failures = await query(`SELECT state, last_error_code, COUNT(*) AS count FROM commerce_pack_status_outbox
    WHERE last_error_code IS NOT NULL GROUP BY state, last_error_code ORDER BY state, last_error_code`);
  return { ...current, projectionCount, validationError, groups, failures };
}

export async function runPackStatusOutboxControl(argv: string[], overrides: Partial<Dependencies> = {}) {
  const options = parsePackStatusOutboxControlArgs(argv);
  const dependencies: Dependencies = { query: queryRemoteCommerceD1, uuid: () => crypto.randomUUID(), ...overrides };
  if (options.command === 'status') return summary(dependencies.query);
  const requirePause = (current: ControlState) => {
    if (!current.paused || current.revision !== options.expectedRevision) throw new Error('Pack-status outbox changes require the expected authority revision and completed Commerce pause/drain.');
  };
  requirePause(await state(dependencies.query));
  let lease = await acquireCommerceAuthorityLease(dependencies.query, dependencies.uuid());
  let renewedAt = Date.now();
  const renew = async () => {
    if (Date.now() - renewedAt < 60_000) return;
    lease = await renewCommerceAuthorityLease(dependencies.query, lease);
    renewedAt = Date.now();
  };
  let operationError: unknown;
  try {
    const current = await state(dependencies.query);
    requirePause(current);
    if ((await dependencies.query('SELECT guard_id FROM commerce_wipe_guards LIMIT 1')).length) throw new Error('A drop wipe is unfinished; complete it before pack-status outbox changes.');
    if (current.mode === 'table') {
      await verifyState(dependencies.query, false, renew);
      return summary(dependencies.query);
    }
    await eachDocument(dependencies.query, async (document) => { planPackStatusOutboxBackfill(document); await renew(); });
    const mutationGuard = guard(current, lease.token);
    if (options.command === 'prepare') {
      await mutate(dependencies.query, `UPDATE commerce_pack_status_outbox_control SET preparation_state = 'preparing',
          source_documents_revision = ${current.documentsRevision}, prepared_at_ms = NULL
        WHERE singleton = 1 AND ${mutationGuard} RETURNING singleton`);
      await eachDocument(dependencies.query, async (document) => {
        await renew();
        const expected = planPackStatusOutboxBackfill(document);
        if (!expected) return;
        const rows = await dependencies.query(`SELECT * FROM commerce_pack_status_outbox WHERE parent_path = ${sqlString(document.path)}`);
        if (rows.length === 1 && isDeepStrictEqual(parsePackStatusOutboxRow(rows[0]), expected)) return;
        await importRecord(dependencies.query, expected, mutationGuard);
      });
      await verifyState(dependencies.query, true, renew);
      await mutate(dependencies.query, `UPDATE commerce_pack_status_outbox_control SET preparation_state = 'ready', prepared_at_ms = ${COMMERCE_D1_NOW_MS_SQL}
        WHERE singleton = 1 AND preparation_state = 'preparing' AND source_documents_revision = ${current.documentsRevision}
          AND ${mutationGuard} RETURNING singleton`);
    } else {
      if (current.preparation !== 'ready' || current.sourceDocumentsRevision !== current.documentsRevision) throw new Error('Pack-status outbox preparation is incomplete or stale; run prepare while paused.');
      await verifyState(dependencies.query, true, renew);
      await renew();
      try {
        await mutate(dependencies.query, `UPDATE commerce_pack_status_outbox_control SET storage_mode = 'table'
          WHERE singleton = 1 AND preparation_state = 'ready' AND ${mutationGuard} RETURNING singleton`);
      } catch (error) {
        const observed = await state(dependencies.query);
        if (observed.mode !== 'table' || !observed.paused || observed.revision !== current.revision ||
          observed.documentsRevision !== current.documentsRevision) throw error;
      }
    }
    return summary(dependencies.query);
  } catch (error) { operationError = error; throw error; }
  finally {
    try { await releaseCommerceAuthorityLease(dependencies.query, lease); }
    catch (error) {
      if (operationError !== undefined) throw new AggregateError([operationError, error], 'Pack-status outbox operation failed and its lease release could not be confirmed; keep Commerce paused.');
      throw error;
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  console.log(JSON.stringify(await runPackStatusOutboxControl(process.argv.slice(2)), null, 2));
}
