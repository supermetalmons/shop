export type SanitizedDudeAssignmentPool = {
  pool: number[];
  usedDefaultPool: boolean;
  rawPoolLen: number | null;
  poolInitLen: number;
  invalidRemoved: number;
  dupRemoved: number;
};

export function sanitizeDudeAssignmentPool(
  rawPool: unknown,
  maxDudeId: number,
): SanitizedDudeAssignmentPool {
  const usedDefaultPool = !Array.isArray(rawPool);
  const rawPoolLen = Array.isArray(rawPool) ? rawPool.length : null;
  const initialPool = Array.isArray(rawPool)
    ? rawPool.map((value) => Math.floor(Number(value)))
    : Array.from({ length: maxDudeId }, (_, index) => index + 1);
  const poolInitLen = initialPool.length;
  const sanitized = initialPool.filter((id) => Number.isFinite(id) && id >= 1 && id <= maxDudeId);
  const invalidRemoved = poolInitLen - sanitized.length;
  const pool = Array.from(new Set(sanitized));
  const dupRemoved = sanitized.length - pool.length;
  return { pool, usedDefaultPool, rawPoolLen, poolInitLen, invalidRemoved, dupRemoved };
}
