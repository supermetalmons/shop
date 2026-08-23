export const NOTIFICATION_ENQUEUE_PATH = '/internal/notifications/enqueue';
export const NOTIFICATION_ENQUEUE_TIMESTAMP_HEADER = 'X-Mons-Notification-Timestamp';
export const NOTIFICATION_ENQUEUE_SIGNATURE_HEADER = 'X-Mons-Notification-Signature';
export const NOTIFICATION_ENQUEUE_MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

const UTF8 = new TextEncoder();
const SIGNATURE_PATTERN = /^v1=([0-9a-f]{64})$/i;

function canonicalNotificationEnqueuePayload(
  timestamp: string,
  method: string,
  pathname: string,
  body: string,
): Uint8Array<ArrayBuffer> {
  return UTF8.encode(`${timestamp}\n${method.toUpperCase()}\n${pathname}\n${body}`);
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[0-9a-f]+$/i.test(value) || value.length % 2 !== 0) return null;
  const result = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    result[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return result;
}

async function hmacKey(secret: string, usage: KeyUsage): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', UTF8.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

export function notificationEnqueueTimestamp(nowMs = Date.now()): string {
  return String(Math.floor(nowMs / 1000));
}

export async function signNotificationEnqueueRequest(args: {
  secret: string;
  timestamp: string;
  method?: string;
  pathname?: string;
  body: string;
}): Promise<string> {
  if (!args.secret) throw new Error('Notification enqueue secret is required');
  const signature = await crypto.subtle.sign(
    'HMAC',
    await hmacKey(args.secret, 'sign'),
    canonicalNotificationEnqueuePayload(
      args.timestamp,
      args.method || 'POST',
      args.pathname || NOTIFICATION_ENQUEUE_PATH,
      args.body,
    ),
  );
  return `v1=${bytesToHex(signature)}`;
}

export async function verifyNotificationEnqueueRequest(args: {
  secret: string;
  timestamp: string | null;
  signature: string | null;
  method: string;
  pathname: string;
  body: string;
  nowMs?: number;
  maxClockSkewMs?: number;
}): Promise<boolean> {
  if (!args.secret || !args.timestamp || !args.signature || !/^\d{10}$/.test(args.timestamp)) return false;
  const timestampMs = Number(args.timestamp) * 1000;
  const nowMs = args.nowMs ?? Date.now();
  const maxClockSkewMs = args.maxClockSkewMs ?? NOTIFICATION_ENQUEUE_MAX_CLOCK_SKEW_MS;
  if (!Number.isSafeInteger(timestampMs) || Math.abs(nowMs - timestampMs) > maxClockSkewMs) return false;
  const signatureMatch = args.signature.match(SIGNATURE_PATTERN);
  const signatureBytes = signatureMatch ? hexToBytes(signatureMatch[1]) : null;
  if (!signatureBytes) return false;
  try {
    return await crypto.subtle.verify(
      'HMAC',
      await hmacKey(args.secret, 'verify'),
      signatureBytes,
      canonicalNotificationEnqueuePayload(args.timestamp, args.method, args.pathname, args.body),
    );
  } catch {
    return false;
  }
}
