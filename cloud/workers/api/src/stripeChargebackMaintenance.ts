import { WorkerEntrypoint } from 'cloudflare:workers';
import type {
  StripeChargebackBackfillResult,
  StripeChargebackMaintenanceErrorResult,
  StripeChargebackWebhookConfigurationResult,
} from '../../../../shared/stripeChargebacks.js';
import { raceWithSignal } from './boundedRequest.js';
import { loadCommerceAuthorityControl } from './commerceRepository.js';
import {
  stripeChargebackBackfillRequestSchema,
  stripeChargebackWebhookConfigurationRequestSchema,
} from './stripeChargebackRequests.js';
import { backfillStripeChargebacks, StripeChargebackError } from './stripeChargebacks.js';
import { configureStripeChargebackWebhooks } from './stripeChargebackWebhooks.js';

export class StripeChargebackMaintenance extends WorkerEntrypoint<Env> {
  async backfill(value: unknown): Promise<StripeChargebackBackfillResult | StripeChargebackMaintenanceErrorResult> {
    const request = stripeChargebackBackfillRequestSchema.safeParse(value);
    if (!request.success) return { ok: false, error: { code: 'invalid-argument', status: 400 } };
    return this.#run((signal) => backfillStripeChargebacks(request.data, this.env, { signal }));
  }

  async configureWebhooks(value: unknown): Promise<StripeChargebackWebhookConfigurationResult | StripeChargebackMaintenanceErrorResult> {
    const request = stripeChargebackWebhookConfigurationRequestSchema.safeParse(value);
    if (!request.success) return { ok: false, error: { code: 'invalid-argument', status: 400 } };
    return this.#run((signal) => configureStripeChargebackWebhooks(request.data, this.env, { signal }));
  }

  async #run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T | StripeChargebackMaintenanceErrorResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new DOMException('Maintenance timed out', 'TimeoutError')), 55_000);
    try {
      const authority = await raceWithSignal(loadCommerceAuthorityControl(this.env.COMMERCE_DB), controller.signal);
      if (authority.state === 'paused') return { ok: false, error: { code: 'commerce-maintenance', status: 503 } };
      const pending = operation(controller.signal);
      this.ctx.waitUntil(pending.then(() => undefined, () => undefined));
      return await raceWithSignal(pending, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) return { ok: false, error: { code: 'deadline-exceeded', status: 504 } };
      if (error instanceof StripeChargebackError) return { ok: false, error: { code: error.code, status: error.status } };
      return { ok: false, error: { code: 'unavailable', status: 503 } };
    } finally {
      clearTimeout(timeout);
    }
  }
}
