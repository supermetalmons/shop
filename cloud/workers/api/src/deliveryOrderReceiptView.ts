import { isBase58Bytes } from '../../../../shared/solanaRpcProxy.js';
import { isRecord } from './dataAccess.js';
import { DeliveryReceiptError } from './deliveryReceiptErrors.js';
import { parseDeliveryOrderOwnership, parseDeliveryOrderStatus } from './deliveryOrderReadModel.js';

type DeliveryReceiptItem = {
  assetId: string | undefined;
  kind: string | undefined;
  readonly refId: number;
};

export function parseDeliveryOrderReceiptView(order: Record<string, unknown>) {
  return {
    ...parseDeliveryOrderStatus(order),
    ownership: parseDeliveryOrderOwnership(order),
    deliveryPda: typeof order.deliveryPda === 'string' ? order.deliveryPda.trim() : '',
    deliverySignature: typeof order.deliverySignature === 'string' ? order.deliverySignature : null,
    closeDeliveryTx: typeof order.closeDeliveryTx === 'string' ? order.closeDeliveryTx : null,
    get receiptsMinted(): number {
      return Number(order.receiptsMinted || 0);
    },
    get receiptTxs(): string[] {
      return Array.isArray(order.receiptTxs)
        ? order.receiptTxs.filter((value): value is string => typeof value === 'string')
        : [];
    },
    get deliveryLamports(): number {
      const value = Number(order.deliveryLamports ?? order.shippingLamports);
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new DeliveryReceiptError('failed-precondition', 'Stored delivery fee is invalid.');
      }
      return value;
    },
    get itemIds(): string[] {
      if (order.itemIds === undefined) return [];
      if (
        !Array.isArray(order.itemIds) ||
        !order.itemIds.every((value): value is string => typeof value === 'string' && isBase58Bytes(value, 32))
      ) {
        throw new DeliveryReceiptError('failed-precondition', 'Delivery order contains invalid itemIds.');
      }
      if (new Set(order.itemIds).size !== order.itemIds.length) {
        throw new DeliveryReceiptError('failed-precondition', 'Delivery order contains duplicate itemIds.');
      }
      return [...order.itemIds];
    },
    get items(): DeliveryReceiptItem[] {
      const items = Array.isArray(order.items) ? order.items.filter(isRecord) : [];
      return items.map((item) => ({
        assetId: typeof item.assetId === 'string' ? item.assetId : undefined,
        kind: typeof item.kind === 'string' ? item.kind : undefined,
        get refId() { return Number(item.refId); },
      }));
    },
  };
}

export type DeliveryOrderReceiptView = ReturnType<typeof parseDeliveryOrderReceiptView>;
