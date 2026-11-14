export const MAX_FREE_MINT_WALLETS: 32;

export type FreeMintGroup = {
  name: string;
  crates: number;
  warehouses: number;
  relics: number;
  wallets: string[];
};

export type FreeMintConfig = {
  chainId?: number;
  groups: FreeMintGroup[];
  allocations: Array<{ wallet: string; crateLimit: number; warehouseLimit: number; relicLimit: number }>;
};

export function parseFreeMintConfig(value: unknown, collectionAddress?: string, chainId?: number): FreeMintConfig;

export function parseFreeMintConfigJson(json: string, collectionAddress?: string, chainId?: number): FreeMintConfig;

export function freeMintOwnerCalls(value: unknown, collectionAddress: string, chainId?: number): Array<{
  group: string;
  chainId?: number;
  to: string;
  data: string;
  value: '0';
}>;
