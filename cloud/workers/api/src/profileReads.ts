import {
  MAX_SHIPMENT_PRESENCE_SELECTORS, isShipmentHistoryCursor,
  type ShipmentPageRequest, type ShipmentPresenceRequest, type ShipmentDeliveryReference,
} from '../../../../shared/shipmentHistory.js';
import type {
  DeliveryOrderSummary, GetProfileStateResponse, GetProfileShipmentsResponse,
  ProfileStateProfile, ProfileStateSection,
} from '../../../../shared/contracts.js';
import { isBase58Bytes } from '../../../../shared/solanaRpcProxy.js';
import { stripeCheckoutAnonymousOwnerId } from '../../../../shared/stripeCheckoutSession.js';
import {
  type RequestAuthContext, resolveRequestWallet, verifyRequestIdentity, type RequestIdentity,
} from './requestIdentity.js';
import type { ProfileProviderFetch } from './boundedResponse.js';
import {
  isRequestCancellationError, isSignalCancellationError, raceReadWithSignal,
} from './boundedRequest.js';
import { withAuthenticatedRequest } from './authenticatedRequest.js';
import { isRecord, ProfileReadError } from './dataAccess.js';
import { jsonResponse } from './httpResponse.js';
import { D1CommerceRepository } from './commerceRepository.js';
import { resolveD1AuthWalletBinding } from './authWalletBindingD1.js';
import {
  PROFILE_READ_TIMEOUT_MS, exactKeys, readProfileRequestBody, parseShipmentsPage,
  loadShipments, loadProfileEmail, readMethodNotAllowed, profileReadFailure,
  type ReadRequestDependencies, type ReadRequestResult,
} from './profileReadSupport.js';

export const PROFILE_SHIPMENTS_PATH = '/profile/shipments';
export const PROFILE_STATE_PATH = '/profile/state';
export const SHIPMENT_PRESENCE_PATH = '/profile/shipment-presence';
export const ANONYMOUS_STRIPE_DELIVERY_HISTORY_PATH = '/profile/anonymous-stripe-delivery-history';
export type ProfileReadPath =
  | typeof PROFILE_SHIPMENTS_PATH
  | typeof PROFILE_STATE_PATH
  | typeof SHIPMENT_PRESENCE_PATH
  | typeof ANONYMOUS_STRIPE_DELIVERY_HISTORY_PATH;

export const PROFILE_READ_PATHS = new Set<ProfileReadPath>([
  PROFILE_SHIPMENTS_PATH, PROFILE_STATE_PATH, SHIPMENT_PRESENCE_PATH,
  ANONYMOUS_STRIPE_DELIVERY_HISTORY_PATH,
]);

type ProfileReadResult = ReadRequestResult & {
  profileStateSections?: {
    profile: 'ready' | 'error' | 'not-applicable';
    shipments: 'ready' | 'error' | 'not-applicable';
  };
};

type ProfileReadDependencies = ReadRequestDependencies & {
  createCommerceRepository: (db: D1Database) => Pick<D1CommerceRepository,
    'queryDeliveryHistory' | 'queryShipmentHistoryPage' | 'queryShipmentPresence'>;
  resolveD1AuthWalletBinding: (
    db: D1Database | undefined,
    uid: string,
    signal: AbortSignal,
  ) => ReturnType<typeof resolveD1AuthWalletBinding>;
};

type ProfileReadEnv = Pick<Env, 'COMMERCE_DB'> & Partial<Pick<Env, 'OPS_DB'>>;

const defaultDependencies: ProfileReadDependencies = {
  createCommerceRepository: (db) => new D1CommerceRepository(db),
  loadProfileEmail,
  nowMs: () => Date.now(),
  providerFetch: (input, init) => fetch(input, init),
  resolveD1AuthWalletBinding: (db, uid, signal) => {
    if (!db) throw new Error('OPS_DB is unavailable');
    return resolveD1AuthWalletBinding(db, uid, signal);
  },
  timeoutMs: PROFILE_READ_TIMEOUT_MS,
  verifyIdentity: verifyRequestIdentity,
};

