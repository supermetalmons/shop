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
export type Ethereum111kScope = { chainId: number; contractAddress: string };
export type Ethereum111kQueryBatch = (queries: Record<string, string>) => Record<string, CommerceD1Row[]> | Promise<Record<string, CommerceD1Row[]>>;
export type Ethereum111kSnapshot = {
  control: Ethereum111kControl;
  databaseNowMs: number;
  documents: CommerceD1Row[];
  recovery: CommerceD1Row[];
  quotes: CommerceD1Row[];
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
  const result = await queryBatch({
    control: `${ETHEREUM_111K_CONTROL_SQL.replace('SELECT ', `SELECT ${COMMERCE_D1_NOW_MS_SQL} AS database_now_ms, `)}`,
    documents: `SELECT document.*, path.revision AS path_revision FROM commerce_documents AS document
      JOIN commerce_document_path_revisions AS path ON path.document_path = document.document_path
      WHERE document.${dropSql} ORDER BY document.document_path`,
    recovery: `SELECT * FROM commerce_delivery_recovery WHERE parent_path IN
      (SELECT document_path FROM commerce_documents WHERE ${dropSql}) ORDER BY parent_path`,
    quotes: `SELECT * FROM ethereum_delivery_quotes WHERE ${scopeSql(scope)} ORDER BY order_id`,
    claims: `SELECT * FROM ethereum_crate_claims WHERE ${scopeSql(scope)} ORDER BY receipt_id`,
    cursors: `SELECT * FROM ethereum_reconciliation_cursor WHERE ${scopeSql(scope)}`,
    counts: ETHEREUM_111K_COUNTS_SQL,
  });
  if (result.control.length !== 1 || result.counts.length !== 1) throw new Error('Invalid Ethereum 111k snapshot.');
  return { control: parseEthereum111kControl(result.control[0]), databaseNowMs: safeInteger(result.control[0].database_now_ms, 'Database time'),
    documents: result.documents, recovery: result.recovery, quotes: result.quotes, claims: result.claims, cursors: result.cursors,
    counts: Object.fromEntries(Object.entries(result.counts[0]).map(([key, value]) => [key, safeInteger(value, key)])) };
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

function rowsUnchanged(table: string, rows: CommerceD1Row[], scope: Ethereum111kScope): string {
  return `(SELECT COUNT(*) FROM ${table} WHERE ${scopeSql(scope)}) = ${rows.length}`
    + rows.map(row => ` AND EXISTS (SELECT 1 FROM ${table} WHERE ${Object.entries(row).filter(([key]) => key !== 'address_json' && key !== 'code').map(([key, value]) => {
      if (!/^[a-z_]+$/.test(key)) throw new Error('Invalid snapshot column.');
      return `${key} IS ${sqlValue(value)}`;
    }).join(' AND ')})`).join('');
}

function assertSql(predicate: string): string {
  return `SELECT CASE WHEN (${predicate}) THEN 1 ELSE json('ethereum 111k reset conflict') END AS reset_assertion`;
}

export function buildEthereum111kResetBatch(plan: Ethereum111kResetPlan): Record<string, string> {
  buildEthereum111kResetPlan(plan.snapshot, plan.scope, plan.expectedRevision, plan.resetId);
  const { snapshot, scope, resetId, expectedRevision } = plan;
  const guard = sqlString(resetId);
  const expectations = serializeCommerceCommitExpectations({
    documents: new Map(snapshot.documents.map(row => [String(row.document_path), { path: String(row.document_path),
      version: Number(row.version), pathRevision: Number(row.path_revision) }])),
    deliveryOwners: new Map(), notifications: new Map(),
    recovery: new Map(snapshot.recovery.map(row => { const recovery = parseDeliveryRecoveryRow(row); return [recovery.parentPath, recovery]; })),
  });
  const ethereum = [...snapshot.quotes.map(row => ({ kind: 'delivery', chainId: row.chain_id, contractAddress: row.contract_address,
    id: String(row.order_id), status: row.status, transactionHash: row.transaction_hash, blockNumber: row.block_number,
    blockHash: row.block_hash, updatedAtMs: row.updated_at_ms })), ...snapshot.claims.map(row => ({ kind: 'claim', chainId: row.chain_id,
    contractAddress: row.contract_address, id: row.receipt_id, orderId: row.order_id, claimId: row.claim_id,
    status: row.status, transactionHash: row.transaction_hash, blockNumber: row.block_number,
    blockHash: row.block_hash, updatedAtMs: row.updated_at_ms }))];
  const ownsReset = `EXISTS (SELECT 1 FROM ethereum_111k_control WHERE singleton = 1 AND paused = 1
    AND revision = ${expectedRevision} AND reset_guard_id = ${guard} AND ${scopeSql(scope)})`;
  return {
    guard: `INSERT INTO commerce_commit_guards (guard_id, expectations_json, expected_documents_revision, created_at_ms,
      delivery_owner_expectations_json, delivery_recovery_expectations_json, delivery_recovery_paths_json, ethereum_state_expectations_json)
      VALUES (${guard}, ${sqlString(expectations.documents)}, NULL, ${COMMERCE_D1_NOW_MS_SQL},
        ${sqlString(expectations.deliveryOwners)}, ${sqlString(expectations.recovery)},
        ${sqlString(JSON.stringify(snapshot.documents.map(row => row.document_path)))}, ${sqlString(JSON.stringify(ethereum))})`,
    claim: `UPDATE ethereum_111k_control SET reset_guard_id = ${guard}, updated_at_ms = ${COMMERCE_D1_NOW_MS_SQL}
      WHERE singleton = 1 AND paused = 1 AND revision = ${expectedRevision} AND reset_guard_id IS NULL
        AND paused_at_ms <= ${COMMERCE_D1_NOW_MS_SQL} - ${ETHEREUM_111K_DRAIN_MS} AND ${scopeSql(scope)}`,
    assert: assertSql(`${ownsReset}
      AND EXISTS (SELECT 1 FROM (${ETHEREUM_111K_COUNTS_SQL}) WHERE ${Object.entries(snapshot.counts).map(([key, value]) => `${key} = ${value}`).join(' AND ')})
      AND ${rowsUnchanged('ethereum_delivery_quotes', snapshot.quotes, scope)}
      AND ${rowsUnchanged('ethereum_crate_claims', snapshot.claims, scope)}
      AND ${rowsUnchanged('ethereum_reconciliation_cursor', snapshot.cursors, scope)}`),
    documents: `DELETE FROM commerce_documents WHERE ${dropSql} AND ${ownsReset}`,
    claims: `DELETE FROM ethereum_crate_claims WHERE ${scopeSql(scope)} AND ${ownsReset}`,
    quotes: `DELETE FROM ethereum_delivery_quotes WHERE ${scopeSql(scope)} AND ${ownsReset}`,
    cursors: `DELETE FROM ethereum_reconciliation_cursor WHERE ${scopeSql(scope)} AND ${ownsReset}`,
    assertDeleted: assertSql(`${ownsReset} AND NOT EXISTS (SELECT 1 FROM commerce_documents WHERE ${dropSql})
      AND NOT EXISTS (SELECT 1 FROM ethereum_delivery_quotes WHERE ${scopeSql(scope)})
      AND NOT EXISTS (SELECT 1 FROM ethereum_crate_claims WHERE ${scopeSql(scope)})
      AND NOT EXISTS (SELECT 1 FROM ethereum_reconciliation_cursor WHERE ${scopeSql(scope)})`),
    revision: `UPDATE commerce_authority_control SET documents_revision = documents_revision + 1,
      updated_at_ms = ${COMMERCE_D1_NOW_MS_SQL} WHERE singleton = 1`,
    complete: `UPDATE ethereum_111k_control SET reset_guard_id = NULL, last_reset_id = ${guard},
      revision = revision + 1, updated_at_ms = ${COMMERCE_D1_NOW_MS_SQL} WHERE singleton = 1 AND ${ownsReset} RETURNING *`,
    release: `DELETE FROM commerce_commit_guards WHERE guard_id = ${guard}`,
  };
}

export function ethereum111kResetOutcome(plan: Ethereum111kResetPlan, current: Ethereum111kSnapshot): 'completed' | 'unchanged' | 'unknown' {
  if (current.control.lastResetId === plan.resetId && current.control.resetGuardId === null
    && current.control.paused && current.control.revision === plan.expectedRevision + 1
    && current.control.chainId === plan.scope.chainId && current.control.contractAddress === plan.scope.contractAddress
    && Object.values(current.counts).every(count => count === 0) && current.quotes.length === 0
    && current.claims.length === 0 && current.cursors.length === 0) return 'completed';
  if (JSON.stringify(current.control) === JSON.stringify(plan.snapshot.control)
    && ['documents', 'recovery', 'quotes', 'claims', 'cursors', 'counts'].every(key =>
      JSON.stringify(current[key as keyof Ethereum111kSnapshot]) === JSON.stringify(plan.snapshot[key as keyof Ethereum111kSnapshot]))) return 'unchanged';
  return 'unknown';
}
