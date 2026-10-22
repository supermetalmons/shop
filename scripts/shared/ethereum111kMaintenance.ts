import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import { createD1MaintenanceRunner } from './d1MaintenanceRunner.ts';
import { parseEthereum111kControl, ETHEREUM_111K_CONTROL_SQL, type Ethereum111kControl } from '../../shared/ethereum/control.ts';
import { ETHEREUM_111K_DROP_ID } from '../../shared/ethereum/protocol.ts';
import { parseDeliveryRecoveryRow } from '../../shared/deliveryRecoveryState.ts';
import { serializeCommerceCommitExpectations } from '../../cloud/workers/api/src/commerceCommitExpectations.ts';
import { COMMERCE_D1_NOW_MS_SQL, safeInteger, sqlString, type CommerceAuthorityQuery, type CommerceD1Row } from './commerceD1Maintenance.ts';

export function createEthereum111kMaintenanceRunner(
  executeFile: (file: string, args: string[], options: ExecFileSyncOptionsWithStringEncoding) => string = execFileSync,
) {
  return createD1MaintenanceRunner('commerce', (file, args, options) => {
    try {
      return executeFile(file, args, { ...options, env: { ...options.env, WRANGLER_LOG_SANITIZE: 'true' } });
    } catch {
      throw new Error('Ethereum 111k D1 request failed.');
    }
  });
}

const ETHEREUM_111K_DRAIN_MS = 65_000;
const CHECKOUT_SNAPSHOT_PAGE_SIZE = 16;
const RESET_ASSERTION_MAX_ROWS = 100;
const RESET_ASSERTION_MAX_BYTES = 64_000;
export type Ethereum111kScope = { chainId: number; contractAddress: string };
export type Ethereum111kQueryBatch = (queries: Record<string, string>) => Record<string, CommerceD1Row[]> | Promise<Record<string, CommerceD1Row[]>>;
export type Ethereum111kSnapshot = {
  control: Ethereum111kControl;
  databaseNowMs: number;
  documents: CommerceD1Row[];
  recovery: CommerceD1Row[];
  quotes: CommerceD1Row[];
  checkouts: CommerceD1Row[];
  attempts: CommerceD1Row[];
  claims: CommerceD1Row[];
  cursors: CommerceD1Row[];
  counts: Record<string, number>;
};
export type Ethereum111kResetPlan = { resetId: string; scope: Ethereum111kScope; expectedRevision: number; snapshot: Ethereum111kSnapshot };

export function ethereum111kScope(chainId: unknown, contractAddress: unknown): Ethereum111kScope {
  if (typeof chainId !== 'number' || !Number.isSafeInteger(chainId) || chainId < 1
    || typeof contractAddress !== 'string' || (!/^0x[0-9a-fA-F]{40}$/.test(contractAddress) || /^0x0{40}$/.test(contractAddress))) {
    throw new Error('Ethereum scope requires a positive chain ID and a 42-character contract address.');
  }
  return { chainId, contractAddress: contractAddress.toLowerCase() };
}

export async function readEthereum111kControl(query: CommerceAuthorityQuery): Promise<Ethereum111kControl> {
  const rows = await query(ETHEREUM_111K_CONTROL_SQL);
  if (rows.length !== 1) throw new Error('Ethereum 111k control is missing or duplicated.');
  return parseEthereum111kControl(rows[0]);
}

function scopeSql(scope: Ethereum111kScope): string {
  return `chain_id = ${scope.chainId} AND contract_address = ${sqlString(scope.contractAddress)}`;
}

function checkoutAttemptsScopeSql(scope: Ethereum111kScope): string {
  return `checkout_id IN (SELECT checkout_id FROM ethereum_delivery_checkouts WHERE ${scopeSql(scope)})`;
}

