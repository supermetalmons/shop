import type { EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.js';
import type { EthereumRevealRetirementRequest } from '../../../../shared/ethereum/revealMaintenance.js';

type Scope = Pick<EthereumRevealDeployment, 'chainId' | 'contractAddress'>;
type Fence = {
  operation_id: string; deployment_id: string; expected_revision: number;
  replacement_deployment_id: string; expected_replacement_revision: number;
  chain_id: number; contract_address: string; replacement_contract_address: string;
  state: 'pending' | 'retired' | 'cancelled';
};
const NOW = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";

function operationId(request: EthereumRevealRetirementRequest): string {
  return `${request.deploymentId}:${request.expectedRevision}:${request.replacementDeploymentId}:${request.expectedReplacementRevision}`;
}

function requireMatchingFence(row: Fence, request: EthereumRevealRetirementRequest, old: Scope, replacement: Scope): void {
  if (row.operation_id !== operationId(request) || row.deployment_id !== request.deploymentId || row.expected_revision !== request.expectedRevision
    || row.replacement_deployment_id !== request.replacementDeploymentId || row.expected_replacement_revision !== request.expectedReplacementRevision
    || row.chain_id !== old.chainId || row.contract_address !== old.contractAddress || row.replacement_contract_address !== replacement.contractAddress) {
    throw new Error('A different Ethereum retirement operation owns this scope.');
  }
}

async function readFence(db: D1Database, request: EthereumRevealRetirementRequest): Promise<Fence | null> {
  return db.prepare('SELECT * FROM ethereum_111k_retirements WHERE operation_id=?').bind(operationId(request)).first<Fence>();
}

function insert(db: D1Database, request: EthereumRevealRetirementRequest, old: Scope, replacement: Scope,
  state: Fence['state']): D1PreparedStatement {
  return db.prepare(`INSERT INTO ethereum_111k_retirements(operation_id,deployment_id,expected_revision,
    replacement_deployment_id,expected_replacement_revision,chain_id,contract_address,replacement_contract_address,state,created_at_ms,updated_at_ms)
    VALUES(?,?,?,?,?,?,?,?,?,${NOW},${NOW})
    ON CONFLICT(operation_id) DO UPDATE SET state=excluded.state,updated_at_ms=excluded.updated_at_ms
      WHERE ethereum_111k_retirements.state=excluded.state OR ethereum_111k_retirements.state='pending'
    RETURNING *`).bind(operationId(request), request.deploymentId, request.expectedRevision,
    request.replacementDeploymentId, request.expectedReplacementRevision, old.chainId, old.contractAddress,
    replacement.contractAddress, state);
}

export async function acquireRevealCommerceFence(db: D1Database, request: EthereumRevealRetirementRequest,
  old: Scope, replacement: Scope): Promise<void> {
  let row = await readFence(db, request);
  if (!row) {
    try { row = await insert(db, request, old, replacement, 'pending').first<Fence>(); }
    catch (error) { row = await readFence(db, request); if (!row) throw error; }
  }
  row ??= await readFence(db, request);
  if (!row) throw new Error('Ethereum retirement commerce fence could not be acquired.');
  requireMatchingFence(row, request, old, replacement);
  if (row.state === 'cancelled') throw new Error('Ethereum retirement was cancelled; create a fresh cleanup plan.');
}

export async function requireCancelableRevealFence(db: D1Database, request: EthereumRevealRetirementRequest,
  old: Scope, replacement: Scope): Promise<Fence['state'] | null> {
  const pending = await db.prepare(`SELECT * FROM ethereum_111k_retirements
    WHERE chain_id=? AND contract_address=? AND state='pending' LIMIT 1`)
    .bind(old.chainId, old.contractAddress).first<Fence>();
  if (pending) requireMatchingFence(pending, request, old, replacement);
  const row = await db.prepare(`SELECT * FROM ethereum_111k_retirements
    WHERE chain_id=? AND contract_address=? AND expected_revision=?`).bind(old.chainId, old.contractAddress, request.expectedRevision).first<Fence>();
  if (row) requireMatchingFence(row, request, old, replacement);
  return row?.state ?? null;
}

export async function resolveRevealCommerceFence(db: D1Database, request: EthereumRevealRetirementRequest,
  old: Scope, replacement: Scope, state: 'retired' | 'cancelled'): Promise<void> {
  let row: Fence | null;
  try { row = await insert(db, request, old, replacement, state).first<Fence>(); }
  catch (error) { row = await readFence(db, request); if (!row || row.state !== state) throw error; }
  if (!row) row = await readFence(db, request);
  if (!row || row.state !== state) throw new Error('Ethereum retirement commerce fence resolution was not confirmed.');
  requireMatchingFence(row, request, old, replacement);
}
