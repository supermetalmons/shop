import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { z } from 'zod';
import { WALLET_SESSION_SUPERSEDED_ERROR_REASON } from '../../../../functions/src/shared/callableErrorCode.js';
import {
  buildWalletDeliveryRecoveryState,
  preparedDeliveryRecoveryNextCheckMs,
  processingDeliveryRecoveryNextCheckMs,
} from '../../../../functions/src/shared/deliveryRecovery.js';
import { parseDropDeliveryOrderPath } from '../../../../functions/src/dropPaths.js';
import { normalizeDropId } from '../../../../functions/src/shared/deploymentCore.js';
import { stripeCheckoutOwnerId } from '../../../../functions/src/shared/stripeCheckoutSession.js';
import type {
  ReconcileProfileStateRequest,
  ReconcileProfileStateResponse,
} from '../../../../functions/src/shared/contracts.js';
import {
  WALLET_SESSION_COLLECTION,
  WALLET_SESSION_COMPATIBILITY_EXPIRES_AT_MS,
  WalletLifecycleValidationError,
  canonicalWalletAddress,
  parseSolanaSignInMessage,
  resolveWalletSessionBinding,
  validateSolanaSignInMessage,
} from '../../../../functions/src/shared/walletLifecycle.js';
import {
  FirebaseIdTokenError,
  verifyFirebaseIdToken,
  type FirebaseIdentity,
} from './firebaseIdToken.js';
import {
  FIRESTORE_DATABASE_NAME,
  FIRESTORE_DOCUMENTS_BASE_URL,
  FIRESTORE_DOCUMENT_NAME_PREFIX,
  FirestoreWriteConflict,
  ProfileReadError,
  authenticatedFirestoreRequest,
  createGoogleAccessTokenProvider,
  decodeFirestoreFields,
  firestoreString,
  isRecord,
  readBoundedText,
  type GoogleAccessTokenProvider,
  type ProfileProviderFetch,
} from './firestoreRest.js';
import { isProfileRequestOriginAllowed } from './profileReads.js';

export const SOLANA_AUTH_PATH = '/auth/solana';
export const PROFILE_RECONCILE_PATH = '/profile/reconcile';
export const PROFILE_LIFECYCLE_PATHS = new Set([SOLANA_AUTH_PATH, PROFILE_RECONCILE_PATH]);

export type ProfileLifecyclePath = typeof SOLANA_AUTH_PATH | typeof PROFILE_RECONCILE_PATH;

const AUTH_TIMEOUT_MS = 15_000;
const RECONCILE_TIMEOUT_MS = 55_000;
const MAX_REQUEST_BYTES = 4096;
const FIRESTORE_TRANSACTION_ATTEMPTS = 5;
const STRIPE_OWNER_MERGE_BATCH_SIZE = 450;

const solanaAuthSchema = z.object({
  wallet: z.string().min(32).max(64),
  message: z.string().min(1).max(1024),
  signature: z.array(z.number().int().min(0).max(255)).length(64),
}).strict();

const reconcileSchema = z.object({
  mergeStripeDeliveryOrders: z.boolean().optional(),
  includeDeliveryRecovery: z.boolean().optional(),
}).strict();

type FirestoreCommon = {
  accessTokenProvider: GoogleAccessTokenProvider;
  nowMs: number;
  providerFetch: ProfileProviderFetch;
  serviceAccountJson: string;
  signal: AbortSignal;
};

type FirestoreDocument = {
  fields: Record<string, unknown>;
  name: string;
  updateTime: string;
};

type ProfileLifecycleMetrics = {
  upstreamCalls: number;
  providerDurationMs: number;
};

export type ProfileLifecycleResult = {
  response: Response;
  metrics: ProfileLifecycleMetrics;
  authOutcome: 'accepted' | 'rejected' | 'provider-failure';
  mergedStripeDeliveryOrders?: number;
};

type ProfileLifecycleDependencies = {
  accessTokenProvider: GoogleAccessTokenProvider;
  nowMs: () => number;
  providerFetch: ProfileProviderFetch;
  timeoutMs: number;
  verifyIdToken: (
    authorization: string | null,
    providerFetch: ProfileProviderFetch,
    signal: AbortSignal,
    nowMs?: number,
  ) => Promise<FirebaseIdentity>;
};

