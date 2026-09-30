import {
  CommerceWriteConflict,
  D1CommerceRepository,
  commerceFieldValue,
  commerceKeys,
  type CommerceDocumentData,
} from './commerceRepository.js';
import { DeliveryPrepareError } from './deliveryPrepareErrors.js';
import { createDeliveryOrder, type RecoverySnapshot } from './deliveryOrderStore.js';
import type { PreparedDeliveryOrderCreate } from './deliveryOrderCreate.js';

const RECONCILE_TIMEOUT_MS = 5_000;

export type PreparedDeliveryCommerceContext = {
  commerceDb?: D1Database;
  nowMs: number;
  repository?: D1CommerceRepository;
  signal: AbortSignal;
};

function commerceRepository(context: PreparedDeliveryCommerceContext): D1CommerceRepository {
  if (context.repository) return context.repository;
  if (context.commerceDb) return new D1CommerceRepository(context.commerceDb);
  throw new DeliveryPrepareError('unavailable', 'Delivery preparation is temporarily unavailable.');
}

export type PreparedDeliveryAddress = {
  decoded: CommerceDocumentData;
};

export type PreparedDeliveryItem = {
  assetId: string;
  kind: 'box' | 'dude';
  refId: number;
};

export type PreparedDeliveryInput = {
  path: string;
  dropId: string;
  owner: string;
  addressId: string;
  address: PreparedDeliveryAddress;
  addressCountry: string;
  items: PreparedDeliveryItem[];
  deliveryId: number;
  deliveryPda: string;
  lookupTable?: string;
  deliveryLamports: number;
  nextPreparedProbeAtMs: number;
  prepareAttemptId: string;
};

export type PreparedDeliveryCleanupToken = {
  updateTime: string;
  version: number;
  recoveryGeneration: string;
  recoveryRevision: number;
};

function preparedCleanupToken(snapshot: RecoverySnapshot): PreparedDeliveryCleanupToken {
  return {
    updateTime: snapshot.order.updateTime,
    version: snapshot.order.version,
    recoveryGeneration: snapshot.state.generation,
    recoveryRevision: snapshot.state.revision,
  };
}

export async function createPreparedDeliveryOrder(
  context: PreparedDeliveryCommerceContext,
  input: PreparedDeliveryInput,
): Promise<PreparedDeliveryCleanupToken> {
  const reconcile = () => reconcilePreparedDeliveryOrder({
    ...context,
    signal: AbortSignal.timeout(RECONCILE_TIMEOUT_MS),
  }, input).catch(() => null);
  const fields = {
    dropId: input.dropId,
    status: 'prepared',
    owner: input.owner,
    addressId: input.addressId,
    addressSnapshot: {
      ...input.address.decoded,
      id: input.addressId,
      ...(input.addressCountry ? { countryCode: input.addressCountry } : {}),
    },
    itemIds: input.items.map((item) => item.assetId),
    items: input.items,
    deliveryId: input.deliveryId,
    deliveryPda: input.deliveryPda,
    ...(input.lookupTable ? { lookupTable: input.lookupTable } : {}),
    deliveryLamports: input.deliveryLamports,
    prepareAttemptId: input.prepareAttemptId,
    receiptRecovery: {
      preparedProbeCount: 0,
      nextPreparedProbeAt: input.nextPreparedProbeAtMs,
    },
    createdAt: commerceFieldValue.serverTimestamp(),
  } satisfies PreparedDeliveryOrderCreate;
  const key = commerceKeys.deliveryOrder(input.dropId, String(input.deliveryId));
  try {
    if (key.path !== input.path) throw new DeliveryPrepareError('internal', 'Delivery preparation failed.');
    const created = await commerceRepository(context).run(
      context.nowMs,
      async (unit) => {
        await createDeliveryOrder(unit, key, fields);
        const snapshot = await unit.getRecoverySnapshot(key);
        if (!snapshot) throw new DeliveryPrepareError('internal', 'Delivery preparation failed.');
        return preparedCleanupToken(snapshot);
      },
    );
    return created;
  } catch (error) {
    const reconciled = await reconcile();
    if (reconciled) return reconciled;
    throw error;
  }
}

async function reconcilePreparedDeliveryOrder(
  context: PreparedDeliveryCommerceContext,
  input: PreparedDeliveryInput,
): Promise<PreparedDeliveryCleanupToken | null> {
  const key = commerceKeys.deliveryOrder(input.dropId, String(input.deliveryId));
  if (key.path !== input.path) return null;
  const snapshot = await commerceRepository(context).getRecoverySnapshot(key);
  if (!snapshot || snapshot.state.revision !== 1 || snapshot.state.leaseId !== null ||
    snapshot.state.receiptRecoveryJson !== JSON.stringify({ preparedProbeCount: 0, nextPreparedProbeAt: input.nextPreparedProbeAtMs })) return null;
  const decoded = snapshot.order.data;
  if (
    !decoded ||
    decoded.prepareAttemptId !== input.prepareAttemptId ||
    decoded.status !== 'prepared' ||
    decoded.dropId !== input.dropId ||
    decoded.owner !== input.owner ||
    decoded.addressId !== input.addressId ||
    decoded.deliveryId !== input.deliveryId ||
    decoded.deliveryPda !== input.deliveryPda ||
    decoded.deliveryLamports !== input.deliveryLamports ||
    JSON.stringify(decoded.itemIds) !== JSON.stringify(input.items.map((item) => item.assetId))
  ) return null;
  return preparedCleanupToken(snapshot);
}

export async function deletePreparedDeliveryOrder(
  context: PreparedDeliveryCommerceContext,
  path: string,
  token: PreparedDeliveryCleanupToken,
): Promise<void> {
  const identity = path.match(/^drops\/([^/]+)\/deliveryOrders\/([^/]+)$/);
  if (!identity) throw new DeliveryPrepareError('internal', 'Delivery preparation failed.');
  const key = commerceKeys.deliveryOrder(identity[1], identity[2]);
  await commerceRepository(context).run(context.nowMs, async (unit) => {
    const current = await unit.getRecoverySnapshot(key);
    if (!current || current.order.data.status !== 'prepared' || current.order.updateTime !== token.updateTime ||
      current.order.version !== token.version || current.state.generation !== token.recoveryGeneration ||
      current.state.revision !== token.recoveryRevision) throw new CommerceWriteConflict();
    await unit.delete(key, { mustExist: true });
  });
}
