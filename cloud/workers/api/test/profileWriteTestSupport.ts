import type { TestContext } from 'node:test';
import nacl from 'tweetnacl';
import { encryptAddressCipherText, serializeAddressCipherPayload } from '../../../../shared/addressCipher.ts';
import { D1CommerceRepository, commerceKeys, type CommerceDocumentData } from '../src/commerceRepository.ts';
import type { ProfileProviderFetch } from '../src/boundedResponse.ts';
import type { ProfileWritePath, handleProfileWriteRequest } from '../src/profileWrites.ts';
import { createCommerceD1Harness, d1Database, seedCommerceDocument } from './commerceD1Harness.ts';

export const FULFILLMENT_ORDER_STATUS_PATH = '/fulfillment/order-status';
export const FULFILLMENT_ORDER_ADDRESS_PATH = '/fulfillment/order-address';
export const FULFILLMENT_SHIPSTATION_LABEL_PATH = '/fulfillment/shipstation-label';
export const FULFILLMENT_SHIPSTATION_LABEL_PURCHASE_PATH = '/fulfillment/shipstation-label-purchase';
export const FULFILLMENT_SHIPSTATION_LABEL_VOID_PATH = '/fulfillment/shipstation-label-void';
export const FULFILLMENT_SHIPSTATION_RATES_PATH = '/fulfillment/shipstation-rates';
export const FULFILLMENT_SHIPSTATION_SHIPMENT_PATH = '/fulfillment/shipstation-shipment';

export const OWNER = 'kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx';
export const ADMIN = 'A87Upx1f1whNV5P8xQCK2YUTwE3uMYigjoKJAF3jiNpz';
export const ADDRESS_VIEWING_ADMIN = 'ETaETZU82ZFnaz3j3TKAxRRzbQvt1Bn5tnF9EGMZe5zy';
export const OTHER = 'So11111111111111111111111111111111111111112';
export const UID = 'auth-user-one';
export const NOW_MS = Date.parse('2026-08-18T12:00:00.000Z');
export const ADDRESS_ID = 'AbCdEfGhIjKlMnOpQrSt';
const NOTIFICATION_JOB_ID = '123e4567-e89b-42d3-a456-426614174000';
export const ADDRESS_KEY_PAIR = nacl.box.keyPair();
export const ADDRESS_SECRET = Buffer.from(ADDRESS_KEY_PAIR.secretKey).toString('base64');
export const SHIP_FROM = {
  name: 'mons.shop',
  address_line1: '1061 10th Street',
  city_locality: 'West Pittsburg',
  state_province: 'PA',
  postal_code: '16160',
  country_code: 'US',
  address_residential_indicator: 'no',
};
export const SHIP_TO = {
  name: 'Ivan',
  address_line1: '100 Main St',
  city_locality: 'Istanbul',
  state_province: 'IST',
  postal_code: '34000',
  country_code: 'TR',
  address_residential_indicator: 'yes',
};
export const LABEL_PURCHASE_BODY = {
  dropId: 'card_nft_2',
  deliveryId: 7,
  rateId: 'rate-1',
  expectedTotal: { currency: 'usd', amount: 10 },
  requestId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
};
export const LABEL_VOID_BODY = {
  dropId: 'card_nft_2',
  deliveryId: 7,
  labelId: 'label-1',
};
export const SHIPSTATION_RATE = {
  rate_id: 'rate-1',
  shipment_id: 'shipment-1',
  carrier_id: 'carrier-1',
  carrier_code: 'stamps_com',
  carrier_friendly_name: 'USPS',
  service_code: 'usps_priority_mail',
  service_type: 'USPS Priority Mail',
  validation_status: 'valid',
  shipping_amount: { currency: 'usd', amount: 10 },
  insurance_amount: { currency: 'usd', amount: 0 },
  confirmation_amount: { currency: 'usd', amount: 0 },
  other_amount: { currency: 'usd', amount: 0 },
  warning_messages: [],
  error_messages: [],
};

