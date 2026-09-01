import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import Stripe from 'stripe';
import { getApiDrop } from './dropConfig.js';
import {
  ADDRESS_CIPHER_SECRET_KEY_LENGTH,
} from '../../../../shared/addressCipher.js';
import {
  BoxMinterConfigCodecError,
  decodeBoxMinterConfigData,
} from '../../../../shared/boxMinterConfigCodec.js';
import {
  StripeCheckoutOperationUncertainError,
  StripeCheckoutSessionError,
  createStripeCheckoutIdentity,
  createStripeCheckoutSessionCore,
  type StripeCheckoutOnchainConfig,
  type StripeCheckoutProviderRequest,
  type StripeCheckoutProviderResponse,
  type StripeCheckoutSessionDrop,
} from '../../../../shared/stripeCheckoutSession.js';
import {
  STRIPE_CHECKOUT_OPERATION_HEADER,
  STRIPE_CHECKOUT_RETRY_HEADER,
  STRIPE_CHECKOUT_RETRY_SAME_OPERATION,
} from '../../../../shared/contracts.js';
import type { StripeCheckoutMode } from '../../../../shared/stripeCheckoutCore.js';
import {
  RequestIdentityError,
  verifyRequestIdentity,
  type RequestIdentity,
} from './requestIdentity.js';
import { resolveD1AuthWalletBinding } from './authWalletBindingD1.js';
import { type ProfileProviderFetch } from './boundedResponse.js';
import {
  createRequestDeadline,
  isRequestCancellationError,
  raceReadWithSignal,
  raceWithSignal,
  readBoundedRequestJson,
  runCriticalRequestOperation,
} from './boundedRequest.js';
import { isRecord, ProfileReadError } from './dataAccess.js';
import { createStripeCheckoutStore, stripeCheckoutFieldValue } from './stripeCheckout/store.js';
import {
  rethrowDeferredWorkRegistrationError,
  type DeferredWork,
} from './deferredWork.js';
import {
  apiErrorBody,
  httpStatusForApiErrorCode,
  jsonResponse,
} from './httpResponse.js';
import {
  createSolanaProvider,
  parseSolanaRpcAccount,
  SolanaProviderError,
  type SolanaRetryPolicy,
} from './solanaProvider.js';

export const STRIPE_CHECKOUT_SESSION_PATH = '/checkout/session';

const CHECKOUT_REQUEST_MAX_BYTES = 4 * 1024;
const CHECKOUT_PROVIDER_MAX_BYTES = 256 * 1024;
const CHECKOUT_TIMEOUT_MS = 30_000;
const TRANSIENT_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

type CheckoutEnv = Pick<Env,
  | 'ADDRESS_DECRYPTION_SECRET'
  | 'COSIGNER_SECRET'
  | 'HELIUS_API_KEY'
  | 'STRIPE_RESTRICTED_KEY'
  | 'STRIPE_RESTRICTED_KEY_LIVE'
  | 'STRIPE_SECRET_KEY'
  | 'STRIPE_SECRET_KEY_LIVE'
> & Pick<Env, 'COMMERCE_DB'> & Partial<Pick<Env, 'OPS_DB'>>;

type StripeCheckoutMetrics = {
  upstreamCalls: number;
  providerDurationMs: number;
};

export type StripeCheckoutResult = {
  response: Response;
  metrics: StripeCheckoutMetrics;
  authOutcome: 'accepted' | 'rejected' | 'provider-failure';
  dropId?: string;
  mode?: StripeCheckoutMode;
};

type CheckoutDependencies = {
  defer: DeferredWork;
  nowMs: () => number;
  providerFetch: ProfileProviderFetch;
  timeoutMs: number;
  verifyIdentity: typeof verifyRequestIdentity;
  createProviderSession?: (
    request: StripeCheckoutProviderRequest,
    mode: StripeCheckoutMode,
    env: CheckoutEnv,
    providerFetch: ProfileProviderFetch,
    signal: AbortSignal,
  ) => Promise<StripeCheckoutProviderResponse>;
  getDrop?: (dropId: string) => StripeCheckoutSessionDrop | undefined;
  loadOnchainConfig?: (drop: StripeCheckoutSessionDrop) => Promise<StripeCheckoutOnchainConfig>;
  requireFulfillmentPrerequisites?: (config: StripeCheckoutOnchainConfig) => void;
  persistCheckout?: (path: string, document: Record<string, unknown>) => Promise<void>;
  resolveAuthWalletBinding: typeof resolveD1AuthWalletBinding;
};

