import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { parseNotificationOutboxRow, type NotificationOutboxRecord } from '../../shared/notificationOutbox.ts';
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
import { planNotificationOutboxBackfill } from '../shared/notificationOutboxMaintenance.ts';

type Options = { command: 'status' | 'prepare' | 'activate'; write: boolean; expectedRevision?: number; workerDeployed: boolean };
type Dependencies = { query: CommerceAuthorityQuery; uuid: () => string };
type ControlState = {
  mode: 'legacy' | 'table'; preparation: 'idle' | 'preparing' | 'ready'; paused: boolean;
  revision: number; documentsRevision: number; sourceDocumentsRevision: number | null; preparedAtMs: number | null;
};
const PAGE_SIZE = 25;

export function parseNotificationOutboxControlArgs(argv: string[]): Options {
  const command = argv[0];
  if (command !== 'status' && command !== 'prepare' && command !== 'activate') {
    throw new Error('Usage: npm run notification-outbox-control -- <status|prepare|activate> [--expected-revision <n> --write] [--worker-deployed]');
  }
  const options: Options = { command, write: false, workerDeployed: false };
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--write') options.write = true;
    else if (flag === '--worker-deployed') options.workerDeployed = true;
    else if (flag === '--expected-revision' && argv[index + 1]) {
      options.expectedRevision = safeInteger(argv[++index], 'Expected authority revision');
      if (options.expectedRevision < 1) throw new Error('Expected authority revision must be positive.');
    } else throw new Error(`Invalid notification-outbox argument: ${flag}`);
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
    JOIN commerce_notification_outbox_control AS outbox ON outbox.singleton = authority.singleton
    WHERE authority.singleton = 1`);
  const row = rows[0];
  if (rows.length !== 1 || !['legacy', 'table'].includes(String(row.storage_mode)) ||
    !['idle', 'preparing', 'ready'].includes(String(row.preparation_state))) throw new Error('Invalid notification outbox control; apply migration 0013 first.');
  return {
    mode: row.storage_mode as ControlState['mode'], preparation: row.preparation_state as ControlState['preparation'],
    paused: row.authority_state === 'paused' && row.paused_at_ms !== null,
    revision: safeInteger(row.revision, 'Authority revision'), documentsRevision: safeInteger(row.documents_revision, 'Documents revision'),
    sourceDocumentsRevision: row.source_documents_revision === null ? null : safeInteger(row.source_documents_revision, 'Outbox source revision'),
    preparedAtMs: row.prepared_at_ms === null ? null : safeInteger(row.prepared_at_ms, 'Outbox preparation timestamp'),
  };
}

async function eachDocument(query: CommerceAuthorityQuery, visit: (document: CommerceD1Document) => Promise<void>): Promise<void> {
  let cursor = '';
  for (;;) {
    const rows = await query(`SELECT document_path, document_kind, drop_id, document_id, document_json,
        version, create_time, update_time FROM commerce_documents
      WHERE document_kind IN ('delivery_order', 'stripe_checkout') AND document_path > ${sqlString(cursor)}
      ORDER BY document_path LIMIT ${PAGE_SIZE}`);
    for (const row of rows) await visit(parseCommerceD1DocumentRow(row));
    if (rows.length < PAGE_SIZE) return;
    cursor = String(rows.at(-1)!.document_path);
  }
}

function guard(current: ControlState, token: string): string {
  return `EXISTS (SELECT 1 FROM commerce_authority_control AS authority
    JOIN commerce_authority_control_lease AS lease ON lease.singleton = authority.singleton
    JOIN commerce_notification_outbox_control AS outbox ON outbox.singleton = authority.singleton
    WHERE authority.singleton = 1 AND authority.authority_state = 'paused' AND authority.paused_at_ms IS NOT NULL
      AND authority.revision = ${current.revision} AND authority.documents_revision = ${current.documentsRevision}
      AND outbox.storage_mode = ${sqlString(current.mode)}
      AND lease.lease_token = ${sqlString(token)} AND lease.expires_at_ms > ${COMMERCE_D1_NOW_MS_SQL})`;
}

async function mutate(query: CommerceAuthorityQuery, sql: string): Promise<void> {
  if ((await query(sql)).length !== 1) throw new Error('Notification outbox mutation was not confirmed; keep Commerce paused and rerun the command.');
}

function entriesExpression(document: CommerceD1Document, record: NotificationOutboxRecord): string {
  let expression = sqlString(JSON.stringify(record.entries.map(({ payload: _payload, ...entry }) => entry)));
  record.entries.forEach((entry, index) => {
    if (!entry.payload) return;
    let jsonPath: string;
    if (record.family === 'stripe_terminal') {
      const jobs = (document.data.stripeTerminalNotification as { jobs: { kind: string }[] }).jobs;
      jsonPath = `$.stripeTerminalNotification.jobs[${jobs.findIndex((job) => job.kind === entry.kind)}]`;
    } else jsonPath = entry.kind === 'buyer_order_received' ? '$.buyerOrderReceivedEmailJob' : '$.shipperReadyToShipEmailJob';
    expression = `json_set(${expression}, '$[${index}].payload', json_extract(document_json, ${sqlString(jsonPath)}))`;
  });
  return expression;
}

async function importRecord(dependencies: Dependencies, document: CommerceD1Document, record: NotificationOutboxRecord, mutationGuard: string) {
  const value = (value: string | number | null) => value === null ? 'NULL' : typeof value === 'number' ? String(value) : sqlString(value);
  await mutate(dependencies.query, `INSERT INTO commerce_notification_outbox (
      parent_path, family, drop_id, generation, outcome, state, entries_json, revision, attempt_count,
      next_attempt_at_ms, claim_id, claim_expires_at_ms, retry_until_ms, created_at_ms, updated_at_ms, last_error_code
    ) SELECT ${[record.parentPath, record.family, record.dropId, record.generation, record.outcome, record.state].map(value).join(', ')},
      ${entriesExpression(document, record)}, ${[record.revision, record.attemptCount, record.nextAttemptAtMs, record.claimId,
        record.claimExpiresAtMs, record.retryUntilMs, record.createdAtMs, record.updatedAtMs, record.lastErrorCode].map(value).join(', ')}
    FROM commerce_documents WHERE document_path = ${sqlString(document.path)} AND version = ${document.version} AND ${mutationGuard}
    RETURNING parent_path`);
}

async function verifyBackfill(query: CommerceAuthorityQuery, renew: () => Promise<void>): Promise<number> {
  let expectedCount = 0;
  await eachDocument(query, async (document) => {
    const expected = planNotificationOutboxBackfill(document);
    if (!expected.length) {
      await renew();
      return;
    }
    const actual = (await query(`SELECT * FROM commerce_notification_outbox WHERE parent_path = ${sqlString(document.path)} ORDER BY family`))
      .map(parseNotificationOutboxRow);
    if (!isDeepStrictEqual(actual, expected.sort((a, b) => a.family.localeCompare(b.family)))) {
      throw new Error(`Notification backfill differs from source: ${document.path}; keep Commerce paused and rerun prepare.`);
    }
    expectedCount += expected.length;
    await renew();
  });
  const rows = await query('SELECT COUNT(*) AS count FROM commerce_notification_outbox');
  if (Number(rows[0]?.count) !== expectedCount) throw new Error('Notification backfill has unexpected records; keep Commerce paused.');
  return expectedCount;
}

async function summary(query: CommerceAuthorityQuery) {
  const current = await state(query);
  let plannedGroups = 0;
  let validationError: string | null = null;
  if (current.mode === 'legacy') {
    try { await eachDocument(query, async (document) => { plannedGroups += planNotificationOutboxBackfill(document).length; }); }
    catch (error) { validationError = error instanceof Error ? error.message : 'Invalid legacy notification data.'; }
  }
  const groups = await query(`SELECT family, state, COUNT(*) AS count,
      MIN(CASE WHEN state = 'pending' THEN created_at_ms END) AS oldest_pending_at_ms,
      MAX(CASE WHEN state = 'pending' THEN MAX(0, ${COMMERCE_D1_NOW_MS_SQL} - created_at_ms) END) AS oldest_pending_age_ms,
      SUM(CASE WHEN state = 'pending' AND claim_id IS NOT NULL AND claim_expires_at_ms <= ${COMMERCE_D1_NOW_MS_SQL} THEN 1 ELSE 0 END) AS expired_claims
    FROM commerce_notification_outbox GROUP BY family, state ORDER BY family, state`);
  const failures = await query(`SELECT family, last_error_code, COUNT(*) AS count FROM commerce_notification_outbox
    WHERE state = 'failed' OR last_error_code IS NOT NULL GROUP BY family, last_error_code ORDER BY family, last_error_code`);
  return { ...current, ...(current.mode === 'legacy' ? { plannedGroups, validationError } : {}), groups, failures };
}

export async function runNotificationOutboxControl(argv: string[], overrides: Partial<Dependencies> = {}) {
  const options = parseNotificationOutboxControlArgs(argv);
  const dependencies: Dependencies = { query: queryRemoteCommerceD1, uuid: () => crypto.randomUUID(), ...overrides };
  if (options.command === 'status') return summary(dependencies.query);
  const requirePause = (current: ControlState) => {
    if (!current.paused || current.revision !== options.expectedRevision) throw new Error('Notification changes require the expected authority revision and completed Commerce pause/drain.');
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
    if ((await dependencies.query('SELECT guard_id FROM commerce_wipe_guards LIMIT 1')).length) throw new Error('A drop wipe is unfinished; complete it before notification changes.');
    if (current.mode === 'table') {
      let cursor = '';
      let family = '';
      for (;;) {
        const rows = await dependencies.query(`SELECT * FROM commerce_notification_outbox
          WHERE (parent_path, family) > (${sqlString(cursor)}, ${sqlString(family)}) ORDER BY parent_path, family LIMIT ${PAGE_SIZE}`);
        rows.forEach(parseNotificationOutboxRow);
        if (rows.length < PAGE_SIZE) break;
        cursor = String(rows.at(-1)!.parent_path);
        family = String(rows.at(-1)!.family);
        await renew();
      }
      return summary(dependencies.query);
    }
    await eachDocument(dependencies.query, async (document) => { planNotificationOutboxBackfill(document); await renew(); });
    const mutationGuard = guard(current, lease.token);
    if (options.command === 'prepare') {
      await mutate(dependencies.query, `UPDATE commerce_notification_outbox_control SET preparation_state = 'preparing',
          source_documents_revision = ${current.documentsRevision}, prepared_at_ms = NULL
        WHERE singleton = 1 AND ${mutationGuard} RETURNING singleton`);
      for (;;) {
        await renew();
        const deleted = await dependencies.query(`DELETE FROM commerce_notification_outbox
          WHERE (parent_path, family) IN (SELECT parent_path, family FROM commerce_notification_outbox
            ORDER BY parent_path, family LIMIT ${PAGE_SIZE}) AND ${mutationGuard} RETURNING parent_path`);
        if (deleted.length < PAGE_SIZE) break;
      }
      await eachDocument(dependencies.query, async (document) => {
        await renew();
        for (const record of planNotificationOutboxBackfill(document)) await importRecord(dependencies, document, record, mutationGuard);
      });
      await verifyBackfill(dependencies.query, renew);
      await mutate(dependencies.query, `UPDATE commerce_notification_outbox_control SET preparation_state = 'ready', prepared_at_ms = ${COMMERCE_D1_NOW_MS_SQL}
        WHERE singleton = 1 AND preparation_state = 'preparing' AND source_documents_revision = ${current.documentsRevision}
          AND ${mutationGuard} RETURNING singleton`);
    } else {
      if (current.preparation !== 'ready' || current.sourceDocumentsRevision !== current.documentsRevision) throw new Error('Notification outbox preparation is incomplete or stale; run prepare while paused.');
      await verifyBackfill(dependencies.query, renew);
      await renew();
      try {
        await mutate(dependencies.query, `UPDATE commerce_notification_outbox_control SET storage_mode = 'table'
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
      if (operationError !== undefined) throw new AggregateError([operationError, error], 'Notification operation failed and its lease release could not be confirmed; keep Commerce paused.');
      throw error;
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  console.log(JSON.stringify(await runNotificationOutboxControl(process.argv.slice(2)), null, 2));
}
