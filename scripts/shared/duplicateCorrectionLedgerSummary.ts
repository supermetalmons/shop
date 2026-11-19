import type { DuplicateCorrectionCounts, DuplicateCorrectionLedgerResult } from '../../shared/ethereum/duplicateCorrectionLedger.ts';

function copyCounts(counts: DuplicateCorrectionCounts): DuplicateCorrectionCounts {
  return { groups: counts.groups, paintings: counts.paintings, revealed: counts.revealed, reserved: counts.reserved,
    keptFree: counts.keptFree, toReplace: counts.toReplace, replaced: counts.replaced,
    conflicts: counts.conflicts, extraRevealed: counts.extraRevealed };
}

export function duplicateCorrectionLedgerSummary(result: DuplicateCorrectionLedgerResult): DuplicateCorrectionLedgerResult {
  return { operationId: result.operationId, definitionSha256: result.definitionSha256, applied: result.applied,
    catalogRevision: result.catalogRevision, appliedAtMs: result.appliedAtMs, ...(result.historical ? { historical: true } : {}), totals: copyCounts(result.totals),
    blocks: Array.from(result.blocks, row => ({ block: row.block, counts: copyCounts(row.counts) })),
    pools: Array.from(result.pools, row => ({ category: row.category, total: row.total, available: row.available })) };
}
