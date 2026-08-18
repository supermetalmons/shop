import { decodeProtectedHeader, importX509, jwtVerify } from 'jose';

const FIREBASE_CERTIFICATES_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
const FIREBASE_PROJECT_ID = 'mons-shop';
const FIREBASE_ISSUER = `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`;
const MAX_AUTHORIZATION_HEADER_BYTES = 8 * 1024;
const MAX_CERTIFICATES_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_CERTIFICATE_TTL_MS = 5 * 60 * 1000;
const MAX_CERTIFICATE_TTL_MS = 24 * 60 * 60 * 1000;
const TRANSIENT_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

export type FirebaseIdentity = {
  uid: string;
};

export type FirebaseIdTokenFetch = typeof fetch;

export class FirebaseIdTokenError extends Error {
  constructor(readonly kind: 'invalid-token' | 'provider-timeout' | 'provider-unavailable') {
    super(kind);
    this.name = 'FirebaseIdTokenError';
  }
}

type CertificateCache = {
  certificates: Map<string, string>;
  expiresAtMs: number;
};

export type FirebaseCertificateImporter = (certificate: string) => Promise<CryptoKey>;

function boundedBearerToken(authorization: string | null): string {
  if (!authorization || new TextEncoder().encode(authorization).byteLength > MAX_AUTHORIZATION_HEADER_BYTES) {
    throw new FirebaseIdTokenError('invalid-token');
  }
  const match = authorization.match(/^Bearer ([^\s]+)$/);
  if (!match?.[1]) throw new FirebaseIdTokenError('invalid-token');
  return match[1];
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {}
}

async function readBoundedText(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const contentLength = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await cancelResponseBody(response);
    throw new FirebaseIdTokenError('provider-unavailable');
  }
  if (!response.body) throw new FirebaseIdTokenError('provider-unavailable');
  const reader = response.body.getReader();
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
      if (signal.aborted) throw signal.reason;
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new FirebaseIdTokenError('provider-unavailable');
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function certificateTtlMs(response: Response): number {
  const cacheControl = response.headers.get('Cache-Control') || '';
  const match = cacheControl.match(/(?:^|,)\s*max-age=(\d+)\s*(?:,|$)/i);
  const seconds = match ? Number(match[1]) : Number.NaN;
  if (!Number.isFinite(seconds) || seconds < 0) return DEFAULT_CERTIFICATE_TTL_MS;
  return Math.min(MAX_CERTIFICATE_TTL_MS, Math.floor(seconds * 1000));
}

function parseCertificates(value: unknown): Map<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new FirebaseIdTokenError('provider-unavailable');
  }
  const entries = Object.entries(value);
  if (!entries.length || entries.length > 20) throw new FirebaseIdTokenError('provider-unavailable');
  const certificates = new Map<string, string>();
  for (const [kid, certificate] of entries) {
    if (
      !kid ||
      kid.length > 256 ||
      typeof certificate !== 'string' ||
      certificate.length > 16 * 1024 ||
      !certificate.startsWith('-----BEGIN CERTIFICATE-----') ||
      !/-----END CERTIFICATE-----\s*$/.test(certificate)
    ) {
      throw new FirebaseIdTokenError('provider-unavailable');
    }
    certificates.set(kid, certificate);
  }
  return certificates;
}

export function createFirebaseIdTokenVerifier(
  importCertificate: FirebaseCertificateImporter = (certificate) => importX509(certificate, 'RS256'),
) {
  let cache: CertificateCache = { certificates: new Map(), expiresAtMs: 0 };

  async function refreshCertificates(
    providerFetch: FirebaseIdTokenFetch,
    signal: AbortSignal,
    nowMs: number,
  ): Promise<void> {
    let response: Response | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        response = await providerFetch(FIREBASE_CERTIFICATES_URL, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          redirect: 'manual',
          signal,
        });
      } catch {
        if (signal.aborted) throw new FirebaseIdTokenError('provider-timeout');
        if (attempt === 0) continue;
        throw new FirebaseIdTokenError('provider-unavailable');
      }
      if (TRANSIENT_HTTP_STATUSES.has(response.status) && attempt === 0) {
        await cancelResponseBody(response);
        response = undefined;
        continue;
      }
      break;
    }
    if (!response?.ok) {
      if (response) await cancelResponseBody(response);
      throw new FirebaseIdTokenError(signal.aborted ? 'provider-timeout' : 'provider-unavailable');
    }
    try {
      const parsed: unknown = JSON.parse(await readBoundedText(response, MAX_CERTIFICATES_RESPONSE_BYTES, signal));
      cache = {
        certificates: parseCertificates(parsed),
        expiresAtMs: nowMs + certificateTtlMs(response),
      };
    } catch (error) {
      if (error instanceof FirebaseIdTokenError) throw error;
      throw new FirebaseIdTokenError(signal.aborted ? 'provider-timeout' : 'provider-unavailable');
    }
  }

  return async function verifyFirebaseIdToken(
    authorization: string | null,
    providerFetch: FirebaseIdTokenFetch,
    signal: AbortSignal,
    nowMs = Date.now(),
  ): Promise<FirebaseIdentity> {
    const token = boundedBearerToken(authorization);
    let protectedHeader: ReturnType<typeof decodeProtectedHeader>;
    try {
      protectedHeader = decodeProtectedHeader(token);
    } catch {
      throw new FirebaseIdTokenError('invalid-token');
    }
    if (protectedHeader.alg !== 'RS256' || typeof protectedHeader.kid !== 'string' || !protectedHeader.kid) {
      throw new FirebaseIdTokenError('invalid-token');
    }
    if (cache.expiresAtMs <= nowMs) {
      await refreshCertificates(providerFetch, signal, nowMs);
    }
    const certificate = cache.certificates.get(protectedHeader.kid);
    if (!certificate) throw new FirebaseIdTokenError('invalid-token');
    let key: CryptoKey;
    try {
      key = await importCertificate(certificate);
    } catch {
      throw new FirebaseIdTokenError('provider-unavailable');
    }
    try {
      const result = await jwtVerify(token, key, {
        algorithms: ['RS256'],
        audience: FIREBASE_PROJECT_ID,
        issuer: FIREBASE_ISSUER,
        clockTolerance: 5,
        currentDate: new Date(nowMs),
      });
      const uid = result.payload.sub;
      const issuedAt = result.payload.iat;
      const authTime = result.payload.auth_time;
      const nowSeconds = Math.floor(nowMs / 1000);
      if (
        typeof uid !== 'string' ||
        !uid ||
        uid.length > 128 ||
        !Number.isSafeInteger(issuedAt) ||
        Number(issuedAt) > nowSeconds + 5 ||
        !Number.isSafeInteger(authTime) ||
        Number(authTime) > nowSeconds + 5
      ) {
        throw new FirebaseIdTokenError('invalid-token');
      }
      return { uid };
    } catch (error) {
      if (error instanceof FirebaseIdTokenError) throw error;
      throw new FirebaseIdTokenError('invalid-token');
    }
  };
}

export const verifyFirebaseIdToken = createFirebaseIdTokenVerifier();
