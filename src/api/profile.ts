import type {
  DeliveryOrderSummary,
  GetAdminProfileViewRequest,
  GetAdminProfileViewResponse,
  GetProfileStateResponse,
  Profile,
  ProfileAddress,
  ProfileStateProfile,
  ProfileStateSection,
  ReconcileProfileStateRequest,
  ReconcileProfileStateResponse,
  SaveProfileAddressRequest,
} from '../types';
import { parseDeliveryOrderSummary } from '../../shared/deliveryOrderSummary.ts';
import { createProfileAddressId } from '../../shared/profileD1.ts';
import { isBase58Bytes } from '../../shared/solanaRpcProxy.ts';
import { ensureAnonymousSession } from '../lib/anonymousSession';
import { ensureStaffWalletSession } from '../lib/staffWalletSession';
import {
  callProfileApi as defaultCallProfileApi,
  type AuthenticatedApiCall,
  type AuthenticatedApiPath,
} from './transport';
import {
  hasExactKeys,
  hasExactRequiredAndOptionalKeys,
  isRecord,
} from './validation';

export async function ensureAuthenticated(): Promise<string> {
  const staffSession = await ensureStaffWalletSession();
  if (staffSession) return staffSession.wallet;
  return (await ensureAnonymousSession()).subject;
}

export function profileOrders(value: unknown): DeliveryOrderSummary[] | null {
  if (!Array.isArray(value)) return null;
  const orders = value.map(parseDeliveryOrderSummary);
  return orders.every((order): order is DeliveryOrderSummary => order !== null) ? orders : null;
}

function exactProfileOrders(value: unknown): DeliveryOrderSummary[] | null {
  if (!Array.isArray(value)) return null;
  const required = ['dropId', 'deliveryId', 'status', 'items'] as const;
  const optional = [
    'stripeCheckoutSessionId',
    'createdAt',
    'processingAt',
    'processedAt',
    'fulfillmentStatus',
    'fulfillmentTrackingCode',
    'fulfillmentUpdatedAt',
  ] as const;
  const allowed = new Set<string>([...required, ...optional]);
  const orders: DeliveryOrderSummary[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    if (!required.every((key) => Object.hasOwn(entry, key))) return null;
    if (!Object.keys(entry).every((key) => allowed.has(key))) return null;
    if (!Array.isArray(entry.items) || !entry.items.every((item) =>
      isRecord(item) && hasExactKeys(item, ['kind', 'refId'])
    )) return null;
    const order = parseDeliveryOrderSummary(entry);
    if (!order) return null;
    orders.push(order);
  }
  return orders;
}

export function parseProfileAddress(value: unknown): ProfileAddress | null {
  if (!isRecord(value)) return null;
  const required = ['id', 'country', 'hint', 'encrypted'] as const;
  const optional = ['countryCode', 'email'] as const;
  const allowed = new Set<string>([...required, ...optional]);
  if (!required.every((key) => Object.hasOwn(value, key))) return null;
  if (!Object.keys(value).every((key) => allowed.has(key))) return null;
  if (
    typeof value.id !== 'string' || !/^[A-Za-z0-9]{20}$/.test(value.id) ||
    typeof value.country !== 'string' || value.country.length > 64 ||
    typeof value.hint !== 'string' || value.hint.length > 256 ||
    typeof value.encrypted !== 'string' || value.encrypted.length > 4096 ||
    (value.countryCode !== undefined && (typeof value.countryCode !== 'string' || value.countryCode.length > 32)) ||
    (value.email !== undefined && (typeof value.email !== 'string' || !value.email || value.email.length > 254))
  ) return null;
  return {
    id: value.id,
    country: value.country,
    hint: value.hint,
    encrypted: value.encrypted,
    ...(typeof value.countryCode === 'string' ? { countryCode: value.countryCode } : {}),
    ...(typeof value.email === 'string' ? { email: value.email } : {}),
  };
}
function profileStateErrorSection(value: unknown): ProfileStateSection<never> | null {
  if (!isRecord(value) || !hasExactKeys(value, ['status', 'error']) || value.status !== 'error') return null;
  const error = value.error;
  if (!isRecord(error) || !hasExactKeys(error, ['code', 'message'])) return null;
  if (
    (error.code !== 'deadline-exceeded' && error.code !== 'unavailable') ||
    typeof error.message !== 'string' ||
    !error.message
  ) return null;
  return { status: 'error', error: { code: error.code, message: error.message } };
}

