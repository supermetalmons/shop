import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseConfigFileTextToJson } from 'typescript';

const CLOUDFLARE_API_ORIGIN = 'https://api.cloudflare.com/client/v4';
const DEFAULT_CONFIG_PATH = fileURLToPath(
  new URL('../../cloud/workers/api/wrangler.jsonc', import.meta.url),
);
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/i;
const QUEUE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const QUEUE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CLOUDFLARE_QUEUE_REQUEST_TIMEOUT_MS = 30_000;
const CLOUDFLARE_QUEUE_INVENTORY_MAX_PAGES = 5;
const CLOUDFLARE_QUEUE_MAINTENANCE_MAX_QUEUES = 8;

type CloudflareEnvelope = {
  result?: unknown;
  result_info?: unknown;
  success?: unknown;
};

export type CloudflareQueueMaintenanceConfig = {
  accountId: string;
  queueNames: string[];
};

export type CloudflareQueueDeliveryState = {
  id: string;
  name: string;
  deliveryPaused: boolean;
};

export type CloudflareQueueMaintenanceClient = {
  listDeliveryStates(): Promise<CloudflareQueueDeliveryState[]>;
  setDeliveryPaused(
    queue: CloudflareQueueDeliveryState,
    deliveryPaused: boolean,
  ): Promise<CloudflareQueueDeliveryState>;
};

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function queueName(value: unknown): string {
  if (typeof value !== 'string' || !QUEUE_NAME_PATTERN.test(value)) {
    return fail('Cloudflare Queue configuration contains an invalid queue name.');
  }
  return value;
}

export function parseCloudflareQueueMaintenanceConfig(
  value: unknown,
): CloudflareQueueMaintenanceConfig {
  if (!isRecord(value) || typeof value.account_id !== 'string' || !ACCOUNT_ID_PATTERN.test(value.account_id)) {
    return fail('Cloudflare Worker configuration contains an invalid account_id.');
  }
  if (!isRecord(value.queues) ||
    !Array.isArray(value.queues.consumers) || value.queues.consumers.length === 0) {
    return fail('Cloudflare Worker configuration contains no Queue consumers.');
  }
  const consumerNames = value.queues.consumers.map((consumer) => {
    if (!isRecord(consumer)) return fail('Cloudflare Worker Queue consumer configuration is invalid.');
    return queueName(consumer.queue);
  });
  if (new Set(consumerNames).size !== consumerNames.length) {
    return fail('Cloudflare Worker Queue consumer names must be unique.');
  }
  if (consumerNames.length > CLOUDFLARE_QUEUE_MAINTENANCE_MAX_QUEUES) {
    return fail('Cloudflare Worker configuration contains too many Queue consumers.');
  }
  return { accountId: value.account_id, queueNames: consumerNames };
}

export function readCloudflareQueueMaintenanceConfig(
  configPath = DEFAULT_CONFIG_PATH,
): CloudflareQueueMaintenanceConfig {
  let source: string;
  try {
    source = readFileSync(configPath, 'utf8');
  } catch {
    return fail('Cloudflare Worker configuration could not be read.');
  }
  const parsed = parseConfigFileTextToJson(configPath, source);
  if (parsed.error || parsed.config === undefined) {
    return fail('Cloudflare Worker configuration could not be read.');
  }
  return parseCloudflareQueueMaintenanceConfig(parsed.config);
}

function queueResource(value: unknown): CloudflareQueueDeliveryState {
  if (!isRecord(value) ||
    typeof value.queue_id !== 'string' || !QUEUE_ID_PATTERN.test(value.queue_id) ||
    typeof value.queue_name !== 'string' || !QUEUE_NAME_PATTERN.test(value.queue_name) ||
    !isRecord(value.settings) ||
    (value.settings.delivery_paused !== undefined && typeof value.settings.delivery_paused !== 'boolean')) {
    return fail('Cloudflare Queue response is invalid.');
  }
  return {
    id: value.queue_id,
    name: value.queue_name,
    deliveryPaused: value.settings.delivery_paused === true,
  };
}

function resultInfo(value: unknown, expectedPage: number): number {
  if (!isRecord(value)) return fail('Cloudflare Queue inventory pagination is invalid.');
  const page = Number(value.page);
  const totalPages = Number(value.total_pages);
  if (
    page !== expectedPage ||
    !Number.isSafeInteger(totalPages) ||
    totalPages < expectedPage ||
    totalPages > CLOUDFLARE_QUEUE_INVENTORY_MAX_PAGES
  ) return fail('Cloudflare Queue inventory pagination is invalid.');
  return totalPages;
}

export function createCloudflareQueueMaintenanceClient(args: {
  config: CloudflareQueueMaintenanceConfig;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): CloudflareQueueMaintenanceClient {
  const token = args.token.trim();
  if (!token) fail('CLOUDFLARE_API_TOKEN is required.');
  const providerFetch = args.fetch || fetch;
  const timeoutMs = args.timeoutMs ?? CLOUDFLARE_QUEUE_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) fail('Cloudflare Queue request timeout is invalid.');
  const accountUrl = `${CLOUDFLARE_API_ORIGIN}/accounts/${encodeURIComponent(args.config.accountId)}/queues`;

  const request = async (
    url: string,
    init: RequestInit,
    operation: string,
  ): Promise<CloudflareEnvelope> => {
    let response: Response;
    try {
      const headers = new Headers(init.headers);
      headers.set('Authorization', `Bearer ${token}`);
      response = await providerFetch(url, {
        ...init,
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return fail(`Cloudflare Queue ${operation} failed.`);
    }
    const payload = await response.json().catch(() => null) as CloudflareEnvelope | null;
    if (!response.ok || !payload || payload.success !== true) {
      return fail(`Cloudflare Queue ${operation} failed with status ${response.status}.`);
    }
    return payload;
  };

  return {
    async listDeliveryStates(): Promise<CloudflareQueueDeliveryState[]> {
      const found = new Map<string, CloudflareQueueDeliveryState>();
      let totalPages = 1;
      for (let page = 1; page <= totalPages; page += 1) {
        const payload = await request(
          `${accountUrl}?page=${page}&per_page=100`,
          { method: 'GET' },
          'inventory request',
        );
        if (!Array.isArray(payload.result)) return fail('Cloudflare Queue inventory is invalid.');
        totalPages = resultInfo(payload.result_info, page);
        for (const value of payload.result) {
          const queue = queueResource(value);
          if (found.has(queue.name)) return fail(`Cloudflare Queue inventory duplicated ${queue.name}.`);
          found.set(queue.name, queue);
        }
      }
      return args.config.queueNames.map((name) => {
        const queue = found.get(name);
        if (!queue) return fail(`Required Cloudflare Queue is missing: ${name}.`);
        return queue;
      });
    },

    async setDeliveryPaused(
      queue: CloudflareQueueDeliveryState,
      deliveryPaused: boolean,
    ): Promise<CloudflareQueueDeliveryState> {
      const payload = await request(
        `${accountUrl}/${encodeURIComponent(queue.id)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ settings: { delivery_paused: deliveryPaused } }),
        },
        `${deliveryPaused ? 'pause' : 'resume'} request for ${queue.name}`,
      );
      const updated = queueResource(payload.result);
      if (
        updated.id !== queue.id ||
        updated.name !== queue.name ||
        updated.deliveryPaused !== deliveryPaused
      ) return fail(`Cloudflare Queue ${queue.name} returned an unexpected delivery state.`);
      return updated;
    },
  };
}
