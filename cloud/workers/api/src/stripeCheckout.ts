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
  StripeCheckoutSessionError,
  createStripeCheckoutIdentity,
  createStripeCheckoutSessionCore,
  type StripeCheckoutOnchainConfig,
  type StripeCheckoutProviderRequest,
  type StripeCheckoutProviderResponse,
  type StripeCheckoutSessionDrop,
} from '../../../../shared/stripeCheckoutSession.js';
import type { StripeCheckoutMode } from '../../../../shared/stripeCheckoutCore.js';
import {
  RequestIdentityError,
  verifyRequestIdentity,
  type RequestIdentity,
} from './requestIdentity.js';
import { resolveD1AuthWalletBinding } from './authWalletBindingD1.js';
import {
  cancelResponseBody,
  readBoundedJson,
  type ProfileProviderFetch,
} from './boundedResponse.js';
import { isRecord, ProfileReadError } from './dataAccess.js';
import { createStripeCheckoutStore, stripeCheckoutFieldValue } from './stripeCheckout/store.js';

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
  nowMs: () => number;
  providerFetch: ProfileProviderFetch;
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
  nowMs: () => Date.now(),
  providerFetch: (input, init) => fetch(input, init),
  resolveAuthWalletBinding: resolveD1AuthWalletBinding,
  verifyIdentity: verifyRequestIdentity,
};

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

function checkoutErrorResponse(error: StripeCheckoutSessionError): Response {
  const status = error.code === 'invalid-argument'
    ? 400
    : error.code === 'failed-precondition'
      ? 409
      : error.code === 'deadline-exceeded'
        ? 504
        : error.code === 'unavailable'
          ? 502
          : 500;
  return jsonResponse({
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  }, status);
}

async function readBoundedRequestJson(request: Request, signal: AbortSignal): Promise<unknown> {
  const contentType = String(request.headers.get('Content-Type') || '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    await request.body?.cancel().catch(() => undefined);
    throw new StripeCheckoutSessionError('invalid-argument', 'Content-Type must be application/json.');
  }
  const contentLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(contentLength) && contentLength > CHECKOUT_REQUEST_MAX_BYTES) {
    await request.body?.cancel().catch(() => undefined);
    throw new StripeCheckoutSessionError('invalid-argument', 'Checkout request is too large.');
  }
  if (!request.body) throw new StripeCheckoutSessionError('invalid-argument', 'Invalid checkout request.');
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const chunks: string[] = [];
  let size = 0;
  const onAbort = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > CHECKOUT_REQUEST_MAX_BYTES) throw new StripeCheckoutSessionError('invalid-argument', 'Checkout request is too large.');
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return JSON.parse(chunks.join(''));
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    if (error instanceof StripeCheckoutSessionError) throw error;
    if (signal.aborted) throw signal.reason;
    throw new StripeCheckoutSessionError('invalid-argument', 'Invalid checkout request.');
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
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

function heliusRpcOrigin(cluster: StripeCheckoutSessionDrop['solanaCluster']): string {
  return `https://${cluster === 'mainnet-beta' ? 'mainnet' : cluster}.helius-rpc.com/`;
}