function profileStateProfileSection(
  value: unknown,
  sessionWallet: string,
): ProfileStateSection<ProfileStateProfile> | null {
  const error = profileStateErrorSection(value);
  if (error) return error;
  if (!isRecord(value) || !hasExactKeys(value, ['status', 'value']) || value.status !== 'ready') return null;
  const profile = value.value;
  if (!isRecord(profile)) return null;
  const keys = Object.keys(profile).sort().join(',');
  if (keys !== 'wallet' && keys !== 'email,wallet') return null;
  if (profile.wallet !== sessionWallet) return null;
  if (
    profile.email !== undefined &&
    (
      typeof profile.email !== 'string' ||
      !profile.email ||
      profile.email.length > 254 ||
      profile.email.trim() !== profile.email
    )
  ) return null;
  return {
    status: 'ready',
    value: {
      wallet: sessionWallet,
      ...(typeof profile.email === 'string' ? { email: profile.email } : {}),
    },
  };
}

function profileStateShipmentsSection(
  value: unknown,
): ProfileStateSection<DeliveryOrderSummary[]> | null {
  const error = profileStateErrorSection(value);
  if (error) return error;
  if (!isRecord(value) || !hasExactKeys(value, ['status', 'value']) || value.status !== 'ready') return null;
  const orders = exactProfileOrders(value.value);
  return orders ? { status: 'ready', value: orders } : null;
}

export function parseProfileState(value: unknown): GetProfileStateResponse | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    'responseMode',
    'sessionWallet',
    'profile',
    'shipments',
  ])) return null;
  if (value.responseMode !== 'profile-state') return null;
  if (value.sessionWallet === null) {
    return value.profile === null && value.shipments === null
      ? {
          responseMode: 'profile-state',
          sessionWallet: null,
          profile: null,
          shipments: null,
        }
      : null;
  }
  if (typeof value.sessionWallet !== 'string' || !isBase58Bytes(value.sessionWallet, 32)) return null;
  const profile = profileStateProfileSection(value.profile, value.sessionWallet);
  const shipments = profileStateShipmentsSection(value.shipments);
  if (!profile || !shipments) return null;
  return {
    responseMode: 'profile-state',
    sessionWallet: value.sessionWallet,
    profile,
    shipments,
  };
}

type ProfileApiCaller = (pathname: AuthenticatedApiPath, data: unknown) => Promise<unknown>;

function retryableProfileAddressError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return code === 'deadline-exceeded' || code === 'unavailable';
}

export async function saveProfileAddressRequest(
  request: SaveProfileAddressRequest,
  call: ProfileApiCaller,
): Promise<unknown> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await call('/profile/addresses', request);
    } catch (error) {
      if (attempt > 0 || !retryableProfileAddressError(error)) throw error;
    }
  }
  throw new Error('Profile address retry failed');
}

export type ProfileDomainDependencies = {
  callProfileApi: AuthenticatedApiCall;
  createProfileAddressId: typeof createProfileAddressId;
};