type ProfileLifecycleEnv = Pick<Env, 'FIRESTORE_WRITER_SERVICE_ACCOUNT_JSON'>;

class WalletSessionSupersededError extends ProfileReadError {
  constructor() {
    super(
      'failed-precondition',
      409,
      'A newer wallet sign-in superseded this request. Sign in again.',
      { reason: WALLET_SESSION_SUPERSEDED_ERROR_REASON },
    );
    this.name = 'WalletSessionSupersededError';
  }
}

class StripeOwnerMergeSessionChangedError extends ProfileReadError {
  constructor(reason: string) {
    super('unauthenticated', 401, 'Wallet session changed. Sign in again.', { reason });
    this.name = 'StripeOwnerMergeSessionChangedError';
  }
}

class StripeOwnerMergeUnexpectedPathError extends ProfileReadError {
  constructor() {
    super(
      'failed-precondition',
      409,
      'Stripe order reconciliation found invalid server data.',
      { reason: 'unexpected-delivery-order-path' },
    );
    this.name = 'StripeOwnerMergeUnexpectedPathError';
  }
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function errorResponse(error: ProfileReadError): Response {
  return jsonResponse({
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  }, error.status);
}

async function parseRequestBody(
  request: Request,
  path: ProfileLifecyclePath,
  signal: AbortSignal,
): Promise<z.infer<typeof solanaAuthSchema> | ReconcileProfileStateRequest> {
  if (String(request.headers.get('Content-Type') || '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw new ProfileReadError('invalid-argument', 400, 'Invalid request.');
  }
  const contentLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    await request.body?.cancel().catch(() => undefined);
    throw new ProfileReadError('invalid-argument', 400, 'Invalid request.');
  }
  if (!request.body) throw new ProfileReadError('invalid-argument', 400, 'Invalid request.');
  let text: string;
  try {
    text = await readBoundedText(new Response(request.body), MAX_REQUEST_BYTES, signal);
  } catch {
    if (signal.aborted) throw signal.reason;
    throw new ProfileReadError('invalid-argument', 400, 'Invalid request.');
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ProfileReadError('invalid-argument', 400, 'Invalid request.');
  }
  const result = path === SOLANA_AUTH_PATH
    ? solanaAuthSchema.safeParse(value)
    : reconcileSchema.safeParse(value);
  if (!result.success) throw new ProfileReadError('invalid-argument', 400, 'Invalid request.');
  return result.data;
}

function parseFirestoreDocument(value: unknown): FirestoreDocument | null {
  if (!isRecord(value) || typeof value.name !== 'string' || typeof value.updateTime !== 'string') return null;
  const fields = decodeFirestoreFields(value.fields);
  if (!fields) return null;
  return { fields, name: value.name, updateTime: value.updateTime };
}

async function loadSessionDocument(
  common: FirestoreCommon,
  uid: string,
  transaction?: string,
): Promise<FirestoreDocument | null> {
  const url = new URL(`${FIRESTORE_DOCUMENTS_BASE_URL}/${WALLET_SESSION_COLLECTION}/${encodeURIComponent(uid)}`);
  url.searchParams.append('mask.fieldPaths', 'wallet');
  if (transaction) url.searchParams.set('transaction', transaction);
  const value = await authenticatedFirestoreRequest({ ...common, method: 'GET', url: url.toString() });
  if (value === null) return null;
  const document = parseFirestoreDocument(value);
  if (!document) throw new ProfileReadError('unavailable', 502, 'Profile data is temporarily unavailable.');
  return document;
}

function resolveSessionWallet(document: FirestoreDocument | null, uid: string): string {
  const resolution = resolveWalletSessionBinding({
    uid,
    sessionExists: document !== null,
    sessionData: document?.fields || null,
  });
  if ('reason' in resolution) {
    throw new ProfileReadError('unauthenticated', 401, 'Sign in with your wallet first.');
  }
  return resolution.wallet;
}

function sessionMatchesBaseline(
  baseline: FirestoreDocument | null,
  current: FirestoreDocument | null,
): boolean {
  if (baseline === null || current === null) return baseline === current;
  return baseline.updateTime === current.updateTime;
}

function documentName(path: string): string {
  return `${FIRESTORE_DOCUMENT_NAME_PREFIX}${path}`;
}

async function commitWrites(common: FirestoreCommon, writes: unknown[]): Promise<void> {
  await authenticatedFirestoreRequest({
    ...common,
    body: JSON.stringify({ writes }),
    method: 'POST',
    surfaceWriteConflict: true,
    url: `https://firestore.googleapis.com/v1/${FIRESTORE_DATABASE_NAME}/documents:commit`,
  });
}

async function pauseForConflict(signal: AbortSignal, attempt: number): Promise<void> {
  if (signal.aborted) throw signal.reason;
  const delay = Math.min(400, 25 * 2 ** attempt);
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const timeout = setTimeout(finish, delay);
    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

async function establishWalletSession(params: {
  common: FirestoreCommon;
  identity: FirebaseIdentity;
  message: string;
  nowMs: number;
  originHostname: string;
  signature: number[];
  wallet: string;
}): Promise<void> {
  const baseline = await loadSessionDocument(params.common, params.identity.uid);
  const statement = parseSolanaSignInMessage(params.message);
  validateSolanaSignInMessage({
    message: statement,
    nowMs: params.nowMs,
    originHostname: params.originHostname,
    uid: params.identity.uid,
    wallet: params.wallet,
  });
  const signatureValid = nacl.sign.detached.verify(
    new TextEncoder().encode(params.message),
    Uint8Array.from(params.signature),
    bs58.decode(params.wallet),
  );
  if (!signatureValid) throw new ProfileReadError('unauthenticated', 401, 'Invalid signature');
  for (let attempt = 0; attempt < FIRESTORE_TRANSACTION_ATTEMPTS; attempt += 1) {
    const current = await loadSessionDocument(params.common, params.identity.uid);
    const currentWallet = current ? canonicalWalletAddress(current.fields.wallet) : null;
    if (!sessionMatchesBaseline(baseline, current) && currentWallet !== params.wallet) {
      throw new WalletSessionSupersededError();
    }
    const sessionFields = {
      wallet: firestoreString(params.wallet),
      expiresAt: { timestampValue: new Date(WALLET_SESSION_COMPATIBILITY_EXPIRES_AT_MS).toISOString() },
    };
    try {
      await commitWrites(params.common, [
        {
          update: {
            name: documentName(`${WALLET_SESSION_COLLECTION}/${params.identity.uid}`),
            fields: sessionFields,
          },
          updateMask: { fieldPaths: Object.keys(sessionFields) },
          updateTransforms: [{ fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' }],
          currentDocument: current
            ? { updateTime: current.updateTime }
            : { exists: false },
        },
        {
          update: {
            name: documentName(`profiles/${params.wallet}`),
            fields: { wallet: firestoreString(params.wallet) },
          },
          updateMask: { fieldPaths: ['wallet'] },
        },
      ]);
      return;
    } catch (error) {
      if (!(error instanceof FirestoreWriteConflict) || attempt + 1 >= FIRESTORE_TRANSACTION_ATTEMPTS) {
        if (error instanceof FirestoreWriteConflict) {
          throw new ProfileReadError('aborted', 409, 'Wallet session changed. Try again.');
        }
        throw error;
      }
      await pauseForConflict(params.common.signal, attempt);
    }
  }
}

async function beginTransaction(common: FirestoreCommon): Promise<string> {
  const value = await authenticatedFirestoreRequest({
    ...common,
    body: JSON.stringify({ options: { readWrite: {} } }),
    method: 'POST',
    url: `https://firestore.googleapis.com/v1/${FIRESTORE_DATABASE_NAME}/documents:beginTransaction`,
  });
  if (!isRecord(value) || typeof value.transaction !== 'string' || !value.transaction) {
    throw new ProfileReadError('unavailable', 502, 'Profile data is temporarily unavailable.');
  }
  return value.transaction;
}

async function rollbackTransaction(common: FirestoreCommon, transaction: string): Promise<void> {
  await authenticatedFirestoreRequest({
    ...common,
    body: JSON.stringify({ transaction }),
    method: 'POST',
    url: `https://firestore.googleapis.com/v1/${FIRESTORE_DATABASE_NAME}/documents:rollback`,
  });
}

async function commitTransaction(common: FirestoreCommon, transaction: string, writes: unknown[]): Promise<void> {
  await authenticatedFirestoreRequest({
    ...common,
    body: JSON.stringify({ transaction, writes }),
    method: 'POST',
    surfaceWriteConflict: true,
    url: `https://firestore.googleapis.com/v1/${FIRESTORE_DATABASE_NAME}/documents:commit`,
  });
}

function queryDocuments(value: unknown): FirestoreDocument[] {
  if (!Array.isArray(value)) throw new ProfileReadError('unavailable', 502, 'Profile data is temporarily unavailable.');
  const documents: FirestoreDocument[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) throw new ProfileReadError('unavailable', 502, 'Profile data is temporarily unavailable.');
    if (entry.document === undefined && typeof entry.readTime === 'string') continue;
    const document = parseFirestoreDocument(entry.document);
    if (!document) throw new ProfileReadError('unavailable', 502, 'Profile data is temporarily unavailable.');
    documents.push(document);
  }
  return documents;
}

function stripeOwnerQuery(owner: string, transaction: string): Record<string, unknown> {
  return {
    structuredQuery: {
      select: { fields: [{ fieldPath: 'owner' }] },
      from: [{ collectionId: 'deliveryOrders', allDescendants: true }],
      where: { fieldFilter: { field: { fieldPath: 'owner' }, op: 'EQUAL', value: firestoreString(owner) } },
      limit: STRIPE_OWNER_MERGE_BATCH_SIZE,
    },
    transaction,
  };
}

function deliveryOrderPath(document: FirestoreDocument): string {
  if (!document.name.startsWith(FIRESTORE_DOCUMENT_NAME_PREFIX)) throw new StripeOwnerMergeUnexpectedPathError();
  const path = document.name.slice(FIRESTORE_DOCUMENT_NAME_PREFIX.length);
  const identity = parseDropDeliveryOrderPath(path);
  if (!identity) throw new StripeOwnerMergeUnexpectedPathError();
  const normalizedDropId = normalizeDropId(identity.dropId);
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalizedDropId)) throw new StripeOwnerMergeUnexpectedPathError();
  return path;
}

async function mergeStripeOwnerBatch(params: {
  common: FirestoreCommon;
  firebaseOwner: string;
  uid: string;
  wallet: string;
}): Promise<number> {
  for (let attempt = 0; attempt < FIRESTORE_TRANSACTION_ATTEMPTS; attempt += 1) {
    const transaction = await beginTransaction(params.common);
    try {
      const session = await loadSessionDocument(params.common, params.uid, transaction);
      const resolution = resolveWalletSessionBinding({
        uid: params.uid,
        sessionExists: session !== null,
        sessionData: session?.fields || null,
      });
      if ('reason' in resolution) throw new StripeOwnerMergeSessionChangedError(resolution.reason);
      if (resolution.wallet !== params.wallet) throw new StripeOwnerMergeSessionChangedError('wallet_mismatch');
      const value = await authenticatedFirestoreRequest({
        ...params.common,
        body: JSON.stringify(stripeOwnerQuery(params.firebaseOwner, transaction)),
        method: 'POST',
        url: `${FIRESTORE_DOCUMENTS_BASE_URL}:runQuery`,
      });
      const documents = queryDocuments(value);
      if (documents.length > STRIPE_OWNER_MERGE_BATCH_SIZE) {
        throw new ProfileReadError('unavailable', 502, 'Profile data is temporarily unavailable.');
      }
      const paths = documents.map(deliveryOrderPath);
      const updateFields = {
        owner: firestoreString(params.wallet),
        mergedFirebaseUid: firestoreString(params.uid),
        previousOwner: firestoreString(params.firebaseOwner),
      };
      await commitTransaction(params.common, transaction, paths.map((path) => ({
        update: { name: documentName(path), fields: updateFields },
        updateMask: { fieldPaths: Object.keys(updateFields) },
        updateTransforms: [{ fieldPath: 'ownerMergedAt', setToServerValue: 'REQUEST_TIME' }],
      })));
      return paths.length;
    } catch (error) {
      if (!(error instanceof FirestoreWriteConflict)) {
        await rollbackTransaction(params.common, transaction).catch(() => undefined);
        throw error;
      }
      if (attempt + 1 >= FIRESTORE_TRANSACTION_ATTEMPTS) {
        throw new ProfileReadError('aborted', 409, 'Stripe order reconciliation changed. Try again.');
      }
      await pauseForConflict(params.common.signal, attempt);
    }
  }
  return 0;
}

async function mergeStripeOrders(params: {
  common: FirestoreCommon;
  uid: string;
  wallet: string;
}): Promise<number> {
  const firebaseOwner = stripeCheckoutOwnerId(params.uid);
  let merged = 0;
  for (;;) {
    const batchCount = await mergeStripeOwnerBatch({ ...params, firebaseOwner });
    merged += batchCount;
    if (batchCount < STRIPE_OWNER_MERGE_BATCH_SIZE) return merged;
  }
}

function deliveryRecoveryQuery(owner: string): Record<string, unknown> {
  return {
    structuredQuery: {
      select: { fields: ['status', 'createdAt', 'receiptRecovery'].map((fieldPath) => ({ fieldPath })) },
      from: [{ collectionId: 'deliveryOrders', allDescendants: true }],
      where: {
        compositeFilter: {
          op: 'AND',
          filters: [
            { fieldFilter: { field: { fieldPath: 'owner' }, op: 'EQUAL', value: firestoreString(owner) } },
            {
              fieldFilter: {
                field: { fieldPath: 'status' },
                op: 'IN',
                value: { arrayValue: { values: ['processing', 'prepared'].map(firestoreString) } },
              },
            },
          ],
        },
      },
    },
  };
}

async function loadDeliveryRecoveryState(common: FirestoreCommon, wallet: string, nowMs: number) {
  const value = await authenticatedFirestoreRequest({
    ...common,
    body: JSON.stringify(deliveryRecoveryQuery(wallet)),
    method: 'POST',
    url: `${FIRESTORE_DOCUMENTS_BASE_URL}:runQuery`,
  });
  const documents = queryDocuments(value);
  let remainingProcessing = 0;
  const nextCheckCandidates: Array<number | null> = [];
  for (const document of documents) {
    if (document.fields.status === 'processing') {
      remainingProcessing += 1;
      nextCheckCandidates.push(processingDeliveryRecoveryNextCheckMs(document.fields, nowMs));
    } else if (document.fields.status === 'prepared') {
      nextCheckCandidates.push(preparedDeliveryRecoveryNextCheckMs(document.fields, nowMs));
    }
  }
  return buildWalletDeliveryRecoveryState({ remainingProcessing, nextCheckCandidates });
}

async function reconcileProfileState(params: {
  body: ReconcileProfileStateRequest;
  common: FirestoreCommon;
  identity: FirebaseIdentity;
  nowMs: number;
}): Promise<ReconcileProfileStateResponse> {
  const session = await loadSessionDocument(params.common, params.identity.uid);
  const wallet = resolveSessionWallet(session, params.identity.uid);
  const mergedStripeDeliveryOrders = params.body.mergeStripeDeliveryOrders === true
    ? await mergeStripeOrders({ common: params.common, uid: params.identity.uid, wallet })
    : 0;
  const recovery = params.body.includeDeliveryRecovery === false
    ? null
    : await loadDeliveryRecoveryState(params.common, wallet, params.nowMs);
  return {
    mergedStripeDeliveryOrders,
    ...(recovery?.nextCheckAt == null ? {} : { deliveryRecovery: { nextCheckAt: recovery.nextCheckAt } }),
  };
}

const defaultAccessTokenProvider = createGoogleAccessTokenProvider();

const defaultDependencies: ProfileLifecycleDependencies = {
  accessTokenProvider: defaultAccessTokenProvider,
  nowMs: () => Date.now(),
  providerFetch: (input, init) => fetch(input, init),
  timeoutMs: AUTH_TIMEOUT_MS,
  verifyIdToken: verifyFirebaseIdToken,
};

export async function handleProfileLifecycleRequest(
  request: Request,
  env: ProfileLifecycleEnv,
  path: ProfileLifecyclePath,
  overrides: Partial<ProfileLifecycleDependencies> = {},
): Promise<ProfileLifecycleResult> {
  const dependencies = {
    ...defaultDependencies,
    timeoutMs: path === PROFILE_RECONCILE_PATH ? RECONCILE_TIMEOUT_MS : AUTH_TIMEOUT_MS,
    ...overrides,
  };
  const metrics: ProfileLifecycleMetrics = { upstreamCalls: 0, providerDurationMs: 0 };
  const trackedFetch: ProfileProviderFetch = async (input, init) => {
    const startedAt = performance.now();
    metrics.upstreamCalls += 1;
    try {
      return await dependencies.providerFetch(input, init);
    } finally {
      metrics.providerDurationMs += Math.max(0, performance.now() - startedAt);
    }
  };
  if (request.method !== 'POST') {
    await request.body?.cancel().catch(() => undefined);
    const response = errorResponse(new ProfileReadError('invalid-argument', 405, 'Method not allowed.'));
    response.headers.set('Allow', 'POST, OPTIONS');
    return { response, metrics, authOutcome: 'rejected' };
  }
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException('Profile lifecycle request timed out', 'TimeoutError')),
    dependencies.timeoutMs,
  );
  let identity: FirebaseIdentity | undefined;
  try {
    const origin = request.headers.get('Origin') || '';
    if (path === SOLANA_AUTH_PATH && (!origin || !isProfileRequestOriginAllowed(request))) {
      throw new ProfileReadError('permission-denied', 403, 'Origin is not allowed.');
    }
    const body = await parseRequestBody(request, path, controller.signal);
    identity = await dependencies.verifyIdToken(
      request.headers.get('Authorization'),
      trackedFetch,
      controller.signal,
      dependencies.nowMs(),
    );
    const serviceAccountJson = typeof env.FIRESTORE_WRITER_SERVICE_ACCOUNT_JSON === 'string'
      ? env.FIRESTORE_WRITER_SERVICE_ACCOUNT_JSON
      : '';
    if (!serviceAccountJson) throw new ProfileReadError('unavailable', 503, 'Profile data is temporarily unavailable.');
    const nowMs = dependencies.nowMs();
    const common: FirestoreCommon = {
      accessTokenProvider: dependencies.accessTokenProvider,
      nowMs,
      providerFetch: trackedFetch,
      serviceAccountJson,
      signal: controller.signal,
    };
    if (path === SOLANA_AUTH_PATH) {
      const authBody = body as z.infer<typeof solanaAuthSchema>;
      const wallet = canonicalWalletAddress(authBody.wallet);
      if (!wallet) throw new ProfileReadError('invalid-argument', 400, 'Invalid wallet address');
      const originHostname = new URL(origin).hostname;
      await establishWalletSession({
        common,
        identity,
        message: authBody.message,
        nowMs,
        originHostname,
        signature: authBody.signature,
        wallet,
      });
      return { response: jsonResponse({ wallet }, 200), metrics, authOutcome: 'accepted' };
    }
    const response = await reconcileProfileState({
      body: body as ReconcileProfileStateRequest,
      common,
      identity,
      nowMs,
    });
    return {
      response: jsonResponse(response, 200),
      metrics,
      authOutcome: 'accepted',
      mergedStripeDeliveryOrders: response.mergedStripeDeliveryOrders,
    };
  } catch (error) {
    let profileError: ProfileReadError;
    let authOutcome: ProfileLifecycleResult['authOutcome'] = identity ? 'provider-failure' : 'rejected';
    if (error instanceof ProfileReadError) {
      profileError = error;
      if ([
        'unauthenticated',
        'permission-denied',
        'invalid-argument',
        'not-found',
        'aborted',
        'failed-precondition',
      ].includes(error.code)) authOutcome = 'rejected';
    } else if (error instanceof WalletLifecycleValidationError) {
      const status = error.code === 'permission-denied' ? 403 : error.code === 'failed-precondition' ? 409 : 400;
      profileError = new ProfileReadError(error.code, status, error.message);
      authOutcome = 'rejected';
    } else if (error instanceof FirebaseIdTokenError) {
      if (error.kind === 'invalid-token') {
        profileError = new ProfileReadError('unauthenticated', 401, 'Authentication is required.');
        authOutcome = 'rejected';
      } else if (error.kind === 'provider-timeout') {
        profileError = new ProfileReadError('deadline-exceeded', 504, 'Profile request timed out.');
      } else {
        profileError = new ProfileReadError('unavailable', 502, 'Authentication is temporarily unavailable.');
      }
    } else if (controller.signal.aborted) {
      profileError = new ProfileReadError('deadline-exceeded', 504, 'Profile request timed out.');
    } else {
      profileError = new ProfileReadError('internal', 500, 'Profile request failed.');
    }
    return { response: errorResponse(profileError), metrics, authOutcome };
  } finally {
    clearTimeout(timeout);
  }
}
