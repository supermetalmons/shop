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
  success?: unknown;
};

function fail(message: string): never {
  throw new Error(message);
}

async function cloudflareJson(url: string, token: string, providerFetch: typeof fetch): Promise<unknown> {
  const response = await providerFetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const payload = await response.json().catch(() => null) as CloudflareEnvelope | null;
  if (!response.ok || payload?.success !== true) fail('Cloudflare Queue metrics request failed.');
  return payload.result;
}

export async function checkQueueBacklogs(
  token = String(process.env.CLOUDFLARE_API_TOKEN || '').trim(),
  providerFetch: typeof fetch = fetch,
): Promise<Record<string, { backlogBytes: number; backlogCount: number; oldestMessageTimestampMs: number }>> {
  if (!token) fail('CLOUDFLARE_API_TOKEN is required.');
  const listed = await cloudflareJson(API_BASE, token, providerFetch);
  if (!Array.isArray(listed)) fail('Cloudflare Queue inventory is invalid.');
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
    const value = await cloudflareJson(`${API_BASE}/${id}/metrics`, token, providerFetch);
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