export function createProfileApiClient(
  dependencies: ProfileDomainDependencies = {
    callProfileApi: defaultCallProfileApi,
    createProfileAddressId,
  },
) {
  const callProfileApi = dependencies.callProfileApi;
  const createProfileAddressId = dependencies.createProfileAddressId;

  async function saveEncryptedAddress(
    encrypted: string,
    country: string,
    hint: string,
    email?: string,
    countryCode?: string,
  ): Promise<ProfileAddress> {
    const request: SaveProfileAddressRequest = {
      id: createProfileAddressId(),
      encrypted,
      country,
      countryCode,
      hint,
      email,
    };
    const response = await saveProfileAddressRequest(request, (pathname, data) => callProfileApi(pathname, data));
    const address = parseProfileAddress(response);
    if (!address) throw new Error('Invalid saved address response');
    return address;
  }

  async function solanaAuth(
    wallet: string,
    message: string,
    signature: Uint8Array,
  ): Promise<{ wallet: string }> {
    const response = await callProfileApi('/auth/solana', {
      wallet,
      message,
      signature: Array.from(signature),
    });
    if (!isRecord(response) || !hasExactKeys(response, ['wallet']) || !isBase58Bytes(response.wallet, 32)) {
      throw new Error('Invalid wallet session response');
    }
    return { wallet: String(response.wallet) };
  }

  async function reconcileProfileState(
    options?: ReconcileProfileStateRequest,
  ): Promise<ReconcileProfileStateResponse> {
    const payload: ReconcileProfileStateRequest = {};
    if (options?.mergeStripeDeliveryOrders === true) {
      payload.mergeStripeDeliveryOrders = true;
    }
    if (typeof options?.includeDeliveryRecovery === 'boolean') {
      payload.includeDeliveryRecovery = options.includeDeliveryRecovery;
    }
    const response = await callProfileApi('/profile/reconcile', payload);
    if (!isRecord(response) || !hasExactRequiredAndOptionalKeys(
      response,
      ['mergedStripeDeliveryOrders'],
      ['deliveryRecovery'],
    )) {
      throw new Error('Invalid profile reconciliation response');
    }
    if (
      !Number.isSafeInteger(response.mergedStripeDeliveryOrders) ||
      Number(response.mergedStripeDeliveryOrders) < 0
    ) {
      throw new Error('Invalid profile reconciliation response');
    }
    let deliveryRecovery: ReconcileProfileStateResponse['deliveryRecovery'];
    if (response.deliveryRecovery !== undefined) {
      if (
        !isRecord(response.deliveryRecovery) ||
        !hasExactKeys(response.deliveryRecovery, ['nextCheckAt']) ||
        typeof response.deliveryRecovery.nextCheckAt !== 'number' ||
        !Number.isFinite(response.deliveryRecovery.nextCheckAt)
      ) {
        throw new Error('Invalid profile reconciliation response');
      }
      deliveryRecovery = { nextCheckAt: response.deliveryRecovery.nextCheckAt };
    }
    return {
      mergedStripeDeliveryOrders: Number(response.mergedStripeDeliveryOrders),
      ...(deliveryRecovery ? { deliveryRecovery } : {}),
    };
  }

  async function loadProfileStateFromServer(): Promise<GetProfileStateResponse> {
    const response = await callProfileApi('/profile/state', {});
    const state = parseProfileState(response);
    if (!state) throw new Error('Invalid profile state response');
    return state;
  }

  async function getAdminProfileView(ownerWallet: string): Promise<GetAdminProfileViewResponse> {
    const response = await callProfileApi<GetAdminProfileViewRequest>('/admin/profile', { ownerWallet });
    if (!response || typeof response !== 'object' || Array.isArray(response)) throw new Error('Invalid admin profile response');
    const profile = (response as Record<string, unknown>).profile;
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new Error('Invalid admin profile response');
    const wallet = (profile as Record<string, unknown>).wallet;
    const email = (profile as Record<string, unknown>).email;
    const orders = profileOrders((profile as Record<string, unknown>).orders);
    if (wallet !== ownerWallet || (email !== undefined && typeof email !== 'string') || !orders) {
      throw new Error('Invalid admin profile response');
    }
    const normalizedEmail = typeof email === 'string' && email ? email : undefined;
    return { profile: { wallet, ...(normalizedEmail ? { email: normalizedEmail } : {}), orders } };
  }

  async function getAnonymousStripeDeliveryHistory(): Promise<{ orders: Profile['orders'] }> {
    const response: unknown = await callProfileApi('/profile/anonymous-stripe-delivery-history', {});
    if (!response || typeof response !== 'object' || Array.isArray(response)) {
      throw new Error('Invalid anonymous Stripe delivery history response');
    }
    const orders = profileOrders((response as Record<string, unknown>).orders);
    if (!orders) throw new Error('Invalid anonymous Stripe delivery history response');
    return { orders };
  }

  async function listDeliveryOrderOwners(
    options?: { cursor?: string; pageSize?: number },
  ): Promise<{ owners: string[]; nextCursor: string | null; hasMore: boolean }> {
    const payload: { cursor?: string; pageSize?: number } = {};
    if (typeof options?.cursor === 'string' && options.cursor) {
      payload.cursor = options.cursor;
    }
    if (typeof options?.pageSize === 'number' && Number.isFinite(options.pageSize)) {
      payload.pageSize = options.pageSize;
    }
    const response = await callProfileApi('/admin/delivery-order-owners', payload);
    if (
      !isRecord(response) ||
      !Array.isArray(response.owners) ||
      !response.owners.every((owner) => typeof owner === 'string' && isBase58Bytes(owner, 32)) ||
      (response.nextCursor !== null && typeof response.nextCursor !== 'string') ||
      typeof response.hasMore !== 'boolean'
    ) throw new Error('Invalid delivery order owners response');
    return {
      owners: response.owners as string[],
      nextCursor: response.nextCursor as string | null,
      hasMore: response.hasMore,
    };
  }


  return {
    getAdminProfileView,
    getAnonymousStripeDeliveryHistory,
    listDeliveryOrderOwners,
    loadProfileStateFromServer,
    reconcileProfileState,
    saveEncryptedAddress,
    solanaAuth,
  };
}

const profileApiClient = createProfileApiClient();

export const {
  getAdminProfileView,
  getAnonymousStripeDeliveryHistory,
  listDeliveryOrderOwners,
  loadProfileStateFromServer,
  reconcileProfileState,
  saveEncryptedAddress,
  solanaAuth,
} = profileApiClient;
