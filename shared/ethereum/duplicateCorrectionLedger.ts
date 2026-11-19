export type DuplicateCorrectionCounts = {
  groups: number;
  paintings: number;
  revealed: number;
  reserved: number;
  keptFree: number;
  toReplace: number;
  replaced: number;
  conflicts: number;
  extraRevealed: number;
};

export type DuplicateCorrectionLedgerResult = {
  operationId: string;
  definitionSha256: string;
  applied: boolean;
  catalogRevision: number;
  appliedAtMs: number | null;
  historical?: boolean;
  totals: DuplicateCorrectionCounts;
  blocks: { block: string; counts: DuplicateCorrectionCounts }[];
  pools: { category: string; total: number; available: number }[];
};