const defaultDependencies: CheckoutDependencies = {
  defer: () => undefined,
  nowMs: () => Date.now(),
  providerFetch: (input, init) => fetch(input, init),
  resolveAuthWalletBinding: resolveD1AuthWalletBinding,
  timeoutMs: CHECKOUT_TIMEOUT_MS,
  verifyIdentity: verifyRequestIdentity,
};

function checkoutErrorResponse(error: StripeCheckoutSessionError, retrySameOperation = false): Response {
  const response = jsonResponse(
    apiErrorBody(error),
    httpStatusForApiErrorCode(error.code, 502),
  );
  if (retrySameOperation) {
    response.headers.set(STRIPE_CHECKOUT_RETRY_HEADER, STRIPE_CHECKOUT_RETRY_SAME_OPERATION);
  }
  return response;
}

function errorContainsCause(
  error: unknown,
  cause: unknown,
  seen = new Set<object>(),
  depth = 0,
): boolean {
  if (error === cause) return true;
  if (depth >= 5 || typeof error !== 'object' || error === null || seen.has(error)) return false;
  seen.add(error);
  const record = error as Record<string, unknown>;
  return ['cause', 'detail', 'exception', 'raw'].some((key) => (
    errorContainsCause(record[key], cause, seen, depth + 1)
  ));
}

function isNestedSignalCancellationError(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted && errorContainsCause(error, signal.reason);
}

function checkoutDrop(dropId: string): StripeCheckoutSessionDrop | undefined {
  const drop = getApiDrop(dropId);
  if (!drop) return undefined;
  return {
    dropId: drop.dropId,
    solanaCluster: drop.solanaCluster,
    dropFamily: drop.dropFamily,
    collectionName: drop.collectionName,
    ...(drop.displayName ? { displayName: drop.displayName } : {}),
    ...(drop.salesMode ? { salesMode: drop.salesMode } : {}),
    ...(drop.mintSelection ? { mintSelection: drop.mintSelection } : {}),
    ...(drop.stripeCheckoutEnabled === undefined ? {} : { stripeCheckoutEnabled: drop.stripeCheckoutEnabled }),
    ...(drop.stripeLiveUnitAmountCents === undefined ? {} : { stripeLiveUnitAmountCents: drop.stripeLiveUnitAmountCents }),
    ...(drop.stripeProductTaxCode ? { stripeProductTaxCode: drop.stripeProductTaxCode } : {}),
    itemsPerBox: drop.itemsPerBox,
    namePrefix: drop.namePrefix,
    boxMinterProgramId: drop.boxMinterProgramId,
    ...(drop.boxMinterConfigPda ? { boxMinterConfigPda: drop.boxMinterConfigPda } : {}),
    collectionMint: drop.collectionMint,
    receiptsMerkleTree: drop.receiptsMerkleTree,
  };
}

const CHECKOUT_CONFIG_RETRY_POLICY: SolanaRetryPolicy = {
  attempts: 2,
  delayMs: () => 100,
  shouldRetry: (error) => (error.kind === 'network' && error.bodyFailure === undefined) || (
    error.kind === 'http' && error.status !== undefined && TRANSIENT_HTTP_STATUSES.has(error.status)
  ),
};

