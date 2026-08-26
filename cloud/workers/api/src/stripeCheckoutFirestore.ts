import {
  StripeCheckoutDeleteField,
  StripeCheckoutIncrement,
  StripeCheckoutServerTimestamp,
  StripeCheckoutTimestamp,
  type StripeCheckoutDocumentData,
  type StripeCheckoutDocumentReference,
  type StripeCheckoutDocumentSnapshot,
  type StripeCheckoutFirestore,
  type StripeCheckoutTransaction,
} from './stripeCheckout/store.js';
import {
  FIRESTORE_DATABASE_NAME,
  FIRESTORE_DOCUMENT_NAME_PREFIX,
  FIRESTORE_DOCUMENTS_BASE_URL,
  FirestoreWriteConflict,
  ProfileReadError,
  authenticatedFirestoreRequest,
  decodeFirestoreFields,
  isRecord,
  type GoogleAccessTokenProvider,
  type ProfileProviderFetch,
} from './firestoreRest.js';

type StripeCheckoutFirestoreContext = {
  accessTokenProvider: GoogleAccessTokenProvider;
  commerceDb?: D1Database;
  providerFetch: ProfileProviderFetch;
  serviceAccountJson: string;
  signal: AbortSignal;
};

type FirestoreDocument = {
  fields: StripeCheckoutDocumentData;
  updateTime: string;
};

type EncodedWrite = Record<string, unknown>;

const FIRESTORE_TRANSACTION_ATTEMPTS = 5;

function documentName(path: string): string {
  return `${FIRESTORE_DOCUMENT_NAME_PREFIX}${path}`;
}

function documentUrl(path: string, transaction?: string): string {
  const url = new URL(`${FIRESTORE_DOCUMENTS_BASE_URL}/${path}`);
  if (transaction) url.searchParams.set('transaction', transaction);
  return url.toString();
}

function encodeScalar(value: unknown): Record<string, unknown> {
  if (value === null) return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Unsupported Firestore number');
    return Number.isSafeInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (value instanceof StripeCheckoutTimestamp) {
    return { timestampValue: new Date(value.milliseconds).toISOString() };
  }
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encodeScalar) } };
  if (isRecord(value)) {
    const fields: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) continue;
      if (
        entry instanceof StripeCheckoutServerTimestamp ||
        entry instanceof StripeCheckoutDeleteField ||
        entry instanceof StripeCheckoutIncrement
      ) {
        throw new Error('Firestore transforms must be top-level fields');
      }
      fields[key] = encodeScalar(entry);
    }
    return { mapValue: { fields } };
  }
  throw new Error('Unsupported Firestore value');
}

