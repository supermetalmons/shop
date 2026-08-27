export const PUBLIC_RATE_LIMITS = Object.freeze({
  notification: 60,
  rpcRead: 5_000,
  rpcWrite: 500,
  shop: 600,
});

const PUBLIC_RATE_LIMIT_PERIOD_SECONDS = 60;
const PUBLIC_RATE_LIMIT_LOG_SAMPLE_DENOMINATOR = 100;

export function isAllowedPublicOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) return false;
  if (url.protocol === 'https:' && (url.hostname === 'mons.shop' || url.hostname === 'www.mons.shop')) {
    return true;
  }
  return (url.protocol === 'http:' || url.protocol === 'https:') &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
}

export function publicRequestOrigin(request: Request): string | null {
  const origin = request.headers.get('Origin');
  return origin && isAllowedPublicOrigin(origin) ? origin : null;
}

export function publicCorsHeaders(
  origin: string,
  allowMethods: string,
  allowHeaders = 'Content-Type',
): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': allowMethods,
    'Access-Control-Allow-Headers': allowHeaders,
    'Access-Control-Max-Age': '86400',
    'Timing-Allow-Origin': origin,
    'Vary': 'Origin',
  };
}

export function applyPublicCors(
  response: Response,
  origin: string,
  allowMethods: string,
  allowHeaders = 'Content-Type',
): Response {
  for (const [name, value] of Object.entries(publicCorsHeaders(origin, allowMethods, allowHeaders))) {
    response.headers.set(name, value);
  }
  return response;
}

function connectingIp(request: Request): string | null {
  const value = request.headers.get('CF-Connecting-IP')?.trim() || '';
  return value && value.length <= 64 && /^[0-9a-f:.]+$/i.test(value) ? value : null;
}

function emit(log: (entry: Record<string, unknown>) => void, entry: Record<string, unknown>): void {
  try {
    log(entry);
  } catch {}
}

function shouldEmit(request: Request): boolean {
  const rayId = request.headers.get('CF-Ray');
  if (!rayId) return true;
  let hash = 2_166_136_261;
  for (let index = 0; index < rayId.length; index += 1) {
    hash ^= rayId.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) % PUBLIC_RATE_LIMIT_LOG_SAMPLE_DENOMINATOR === 0;
}

export async function observePublicRateLimit(args: {
  binding: RateLimit;
  keyScope: string;
  limit: number;
  log: (entry: Record<string, unknown>) => void;
  request: Request;
  route: string;
  rpcClass?: 'read' | 'write';
}): Promise<void> {
  const ip = connectingIp(args.request);
  if (!ip) {
    if (shouldEmit(args.request)) emit(args.log, {
      event: 'public_rate_limit_key_missing',
      route: args.route,
      ...(args.rpcClass ? { rpcClass: args.rpcClass } : {}),
      sampleDenominator: PUBLIC_RATE_LIMIT_LOG_SAMPLE_DENOMINATOR,
    });
    return;
  }
  try {
    const outcome = await args.binding.limit({ key: `${args.keyScope}:${ip}` });
    if (outcome.success) return;
    if (shouldEmit(args.request)) emit(args.log, {
      event: 'public_rate_limit_would_block',
      route: args.route,
      ...(args.rpcClass ? { rpcClass: args.rpcClass } : {}),
      limit: args.limit,
      periodSeconds: PUBLIC_RATE_LIMIT_PERIOD_SECONDS,
      sampleDenominator: PUBLIC_RATE_LIMIT_LOG_SAMPLE_DENOMINATOR,
    });
  } catch (error) {
    if (shouldEmit(args.request)) emit(args.log, {
      event: 'public_rate_limit_check_failed',
      route: args.route,
      ...(args.rpcClass ? { rpcClass: args.rpcClass } : {}),
      error: error instanceof Error ? { name: error.name } : { name: 'UnknownError' },
      sampleDenominator: PUBLIC_RATE_LIMIT_LOG_SAMPLE_DENOMINATOR,
    });
  }
}