const dropSql = `drop_id = '${ETHEREUM_111K_DROP_ID}'`;
const ETHEREUM_111K_COUNTS_SQL = `SELECT
  (SELECT COUNT(*) FROM commerce_documents WHERE ${dropSql}) AS documents,
  (SELECT COUNT(*) FROM commerce_delivery_recovery WHERE parent_path IN
    (SELECT document_path FROM commerce_documents WHERE ${dropSql})) AS recovery,
  (SELECT COUNT(*) FROM commerce_notification_outbox WHERE ${dropSql} OR parent_path IN
    (SELECT document_path FROM commerce_documents WHERE ${dropSql})) AS notifications,
  (SELECT COUNT(*) FROM commerce_pack_status_outbox WHERE ${dropSql} OR parent_path IN
    (SELECT document_path FROM commerce_documents WHERE ${dropSql})) AS pack_outbox,
  (SELECT COUNT(*) FROM commerce_inventory_drops WHERE ${dropSql}) AS inventory,
  (SELECT COUNT(*) FROM commerce_available_dudes WHERE ${dropSql}) AS available_dudes,
  (SELECT COUNT(*) FROM commerce_inventory_initializations WHERE ${dropSql}) AS inventory_initializations,
  (SELECT COUNT(*) FROM commerce_documents WHERE drop_id IS NOT '${ETHEREUM_111K_DROP_ID}'
    AND json_extract(document_json, '$.dropId') = '${ETHEREUM_111K_DROP_ID}') AS linked_documents`;
export const ETHEREUM_111K_DATA_PREFLIGHT_SQL = `SELECT
  (SELECT COUNT(*) FROM pack_status_events WHERE ${dropSql}) AS events,
  (SELECT COUNT(*) FROM pack_status WHERE ${dropSql} AND
    (unsealed_online <> 0 OR redeemed_irl_normal <> 0 OR redeemed_irl_stripe <> 0 OR redeemed_unsealed_cards <> 0)) AS history`;
export const ETHEREUM_111K_OPS_PREFLIGHT_SQL = `SELECT COUNT(*) AS reveals FROM reveal_submissions WHERE ${dropSql}`;

export function requireZeroEthereum111kHistory(rows: CommerceD1Row[], label: string): void {
  if (rows.length !== 1 || Object.keys(rows[0]).length === 0
    || Object.values(rows[0]).some(value => value !== 0)) throw new Error(`Ethereum 111k reset blocked by ${label}.`);
}

