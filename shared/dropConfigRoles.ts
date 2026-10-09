export type DropConfigRole = 'mint' | 'operations';

export type DropOperationsConfig = {
  configId: string;
  boxMinterConfigPda: string;
  maxSupply: number;
};

type ConfigRoleSource = {
  dropId: string;
  boxMinterConfigPda?: string;
  maxSupply: number;
  itemsPerBox: number;
  operationsConfig?: DropOperationsConfig;
};

export function resolveDropConfigRole(drop: ConfigRoleSource, role: DropConfigRole): {
  configId: string;
  boxMinterConfigPda?: string;
  maxSupply: number;
  itemsPerBox: number;
} {
  if (role === 'operations' && drop.operationsConfig) {
    return { ...drop.operationsConfig, itemsPerBox: drop.itemsPerBox };
  }
  return {
    configId: drop.dropId,
    ...(drop.boxMinterConfigPda ? { boxMinterConfigPda: drop.boxMinterConfigPda } : {}),
    maxSupply: drop.maxSupply,
    itemsPerBox: drop.operationsConfig ? 0 : drop.itemsPerBox,
  };
}
