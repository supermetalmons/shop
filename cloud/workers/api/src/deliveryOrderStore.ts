import {
  commerceKeys,
  type CommerceDocumentData,
  type CommerceDocumentKey,
  type CommerceDocumentRecord,
  type CommerceUnitOfWork,
  type D1CommerceRepository,
} from './commerceRepository.js';
import {
  readCommerceRecord,
  requireCommerceKey,
  type CommerceReadContext,
} from './commerceTransactions.js';
import { ProfileReadError } from './dataAccess.js';

export type DeliveryOrderKey = CommerceDocumentKey<'delivery_order'>;
export type DeliveryOrderDocument = CommerceDocumentRecord<CommerceDocumentData, 'delivery_order'>;

export function deliveryOrderKey(path: string): DeliveryOrderKey {
  const key = requireCommerceKey(path);
  if (key.kind !== 'delivery_order') throw new Error('Invalid delivery order document path.');
  return { ...key, kind: key.kind };
}

export function deliveryOrderDocument(record: CommerceDocumentRecord): DeliveryOrderDocument {
  if (record.key.kind !== 'delivery_order') throw new Error('Invalid delivery order document kind.');
  return { ...record, key: { ...record.key, kind: record.key.kind } };
}

export async function readDeliveryOrder(
  context: CommerceReadContext,
  key: DeliveryOrderKey,
  transaction?: CommerceUnitOfWork,
): Promise<DeliveryOrderDocument | null> {
  const document = await readCommerceRecord(context, key, transaction);
  return document ? deliveryOrderDocument(document) : null;
}

export async function loadDeliveryOrderDocument(
  context: { repository: Pick<D1CommerceRepository, 'get'> },
  dropId: string,
  deliveryId: number,
): Promise<DeliveryOrderDocument> {
  const document = await context.repository.get(commerceKeys.deliveryOrder(dropId, String(deliveryId)));
  if (!document) throw new ProfileReadError('not-found', 404, 'Delivery order not found');
  return deliveryOrderDocument(document);
}
