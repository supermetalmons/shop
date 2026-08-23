import {
  FieldValue,
  Timestamp,
  type DocumentData,
  type DocumentReference,
  type DocumentSnapshot,
  type Firestore,
  type Transaction,
  type UpdateData,
} from 'firebase-admin/firestore';
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
} from './store.js';

function firebaseValue(value: unknown): unknown {
  if (value instanceof StripeCheckoutServerTimestamp) return FieldValue.serverTimestamp();
  if (value instanceof StripeCheckoutDeleteField) return FieldValue.delete();
  if (value instanceof StripeCheckoutIncrement) return FieldValue.increment(value.operand);
  if (value instanceof StripeCheckoutTimestamp) return Timestamp.fromMillis(value.milliseconds);
  if (Array.isArray(value)) return value.map(firebaseValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, firebaseValue(entry)]),
  );
}

function documentSnapshot(snapshot: DocumentSnapshot): StripeCheckoutDocumentSnapshot {
  return {
    exists: snapshot.exists,
    data: () => snapshot.data() as StripeCheckoutDocumentData | undefined,
    get: (fieldPath) => snapshot.get(fieldPath),
  };
}

class FirebaseAdminDocumentReference implements StripeCheckoutDocumentReference {
  constructor(
    readonly raw: DocumentReference,
    readonly firestore: StripeCheckoutFirestore,
  ) {}

  get path(): string {
    return this.raw.path;
  }

  async get(): Promise<StripeCheckoutDocumentSnapshot> {
    return documentSnapshot(await this.raw.get());
  }

  async update(data: StripeCheckoutDocumentData): Promise<void> {
    await this.raw.update(firebaseValue(data) as UpdateData<DocumentData>);
  }
}

function rawReference(reference: StripeCheckoutDocumentReference): DocumentReference {
  if (!(reference instanceof FirebaseAdminDocumentReference)) {
    throw new Error('Stripe checkout document reference belongs to a different store');
  }
  return reference.raw;
}

class FirebaseAdminTransaction implements StripeCheckoutTransaction {
  constructor(private readonly raw: Transaction) {}

  async get(reference: StripeCheckoutDocumentReference): Promise<StripeCheckoutDocumentSnapshot> {
    return documentSnapshot(await this.raw.get(rawReference(reference)));
  }

  create(reference: StripeCheckoutDocumentReference, data: StripeCheckoutDocumentData): void {
    this.raw.create(rawReference(reference), firebaseValue(data) as DocumentData);
  }

  update(reference: StripeCheckoutDocumentReference, data: StripeCheckoutDocumentData): void {
    this.raw.update(
      rawReference(reference),
      firebaseValue(data) as UpdateData<DocumentData>,
    );
  }

  set(
    reference: StripeCheckoutDocumentReference,
    data: StripeCheckoutDocumentData,
    options?: { merge?: boolean },
  ): void {
    const normalized = firebaseValue(data) as DocumentData;
    if (options?.merge) this.raw.set(rawReference(reference), normalized, { merge: true });
    else this.raw.set(rawReference(reference), normalized);
  }
}

class FirebaseAdminStore implements StripeCheckoutFirestore {
  constructor(private readonly raw: Firestore) {}

  doc(path: string): StripeCheckoutDocumentReference {
    return new FirebaseAdminDocumentReference(this.raw.doc(path), this);
  }

  runTransaction<T>(operation: (transaction: StripeCheckoutTransaction) => Promise<T>): Promise<T> {
    return this.raw.runTransaction((transaction) => operation(new FirebaseAdminTransaction(transaction)));
  }
}

export function createFirebaseAdminStripeCheckoutStore(firestore: Firestore): StripeCheckoutFirestore {
  return new FirebaseAdminStore(firestore);
}