async function fetchOnchainConfig(
  drop: StripeCheckoutSessionDrop,
  apiKey: string,
  providerFetch: ProfileProviderFetch,
  signal: AbortSignal,
): Promise<StripeCheckoutOnchainConfig> {
  const configPda = String(drop.boxMinterConfigPda || '').trim();
  if (!configPda) {
    throw new StripeCheckoutSessionError('failed-precondition', 'Box minter config PDA is not configured.');
  }
  const provider = createSolanaProvider({
    apiKey,
    attemptTimeoutMs: null,
    cluster: drop.solanaCluster,
    fetch: providerFetch,
    maxResponseBytes: CHECKOUT_PROVIDER_MAX_BYTES,
    requestId: () => 'stripe-checkout-config',
    retry: CHECKOUT_CONFIG_RETRY_POLICY,
    signal,
  });
  let result: unknown;
  try {
    result = await provider.rpc('getAccountInfo', [
      configPda,
      { commitment: 'confirmed', encoding: 'base64' },
    ], { errorMode: 'truthy', redirect: 'follow' });
  } catch (error) {
    if (isNestedSignalCancellationError(error, signal)) throw signal.reason;
    if (error instanceof SolanaProviderError && error.bodyFailure !== undefined) {
      throw new ProfileReadError('unavailable', 502, 'Profile data is temporarily unavailable.');
    }
    if (error instanceof SolanaProviderError && error.kind === 'invalid-response') {
      throw new StripeCheckoutSessionError('unavailable', 'On-chain checkout configuration returned an invalid response.');
    }
    throw new StripeCheckoutSessionError('unavailable', 'On-chain checkout configuration is temporarily unavailable.');
  }
  if (!isRecord(result)) {
    throw new StripeCheckoutSessionError('unavailable', 'On-chain checkout configuration returned an invalid response.');
  }
  const value = result.value;
  if (!isRecord(value) || value.owner !== drop.boxMinterProgramId || !Array.isArray(value.data)) {
    throw new StripeCheckoutSessionError('failed-precondition', 'Box minter config PDA is invalid.');
  }
  let accountData: Uint8Array;
  try {
    accountData = parseSolanaRpcAccount(value, { maxEncodedBytes: CHECKOUT_PROVIDER_MAX_BYTES }).data;
  } catch {
    throw new StripeCheckoutSessionError('unavailable', 'On-chain checkout configuration returned invalid data.');
  }
  let decoded;
  try {
    decoded = decodeBoxMinterConfigData(Buffer.from(accountData), { validateDiscriminator: true });
  } catch (error) {
    if (error instanceof BoxMinterConfigCodecError) {
      throw new StripeCheckoutSessionError('failed-precondition', error.message, error.details);
    }
    throw error;
  }
  return {
    admin: bs58.encode(decoded.admin),
    coreCollection: bs58.encode(decoded.coreCollection),
    maxSupply: decoded.maxSupply,
    maxPerTx: decoded.maxPerTx,
    itemsPerBox: decoded.itemsPerBox,
    minted: decoded.minted,
    started: decoded.started,
    mintVariantKind: decoded.mintVariantKind,
    mintVariantStartIds: decoded.mintVariantStartIds,
    mintVariantEndIds: decoded.mintVariantEndIds,
    mintVariantNextIds: decoded.mintVariantNextIds,
  };
}

export function requireFulfillmentPrerequisites(env: CheckoutEnv, config: StripeCheckoutOnchainConfig): void {
  let secretKey: Uint8Array;
  try {
    secretKey = bs58.decode(String(env.COSIGNER_SECRET || '').trim());
  } catch {
    throw new StripeCheckoutSessionError('failed-precondition', 'COSIGNER_SECRET is not configured for Stripe checkout fulfillment');
  }
  if (secretKey.length !== 64) {
    throw new StripeCheckoutSessionError('failed-precondition', 'COSIGNER_SECRET is not configured for Stripe checkout fulfillment');
  }
  let cosigner: string;
  try {
    cosigner = Keypair.fromSecretKey(secretKey).publicKey.toBase58();
  } catch {
    throw new StripeCheckoutSessionError('failed-precondition', 'COSIGNER_SECRET is not configured for Stripe checkout fulfillment');
  }
  if (cosigner !== config.admin) {
    throw new StripeCheckoutSessionError('failed-precondition', 'COSIGNER_SECRET does not match on-chain admin', {
      expectedAdmin: config.admin,
      cosigner,
    });
  }
  const addressKey = Buffer.from(String(env.ADDRESS_DECRYPTION_SECRET || '').trim(), 'base64');
  if (addressKey.length !== ADDRESS_CIPHER_SECRET_KEY_LENGTH) {
    throw new StripeCheckoutSessionError(
      'failed-precondition',
      'ADDRESS_DECRYPTION_SECRET is not configured correctly for Stripe checkout fulfillment',
    );
  }
}

export function stripeKeys(env: CheckoutEnv, mode: StripeCheckoutMode): string[] {
  const candidates = mode === 'test'
    ? [env.STRIPE_SECRET_KEY, env.STRIPE_RESTRICTED_KEY]
    : [env.STRIPE_SECRET_KEY_LIVE, env.STRIPE_RESTRICTED_KEY_LIVE];
  const pattern = mode === 'test' ? /^(sk|rk)_test_/ : /^(sk|rk)_live_/;
  return Array.from(new Set(candidates.map((value) => String(value || '').trim()).filter((value) => pattern.test(value))));
}

