import {
  STRIPE_CHECKOUT_OWNER_KIND_FIREBASE,
  STRIPE_CHECKOUT_STATUS,
  STRIPE_RECEIPT_CLAIM_CODE_NAMESPACE,
  buildStripeOffchainDeliveryOrderDocument,
  buildStripeOffchainOrderMarkerDocument,
  requireStripeReceiptClaimCode,
  type StripeOffchainDeliveryOrderDocumentInput,
} from '../../functions/src/stripeCheckout/contract.ts';
import { encodeFirestoreRestFields } from './firebaseCliFirestoreRest.ts';

export const CARD_NFT_BINDER_OVERSELL_DROP_ID = 'card_nft_binder';
export const CARD_NFT_BINDER_OVERSELL_PROJECT_ID = 'mons-shop';
export const CARD_NFT_BINDER_OVERSELL_ADMIN =
  'kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx';
export const CARD_NFT_BINDER_OVERSELL_COLLECTION =
  '57rWZEQFtgsWf846fu9VjA89TkMkbmgbUvmqc8z56WLD';
export const CARD_NFT_BINDER_OVERSELL_TREE =
  'A84bJxATE2V1S3Gsr2VVoqLpitmfAGCXt7BAgLKp5QCF';
const CARD_NFT_BINDER_OVERSELL_METADATA_BASE =
  'https://cdn.lil.org/nft/card_nft_binder/json';

export type CardNftBinderOversellRecoveryItem = {
  sessionId: string;
  metadataId: number;
  name: string;
  uri: string;
};

export const CARD_NFT_BINDER_OVERSELL_RECOVERY_ITEMS: readonly CardNftBinderOversellRecoveryItem[] =
  [
    {
      sessionId:
        'cs_live_a1ZanWVK9yZbZslwrR7NcxjU4ufFlJGNpgC7QFuXVC8Ff4ZPBpO61ssKU0',
      metadataId: 16,
      name: 'receipt · binder 16',
      uri: `${CARD_NFT_BINDER_OVERSELL_METADATA_BASE}/rb16.json`,
    },
    {
      sessionId:
        'cs_live_a16siqxPeMuQoyNYyNMZvHMbfzGuuQBER06a6AMnl03CwBDKriRRzE7Iv0',
      metadataId: 17,
      name: 'receipt · binder 17',
      uri: `${CARD_NFT_BINDER_OVERSELL_METADATA_BASE}/rb17.json`,
    },
    {
      sessionId:
        'cs_live_a1N1U7jzdmAkw7Ao78BH2Ru35yIvxLVhT7Wks2xl8m0jEfCfgUKLSTuIG7',
      metadataId: 18,
      name: 'receipt · binder 18',
      uri: `${CARD_NFT_BINDER_OVERSELL_METADATA_BASE}/rb18.json`,
    },
    {
      sessionId:
        'cs_live_a1DmeTWkPpgbJKs1uILK0Rpw8Hm7DSkBfktjHgN3StjlgARS3O4g86RUyQ',
      metadataId: 19,
      name: 'receipt · binder 19',
      uri: `${CARD_NFT_BINDER_OVERSELL_METADATA_BASE}/rb19.json`,
    },
    {
      sessionId:
        'cs_live_a1X9UrjIGjr4lSljeTfgB8LQKd9gZnT5eVFhyaKJKDE8xqHunANHIJpGlc',
      metadataId: 20,
      name: 'receipt · binder 20',
      uri: `${CARD_NFT_BINDER_OVERSELL_METADATA_BASE}/rb20.json`,
    },
  ];

export const CARD_NFT_BINDER_OVERSELL_SESSION_IDS = new Set(
  CARD_NFT_BINDER_OVERSELL_RECOVERY_ITEMS.map((item) => item.sessionId),
);

const CHECKOUT_FAILURE_FIELDS = [
  'lastFulfillmentError',
  'lastRetryableFulfillmentAttempt',
  'lastRetryableFulfillmentError',
  'lastRetryableFulfillmentErrorAt',
  'manualRefundReviewRequired',
  'manualRefundReviewReason',
  'nextFulfillmentRetryAt',
  'failedAt',
  'processingAttemptId',
  'processingLeaseExpiresAt',
] as const;

type FirestoreCommitWrite = {
  update: {
    name: string;
    fields: Record<string, Record<string, unknown>>;
  };
  updateMask?: {
    fieldPaths: string[];
  };
  updateTransforms?: Array<{
    fieldPath: string;
    setToServerValue: 'REQUEST_TIME';
  }>;
  currentDocument: {
    exists?: boolean;
    updateTime?: string;
  };
};

function documentName(projectId: string, path: string): string {
  return `projects/${projectId}/databases/(default)/documents/${path}`;
}