export async function readEthereum111kSnapshot(queryBatch: Ethereum111kQueryBatch, scope: Ethereum111kScope): Promise<Ethereum111kSnapshot> {
  scope = ethereum111kScope(scope.chainId, scope.contractAddress);
  const checkoutBoundsSql = `SELECT COUNT(*) AS count, MAX(checkout_id) AS last_checkout_id
    FROM ethereum_delivery_checkouts WHERE ${scopeSql(scope)}`;
  const result = await queryBatch({
    control: `${ETHEREUM_111K_CONTROL_SQL.replace('SELECT ', `SELECT ${COMMERCE_D1_NOW_MS_SQL} AS database_now_ms, `)}`,
    documents: `SELECT document.*, path.revision AS path_revision FROM commerce_documents AS document
      JOIN commerce_document_path_revisions AS path ON path.document_path = document.document_path
      WHERE document.${dropSql} ORDER BY document.document_path`,
    recovery: `SELECT * FROM commerce_delivery_recovery WHERE parent_path IN
      (SELECT document_path FROM commerce_documents WHERE ${dropSql}) ORDER BY parent_path`,
    quotes: `SELECT * FROM ethereum_delivery_quotes WHERE ${scopeSql(scope)} ORDER BY order_id`,
    checkoutBounds: checkoutBoundsSql,
    attempts: `SELECT * FROM ethereum_delivery_checkout_attempts WHERE ${checkoutAttemptsScopeSql(scope)} ORDER BY attempt_id`,
    claims: `SELECT * FROM ethereum_crate_claims WHERE ${scopeSql(scope)} ORDER BY receipt_id`,
    cursors: `SELECT * FROM ethereum_reconciliation_cursor WHERE ${scopeSql(scope)}`,
    counts: ETHEREUM_111K_COUNTS_SQL,
  });
  if (result.control.length !== 1 || result.counts.length !== 1) throw new Error('Invalid Ethereum 111k snapshot.');
  const control = parseEthereum111kControl(result.control[0]);
  const checkControl = (rows: CommerceD1Row[]) => {
    if (rows.length !== 1 || JSON.stringify(parseEthereum111kControl(rows[0])) !== JSON.stringify(control)) {
      throw new Error('Ethereum 111k control changed while reading the snapshot.');
    }
  };
  const bounds = checkoutSnapshotBounds(result.checkoutBounds);
  const checkouts: CommerceD1Row[] = [];
  let after = '';
  while (checkouts.length < bounds.count) {
    const page = await queryBatch({
      control: ETHEREUM_111K_CONTROL_SQL,
      checkouts: `SELECT * FROM ethereum_delivery_checkouts WHERE ${scopeSql(scope)}
        AND checkout_id > ${sqlString(after)} AND checkout_id <= ${sqlString(bounds.lastId!)}
        ORDER BY checkout_id LIMIT ${CHECKOUT_SNAPSHOT_PAGE_SIZE}`,
    });
    checkControl(page.control);
    if (!page.checkouts.length || page.checkouts.length > CHECKOUT_SNAPSHOT_PAGE_SIZE ||
      checkouts.length + page.checkouts.length > bounds.count) {
      throw new Error('Ethereum checkout snapshot is incomplete or changed while reading.');
    }
    for (const checkout of page.checkouts) {
      if (typeof checkout.checkout_id !== 'string' || checkout.checkout_id <= after || checkout.checkout_id > bounds.lastId!) {
        throw new Error('Ethereum checkout snapshot is incomplete or changed while reading.');
      }
      checkouts.push(checkout);
      after = checkout.checkout_id;
    }
  }
  const final = await queryBatch({ control: ETHEREUM_111K_CONTROL_SQL, checkoutBounds: checkoutBoundsSql });
  checkControl(final.control);
  if (bounds.count > 0 && after !== bounds.lastId || JSON.stringify(checkoutSnapshotBounds(final.checkoutBounds)) !== JSON.stringify(bounds)) {
    throw new Error('Ethereum checkout snapshot changed while reading.');
  }
  return { control, databaseNowMs: safeInteger(result.control[0].database_now_ms, 'Database time'),
    documents: result.documents, recovery: result.recovery, quotes: result.quotes, checkouts, attempts: result.attempts,
    claims: result.claims, cursors: result.cursors,
    counts: Object.fromEntries(Object.entries(result.counts[0]).map(([key, value]) => [key, safeInteger(value, key)])) };
}

function checkoutSnapshotBounds(rows: CommerceD1Row[]): { count: number; lastId: string | null } {
  if (rows.length !== 1) throw new Error('Invalid Ethereum checkout snapshot bounds.');
  const count = safeInteger(rows[0].count, 'Checkout count');
  const lastId = rows[0].last_checkout_id;
  if (count === 0 ? lastId !== null : typeof lastId !== 'string' || !lastId) throw new Error('Invalid Ethereum checkout snapshot bounds.');
  return { count, lastId: lastId as string | null };
}