function stripeKeyKind(key: string): string {
  return /^(sk|rk)_(test|live)_/.exec(key)?.slice(1).join('_') || 'unknown';
}

function stripeCredentialError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  const type = String(error.type || error.rawType || error.name || '');
  const raw = isRecord(error.raw) ? error.raw : {};
  const statusCode = Number(error.statusCode ?? raw.statusCode);
  return type === 'StripeAuthenticationError' || type === 'StripePermissionError' || statusCode === 401 || statusCode === 403;
}

function stripeSuccessBodyUncertain(error: unknown, status: number | undefined): boolean {
  const raw = error instanceof Stripe.errors.StripeAPIError && isRecord(error.raw)
    ? error.raw
    : null;
  return status !== undefined &&
    status >= 200 &&
    status < 300 &&
    raw !== null &&
    Object.hasOwn(raw, 'exception');
}

async function createStripeProviderSession(
  request: StripeCheckoutProviderRequest,
  mode: StripeCheckoutMode,
  env: CheckoutEnv,
  providerFetch: ProfileProviderFetch,
  signal: AbortSignal,
): Promise<StripeCheckoutProviderResponse> {
  const keys = stripeKeys(env, mode);
  if (!keys.length) throw new StripeCheckoutSessionError('failed-precondition', `Stripe ${mode} key is not configured.`);
  let providerFailureRacingAbort: unknown;
  let settledProviderStatus: number | undefined;
  const stripeFetch: typeof fetch = async (input, init) => {
    settledProviderStatus = undefined;
    const stripeSignal = init?.signal;
    const combinedSignal = stripeSignal
      ? AbortSignal.any([signal, stripeSignal])
      : signal;
    try {
      combinedSignal.throwIfAborted();
      const response = await raceWithSignal(
        providerFetch(input, { ...init, signal: combinedSignal }),
        combinedSignal,
      );
      settledProviderStatus = response.status;
      return response;
    } catch (error) {
      if (isNestedSignalCancellationError(error, signal)) {
        const cancellation = new Error('Stripe request cancelled');
        Object.defineProperty(cancellation, 'cause', { value: signal.reason });
        throw cancellation;
      }
      if (signal.aborted && providerFailureRacingAbort === undefined) {
        providerFailureRacingAbort = error;
      }
      throw error;
    }
  };
  let lastCredentialError: unknown;
  for (const key of keys) {
    providerFailureRacingAbort = undefined;
    settledProviderStatus = undefined;
    try {
      if (signal.aborted) throw signal.reason;
      const stripe = new Stripe(key, {
        httpClient: Stripe.createFetchHttpClient(stripeFetch),
        maxNetworkRetries: 1,
        timeout: 20_000,
      });
      if (signal.aborted) throw signal.reason;
      const session = await stripe.checkout.sessions.create({
        mode: request.mode,
        automatic_tax: { enabled: request.automaticTax },
        billing_address_collection: request.billingAddressCollection,
        success_url: request.successUrl,
        cancel_url: request.cancelUrl,
        client_reference_id: request.clientReferenceId,
        line_items: [{
          quantity: request.quantity,
          price_data: {
            currency: request.currency,
            unit_amount: request.unitAmountCents,
            tax_behavior: 'exclusive',
            product_data: { name: request.productName, tax_code: request.productTaxCode },
          },
        }],
        metadata: request.metadata,
        shipping_address_collection: { allowed_countries: [...request.allowedCountries] },
      }, { idempotencyKey: request.idempotencyKey });
      const id = typeof session.id === 'string' ? session.id : '';
      const url = typeof session.url === 'string' ? session.url : '';
      if (!/^cs_(?:test|live)_[A-Za-z0-9_]+$/.test(id) || !url) {
        throw new StripeCheckoutSessionError('unavailable', 'Stripe response did not include a checkout URL');
      }
      return { id, url, livemode: Boolean(session.livemode) };
    } catch (error) {
      const settledProviderFailure = settledProviderStatus !== undefined &&
        (settledProviderStatus < 200 || settledProviderStatus >= 300);
      if (
        providerFailureRacingAbort === undefined &&
        !settledProviderFailure &&
        isNestedSignalCancellationError(error, signal)
      ) {
        throw signal.reason;
      }
      if (error instanceof StripeCheckoutSessionError) throw error;
      if (!stripeCredentialError(error)) {
        const record = isRecord(error) ? error : {};
        const raw = isRecord(record.raw) ? record.raw : {};
        console.warn({
          event: 'stripe_checkout_provider_error',
          mode,
          type: String(record.type || record.rawType || record.name || 'StripeProviderError'),
          statusCode: Number(record.statusCode ?? raw.statusCode) || undefined,
          code: typeof record.code === 'string' ? record.code : undefined,
        });
        if (settledProviderStatus === 500) {
          throw new StripeCheckoutOperationUncertainError('Stripe checkout is temporarily unavailable.', error);
        }
        if (stripeSuccessBodyUncertain(error, settledProviderStatus)) {
          throw new StripeCheckoutOperationUncertainError('Stripe checkout is temporarily unavailable.', error);
        }
        if (error instanceof Stripe.errors.StripeConnectionError) {
          throw new StripeCheckoutOperationUncertainError('Stripe checkout is temporarily unavailable.', error);
        }
        throw new StripeCheckoutSessionError('unavailable', 'Stripe checkout is temporarily unavailable.');
      }
      lastCredentialError = error;
    }
  }
  const errorRecord = isRecord(lastCredentialError) ? lastCredentialError : {};
  const raw = isRecord(errorRecord.raw) ? errorRecord.raw : {};
  throw new StripeCheckoutSessionError('failed-precondition', `Stripe ${mode} key was rejected by Stripe.`, {
    mode,
    configuredKeyKinds: keys.map(stripeKeyKind),
    stripeError: {
      type: String(errorRecord.type || errorRecord.rawType || errorRecord.name || 'StripeCredentialError'),
      statusCode: Number(errorRecord.statusCode ?? raw.statusCode) || undefined,
    },
  });
}

