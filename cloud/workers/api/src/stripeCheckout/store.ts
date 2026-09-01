import {
  CommerceRepositoryError,
  D1CommerceRepository,
  commerceFieldValue,
  commerceKeys,
  type CommerceDocumentData,
  type CommerceDocumentKey,
  type CommerceDocumentWriteData,
  type CommerceJsonValue,
  type CommerceUnitOfWork,
  type CommerceUpdateValue,
} from '../commerceRepository.js';
import { runCommerceTransaction } from '../commerceTransactions.js';

export type StripeCheckoutDocumentData = Record<string, unknown>;

export interface StripeCheckoutDocumentSnapshot {
  readonly exists: boolean;
  data(): StripeCheckoutDocumentData | undefined;
  get(fieldPath: string): unknown;
}

export interface StripeCheckoutDocumentReference {
  readonly path: string;
  readonly store: StripeCheckoutStore;
  get(): Promise<StripeCheckoutDocumentSnapshot>;
  update(data: StripeCheckoutDocumentData): Promise<void>;
}

export interface StripeCheckoutTransaction {
  get(reference: StripeCheckoutDocumentReference): Promise<StripeCheckoutDocumentSnapshot>;
  create(reference: StripeCheckoutDocumentReference, data: StripeCheckoutDocumentData): void;
  update(reference: StripeCheckoutDocumentReference, data: StripeCheckoutDocumentData): void;
  set(
    reference: StripeCheckoutDocumentReference,
    data: StripeCheckoutDocumentData,
    options?: { merge?: boolean },
  ): void;
}

export interface StripeCheckoutStore {
  doc(path: string): StripeCheckoutDocumentReference;
  runTransaction<T>(operation: (transaction: StripeCheckoutTransaction) => Promise<T>): Promise<T>;
}

export type StripeCheckoutServerTimestamp = Readonly<{ kind: 'server_timestamp' }>;
export type StripeCheckoutDeleteField = Readonly<{ kind: 'delete_field' }>;
export type StripeCheckoutIncrement = Readonly<{ kind: 'increment'; operand: number }>;
export type StripeCheckoutTimestamp = Readonly<{
  kind: 'timestamp';
  milliseconds: number;
  toMillis: () => number;
}>;

class StripeCheckoutServerTimestampValue {
  readonly kind = 'server_timestamp';
}

class StripeCheckoutDeleteFieldValue {
  readonly kind = 'delete_field';
}

class StripeCheckoutIncrementValue {
  readonly kind = 'increment';

  constructor(readonly operand: number) {}
}

class StripeCheckoutTimestampValue {
  readonly kind = 'timestamp';

  constructor(readonly milliseconds: number) {}

  toMillis(): number {
    return this.milliseconds;
  }
}

export const stripeCheckoutFieldValue = Object.freeze({
  delete: (): StripeCheckoutDeleteField => Object.freeze(new StripeCheckoutDeleteFieldValue()),
  increment: (operand: number): StripeCheckoutIncrement =>
    Object.freeze(new StripeCheckoutIncrementValue(operand)),
  serverTimestamp: (): StripeCheckoutServerTimestamp =>
    Object.freeze(new StripeCheckoutServerTimestampValue()),
  timestampFromMillis: (milliseconds: number): StripeCheckoutTimestamp =>
    Object.freeze(new StripeCheckoutTimestampValue(milliseconds)),
});

function keyForPath(path: string): CommerceDocumentKey {
  const claim = /^claimCodes\/([^/]+)$/.exec(path);
  if (claim) return commerceKeys.claimCode(claim[1]);
  const nested = /^drops\/([^/]+)\/(stripeCheckouts|deliveryOrders|offchainOrders)\/([^/]+)$/.exec(path);
  if (!nested) throw new CommerceRepositoryError('invalid-argument', 'Invalid Stripe checkout document path.');
  const [, dropId, collection, documentId] = nested;
  if (collection === 'stripeCheckouts') return commerceKeys.stripeCheckout(dropId, documentId);
  if (collection === 'deliveryOrders') return commerceKeys.deliveryOrder(dropId, documentId);
  return commerceKeys.offchainOrder(dropId, documentId);
}

function nestedField(data: StripeCheckoutDocumentData, fieldPath: string): unknown {
  let value: unknown = data;
  for (const segment of fieldPath.split('.')) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

function snapshot(data: CommerceDocumentData | null): StripeCheckoutDocumentSnapshot {
  const value = data ? structuredClone(data) : null;
  return {
    exists: value !== null,
    data: () => value ? structuredClone(value) : undefined,
    get: (fieldPath) => value ? nestedField(value, fieldPath) : undefined,
  };
}

function jsonValue(value: unknown): CommerceJsonValue {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(jsonValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, jsonValue(entry)]),
    );
  }
  throw new CommerceRepositoryError('invalid-argument', 'Invalid Stripe checkout document value.');
}

