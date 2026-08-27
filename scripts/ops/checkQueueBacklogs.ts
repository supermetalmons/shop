import { pathToFileURL } from 'node:url';

const ACCOUNT_ID = 'e25f90fc073ea309b54b8b5144bf28e0';
const API_BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/queues`;
const REQUIRED_QUEUES = [
  'mons-shop-notification-emails',
  'mons-shop-notification-emails-dlq',
  'mons-shop-reveal-reconciliation',
  'mons-shop-reveal-reconciliation-dlq',
  'mons-shop-stripe-fulfillment',
  'mons-shop-stripe-fulfillment-dlq',
] as const;

type CloudflareEnvelope = {
  result?: unknown;
  result_info?: unknown;
  success?: unknown;
};

function fail(message: string): never {
  throw new Error(message);
}

async function cloudflareEnvelope(
  url: string,
  token: string,
  providerFetch: typeof fetch,
): Promise<CloudflareEnvelope> {
  const response = await providerFetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const payload = await response.json().catch(() => null) as CloudflareEnvelope | null;
  if (!response.ok || payload?.success !== true) fail('Cloudflare Queue metrics request failed.');
  return payload;
}

async function cloudflareResult(url: string, token: string, providerFetch: typeof fetch): Promise<unknown> {
  return (await cloudflareEnvelope(url, token, providerFetch)).result;
}

export async function checkQueueBacklogs(
  token = String(process.env.CLOUDFLARE_API_TOKEN || '').trim(),
  providerFetch: typeof fetch = fetch,
): Promise<Record<string, { backlogBytes: number; backlogCount: number; oldestMessageTimestampMs: number }>> {
  if (!token) fail('CLOUDFLARE_API_TOKEN is required.');
  const listed: unknown[] = [];
  let totalPages = 1;
  for (let page = 1; page <= totalPages; page += 1) {
    const payload = await cloudflareEnvelope(`${API_BASE}?page=${page}&per_page=100`, token, providerFetch);
    if (!Array.isArray(payload.result) || !payload.result_info ||
      typeof payload.result_info !== 'object' || Array.isArray(payload.result_info)) {
      fail('Cloudflare Queue inventory is invalid.');
    }
    const info = payload.result_info as Record<string, unknown>;
    const responsePage = Number(info.page);
    const responseTotalPages = Number(info.total_pages);
    if (responsePage !== page || !Number.isSafeInteger(responseTotalPages) ||
      responseTotalPages < page || responseTotalPages > 1000 ||
      (page > 1 && responseTotalPages !== totalPages)) {
      fail('Cloudflare Queue inventory pagination is invalid.');
    }
    totalPages = responseTotalPages;
    listed.push(...payload.result);
  }
  const queues = new Map(listed.flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const row = value as Record<string, unknown>;
    return typeof row.queue_name === 'string' && typeof row.queue_id === 'string'
      ? [[row.queue_name, row.queue_id] as const]
      : [];
  }));
  const report: Record<string, { backlogBytes: number; backlogCount: number; oldestMessageTimestampMs: number }> = {};
  for (const name of REQUIRED_QUEUES) {
    const id = queues.get(name);
    if (!id) fail(`Required Queue is missing: ${name}.`);
    const value = await cloudflareResult(`${API_BASE}/${id}/metrics`, token, providerFetch);
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} metrics are invalid.`);
    const row = value as Record<string, unknown>;
    const backlogCount = Number(row.backlog_count);
    const backlogBytes = Number(row.backlog_bytes);
    const oldestMessageTimestampMs = Number(row.oldest_message_timestamp_ms);
    if (
      !Number.isSafeInteger(backlogCount) || backlogCount < 0 ||
      !Number.isSafeInteger(backlogBytes) || backlogBytes < 0 ||
      !Number.isSafeInteger(oldestMessageTimestampMs) || oldestMessageTimestampMs < 0
    ) fail(`${name} metrics are invalid.`);
    if (backlogCount !== 0 || backlogBytes !== 0) fail(`${name} backlog is not empty.`);
    report[name] = { backlogBytes, backlogCount, oldestMessageTimestampMs };
  }
  return report;
}

async function main(): Promise<void> {
  console.log(JSON.stringify(await checkQueueBacklogs(), null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) await main();