async function persistCheckoutDocument(
  path: string,
  document: Record<string, unknown>,
  nowMs: number,
  commerceDb: D1Database,
): Promise<void> {
  const store = createStripeCheckoutStore({ commerceDb, nowMs: () => nowMs });
  const reference = store.doc(path);
  await store.runTransaction(async (transaction) => {
    const existing = await transaction.get(reference);
    if (existing.exists) {
      if (
        existing.get('operationId') === document.operationId &&
        existing.get('sessionId') === document.sessionId &&
        existing.get('dropId') === document.dropId
      ) return;
      throw new StripeCheckoutSessionError('failed-precondition', 'Stripe checkout operation conflicts with an existing session.');
    }
    transaction.create(reference, {
      ...document,
      createdAt: stripeCheckoutFieldValue.serverTimestamp(),
      updatedAt: stripeCheckoutFieldValue.serverTimestamp(),
    });
  });
}

export async function handleStripeCheckoutSession(
  request: Request,
  env: CheckoutEnv,
  overrides: Partial<CheckoutDependencies> = {},
): Promise<StripeCheckoutResult> {
  const dependencies = { ...defaultDependencies, ...overrides };
  const metrics: StripeCheckoutMetrics = { upstreamCalls: 0, providerDurationMs: 0 };
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
    const response = checkoutErrorResponse(new StripeCheckoutSessionError('invalid-argument', 'Method not allowed.'));
    response.headers.set('Allow', 'POST, OPTIONS');
    return { response: new Response(response.body, { headers: response.headers, status: 405 }), metrics, authOutcome: 'rejected' };
  }
  const deadline = createRequestDeadline(request, {
    timeoutMs: dependencies.timeoutMs,
    timeoutMessage: 'Checkout request timed out',
  });
  let identity: RequestIdentity | undefined;
  try {
    const body = await readBoundedRequestJson(request, {
      maxBytes: CHECKOUT_REQUEST_MAX_BYTES,
      signal: deadline.signal,
      createError: (failure) => new StripeCheckoutSessionError(
        'invalid-argument',
        failure === 'unsupported-media-type'
          ? 'Content-Type must be application/json.'
          : failure === 'too-large'
            ? 'Checkout request is too large.'
            : 'Invalid checkout request.',
      ),
    });
    identity = await dependencies.verifyIdentity(
      request,
      env.OPS_DB,
      deadline.signal,
      dependencies.nowMs(),
    );
    const heliusApiKey = String(env.HELIUS_API_KEY || '').trim();
    if (!heliusApiKey) {
      throw new StripeCheckoutSessionError('unavailable', 'Stripe checkout is temporarily unavailable.');
    }
    const resolvedWallet = identity.kind === 'staff-wallet'
      ? identity.wallet
      : env.OPS_DB
        ? (await raceReadWithSignal(
            dependencies.resolveAuthWalletBinding(
              env.OPS_DB,
              identity.authSubject,
              deadline.signal,
            ),
            deadline.signal,
          )).wallet
        : null;
    const result = await createStripeCheckoutSessionCore({
      identity: createStripeCheckoutIdentity(
        identity.kind === 'staff-wallet' ? identity.wallet : identity.authSubject,
        resolvedWallet || undefined,
      ),
      requestOrigin: request.headers.get('Origin') || undefined,
      allowedOrigins: request.headers.get('Origin') ? [request.headers.get('Origin')!] : [],
      body,
      operationId: request.headers.get(STRIPE_CHECKOUT_OPERATION_HEADER) || undefined,
    }, {
      getDrop: dependencies.getDrop || checkoutDrop,
      loadOnchainConfig: dependencies.loadOnchainConfig ||
        ((drop) => fetchOnchainConfig(drop, heliusApiKey, trackedFetch, deadline.signal)),
      requireFulfillmentPrerequisites: dependencies.requireFulfillmentPrerequisites ||
        ((config) => requireFulfillmentPrerequisites(env, config)),
      createProviderSession: (providerRequest, mode) =>
        (dependencies.createProviderSession || createStripeProviderSession)(
          providerRequest,
          mode,
          env,
          trackedFetch,
          deadline.signal,
        ),
      persistCheckout: (path, document) => {
        return runCriticalRequestOperation(
          () => dependencies.persistCheckout
            ? dependencies.persistCheckout(path, document)
            : persistCheckoutDocument(
                path,
                document,
                dependencies.nowMs(),
                env.COMMERCE_DB,
              ),
          { deadline, defer: dependencies.defer },
        );
      },
      nowMs: dependencies.nowMs,
    });
    return {
      response: jsonResponse(result.session, 200),
      metrics,
      authOutcome: 'accepted',
      dropId: result.dropId,
      mode: result.mode,
    };
  } catch (error) {
    rethrowDeferredWorkRegistrationError(error);
    if (isRequestCancellationError(request, error)) throw error;
    if (error instanceof RequestIdentityError) {
      if (error.kind === 'invalid-token') {
        return {
          response: jsonResponse(apiErrorBody({
            code: 'unauthenticated',
            message: 'Authentication is required.',
          }), 401),
          metrics,
          authOutcome: 'rejected',
        };
      }
      const checkoutError = error.kind === 'provider-timeout'
        ? new StripeCheckoutSessionError('deadline-exceeded', 'Checkout request timed out.')
        : new StripeCheckoutSessionError('unavailable', 'Authentication is temporarily unavailable.');
      return { response: checkoutErrorResponse(checkoutError), metrics, authOutcome: 'provider-failure' };
    }
    if (deadline.timedOut()) {
      return {
        response: checkoutErrorResponse(
          new StripeCheckoutSessionError('deadline-exceeded', 'Checkout request timed out.'),
          true,
        ),
        metrics,
        authOutcome: identity ? 'provider-failure' : 'rejected',
      };
    }
    if (error instanceof StripeCheckoutOperationUncertainError) {
      return {
        response: checkoutErrorResponse(error, true),
        metrics,
        authOutcome: 'provider-failure',
      };
    }
    if (error instanceof StripeCheckoutSessionError) {
      return {
        response: checkoutErrorResponse(error),
        metrics,
        authOutcome: error.code === 'invalid-argument' || error.code === 'failed-precondition'
          ? 'rejected'
          : 'provider-failure',
      };
    }
    if (error instanceof ProfileReadError) {
      return {
        response: checkoutErrorResponse(new StripeCheckoutSessionError('unavailable', 'Stripe checkout is temporarily unavailable.')),
        metrics,
        authOutcome: 'provider-failure',
      };
    }
    return {
      response: checkoutErrorResponse(new StripeCheckoutSessionError('internal', 'Stripe checkout failed.')),
      metrics,
      authOutcome: 'provider-failure',
    };
  } finally {
    deadline.dispose();
  }
}