type ParsedProfileReadRequest =
  | { path: typeof SHIPMENT_PRESENCE_PATH; presence: ShipmentPresenceRequest }
  | { path: typeof PROFILE_STATE_PATH; shipmentsPage?: ShipmentPageRequest }
  | { path: typeof ANONYMOUS_STRIPE_DELIVERY_HISTORY_PATH; shipmentsPage?: ShipmentPageRequest }
  | { path: typeof PROFILE_SHIPMENTS_PATH; ownerWallet: string; shipmentsPage?: ShipmentPageRequest };

function isShipmentDeliveryReference(value: unknown): value is ShipmentDeliveryReference {
  return isRecord(value) && exactKeys(value, ['dropId', 'deliveryId']) &&
    typeof value.dropId === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value.dropId) &&
    typeof value.deliveryId === 'number' && Number.isSafeInteger(value.deliveryId) && value.deliveryId > 0;
}

function parseShipmentPresence(parsed: Record<string, unknown>): ShipmentPresenceRequest {
  const sessions = parsed.stripeSessionIds ?? [];
  const deliveries = parsed.deliveries ?? [];
  const invalid = () => new ProfileReadError('invalid-argument', 400, 'Invalid shipment presence request.');
  if (!exactKeys(parsed, ['scope', 'expectedWallet', 'stripeSessionIds', 'deliveries']) ||
    !Array.isArray(sessions) || !Array.isArray(deliveries) ||
    sessions.length + deliveries.length < 1 || sessions.length + deliveries.length > MAX_SHIPMENT_PRESENCE_SELECTORS ||
    !sessions.every((id): id is string => typeof id === 'string' && /^cs_[A-Za-z0-9_]+$/.test(id) && id.length <= 256) ||
    !deliveries.every(isShipmentDeliveryReference) ||
    parsed.stripeSessionIds === null || parsed.deliveries === null) {
    throw invalid();
  }
  if (parsed.scope === 'wallet') {
    if (typeof parsed.expectedWallet !== 'string' || !isBase58Bytes(parsed.expectedWallet, 32)) throw invalid();
    return { scope: 'wallet', expectedWallet: parsed.expectedWallet, stripeSessionIds: sessions, deliveries };
  }
  if (parsed.scope !== 'anonymous' || Object.hasOwn(parsed, 'expectedWallet')) throw invalid();
  return { scope: 'anonymous', stripeSessionIds: sessions, deliveries };
}

async function parseExactRequestBody(
  request: Request,
  path: ProfileReadPath,
  signal: AbortSignal,
): Promise<ParsedProfileReadRequest> {
  const parsed = await readProfileRequestBody(request, signal, path === SHIPMENT_PRESENCE_PATH ? 16 * 1024 : undefined);
  if (path === SHIPMENT_PRESENCE_PATH) return { path, presence: parseShipmentPresence(parsed) };
  const shipmentsPage = parseShipmentsPage(parsed);
  if (path === ANONYMOUS_STRIPE_DELIVERY_HISTORY_PATH || path === PROFILE_STATE_PATH) {
    if (!exactKeys(parsed, ['shipmentsPage'])) throw new ProfileReadError('invalid-argument', 400, 'Invalid request.');
    return { path, ...(shipmentsPage ? { shipmentsPage } : {}) };
  }
  if (!exactKeys(parsed, ['ownerWallet', 'shipmentsPage']) || typeof parsed.ownerWallet !== 'string' || !isBase58Bytes(parsed.ownerWallet, 32)) {
    throw new ProfileReadError('invalid-argument', 400, 'Invalid wallet address.');
  }
  return { path, ownerWallet: parsed.ownerWallet, ...(shipmentsPage ? { shipmentsPage } : {}) };
}

