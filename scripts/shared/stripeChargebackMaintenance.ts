import { fileURLToPath } from 'node:url';
import type { GetPlatformProxyOptions } from 'wrangler';
import type { StripeChargebackBackfillRequest, StripeChargebackMode } from '../../shared/stripeChargebacks.ts';

type WebhookRequest = { mode: StripeChargebackMode; write: boolean };
type MaintenanceBinding = {
  backfill: (request: StripeChargebackBackfillRequest) => Promise<unknown>;
  configureWebhooks: (request: WebhookRequest) => Promise<unknown>;
};
type MaintenanceProxy = {
  env: { CHARGEBACKS: MaintenanceBinding };
  dispose: () => Promise<void>;
};
type ProxyFactory = (options: GetPlatformProxyOptions) => Promise<MaintenanceProxy>;
export type StripeChargebackMaintenanceTransport = {
  backfill: (request: StripeChargebackBackfillRequest) => Promise<Response>;
  configureWebhooks: (request: WebhookRequest) => Promise<Response>;
};

const RETRYABLE_CODES = new Set([
  'stripe-unavailable',
  'stripe-request-timeout',
  'stripe-network-error',
  'chargeback-storage-unavailable',
  'chargeback-order-pending',
  'chargeback-unavailable',
  'commerce-maintenance',
  'deadline-exceeded',
  'unavailable',
]);
const SAFE_CODES = new Set([
  ...RETRYABLE_CODES,
  'stripe-invalid-response',
  'stripe-api-version-unsupported',
  'stripe-redirect-rejected',
  'stripe-not-configured',
  'stripe-credentials-rejected',
  'stripe-webhook-invalid-response',
  'stripe-webhook-verification-failed',
  'stripe-webhook-not-active',
  'chargeback-identity-conflict',
  'invalid-dispute',
  'invalid-argument',
]);

export class StripeChargebackMaintenanceConnectionError extends Error {}

export function isRetryableStripeChargebackFailureCode(code: string): boolean {
  if (RETRYABLE_CODES.has(code)) return true;
  const status = /^stripe-http-([45]\d{2})$/.exec(code)?.[1];
  return status !== undefined && (Number(status) >= 500 || status === '408' || status === '429');
}

function isSafeFailureCode(code: string): boolean {
  return SAFE_CODES.has(code) || /^stripe-http-[45]\d{2}$/.test(code);
}

function failureResponse(retryable: boolean, code?: string): Response {
  return Response.json({ ok: false }, {
    status: retryable ? 503 : 400,
    ...(code && isSafeFailureCode(code) ? { headers: { 'X-Mons-Maintenance-Error': code } } : {}),
  });
}

export function stripeChargebackMaintenanceFailureCode(response: Response): string | undefined {
  const code = response.headers.get('X-Mons-Maintenance-Error');
  return code && isSafeFailureCode(code) ? code : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function defaultProxyFactory(options: GetPlatformProxyOptions): Promise<MaintenanceProxy> {
  const { getPlatformProxy } = await import('wrangler');
  return getPlatformProxy<{ CHARGEBACKS: MaintenanceBinding }>(options);
}

export async function withStripeChargebackMaintenance<T>(
  run: (transport: StripeChargebackMaintenanceTransport) => Promise<T>,
  createProxy: ProxyFactory = defaultProxyFactory,
): Promise<T> {
  let proxy: MaintenanceProxy;
  try {
    proxy = await createProxy({
      configPath: fileURLToPath(new URL('../ops/stripe-chargebacks.wrangler.jsonc', import.meta.url)),
      envFiles: [],
      persist: false,
      remoteBindings: true,
    });
  } catch {
    throw new StripeChargebackMaintenanceConnectionError('Unable to connect to Cloudflare maintenance. Check existing Wrangler authentication and Workers permissions.');
  }
  async function call(operation: () => Promise<unknown>): Promise<Response> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Cloudflare maintenance request timed out.')), 60_000);
      });
      const result = await Promise.race([operation(), deadline]);
      if (isRecord(result) && result.ok === false) {
        const error = result.error;
        if (!isRecord(error) || !Number.isInteger(error.status) || Number(error.status) < 400 || Number(error.status) > 599) return failureResponse(false);
        const code = typeof error.code === 'string' ? error.code : undefined;
        return failureResponse(Boolean(code && isRetryableStripeChargebackFailureCode(code)), code);
      }
      if (!isRecord(result)) return failureResponse(false);
      return Response.json({ ...result, ok: true });
    } catch {
      return failureResponse(true);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
  try {
    return await run({
      backfill: (request) => call(() => proxy.env.CHARGEBACKS.backfill(request)),
      configureWebhooks: (request) => call(() => proxy.env.CHARGEBACKS.configureWebhooks(request)),
    });
  } finally {
    try {
      await proxy.dispose();
    } catch {
      throw new StripeChargebackMaintenanceConnectionError('Cloudflare maintenance cleanup failed. Stop this process before retrying.');
    }
  }
}