function updateValue(value: unknown): CommerceUpdateValue {
  if (value instanceof StripeCheckoutServerTimestampValue) return commerceFieldValue.serverTimestamp();
  if (value instanceof StripeCheckoutDeleteFieldValue) return commerceFieldValue.delete();
  if (value instanceof StripeCheckoutIncrementValue) return commerceFieldValue.increment(value.operand);
  if (value instanceof StripeCheckoutTimestampValue) {
    if (!Number.isSafeInteger(value.milliseconds) || value.milliseconds < 0) {
      throw new CommerceRepositoryError('invalid-argument', 'Invalid Stripe checkout timestamp.');
    }
    const seconds = Math.floor(value.milliseconds / 1000);
    return commerceFieldValue.timestamp(
      seconds,
      (value.milliseconds - seconds * 1000) * 1_000_000,
    );
  }
  return jsonValue(value);
}

function writeData(data: StripeCheckoutDocumentData): CommerceDocumentWriteData {
  return Object.fromEntries(
    Object.entries(data)
      .filter(([, value]) => value !== undefined)
      .map(([field, value]) => [field, updateValue(value)]),
  );
}

class D1StripeCheckoutReference implements StripeCheckoutDocumentReference {
  readonly key: CommerceDocumentKey;

  constructor(
    readonly path: string,
    readonly store: D1StripeCheckoutStore,
  ) {
    this.key = keyForPath(path);
  }

  get(): Promise<StripeCheckoutDocumentSnapshot> {
    return this.store.get(this);
  }

  update(data: StripeCheckoutDocumentData): Promise<void> {
    return this.store.update(this, data);
  }
}

function d1Reference(reference: StripeCheckoutDocumentReference): D1StripeCheckoutReference {
  if (!(reference instanceof D1StripeCheckoutReference)) {
    throw new CommerceRepositoryError('invalid-argument', 'Stripe checkout reference belongs to a different store.');
  }
  return reference;
}

type PendingWrite = (unit: CommerceUnitOfWork) => Promise<void>;

class D1StripeCheckoutTransaction implements StripeCheckoutTransaction {
  private readonly writes: PendingWrite[] = [];

  constructor(private readonly unit: CommerceUnitOfWork) {}

  async get(reference: StripeCheckoutDocumentReference): Promise<StripeCheckoutDocumentSnapshot> {
    const record = await this.unit.get(d1Reference(reference).key);
    return snapshot(record?.data || null);
  }

  create(reference: StripeCheckoutDocumentReference, data: StripeCheckoutDocumentData): void {
    const key = d1Reference(reference).key;
    this.writes.push(async (unit) => {
      await unit.create(key, writeData(data));
    });
  }

  update(reference: StripeCheckoutDocumentReference, data: StripeCheckoutDocumentData): void {
    const key = d1Reference(reference).key;
    this.writes.push((unit) => unit.update(key, writeData(data)));
  }

  set(
    reference: StripeCheckoutDocumentReference,
    data: StripeCheckoutDocumentData,
    options?: { merge?: boolean },
  ): void {
    const key = d1Reference(reference).key;
    this.writes.push((unit) => unit.set(key, writeData(data), options));
  }

  async flush(): Promise<void> {
    for (const write of this.writes) await write(this.unit);
  }
}

export class D1StripeCheckoutStore implements StripeCheckoutStore {
  private readonly repository: D1CommerceRepository;

  constructor(
    db: D1Database,
    private readonly signal?: AbortSignal,
    private readonly nowMs: () => number = () => Date.now(),
  ) {
    this.repository = new D1CommerceRepository(db);
  }

  doc(path: string): StripeCheckoutDocumentReference {
    return new D1StripeCheckoutReference(path, this);
  }

  async get(reference: D1StripeCheckoutReference): Promise<StripeCheckoutDocumentSnapshot> {
    this.signal?.throwIfAborted();
    const record = await this.repository.get(reference.key);
    this.signal?.throwIfAborted();
    return snapshot(record?.data || null);
  }

  async update(reference: D1StripeCheckoutReference, data: StripeCheckoutDocumentData): Promise<void> {
    await this.runTransaction(async (transaction) => {
      transaction.update(reference, data);
    });
  }

  async runTransaction<T>(operation: (transaction: StripeCheckoutTransaction) => Promise<T>): Promise<T> {
    return runCommerceTransaction({
      nowMs: this.nowMs,
      repository: this.repository,
      signal: this.signal,
    }, async (unit) => {
      const transaction = new D1StripeCheckoutTransaction(unit);
      const result = await operation(transaction);
      await transaction.flush();
      return result;
    }, {
      shouldRetry: (error) => error.code === 'aborted',
    });
  }
}

export function createStripeCheckoutStore(args: {
  commerceDb: D1Database;
  signal?: AbortSignal;
  nowMs?: () => number;
}): D1StripeCheckoutStore {
  return new D1StripeCheckoutStore(args.commerceDb, args.signal, args.nowMs);
}
