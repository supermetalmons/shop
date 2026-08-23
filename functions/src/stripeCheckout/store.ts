export type StripeCheckoutDocumentData = Record<string, unknown>;

export interface StripeCheckoutDocumentSnapshot {
  readonly exists: boolean;
  data(): StripeCheckoutDocumentData | undefined;
  get(fieldPath: string): unknown;
}

export interface StripeCheckoutDocumentReference {
  readonly path: string;
  readonly firestore: StripeCheckoutFirestore;
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

export interface StripeCheckoutFirestore {
  doc(path: string): StripeCheckoutDocumentReference;
  runTransaction<T>(operation: (transaction: StripeCheckoutTransaction) => Promise<T>): Promise<T>;
}

export class StripeCheckoutServerTimestamp {
  readonly kind = 'server_timestamp';
}

export class StripeCheckoutDeleteField {
  readonly kind = 'delete_field';
}

export class StripeCheckoutIncrement {
  readonly kind = 'increment';

  constructor(readonly operand: number) {}
}

export class StripeCheckoutTimestamp {
  readonly kind = 'timestamp';

  constructor(readonly milliseconds: number) {}

  toMillis(): number {
    return this.milliseconds;
  }
}

export const stripeCheckoutFieldValue = Object.freeze({
  delete: (): StripeCheckoutDeleteField => new StripeCheckoutDeleteField(),
  increment: (operand: number): StripeCheckoutIncrement => new StripeCheckoutIncrement(operand),
  serverTimestamp: (): StripeCheckoutServerTimestamp => new StripeCheckoutServerTimestamp(),
  timestampFromMillis: (milliseconds: number): StripeCheckoutTimestamp =>
    new StripeCheckoutTimestamp(milliseconds),
});
