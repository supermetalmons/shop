export type ProceedsConfig = {
  mintRecipients: string[];
  mintSharesBps: number[];
  deliveryPaymentReceiver: string;
};

export function parseProceedsConfig(value: unknown, collectionAddress?: string): ProceedsConfig;