async function pause(signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const timeout = setTimeout(finish, 100);
    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

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
  const requestBody = JSON.stringify({
    jsonrpc: '2.0',
    id: 'stripe-checkout-config',
    method: 'getAccountInfo',
    params: [configPda, { commitment: 'confirmed', encoding: 'base64' }],
  });
  let response: Response | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      response = await providerFetch(`${heliusRpcOrigin(drop.solanaCluster)}?api-key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: requestBody,
        signal,
      });
    } catch {
      if (signal.aborted) throw signal.reason;
      if (attempt === 0) {
        await pause(signal);
        continue;
      }
      throw new StripeCheckoutSessionError('unavailable', 'On-chain checkout configuration is temporarily unavailable.');
    }
    if (TRANSIENT_HTTP_STATUSES.has(response.status) && attempt === 0) {
      await cancelResponseBody(response);
      await pause(signal);
      continue;
    }
    break;
  }
  if (!response?.ok) {
    if (response) await cancelResponseBody(response);
    throw new StripeCheckoutSessionError('unavailable', 'On-chain checkout configuration is temporarily unavailable.');
  }
  const payload = await readBoundedJson(response, CHECKOUT_PROVIDER_MAX_BYTES, signal);
  if (!isRecord(payload) || payload.jsonrpc !== '2.0' || payload.id !== 'stripe-checkout-config') {
    throw new StripeCheckoutSessionError('unavailable', 'On-chain checkout configuration returned an invalid response.');
  }
  if (payload.error) throw new StripeCheckoutSessionError('unavailable', 'On-chain checkout configuration is temporarily unavailable.');
  if (!isRecord(payload.result)) {
    throw new StripeCheckoutSessionError('unavailable', 'On-chain checkout configuration returned an invalid response.');
  }
  const value = payload.result.value;
  if (!isRecord(value) || value.owner !== drop.boxMinterProgramId || !Array.isArray(value.data)) {
    throw new StripeCheckoutSessionError('failed-precondition', 'Box minter config PDA is invalid.');
  }
  const encoded = value.data[0];
  const encoding = value.data[1];
  if (typeof encoded !== 'string' || encoding !== 'base64' || encoded.length > CHECKOUT_PROVIDER_MAX_BYTES) {
    throw new StripeCheckoutSessionError('unavailable', 'On-chain checkout configuration returned invalid data.');
  }
  let decoded;
  try {
    decoded = decodeBoxMinterConfigData(Buffer.from(encoded, 'base64'), { validateDiscriminator: true });
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

function requireFulfillmentPrerequisites(env: CheckoutEnv, config: StripeCheckoutOnchainConfig): void {
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

function stripeKeys(env: CheckoutEnv, mode: StripeCheckoutMode): string[] {
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

async function createStripeProviderSession(
  request: StripeCheckoutProviderRequest,
  mode: StripeCheckoutMode,
  env: CheckoutEnv,
  _providerFetch: ProfileProviderFetch,
  signal: AbortSignal,
): Promise<StripeCheckoutProviderResponse> {
  const keys = stripeKeys(env, mode);
  if (!keys.length) throw new StripeCheckoutSessionError('failed-precondition', `Stripe ${mode} key is not configured.`);
  let lastCredentialError: unknown;
  for (const key of keys) {
    try {
      if (signal.aborted) throw signal.reason;
      const stripe = new Stripe(key, {
        httpClient: Stripe.createFetchHttpClient(),
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
      });
      const id = typeof session.id === 'string' ? session.id : '';
      const url = typeof session.url === 'string' ? session.url : '';
      if (!/^cs_(?:test|live)_[A-Za-z0-9_]+$/.test(id) || !url) {
        throw new StripeCheckoutSessionError('unavailable', 'Stripe response did not include a checkout URL');
      }
      return { id, url, livemode: Boolean(session.livemode) };
    } catch (error) {
      if (error instanceof StripeCheckoutSessionError) throw error;
      if (!stripeCredentialError(error)) {
        if (signal.aborted) throw signal.reason;
        const record = isRecord(error) ? error : {};
        const raw = isRecord(record.raw) ? record.raw : {};
        console.warn({
          event: 'stripe_checkout_provider_error',
          mode,
          type: String(record.type || record.rawType || record.name || 'StripeProviderError'),
          statusCode: Number(record.statusCode ?? raw.statusCode) || undefined,
          code: typeof record.code === 'string' ? record.code : undefined,
        });
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
    transaction.set(reference, {
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
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException('Checkout request timed out', 'TimeoutError')),
    CHECKOUT_TIMEOUT_MS,
  );
  let identity: RequestIdentity | undefined;
  try {
    const body = await readBoundedRequestJson(request, controller.signal);
    identity = await dependencies.verifyIdentity(
      request,
      env.OPS_DB,
      controller.signal,
      dependencies.nowMs(),
    );
    const heliusApiKey = String(env.HELIUS_API_KEY || '').trim();
    if (!heliusApiKey) {
      throw new StripeCheckoutSessionError('unavailable', 'Stripe checkout is temporarily unavailable.');
    }
    const resolvedWallet = identity.kind === 'staff-wallet'
      ? identity.wallet
      : env.OPS_DB
        ? (await dependencies.resolveAuthWalletBinding(
            env.OPS_DB,
            identity.authSubject,
            controller.signal,
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
    }, {
      getDrop: dependencies.getDrop || checkoutDrop,
      loadOnchainConfig: dependencies.loadOnchainConfig ||
        ((drop) => fetchOnchainConfig(drop, heliusApiKey, trackedFetch, controller.signal)),
      requireFulfillmentPrerequisites: dependencies.requireFulfillmentPrerequisites ||
        ((config) => requireFulfillmentPrerequisites(env, config)),
      createProviderSession: (providerRequest, mode) =>
        (async () => {
          const startedAt = performance.now();
          metrics.upstreamCalls += 1;
          try {
            return await (dependencies.createProviderSession || createStripeProviderSession)(
              providerRequest,
              mode,
              env,
              trackedFetch,
              controller.signal,
            );
          } finally {
            metrics.providerDurationMs += Math.max(0, performance.now() - startedAt);
          }
        })(),
      persistCheckout: dependencies.persistCheckout ||
        ((path, document) => persistCheckoutDocument(
          path,
          document,
          dependencies.nowMs(),
          env.COMMERCE_DB,
        )),
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
    if (error instanceof RequestIdentityError) {
      if (error.kind === 'invalid-token') {
        return {
          response: jsonResponse({ ok: false, error: { code: 'unauthenticated', message: 'Authentication is required.' } }, 401),
          metrics,
          authOutcome: 'rejected',
        };
      }
      const checkoutError = error.kind === 'provider-timeout'
        ? new StripeCheckoutSessionError('deadline-exceeded', 'Checkout request timed out.')
        : new StripeCheckoutSessionError('unavailable', 'Authentication is temporarily unavailable.');
      return { response: checkoutErrorResponse(checkoutError), metrics, authOutcome: 'provider-failure' };
    }
    if (controller.signal.aborted) {
      return {
        response: checkoutErrorResponse(new StripeCheckoutSessionError('deadline-exceeded', 'Checkout request timed out.')),
        metrics,
        authOutcome: identity ? 'provider-failure' : 'rejected',
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
    clearTimeout(timeout);
  }
}

export const stripeCheckoutTestHooks = {
  checkoutDrop,
  createStripeProviderSession,
  fetchOnchainConfig,
  persistCheckoutDocument,
  requireFulfillmentPrerequisites,
  stripeKeys,
};