async function loadOptionalSessionWallet(args: {
  db: D1Database | undefined;
  resolveD1AuthWalletBinding: ProfileReadDependencies['resolveD1AuthWalletBinding'];
  signal: AbortSignal;
  uid: string;
}): Promise<string | null> {
  try {
    const resolution = await args.resolveD1AuthWalletBinding(args.db, args.uid, args.signal);
    if ('reason' in resolution) {
      if (resolution.reason === 'missing-binding') return null;
      throw new ProfileReadError('unauthenticated', 401, 'Sign in with your wallet first.');
    }
    return resolution.wallet;
  } catch (error) {
    if (isSignalCancellationError(args.signal, error)) throw args.signal.reason;
    if (error instanceof ProfileReadError) throw error;
    throw new ProfileReadError('unavailable', 503, 'Profile data is temporarily unavailable.');
  }
}

async function loadSessionWallet(args: {
  db: D1Database | undefined;
  resolveD1AuthWalletBinding: ProfileReadDependencies['resolveD1AuthWalletBinding'];
  signal: AbortSignal;
  uid: string;
}): Promise<string> {
  const wallet = await loadOptionalSessionWallet(args);
  if (!wallet) throw new ProfileReadError('unauthenticated', 401, 'Sign in with your wallet first.');
  return wallet;
}

async function loadProfileStateProfile(args: {
  db: D1Database | undefined;
  nowMs: number;
  ownerWallet: string;
  providerFetch: ProfileProviderFetch;
  signal: AbortSignal;
}, profileEmailLoader: typeof loadProfileEmail): Promise<ProfileStateProfile> {
  const email = await profileEmailLoader(args);
  return { wallet: args.ownerWallet, ...(email ? { email } : {}) };
}

function profileStateSection<T>(
  result: PromiseSettledResult<T>,
  request: Request,
  timeoutSignal: AbortSignal,
): ProfileStateSection<T> {
  if (result.status === 'fulfilled') return { status: 'ready', value: result.value };
  if (isRequestCancellationError(request, result.reason)) throw result.reason;
  if (
    result.reason instanceof ProfileReadError &&
    (result.reason.code === 'deadline-exceeded' || result.reason.code === 'unavailable')
  ) {
    return {
      status: 'error',
      error: { code: result.reason.code, message: result.reason.message },
    };
  }
  if (isSignalCancellationError(timeoutSignal, result.reason)) {
    return {
      status: 'error',
      error: { code: 'deadline-exceeded', message: 'Profile request timed out.' },
    };
  }
  throw result.reason;
}

