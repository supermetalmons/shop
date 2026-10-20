export type Ethereum111kControl = {
  paused: boolean;
  revision: number;
  pausedAtMs: number | null;
  chainId: number | null;
  contractAddress: string | null;
  resetGuardId: string | null;
  lastResetId: string | null;
  updatedAtMs: number;
};

export const ETHEREUM_111K_CONTROL_SQL = `SELECT paused, revision, paused_at_ms, chain_id,
  contract_address, reset_guard_id, last_reset_id, updated_at_ms
  FROM ethereum_111k_control WHERE singleton = 1`;
const ETHEREUM_111K_FENCE_ERROR = 'ethereum 111k is paused or scope is unavailable';

export function isEthereum111kFenceError(error: unknown): boolean {
  const seen = new Set<unknown>();
  while (error && !seen.has(error)) {
    seen.add(error);
    if (error instanceof Error && error.message.includes(ETHEREUM_111K_FENCE_ERROR)) return true;
    error = error instanceof Error ? error.cause : undefined;
  }
  return false;
}

export function parseEthereum111kControl(value: unknown): Ethereum111kControl {
  const fail = (): never => { throw new Error('Invalid Ethereum 111k control.'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const row = value as Record<string, unknown>;
  const integer = (value: unknown, minimum = 0): number => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) return fail();
    return value;
  };
  const nullableId = (value: unknown): string | null => {
    if (value === null) return null;
    if (typeof value !== 'string' || value.length < 1 || value.length > 128) return fail();
    return value;
  };
  if (row.paused !== 0 && row.paused !== 1) return fail();
  const chainId = row.chain_id === null ? null : integer(row.chain_id, 1);
  const contractAddress = row.contract_address;
  if (contractAddress !== null && (typeof contractAddress !== 'string' || !/^0x[0-9a-f]{40}$/.test(contractAddress) || /^0x0{40}$/.test(contractAddress))) return fail();
  if ((chainId === null) !== (contractAddress === null)) return fail();
  const paused = row.paused === 1;
  const pausedAtMs = row.paused_at_ms === null ? null : integer(row.paused_at_ms);
  const resetGuardId = nullableId(row.reset_guard_id);
  if (paused !== (pausedAtMs !== null) || (!paused && (chainId === null || resetGuardId !== null))) return fail();
  return { paused, revision: integer(row.revision, 1), pausedAtMs, chainId, contractAddress: contractAddress as string | null,
    resetGuardId, lastResetId: nullableId(row.last_reset_id), updatedAtMs: integer(row.updated_at_ms) };
}

export function ethereum111kControlAllows(
  control: Ethereum111kControl,
  scope: { chainId: number; contractAddress: string },
): boolean {
  return !control.paused && control.resetGuardId === null && control.chainId === scope.chainId
    && typeof scope.contractAddress === 'string' && /^0x[0-9a-fA-F]{40}$/.test(scope.contractAddress)
    && control.contractAddress === scope.contractAddress.toLowerCase();
}