export function buildEthereum111kResetPlan(snapshot: Ethereum111kSnapshot, scope: Ethereum111kScope,
  expectedRevision: number, resetId: string): Ethereum111kResetPlan {
  scope = ethereum111kScope(scope.chainId, scope.contractAddress);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(resetId)) throw new Error('Invalid reset ID.');
  const control = snapshot.control;
  if (!control.paused || control.resetGuardId !== null || control.revision !== expectedRevision
    || control.chainId !== scope.chainId || control.contractAddress !== scope.contractAddress) throw new Error('Ethereum 111k reset requires the expected paused scope and revision.');
  if (snapshot.databaseNowMs - control.pausedAtMs! < ETHEREUM_111K_DRAIN_MS) throw new Error('Ethereum 111k must be paused for at least 65 seconds before reset.');
  for (const key of ['notifications', 'pack_outbox', 'inventory', 'available_dudes', 'inventory_initializations', 'linked_documents']) {
    if (snapshot.counts[key] !== 0) throw new Error(`Ethereum 111k reset blocked by ${key}.`);
  }
  if (snapshot.counts.documents !== snapshot.documents.length || snapshot.counts.recovery !== snapshot.recovery.length
    || snapshot.documents.length !== snapshot.recovery.length || snapshot.cursors.length > 1) throw new Error('Incomplete Ethereum 111k snapshot.');
  const recoveries = new Set(snapshot.recovery.map(row => parseDeliveryRecoveryRow(row).parentPath));
  const checkoutIds = new Set(snapshot.checkouts.map(row => row.checkout_id));
  if (snapshot.quotes.some(row => row.checkout_id !== null && !checkoutIds.has(row.checkout_id)) ||
    snapshot.attempts.some(row => !checkoutIds.has(row.checkout_id) ||
      !snapshot.quotes.some(quote => quote.order_id === row.order_id && quote.checkout_id === row.checkout_id))) {
    throw new Error('Incomplete Ethereum checkout snapshot.');
  }
  for (const row of snapshot.documents) {
    const data = JSON.parse(String(row.document_json));
    if (row.document_kind !== 'delivery_order' || row.source !== 'ethereum' || data.source !== 'ethereum'
      || data.chainId !== scope.chainId || data.contractAddress !== scope.contractAddress
      || !recoveries.has(String(row.document_path))
      || !snapshot.quotes.some(quote => String(quote.order_id) === row.document_id)) {
      throw new Error('Ethereum 111k contains unsupported documents or a different contract scope.');
    }
    safeInteger(row.path_revision, 'Document path revision');
    safeInteger(row.version, 'Document version');
  }
  return { resetId, scope, expectedRevision, snapshot };
}