function createWrite(
  projectId: string,
  path: string,
  data: Record<string, unknown>,
  timestampFields: string[],
): FirestoreCommitWrite {
  return {
    update: {
      name: documentName(projectId, path),
      fields: encodeFirestoreRestFields(data),
    },
    updateTransforms: timestampFields.map((fieldPath) => ({
      fieldPath,
      setToServerValue: 'REQUEST_TIME' as const,
    })),
    currentDocument: { exists: false },
  };
}

export function buildCardNftBinderOversellFirestoreCommit(args: {
  projectId?: string;
  checkoutUpdateTime: string;
  item: CardNftBinderOversellRecoveryItem;
  receiptTx: string;
  deliveryId: number;
  claimCode: string;
  owner: string;
  firebaseUid: string;
  receiptOwner: string;
  orderHashHex: string;
  stripeSession: StripeOffchainDeliveryOrderDocumentInput['stripeSession'];
  addressSnapshot: Record<string, unknown>;
}): {
  writes: FirestoreCommitWrite[];
  deliveryPath: string;
  markerPath: string;
  claimPath: string;
  checkoutPath: string;
} {
  const projectId = args.projectId || CARD_NFT_BINDER_OVERSELL_PROJECT_ID;
  const claimCode = requireStripeReceiptClaimCode(args.claimCode);
  const deliveryPath = `drops/${CARD_NFT_BINDER_OVERSELL_DROP_ID}/deliveryOrders/${args.deliveryId}`;
  const markerPath = `drops/${CARD_NFT_BINDER_OVERSELL_DROP_ID}/offchainOrders/${args.orderHashHex}`;
  const claimPath = `claimCodes/${claimCode}`;
  const checkoutPath = `drops/${CARD_NFT_BINDER_OVERSELL_DROP_ID}/stripeCheckouts/${args.item.sessionId}`;
  const stripeReceiptClaim = {
    code: claimCode,
    boxId: args.item.metadataId,
    status: 'unclaimed',
  };
  const orderInput: StripeOffchainDeliveryOrderDocumentInput = {
    dropId: CARD_NFT_BINDER_OVERSELL_DROP_ID,
    deliveryId: args.deliveryId,
    owner: args.owner,
    ownerKind: STRIPE_CHECKOUT_OWNER_KIND_FIREBASE,
    firebaseUid: args.firebaseUid,
    receiptOwner: args.receiptOwner,
    metadataId: args.item.metadataId,
    metadataIds: [args.item.metadataId],
    orderHashHex: args.orderHashHex,
    stripeSession: args.stripeSession,
    receiptTx: args.receiptTx,
    addressSnapshot: args.addressSnapshot,
    stripeReceiptClaim,
  };
  const delivery = buildStripeOffchainDeliveryOrderDocument(orderInput);
  const marker = buildStripeOffchainOrderMarkerDocument(orderInput);
  const claim = {
    version: 1,
    namespace: STRIPE_RECEIPT_CLAIM_CODE_NAMESPACE,
    code: claimCode,
    dropId: CARD_NFT_BINDER_OVERSELL_DROP_ID,
    deliveryId: args.deliveryId,
    owner: args.owner,
    ownerKind: STRIPE_CHECKOUT_OWNER_KIND_FIREBASE,
    firebaseUid: args.firebaseUid,
    receiptOwner: args.receiptOwner,
    boxId: args.item.metadataId,
    offchainOrderHash: args.orderHashHex,
    stripeCheckoutSessionId: args.item.sessionId,
    status: 'unclaimed',
  };
  const checkoutUpdate = {
    status: STRIPE_CHECKOUT_STATUS.FULFILLED,
    deliveryId: args.deliveryId,
    metadataId: args.item.metadataId,
    metadataIds: [args.item.metadataId],
    quantity: 1,
    receiptTx: args.receiptTx,
  };
  const checkoutFieldPaths = [
    ...Object.keys(checkoutUpdate),
    ...CHECKOUT_FAILURE_FIELDS,
  ].sort();

  return {
    deliveryPath,
    markerPath,
    claimPath,
    checkoutPath,
    writes: [
      createWrite(projectId, deliveryPath, delivery, [
        'processedAt',
        'createdAt',
      ]),
      createWrite(projectId, markerPath, marker, ['createdAt']),
      createWrite(projectId, claimPath, claim, ['createdAt']),
      {
        update: {
          name: documentName(projectId, checkoutPath),
          fields: encodeFirestoreRestFields(checkoutUpdate),
        },
        updateMask: { fieldPaths: checkoutFieldPaths },
        updateTransforms: ['fulfilledAt', 'updatedAt'].map((fieldPath) => ({
          fieldPath,
          setToServerValue: 'REQUEST_TIME' as const,
        })),
        currentDocument: { updateTime: args.checkoutUpdateTime },
      },
    ],
  };
}