function encodedDocumentWrite(
  path: string,
  data: StripeCheckoutDocumentData,
  mode: 'create' | 'set' | 'merge' | 'update',
): EncodedWrite {
  const fields: Record<string, unknown> = {};
  const fieldPaths: string[] = [];
  const updateTransforms: Record<string, unknown>[] = [];
  for (const [fieldPath, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (value instanceof StripeCheckoutServerTimestamp) {
      updateTransforms.push({ fieldPath, setToServerValue: 'REQUEST_TIME' });
    } else if (value instanceof StripeCheckoutDeleteField) {
      if (mode === 'create' || mode === 'set') throw new Error('Cannot delete a field during a full document write');
      fieldPaths.push(fieldPath);
    } else if (value instanceof StripeCheckoutIncrement) {
      updateTransforms.push({ fieldPath, increment: encodeScalar(value.operand) });
    } else {
      fieldPaths.push(fieldPath);
      fields[fieldPath] = encodeScalar(value);
    }
  }
  if (
    updateTransforms.length &&
    fieldPaths.length === 0 &&
    Object.keys(fields).length === 0 &&
    (mode === 'merge' || mode === 'update')
  ) {
    return {
      transform: { document: documentName(path), fieldTransforms: updateTransforms },
      currentDocument: { exists: true },
    };
  }
  const write: EncodedWrite = {
    update: { name: documentName(path), fields },
    ...(mode === 'merge' || mode === 'update' ? { updateMask: { fieldPaths } } : {}),
    ...(updateTransforms.length ? { updateTransforms } : {}),
    ...(mode === 'create' ? { currentDocument: { exists: false } } : {}),
    ...(mode === 'update' ? { currentDocument: { exists: true } } : {}),
  };
  return write;
}

function parseDocument(value: unknown): FirestoreDocument | null {
  if (value === null) return null;
  if (!isRecord(value) || typeof value.updateTime !== 'string' || !value.updateTime) {
    throw new ProfileReadError('unavailable', 502, 'Stripe checkout data is temporarily unavailable.');
  }
  const fields = value.fields === undefined ? {} : decodeFirestoreFields(value.fields);
  if (!fields) {
    throw new ProfileReadError('unavailable', 502, 'Stripe checkout data is temporarily unavailable.');
  }
  return { fields, updateTime: value.updateTime };
}

function nestedField(data: StripeCheckoutDocumentData, fieldPath: string): unknown {
  let value: unknown = data;
  for (const segment of fieldPath.split('.')) {
    if (!isRecord(value)) return undefined;
    value = value[segment];
  }
  return value;
}

function snapshot(document: FirestoreDocument | null): StripeCheckoutDocumentSnapshot {
  return {
    exists: document !== null,
    data: () => document?.fields,
    get: (fieldPath) => document ? nestedField(document.fields, fieldPath) : undefined,
  };
}

async function pause(signal: AbortSignal, attempt: number): Promise<void> {
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const timeout = setTimeout(finish, Math.min(400, 25 * 2 ** attempt));
    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

class WorkerStripeCheckoutReference implements StripeCheckoutDocumentReference {
  constructor(
    readonly path: string,
    readonly firestore: WorkerStripeCheckoutFirestore,
  ) {}

  get(): Promise<StripeCheckoutDocumentSnapshot> {
    return this.firestore.read(this.path);
  }

  update(data: StripeCheckoutDocumentData): Promise<void> {
    return this.firestore.commit([encodedDocumentWrite(this.path, data, 'update')]);
  }
}

function workerReference(reference: StripeCheckoutDocumentReference): WorkerStripeCheckoutReference {
  if (!(reference instanceof WorkerStripeCheckoutReference)) {
    throw new Error('Stripe checkout document reference belongs to a different store');
  }
  return reference;
}

class WorkerStripeCheckoutTransaction implements StripeCheckoutTransaction {
  readonly writes: EncodedWrite[] = [];

  constructor(
    private readonly firestore: WorkerStripeCheckoutFirestore,
    private readonly transaction: string,
  ) {}

  get(reference: StripeCheckoutDocumentReference): Promise<StripeCheckoutDocumentSnapshot> {
    return this.firestore.read(workerReference(reference).path, this.transaction);
  }

  create(reference: StripeCheckoutDocumentReference, data: StripeCheckoutDocumentData): void {
    this.writes.push(encodedDocumentWrite(workerReference(reference).path, data, 'create'));
  }

  update(reference: StripeCheckoutDocumentReference, data: StripeCheckoutDocumentData): void {
    this.writes.push(encodedDocumentWrite(workerReference(reference).path, data, 'update'));
  }

  set(
    reference: StripeCheckoutDocumentReference,
    data: StripeCheckoutDocumentData,
    options?: { merge?: boolean },
  ): void {
    this.writes.push(encodedDocumentWrite(workerReference(reference).path, data, options?.merge ? 'merge' : 'set'));
  }
}

export class WorkerStripeCheckoutFirestore implements StripeCheckoutFirestore {
  constructor(private readonly context: StripeCheckoutFirestoreContext) {}

  doc(path: string): StripeCheckoutDocumentReference {
    if (!path || path.startsWith('/') || path.endsWith('/') || path.split('/').length % 2 !== 0) {
      throw new Error('Invalid Firestore document path');
    }
    return new WorkerStripeCheckoutReference(path, this);
  }

  private request(args: { body?: string; method: 'GET' | 'POST'; surfaceWriteConflict?: boolean; url: string }) {
    return authenticatedFirestoreRequest({
      ...this.context,
      ...args,
      nowMs: Date.now(),
    });
  }

  async read(path: string, transaction?: string): Promise<StripeCheckoutDocumentSnapshot> {
    return snapshot(parseDocument(await this.request({ method: 'GET', url: documentUrl(path, transaction) })));
  }

  async commit(writes: EncodedWrite[], transaction?: string): Promise<void> {
    await this.request({
      body: JSON.stringify({ writes, ...(transaction ? { transaction } : {}) }),
      method: 'POST',
      surfaceWriteConflict: true,
      url: `https://firestore.googleapis.com/v1/${FIRESTORE_DATABASE_NAME}/documents:commit`,
    });
  }

  private async beginTransaction(): Promise<string> {
    const value = await this.request({
      body: JSON.stringify({ options: { readWrite: {} } }),
      method: 'POST',
      url: `https://firestore.googleapis.com/v1/${FIRESTORE_DATABASE_NAME}/documents:beginTransaction`,
    });
    if (!isRecord(value) || typeof value.transaction !== 'string' || !value.transaction) {
      throw new ProfileReadError('unavailable', 502, 'Stripe checkout storage is temporarily unavailable.');
    }
    return value.transaction;
  }

  private async rollback(transaction: string): Promise<void> {
    await this.request({
      body: JSON.stringify({ transaction }),
      method: 'POST',
      url: `https://firestore.googleapis.com/v1/${FIRESTORE_DATABASE_NAME}/documents:rollback`,
    });
  }

  async runTransaction<T>(operation: (transaction: StripeCheckoutTransaction) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < FIRESTORE_TRANSACTION_ATTEMPTS; attempt += 1) {
      const transactionId = await this.beginTransaction();
      const transaction = new WorkerStripeCheckoutTransaction(this, transactionId);
      let result: T;
      try {
        result = await operation(transaction);
      } catch (error) {
        await this.rollback(transactionId).catch(() => undefined);
        throw error;
      }
      if (!transaction.writes.length) {
        await this.rollback(transactionId);
        return result;
      }
      try {
        await this.commit(transaction.writes, transactionId);
        return result;
      } catch (error) {
        if (!(error instanceof FirestoreWriteConflict) || error.status !== 'ABORTED') throw error;
        if (attempt + 1 >= FIRESTORE_TRANSACTION_ATTEMPTS) throw error;
        await pause(this.context.signal, attempt);
      }
    }
    throw new FirestoreWriteConflict();
  }
}

export function createWorkerStripeCheckoutStore(
  context: StripeCheckoutFirestoreContext,
): WorkerStripeCheckoutFirestore {
  return new WorkerStripeCheckoutFirestore(context);
}

export const stripeCheckoutFirestoreTestHooks = {
  encodedDocumentWrite,
  parseDocument,
};
