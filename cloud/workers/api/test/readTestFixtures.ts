import assert from 'node:assert/strict';
import { createCommerceD1, decodeLegacyFirestoreFixtureFields } from './commerceD1Harness.ts';
import { D1CommerceRepository, commerceKeys, type CommerceDocumentData, type CommerceDocumentRecord } from '../src/commerceRepository.ts';
import type { ProfileProviderFetch } from '../src/boundedResponse.ts';
import type { handleProfileReadRequest } from '../src/profileReads.ts';
import type { handleStaffReadRequest } from '../src/staffReads.ts';

export const OWNER = 'kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx';
export const ADMIN = 'A87Upx1f1whNV5P8xQCK2YUTwE3uMYigjoKJAF3jiNpz';
export const OTHER = 'So11111111111111111111111111111111111111112';
export const SYSTEM_OWNER = '11111111111111111111111111111111';
export const UID = 'auth-user-one';
export const NOW_MS = Date.parse('2026-08-18T12:00:00.000Z');

export function tokenRequest(path: string, body: unknown, origin = 'https://mons.shop'): Request {
  return new Request(`https://api.mons.shop${path}`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
      Origin: origin,
    },
    body: JSON.stringify(body),
  });
}

export function stringValue(value: string) {
  return { stringValue: value };
}

export function integerValue(value: number) {
  return { integerValue: String(value) };
}

export function base64UrlJson(value: unknown): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function orderDocument(owner = OWNER, deliveryId = 7) {
  return {
    name: `projects/mons-shop/databases/(default)/documents/drops/card_nft_2/deliveryOrders/${deliveryId}`,
    fields: {
      dropId: stringValue('card_nft_2'),
      deliveryId: integerValue(deliveryId),
      status: stringValue('ready_to_ship'),
      createdAt: { timestampValue: '2026-08-18T10:00:00.000Z' },
      processedAt: { timestampValue: '2026-08-18T11:00:00.000Z' },
      items: {
        arrayValue: {
          values: [{ mapValue: { fields: { kind: stringValue('box'), refId: integerValue(3) } } }],
        },
      },
      owner: stringValue(owner),
    },
  };
}

export function manualReviewDocument() {
  return {
    name: 'projects/mons-shop/databases/(default)/documents/drops/card_nft_2/stripeCheckouts/cs_test_review',
    fields: {
      manualRefundReviewRequired: { booleanValue: true },
      status: stringValue('fulfillment_failed'),
      sessionId: stringValue('cs_test_review'),
      owner: stringValue(OWNER),
      ownerKind: stringValue('wallet'),
      quantity: integerValue(2),
      stripeSessionSummary: {
        mapValue: {
          fields: {
            amount_total: integerValue(4200),
            currency: stringValue('usd'),
          },
        },
      },
    },
  };
}

