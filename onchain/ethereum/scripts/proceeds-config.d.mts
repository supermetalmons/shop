export type ProceedsConfig = {
  mintRecipients: string[];
  mintSharesBps: number[];
};

export function parseProceedsConfig(value: unknown, collectionAddress?: string): ProceedsConfig;

export function parseInitialDeliveryReceiver(
  value: unknown, collectionAddress?: string, mintRecipients?: readonly string[],
): string;