export function request(path: ProfileWritePath, body: unknown): Request {
  return new Request(`https://api.mons.shop${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://mons.shop',
    },
    body: JSON.stringify(body),
  });
}

export function d1Dependencies(
  providerFetch: ProfileProviderFetch,
  overrides: Partial<Parameters<typeof handleProfileWriteRequest>[4]> = {},
): Parameters<typeof handleProfileWriteRequest>[4] {
  return {
    autoId: () => ADDRESS_ID,
    createNotificationJobId: () => NOTIFICATION_JOB_ID,
    error: () => undefined,
    log: () => undefined,
    nowMs: () => NOW_MS,
    providerFetch,
    resolveD1AuthWalletBinding: async () => ({ wallet: OWNER, source: 'binding' }),
    saveProfileAddress: async (_db, address) => ({
      id: address.id,
      country: address.country,
      ...(address.countryCode ? { countryCode: address.countryCode } : {}),
      encrypted: address.encrypted,
      hint: address.hint,
      ...(address.email ? { email: address.email } : {}),
    }),
    timeoutMs: 500,
    verifyIdentity: async () => ({ kind: 'staff-wallet' as const, wallet: OWNER }),
    warn: () => undefined,
    ...overrides,
  };
}

export const fulfillmentSettings = {
  ADDRESS_DECRYPTION_SECRET: ADDRESS_SECRET,
  SHIPSTATION_API_KEY: 'shipstation-api-key',
  SHIPSTATION_SHIP_FROM: JSON.stringify(SHIP_FROM),
};

export function decodeBase64(value: string): Uint8Array | null {
  try {
    return Uint8Array.from(Buffer.from(value, 'base64'));
  } catch {
    return null;
  }
}

export function encryptedAddress(full: string): string {
  return serializeAddressCipherPayload(
    encryptAddressCipherText(full, ADDRESS_KEY_PAIR.publicKey),
    (value) => Buffer.from(value).toString('base64'),
  );
}

export function orderFixture(t: TestContext, fields: CommerceDocumentData | null = {}, dropId = 'card_nft_2') {
  type Hook = () => void | Promise<void>;
  const hooks: { beforeWrite?: Hook; afterWrite?: Hook; afterRead?: Hook } = {};
  const documentWrite = /^\s*(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+commerce_documents\b/i;
  const documentRead = /^\s*SELECT\b[\s\S]*?\b(?:FROM|JOIN)\s+commerce_documents\b/i;
  const harness = createCommerceD1Harness({
    observeBatchBeforeBegin: ({ statements }) => {
      if (statements.some(({ sql }) => documentWrite.test(sql))) return hooks.beforeWrite?.();
    },
    observeBatchAfterCommit: ({ statements }) => {
      if (statements.some(({ sql }) => documentWrite.test(sql))) return hooks.afterWrite?.();
      if (statements.some(({ sql }) => documentRead.test(sql))) return hooks.afterRead?.();
    },
  });
  t.after(() => harness.database.close());
  const key = commerceKeys.deliveryOrder(dropId, '7');
  if (fields) {
    seedCommerceDocument(harness, {
      key,
      data: { deliveryId: 7, owner: OWNER, status: 'ready_to_ship', items: [{ kind: 'dude', refId: 1 }], ...fields },
    });
  }
  const concurrentWriter = new D1CommerceRepository(d1Database(harness.database));
  function read() {
    const result = harness.database.prepare('SELECT document_json FROM commerce_documents WHERE document_path = ?').get(key.path);
    if (!result) throw new Error('Missing fixture order');
    return JSON.parse(String(result.document_json)) as CommerceDocumentData;
  }
  return Object.assign(hooks, {
    env: { ...fulfillmentSettings, COMMERCE_DB: harness.db },
    key,
    harness,
    repository: new D1CommerceRepository(harness.db),
    read,
    station: () => (read().shipstation ?? {}) as CommerceDocumentData,
    patch(fields: CommerceDocumentData) {
      return concurrentWriter.run(NOW_MS, unit => unit.update(key, fields));
    },
  });
}