function createLegacyFirestoreRepository(providerFetch: ProfileProviderFetch) {
  const loadDocuments = async (request: object): Promise<CommerceDocumentRecord[]> => {
    const response = await providerFetch('https://commerce.test/documents:runQuery', {
      method: 'POST',
      body: JSON.stringify(request),
    });
    const payload = await response.json() as unknown;
    if (!Array.isArray(payload)) throw new Error('Invalid repository fixture');
    return payload.flatMap((entry): CommerceDocumentRecord[] => {
      const document = entry && typeof entry === 'object' && 'document' in entry
        ? (entry as { document?: unknown }).document
        : undefined;
      if (!document || typeof document !== 'object') return [];
      const raw = document as { name?: unknown; fields?: unknown; updateTime?: unknown };
      if (typeof raw.name !== 'string') return [];
      const fields = decodeLegacyFirestoreFixtureFields(raw.fields);
      if (!fields) return [];
      const delivery = raw.name.match(/\/drops\/([^/]+)\/deliveryOrders\/([^/]+)$/);
      const checkout = raw.name.match(/\/drops\/([^/]+)\/stripeCheckouts\/([^/]+)$/);
      const key = delivery
        ? commerceKeys.deliveryOrder(delivery[1], delivery[2])
        : checkout ? commerceKeys.stripeCheckout(checkout[1], checkout[2]) : null;
      if (!key) return [];
      const timestamp = (raw.fields as { processedAt?: { timestampValue?: unknown } })?.processedAt?.timestampValue;
      const milliseconds = typeof timestamp === 'string' ? Date.parse(timestamp) : Number.NaN;
      const fraction = typeof timestamp === 'string' ? timestamp.match(/\.(\d{1,9})Z$/)?.[1] || '' : '';
      return [{
        createTime: '',
        data: fields as CommerceDocumentData,
        key,
        processedAt: Number.isFinite(milliseconds)
          ? { seconds: Math.floor(milliseconds / 1000), nanos: Number(fraction.padEnd(9, '0')) || 0 }
          : null,
        updateTime: typeof raw.updateTime === 'string' ? raw.updateTime : '',
        version: 1,
      }];
    });
  };
  return {
    notificationOutbox: new D1CommerceRepository(createCommerceD1()).notificationOutbox,
    queryShipmentHistoryPage: async () => assert.fail('Unexpected paged shipment query'),
    queryShipmentPresence: async () => assert.fail('Unexpected shipment presence query'),
    queryDeliveryHistory: (args: Parameters<D1CommerceRepository['queryDeliveryHistory']>[0]) =>
      loadDocuments({ operation: 'queryDeliveryHistory', ...args }),
    queryFulfillmentOrders: (args: Parameters<D1CommerceRepository['queryFulfillmentOrders']>[0]) =>
      loadDocuments({ operation: 'queryFulfillmentOrders', ...args }),
    queryManualReviewCheckouts: (args: Parameters<D1CommerceRepository['queryManualReviewCheckouts']>[0]) =>
      loadDocuments({ operation: 'queryManualReviewCheckouts', ...args }),
    queryDeliveryOrderOwners: async (args: Readonly<{ startAfterOwner?: string; limit: number }>) => {
      const documents = await loadDocuments({ operation: 'queryDeliveryOrderOwners', ...args });
      return [...new Set(documents.flatMap((document) =>
        typeof document.data.owner === 'string' ? [document.data.owner] : []))]
        .filter((owner) => args.startAfterOwner === undefined || owner > args.startAfterOwner)
        .sort()
        .slice(0, args.limit);
    },
  };
}

export function profileDependencies(
  providerFetch: ProfileProviderFetch,
  createCommerceRepository: NonNullable<Parameters<typeof handleProfileReadRequest>[4]>['createCommerceRepository'],
  overrides: Parameters<typeof handleProfileReadRequest>[4] = {},
): Parameters<typeof handleProfileReadRequest>[4] {
  return {
    createCommerceRepository,
    loadProfileEmail: async () => undefined,
    nowMs: () => NOW_MS,
    providerFetch,
    resolveD1AuthWalletBinding: async () => ({ wallet: OWNER, source: 'binding' }),
    timeoutMs: 500,
    verifyIdentity: async () => ({ kind: 'anonymous' as const, authSubject: UID }),
    ...overrides,
  };
}

export function legacyFirestoreProfileDependencies(
  providerFetch: ProfileProviderFetch,
  overrides: Parameters<typeof handleProfileReadRequest>[4] = {},
): Parameters<typeof handleProfileReadRequest>[4] {
  return profileDependencies(providerFetch, () => createLegacyFirestoreRepository(providerFetch), overrides);
}

export function d1ProfileDependencies(
  providerFetch: ProfileProviderFetch,
  overrides: Parameters<typeof handleProfileReadRequest>[4] = {},
): Parameters<typeof handleProfileReadRequest>[4] {
  return profileDependencies(providerFetch, (database) => new D1CommerceRepository(database), overrides);
}

export function staffDependencies(
  providerFetch: ProfileProviderFetch,
  createCommerceRepository: NonNullable<Parameters<typeof handleStaffReadRequest>[4]>['createCommerceRepository'],
  overrides: Parameters<typeof handleStaffReadRequest>[4] = {},
): Parameters<typeof handleStaffReadRequest>[4] {
  return {
    createCommerceRepository,
    loadProfileEmail: async () => undefined,
    nowMs: () => NOW_MS,
    providerFetch,
    timeoutMs: 500,
    verifyIdentity: async () => ({ kind: 'staff-wallet' as const, wallet: ADMIN }),
    ...overrides,
  };
}

export function legacyFirestoreStaffDependencies(
  providerFetch: ProfileProviderFetch,
  overrides: Parameters<typeof handleStaffReadRequest>[4] = {},
): Parameters<typeof handleStaffReadRequest>[4] {
  return staffDependencies(providerFetch, () => createLegacyFirestoreRepository(providerFetch), overrides);
}

export function d1StaffDependencies(
  providerFetch: ProfileProviderFetch,
  overrides: Parameters<typeof handleStaffReadRequest>[4] = {},
): Parameters<typeof handleStaffReadRequest>[4] {
  return staffDependencies(providerFetch, (database) => new D1CommerceRepository(database), overrides);
}