function sqlValue(value: unknown): string {
  if (value === null) return 'NULL';
  if (typeof value === 'string') return sqlString(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  throw new Error('Invalid Ethereum snapshot value.');
}

function assertSql(predicate: string): string {
  return `SELECT CASE WHEN (${predicate}) THEN 1 ELSE json('ethereum 111k reset conflict') END AS reset_assertion`;
}

function rowAssertions(table: string, rows: CommerceD1Row[], ownsReset: string): string[] {
  function* predicates() {
    for (const row of rows) {
      yield `EXISTS (SELECT 1 FROM ${table} WHERE ${Object.entries(row)
        .filter(([key]) => key !== 'address_json' && key !== 'code' && (table !== 'ethereum_delivery_checkouts' || key !== 'items_json'))
        .map(([key, value]) => {
          if (!/^[a-z_]+$/.test(key)) throw new Error('Invalid snapshot column.');
          return `${key} IS ${sqlValue(value)}`;
        }).join(' AND ')})`;
    }
  }
  return resetStatementChunks(predicates(), chunk => assertSql(`${ownsReset} AND ${chunk.join(' AND ')}`),
    'Ethereum reset snapshot row exceeds the assertion size limit.');
}

function resetGuardSql(id: string, values: { documents?: string; recovery?: string; paths?: string; ethereum?: string } = {}): string {
  return `INSERT INTO commerce_commit_guards (guard_id, expectations_json, expected_documents_revision, created_at_ms,
    delivery_owner_expectations_json, delivery_recovery_expectations_json, delivery_recovery_paths_json, ethereum_state_expectations_json)
    VALUES (${sqlString(id)}, ${sqlString(values.documents ?? '[]')}, NULL, ${COMMERCE_D1_NOW_MS_SQL}, '[]',
      ${sqlString(values.recovery ?? '[]')}, ${sqlString(values.paths ?? '[]')}, ${sqlString(values.ethereum ?? '[]')})`;
}

function resetStatementChunks<T>(rows: Iterable<T>, render: (chunk: T[], index: number) => string,
  oversizedMessage = 'Ethereum reset expectation exceeds the guard size limit.'): string[] {
  const statements: string[] = [];
  let chunk: T[] = [];
  for (const row of rows) {
    if (chunk.length && (chunk.length >= RESET_ASSERTION_MAX_ROWS ||
      Buffer.byteLength(render([...chunk, row], statements.length)) > RESET_ASSERTION_MAX_BYTES)) {
      statements.push(render(chunk, statements.length));
      chunk = [];
    }
    chunk.push(row);
    if (Buffer.byteLength(render(chunk, statements.length)) > RESET_ASSERTION_MAX_BYTES) {
      throw new Error(oversizedMessage);
    }
  }
  if (chunk.length) statements.push(render(chunk, statements.length));
  return statements;
}

export function buildEthereum111kResetBatch(plan: Ethereum111kResetPlan): Record<string, string> {
  buildEthereum111kResetPlan(plan.snapshot, plan.scope, plan.expectedRevision, plan.resetId);
  const { snapshot, scope, resetId, expectedRevision } = plan;
  const guard = sqlString(resetId);
  const recovery = new Map(snapshot.recovery.map(row => { const state = parseDeliveryRecoveryRow(row); return [state.parentPath, state]; }));
  const documentGuards = resetStatementChunks(snapshot.documents, (rows, index) => {
    const expectations = serializeCommerceCommitExpectations({
      documents: new Map(rows.map(row => [String(row.document_path), { path: String(row.document_path),
        version: Number(row.version), pathRevision: Number(row.path_revision) }])),
      deliveryOwners: new Map(), notifications: new Map(),
      recovery: new Map(rows.map(row => [String(row.document_path), recovery.get(String(row.document_path))!])),
    });
    return resetGuardSql(`${resetId}:documents:${index}`, { documents: expectations.documents, recovery: expectations.recovery,
      paths: JSON.stringify(rows.map(row => row.document_path)) });
  });
  const ethereum = [...snapshot.quotes.map(row => ({ kind: 'delivery', chainId: row.chain_id, contractAddress: row.contract_address,
    id: String(row.order_id), status: row.status, transactionHash: row.transaction_hash, blockNumber: row.block_number,
    blockHash: row.block_hash, updatedAtMs: row.updated_at_ms })), ...snapshot.claims.map(row => ({ kind: 'claim', chainId: row.chain_id,
    contractAddress: row.contract_address, id: row.receipt_id, orderId: row.order_id, claimId: row.claim_id,
    status: row.status, transactionHash: row.transaction_hash, blockNumber: row.block_number,
    blockHash: row.block_hash, updatedAtMs: row.updated_at_ms }))];
  const ethereumGuards = resetStatementChunks(ethereum, (rows, index) =>
    resetGuardSql(`${resetId}:ethereum:${index}`, { ethereum: JSON.stringify(rows) }));
  const guards = [{ kind: 'documents', statements: documentGuards }, { kind: 'ethereum', statements: ethereumGuards }]
    .flatMap(({ kind, statements }) => statements.map((sql, index) => ({ key: `guard_${kind}_${index}`, id: `${resetId}:${kind}:${index}`, sql })));
  const ownsReset = `EXISTS (SELECT 1 FROM ethereum_111k_control WHERE singleton = 1 AND paused = 1
    AND revision = ${expectedRevision} AND reset_guard_id = ${guard} AND ${scopeSql(scope)})`;
  const tables = [
    { table: 'ethereum_delivery_quotes', rows: snapshot.quotes, predicate: scopeSql(scope) },
    { table: 'ethereum_delivery_checkouts', rows: snapshot.checkouts, predicate: scopeSql(scope) },
    { table: 'ethereum_delivery_checkout_attempts', rows: snapshot.attempts, predicate: checkoutAttemptsScopeSql(scope) },
    { table: 'ethereum_crate_claims', rows: snapshot.claims, predicate: scopeSql(scope) },
    { table: 'ethereum_reconciliation_cursor', rows: snapshot.cursors, predicate: scopeSql(scope) },
  ];
  const assertions = Object.fromEntries(tables.flatMap(({ table, rows }) =>
    rowAssertions(table, rows, ownsReset).map((sql, index) => [`assert_${table}_${index}`, sql])));
  return {
    guard: resetGuardSql(resetId),
    ...Object.fromEntries(guards.map(entry => [entry.key, entry.sql])),
    claim: `UPDATE ethereum_111k_control SET reset_guard_id = ${guard}, updated_at_ms = ${COMMERCE_D1_NOW_MS_SQL}
      WHERE singleton = 1 AND paused = 1 AND revision = ${expectedRevision} AND reset_guard_id IS NULL
        AND paused_at_ms <= ${COMMERCE_D1_NOW_MS_SQL} - ${ETHEREUM_111K_DRAIN_MS} AND ${scopeSql(scope)}`,
    assert: assertSql(`${ownsReset}
      AND EXISTS (SELECT 1 FROM (${ETHEREUM_111K_COUNTS_SQL}) WHERE ${Object.entries(snapshot.counts).map(([key, value]) => `${key} = ${value}`).join(' AND ')})
      AND ${tables.map(({ table, rows, predicate }) => `(SELECT COUNT(*) FROM ${table} WHERE ${predicate}) = ${rows.length}`).join(' AND ')}`),
    ...assertions,
    documents: `DELETE FROM commerce_documents WHERE ${dropSql} AND ${ownsReset}`,
    claims: `DELETE FROM ethereum_crate_claims WHERE ${scopeSql(scope)} AND ${ownsReset}`,
    attempts: `DELETE FROM ethereum_delivery_checkout_attempts WHERE ${checkoutAttemptsScopeSql(scope)} AND ${ownsReset}`,
    quotes: `DELETE FROM ethereum_delivery_quotes WHERE ${scopeSql(scope)} AND ${ownsReset}`,
    checkouts: `DELETE FROM ethereum_delivery_checkouts WHERE ${scopeSql(scope)} AND ${ownsReset}`,
    cursors: `DELETE FROM ethereum_reconciliation_cursor WHERE ${scopeSql(scope)} AND ${ownsReset}`,
    assertDeleted: assertSql(`${ownsReset} AND NOT EXISTS (SELECT 1 FROM commerce_documents WHERE ${dropSql})
      AND NOT EXISTS (SELECT 1 FROM ethereum_delivery_quotes WHERE ${scopeSql(scope)})
      AND NOT EXISTS (SELECT 1 FROM ethereum_delivery_checkouts WHERE ${scopeSql(scope)})
      AND NOT EXISTS (SELECT 1 FROM ethereum_crate_claims WHERE ${scopeSql(scope)})
      AND NOT EXISTS (SELECT 1 FROM ethereum_reconciliation_cursor WHERE ${scopeSql(scope)})`),
    revision: `UPDATE commerce_authority_control SET documents_revision = documents_revision + 1,
      updated_at_ms = ${COMMERCE_D1_NOW_MS_SQL} WHERE singleton = 1`,
    complete: `UPDATE ethereum_111k_control SET reset_guard_id = NULL, last_reset_id = ${guard},
      revision = revision + 1, updated_at_ms = ${COMMERCE_D1_NOW_MS_SQL} WHERE singleton = 1 AND ${ownsReset} RETURNING *`,
    ...Object.fromEntries(guards.map(entry => [`release_${entry.key}`, `DELETE FROM commerce_commit_guards WHERE guard_id = ${sqlString(entry.id)}`])),
    release: `DELETE FROM commerce_commit_guards WHERE guard_id = ${guard}`,
  };
}

export function ethereum111kResetOutcome(plan: Ethereum111kResetPlan, current: Ethereum111kSnapshot): 'completed' | 'unchanged' | 'unknown' {
  if (current.control.lastResetId === plan.resetId && current.control.resetGuardId === null
    && current.control.paused && current.control.revision === plan.expectedRevision + 1
    && current.control.chainId === plan.scope.chainId && current.control.contractAddress === plan.scope.contractAddress
    && Object.values(current.counts).every(count => count === 0) && current.quotes.length === 0
    && current.claims.length === 0 && current.cursors.length === 0 && current.checkouts.length === 0 && current.attempts.length === 0) return 'completed';
  if (JSON.stringify(current.control) === JSON.stringify(plan.snapshot.control)
    && ['documents', 'recovery', 'quotes', 'checkouts', 'attempts', 'claims', 'cursors', 'counts'].every(key =>
      JSON.stringify(current[key as keyof Ethereum111kSnapshot]) === JSON.stringify(plan.snapshot[key as keyof Ethereum111kSnapshot]))) return 'unchanged';
  return 'unknown';
}