export async function handleProfileReadRequest(
  request: Request,
  env: ProfileReadEnv,
  path: ProfileReadPath,
  authContext: RequestAuthContext = {},
  overrides: Partial<ProfileReadDependencies> = {},
): Promise<ProfileReadResult> {
  const dependencies = { ...defaultDependencies, ...overrides };
  if (request.method !== 'POST') return readMethodNotAllowed(request);
  return withAuthenticatedRequest<ProfileReadResult>(request, {
    authContext,
    opsDb: env.OPS_DB,
    timeoutMessage: 'Profile request timed out',
    dependencies,
  }, async ({ deadline, metrics, trackedFetch, authenticate }) => {
    const boundedRead = <T>(operation: Promise<T>) => raceReadWithSignal(operation, deadline.signal);
    let identity: RequestIdentity | undefined;
    try {
      const requestBody = await parseExactRequestBody(request, path, deadline.signal);
      identity = await authenticate();
      const common = {
        repository: dependencies.createCommerceRepository(env.COMMERCE_DB),
        nowMs: dependencies.nowMs(),
        providerFetch: trackedFetch,
        signal: deadline.signal,
      };
      const sessionCommon = {
        db: env.OPS_DB,
        resolveD1AuthWalletBinding: dependencies.resolveD1AuthWalletBinding,
        signal: deadline.signal,
      };
      if (requestBody.path === SHIPMENT_PRESENCE_PATH) {
        const presence = requestBody.presence;
        const owner = presence.scope === 'anonymous'
          ? identity.kind === 'staff-wallet' ? identity.wallet : stripeCheckoutAnonymousOwnerId(identity.authSubject)
          : await boundedRead(resolveRequestWallet(identity, (uid) => loadSessionWallet({ ...sessionCommon, uid })));
        if (presence.scope === 'wallet' && presence.expectedWallet !== owner) {
          throw new ProfileReadError('unauthenticated', 401, 'Wallet session changed. Sign in again.');
        }
        const matches = await boundedRead(common.repository.queryShipmentPresence({ ...presence, owner }));
        return { response: jsonResponse(matches, 200), metrics, authOutcome: 'accepted' };
      }
      if (requestBody.path === ANONYMOUS_STRIPE_DELIVERY_HISTORY_PATH) {
        const owner = identity.kind === 'staff-wallet' ? identity.wallet : stripeCheckoutAnonymousOwnerId(identity.authSubject);
        const shipments = await boundedRead(loadShipments({ ...common, owner, shipmentsPage: requestBody.shipmentsPage }));
        return { response: jsonResponse(shipments, 200), metrics, authOutcome: 'accepted' };
      }
      if (requestBody.path === PROFILE_STATE_PATH) {
        const wallet = await boundedRead(resolveRequestWallet(
          identity,
          (uid) => loadOptionalSessionWallet({ ...sessionCommon, uid }),
        ));
        if (requestBody.shipmentsPage?.cursor && (!wallet || !isShipmentHistoryCursor(requestBody.shipmentsPage.cursor, wallet))) {
          throw new ProfileReadError('invalid-argument', 400, 'Invalid shipment cursor owner.');
        }
        if (!wallet) {
          const response: GetProfileStateResponse = {
            responseMode: 'profile-state',
            sessionWallet: null,
            profile: null,
            shipments: null,
            ...(requestBody.shipmentsPage ? { nextCursor: null } : {}),
          };
          return {
            response: jsonResponse(response, 200),
            metrics,
            authOutcome: 'accepted',
            profileStateSections: { profile: 'not-applicable', shipments: 'not-applicable' },
          };
        }
        const [profileResult, shipmentsResult] = await Promise.allSettled([
          boundedRead(loadProfileStateProfile(
            { ...common, db: env.OPS_DB, ownerWallet: wallet },
            dependencies.loadProfileEmail,
          )),
          boundedRead(loadShipments({ ...common, owner: wallet, shipmentsPage: requestBody.shipmentsPage })),
        ]);
        const profile = profileStateSection(profileResult, request, deadline.timeoutSignal);
        const shipmentPage = profileStateSection(shipmentsResult, request, deadline.timeoutSignal);
        const shipments: ProfileStateSection<DeliveryOrderSummary[]> = shipmentPage.status === 'ready'
          ? { status: 'ready', value: shipmentPage.value.orders } : shipmentPage;
        const response: GetProfileStateResponse = {
          responseMode: 'profile-state',
          sessionWallet: wallet,
          profile,
          shipments,
          ...(shipmentPage.status === 'ready' && shipmentPage.value.nextCursor !== undefined
            ? { nextCursor: shipmentPage.value.nextCursor } : {}),
        };
        return {
          response: jsonResponse(response, 200),
          metrics,
          authOutcome: 'accepted',
          profileStateSections: { profile: profile.status, shipments: shipments.status },
        };
      }
      const ownerWallet = requestBody.ownerWallet;
      const wallet = await boundedRead(resolveRequestWallet(
        identity,
        (uid) => loadSessionWallet({ ...sessionCommon, uid }),
      ));
      if (wallet !== ownerWallet) throw new ProfileReadError('unauthenticated', 401, 'Wallet session changed. Sign in again.');
      const shipments = await boundedRead(loadShipments({ ...common, owner: ownerWallet, shipmentsPage: requestBody.shipmentsPage }));
      const response: GetProfileShipmentsResponse = { responseMode: 'shipments', wallet, ...shipments };
      return { response: jsonResponse(response, 200), metrics, authOutcome: 'accepted' };
    } catch (error) {
      return profileReadFailure(error, request, identity, deadline, metrics);
    }
  });
}
