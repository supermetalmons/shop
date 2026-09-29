import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { parseStripeCheckoutStateRow, stripeCheckoutStateRow, type StripeCheckoutState } from '../../shared/stripeCheckoutState.ts';
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
import { planStripeCheckoutStateBackfill } from '../shared/stripeCheckoutStateMaintenance.ts';

type Options = { command: 'status' | 'prepare' | 'activate'; write: boolean; expectedRevision?: number; workerDeployed: boolean };
type Dependencies = { query: CommerceAuthorityQuery; uuid: () => string };
type ControlState = {
  mode: 'legacy' | 'table'; preparation: 'idle' | 'preparing' | 'ready'; paused: boolean;
  revision: number; documentsRevision: number; sourceDocumentsRevision: number | null; preparedAtMs: number | null;
};
const PAGE_SIZE = 25;

export function parseStripeCheckoutStateControlArgs(argv: string[]): Options {
  const command = argv[0];
  if (command !== 'status' && command !== 'prepare' && command !== 'activate') {
    throw new Error('Usage: npm run stripe-checkout-state-control -- <status|prepare|activate> [--expected-revision <n> --write] [--worker-deployed]');
  }
  const options: Options = { command, write: false, workerDeployed: false };
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--write') options.write = true;
    else if (flag === '--worker-deployed') options.workerDeployed = true;
    else if (flag === '--expected-revision' && argv[index + 1]) {
      options.expectedRevision = safeInteger(argv[++index], 'Expected authority revision');
      if (options.expectedRevision < 1) throw new Error('Expected authority revision must be positive.');
    } else throw new Error(`Invalid Stripe checkout state argument: ${flag}`);
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
      authority.documents_revision, checkout.storage_mode, checkout.preparation_state,
      checkout.source_documents_revision, checkout.prepared_at_ms
    FROM commerce_authority_control AS authority
    JOIN commerce_stripe_checkout_state_control AS checkout ON checkout.singleton = authority.singleton
    WHERE authority.singleton = 1`);
  const row = rows[0];
  if (rows.length !== 1 || !['legacy', 'table'].includes(String(row.storage_mode)) ||
    !['idle', 'preparing', 'ready'].includes(String(row.preparation_state))) throw new Error('Invalid Stripe checkout state control; apply migration 0026 first.');
  return {
    mode: row.storage_mode as ControlState['mode'], preparation: row.preparation_state as ControlState['preparation'],
    paused: row.authority_state === 'paused' && row.paused_at_ms !== null,
    revision: safeInteger(row.revision, 'Authority revision'), documentsRevision: safeInteger(row.documents_revision, 'Documents revision'),
    sourceDocumentsRevision: row.source_documents_revision === null ? null : safeInteger(row.source_documents_revision, 'Checkout source revision'),
    preparedAtMs: row.prepared_at_ms === null ? null : safeInteger(row.prepared_at_ms, 'Checkout preparation timestamp'),
  };
}

async function eachDocument(query: CommerceAuthorityQuery, visit: (document: CommerceD1Document) => Promise<void>): Promise<void> {
  let cursor = '';
  for (;;) {
    const rows = await query(`SELECT document_path, document_kind, drop_id, document_id, document_json,
        version, create_time, update_time FROM commerce_documents
      WHERE document_kind = 'stripe_checkout' AND document_path > ${sqlString(cursor)}
      ORDER BY document_path LIMIT ${PAGE_SIZE}`);
    for (const row of rows) await visit(parseCommerceD1DocumentRow(row));
    if (rows.length < PAGE_SIZE) return;
    cursor = String(rows.at(-1)!.document_path);
  }
}

function guard(current: ControlState, token: string): string {
  return `EXISTS (SELECT 1 FROM commerce_authority_control AS authority
    JOIN commerce_authority_control_lease AS lease ON lease.singleton = authority.singleton
    JOIN commerce_stripe_checkout_state_control AS checkout ON checkout.singleton = authority.singleton
    WHERE authority.singleton = 1 AND authority.authority_state = 'paused' AND authority.paused_at_ms IS NOT NULL
      AND authority.revision = ${current.revision} AND authority.documents_revision = ${current.documentsRevision}
      AND checkout.storage_mode = ${sqlString(current.mode)}
      AND lease.lease_token = ${sqlString(token)} AND lease.expires_at_ms > ${COMMERCE_D1_NOW_MS_SQL})`;
}

async function mutate(query: CommerceAuthorityQuery, sql: string): Promise<void> {
  if ((await query(sql)).length !== 1) throw new Error('Stripe checkout state mutation was not confirmed; keep Commerce paused and rerun the command.');
}

async function importRecord(query: CommerceAuthorityQuery, record: StripeCheckoutState, mutationGuard: string): Promise<void> {
  const row = stripeCheckoutStateRow(record);
  const columns = Object.keys(row);
  const values = Object.values(row).map((value) => value === null ? 'NULL' : typeof value === 'number' ? String(value) : sqlString(value));
  await mutate(query, `INSERT INTO commerce_stripe_checkout_state (${columns.join(', ')})
    SELECT ${values.join(', ')} FROM commerce_documents
    WHERE document_path = ${sqlString(record.documentPath)} AND version = ${record.documentVersion} AND ${mutationGuard}
    ON CONFLICT(document_path) DO UPDATE SET ${columns.filter((column) => column !== 'document_path')
      .map((column) => `${column} = excluded.${column}`).join(', ')}
    RETURNING document_path`);
}

async function verifyState(query: CommerceAuthorityQuery, legacy: boolean, renew: () => Promise<void>): Promise<number> {
  if (!legacy) {
    let cursor = '';
    let count = 0;
    for (;;) {
      const rows = await query(`SELECT checkout.*, document.document_path AS parent_path, document.version AS parent_version
        FROM commerce_documents AS document LEFT JOIN commerce_stripe_checkout_state AS checkout
          ON checkout.document_path = document.document_path
        WHERE document.document_kind = 'stripe_checkout' AND document.document_path > ${sqlString(cursor)}
        ORDER BY document.document_path LIMIT ${PAGE_SIZE}`);
      for (const row of rows) {
        const actual = parseStripeCheckoutStateRow(row);
        if (actual.documentPath !== row.parent_path || actual.documentVersion !== row.parent_version) {
          throw new Error(`Stripe checkout state differs from source: ${String(row.parent_path)}.`);
        }
      }
      count += rows.length;
      await renew();
      if (rows.length < PAGE_SIZE) break;
      cursor = String(rows.at(-1)!.parent_path);
    }
    const invalid = await query(`SELECT COUNT(*) AS count FROM commerce_stripe_checkout_state AS checkout
      LEFT JOIN commerce_documents AS document ON document.document_path = checkout.document_path
      WHERE document.document_kind IS NOT 'stripe_checkout'`);
    if (invalid.length !== 1 || safeInteger(invalid[0].count, 'Invalid checkout state count') !== 0) throw new Error('Stripe checkout state has unexpected records.');
    return count;
  }
  let count = 0;
  await eachDocument(query, async (document) => {
    const rows = await query(`SELECT * FROM commerce_stripe_checkout_state WHERE document_path = ${sqlString(document.path)}`);
    if (rows.length !== 1) throw new Error(`Stripe checkout state is missing: ${document.path}.`);
    const actual = parseStripeCheckoutStateRow(rows[0]);
    if (actual.documentVersion !== document.version || (legacy && !isDeepStrictEqual(actual, planStripeCheckoutStateBackfill(document)))) {
      throw new Error(`Stripe checkout state differs from source: ${document.path}; keep Commerce paused and rerun prepare.`);
    }
    count += 1;
    await renew();
  });
  const rows = await query('SELECT COUNT(*) AS count FROM commerce_stripe_checkout_state');
  if (rows.length !== 1 || safeInteger(rows[0].count, 'Checkout state count') !== count) throw new Error('Stripe checkout state has unexpected records; keep Commerce paused.');
  return count;
}

async function summary(query: CommerceAuthorityQuery) {
  const current = await state(query);
  let checkoutCount = 0;
  let validationError: string | null = null;
  try {
    if (current.mode === 'legacy') {
      await eachDocument(query, async (document) => { planStripeCheckoutStateBackfill(document); checkoutCount += 1; });
    } else checkoutCount = await verifyState(query, false, async () => undefined);
  } catch (error) { validationError = error instanceof Error ? error.message : 'Invalid Stripe checkout state.'; }
  const groups = await query(`SELECT status, COUNT(*) AS count,
      MIN(CASE WHEN status IN ('fulfillment_pending', 'processing') THEN updated_at_ms END) AS oldest_pending_at_ms,
      SUM(CASE WHEN status = 'processing' AND processing_lease_expires_at_ms <= ${COMMERCE_D1_NOW_MS_SQL} THEN 1 ELSE 0 END) AS expired_claims
    FROM commerce_stripe_checkout_state GROUP BY status ORDER BY status`);
  return { ...current, checkoutCount, validationError, groups };
}

export async function runStripeCheckoutStateControl(argv: string[], overrides: Partial<Dependencies> = {}) {
  const options = parseStripeCheckoutStateControlArgs(argv);
  const dependencies: Dependencies = { query: queryRemoteCommerceD1, uuid: () => crypto.randomUUID(), ...overrides };
  if (options.command === 'status') return summary(dependencies.query);
  const requirePause = (current: ControlState) => {
    if (!current.paused || current.revision !== options.expectedRevision) throw new Error('Stripe checkout state changes require the expected authority revision and completed Commerce pause/drain.');
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
    if ((await dependencies.query('SELECT guard_id FROM commerce_wipe_guards LIMIT 1')).length) throw new Error('A drop wipe is unfinished; complete it before Stripe checkout state changes.');
    if (current.mode === 'table') {
      await verifyState(dependencies.query, false, renew);
      return summary(dependencies.query);
    }
    await eachDocument(dependencies.query, async (document) => { planStripeCheckoutStateBackfill(document); await renew(); });
    const mutationGuard = guard(current, lease.token);
    if (options.command === 'prepare') {
      await mutate(dependencies.query, `UPDATE commerce_stripe_checkout_state_control SET preparation_state = 'preparing',
          source_documents_revision = ${current.documentsRevision}, prepared_at_ms = NULL
        WHERE singleton = 1 AND ${mutationGuard} RETURNING singleton`);
      await eachDocument(dependencies.query, async (document) => {
        await renew();
        const expected = planStripeCheckoutStateBackfill(document);
        const rows = await dependencies.query(`SELECT * FROM commerce_stripe_checkout_state WHERE document_path = ${sqlString(document.path)}`);
        if (rows.length === 1 && isDeepStrictEqual(parseStripeCheckoutStateRow(rows[0]), expected)) return;
        await importRecord(dependencies.query, expected, mutationGuard);
      });
      await verifyState(dependencies.query, true, renew);
      await mutate(dependencies.query, `UPDATE commerce_stripe_checkout_state_control SET preparation_state = 'ready', prepared_at_ms = ${COMMERCE_D1_NOW_MS_SQL}
        WHERE singleton = 1 AND preparation_state = 'preparing' AND source_documents_revision = ${current.documentsRevision}
          AND ${mutationGuard} RETURNING singleton`);
    } else {
      if (current.preparation !== 'ready' || current.sourceDocumentsRevision !== current.documentsRevision) throw new Error('Stripe checkout state preparation is incomplete or stale; run prepare while paused.');
      await verifyState(dependencies.query, true, renew);
      await renew();
      try {
        await mutate(dependencies.query, `UPDATE commerce_stripe_checkout_state_control SET storage_mode = 'table'
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
      if (operationError !== undefined) throw new AggregateError([operationError, error], 'Stripe checkout state operation failed and its lease release could not be confirmed; keep Commerce paused.');
      throw error;
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  console.log(JSON.stringify(await runStripeCheckoutStateControl(process.argv.slice(2)), null, 2));
}
