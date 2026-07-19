import { spawnSync } from 'node:child_process';

const FIREBASE_CLI_CLIENT_ID =
  '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com';
const FIREBASE_CLI_CLIENT_SECRET = 'j9iVZfS8kkCEFUPaAeJV0sAi';
const FIREBASE_CLI_TOKEN_URL = 'https://www.googleapis.com/oauth2/v3/token';
const FIRESTORE_API_ORIGIN = 'https://firestore.googleapis.com';

type FirebaseCliFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

type FirebaseCliSpawnSync = (
  command: string,
  args: string[],
  options: {
    encoding: 'utf8';
    env: NodeJS.ProcessEnv;
  },
) => {
  status: number | null;
  stdout?: string | null;
  stderr?: string | null;
};

export type FirestoreRestDocument = {
  path: string;
  id: string;
  data: Record<string, unknown>;
};

type FirestoreRestRequest = {
  url: URL;
  method?: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  allow404?: boolean;
};

export type FirebaseCliFirestoreRestClient = {
  documentUrl(path: string, suffix?: string): URL;
  documentsUrl(suffix?: string): URL;
  request(args: FirestoreRestRequest): Promise<any>;
};

type CreateFirebaseCliFirestoreRestClientOptions = {
  projectId: string;
  fetchImpl?: FirebaseCliFetch;
  spawnSyncImpl?: FirebaseCliSpawnSync;
};

function asRecord(value: unknown): Record<string, any> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : undefined;
}

function encodeFirestoreDocumentPath(pathValue: string): string {
  return String(pathValue || '')
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function firestoreRelativeDocumentPath(
  resourceName: unknown,
): string | undefined {
  if (typeof resourceName !== 'string') return undefined;
  const marker = '/documents/';
  const index = resourceName.indexOf(marker);
  if (index < 0) return undefined;
  const path = resourceName.slice(index + marker.length);
  return path || undefined;
}

function decodeFirestoreRestValue(value: unknown): unknown {
  const encoded = asRecord(value);
  if (!encoded) return undefined;

  if ('nullValue' in encoded) return null;
  if ('booleanValue' in encoded) return encoded.booleanValue === true;
  if ('integerValue' in encoded) return Number(encoded.integerValue);
  if ('doubleValue' in encoded) return Number(encoded.doubleValue);
  if ('timestampValue' in encoded) return String(encoded.timestampValue || '');
  if ('stringValue' in encoded) return String(encoded.stringValue || '');
  if ('bytesValue' in encoded) return String(encoded.bytesValue || '');
  if ('referenceValue' in encoded) {
    return String(encoded.referenceValue || '');
  }
  if ('geoPointValue' in encoded) {
    const geoPoint = asRecord(encoded.geoPointValue) || {};
    return {
      latitude: Number(geoPoint.latitude),
      longitude: Number(geoPoint.longitude),
    };
  }
  if ('arrayValue' in encoded) {
    const arrayValue = asRecord(encoded.arrayValue);
    const values = Array.isArray(arrayValue?.values) ? arrayValue.values : [];
    return values.map((entry) => decodeFirestoreRestValue(entry));
  }
  if ('mapValue' in encoded) {
    const mapValue = asRecord(encoded.mapValue);
    const fields = asRecord(mapValue?.fields) || {};
    return Object.fromEntries(
      Object.entries(fields).map(([key, entry]) => [
        key,
        decodeFirestoreRestValue(entry),
      ]),
    );
  }
  return undefined;
}

export function decodeFirestoreRestDocument(
  document: unknown,
): FirestoreRestDocument | undefined {
  const encoded = asRecord(document);
  const path = firestoreRelativeDocumentPath(encoded?.name);
  if (!path) return undefined;

  const fields = asRecord(encoded?.fields) || {};
  return {
    path,
    id: path.split('/').pop() || path,
    data: Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [
        key,
        decodeFirestoreRestValue(value),
      ]),
    ),
  };
}

async function responseJson(
  response: Response,
  options: {
    allowMalformed?: boolean;
    malformedMessage: string;
  },
): Promise<any> {
  const text = await response.text();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch (cause) {
    if (options.allowMalformed) return {};
    throw new Error(options.malformedMessage, { cause });
  }
}

export function createFirebaseCliFirestoreRestClient(
  options: CreateFirebaseCliFirestoreRestClientOptions,
): FirebaseCliFirestoreRestClient {
  const projectId = String(options.projectId || '').trim();
  if (!projectId) {
    throw new Error('Firebase project id is required');
  }

  const fetchImpl = options.fetchImpl || (fetch as FirebaseCliFetch);
  const spawnSyncImpl =
    options.spawnSyncImpl || (spawnSync as FirebaseCliSpawnSync);
  let cachedAccessTokenPromise: Promise<string> | null = null;

  function firebaseCliAuthState(): {
    refreshToken: string;
    scope?: string;
  } {
    const result = spawnSyncImpl('firebase', ['login:list', '--json'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        FIREBASE_CLI_DISABLE_UPDATE_CHECK: '1',
      },
    });

    if (result.status !== 0) {
      const message =
        result.stderr?.trim() ||
        result.stdout?.trim() ||
        'firebase login:list failed';
      throw new Error(message);
    }

    const payload = JSON.parse(result.stdout || '{}') as any;
    const refreshToken = payload?.result?.[0]?.tokens?.refresh_token;
    const scope = payload?.result?.[0]?.tokens?.scope;
    if (typeof refreshToken !== 'string' || !refreshToken) {
      throw new Error('No Firebase CLI refresh token available');
    }
    return {
      refreshToken,
      ...(typeof scope === 'string' && scope ? { scope } : {}),
    };
  }

  async function refreshAccessToken(): Promise<string> {
    const authState = firebaseCliAuthState();
    const body = new URLSearchParams({
      refresh_token: authState.refreshToken,
      client_id: FIREBASE_CLI_CLIENT_ID,
      client_secret: FIREBASE_CLI_CLIENT_SECRET,
      grant_type: 'refresh_token',
      ...(authState.scope ? { scope: authState.scope } : {}),
    });

    const response = await fetchImpl(FIREBASE_CLI_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const json = await responseJson(response, {
      malformedMessage: 'OAuth token refresh returned malformed JSON',
    });
    if (!response.ok || typeof json?.access_token !== 'string') {
      const message =
        json?.error_description ||
        json?.error ||
        response.statusText ||
        'OAuth token refresh failed';
      throw new Error(message);
    }
    return json.access_token;
  }

  function accessToken(): Promise<string> {
    if (!cachedAccessTokenPromise) {
      cachedAccessTokenPromise = refreshAccessToken().catch((error) => {
        cachedAccessTokenPromise = null;
        throw error;
      });
    }
    return cachedAccessTokenPromise;
  }

  function documentsUrl(suffix = ''): URL {
    return new URL(
      `/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents${suffix}`,
      FIRESTORE_API_ORIGIN,
    );
  }

  function documentUrl(path: string, suffix = ''): URL {
    return new URL(
      `${documentsUrl().toString()}/${encodeFirestoreDocumentPath(path)}${suffix}`,
    );
  }

  async function request(args: FirestoreRestRequest): Promise<any> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await accessToken()}`,
    };
    if (args.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const response = await fetchImpl(args.url, {
      method: args.method ?? (args.body === undefined ? 'GET' : 'POST'),
      headers,
      ...(args.body !== undefined
        ? { body: JSON.stringify(args.body) }
        : {}),
    });
    const json = await responseJson(response, {
      allowMalformed: args.allow404 && response.status === 404,
      malformedMessage: 'Firestore REST request returned malformed JSON',
    });

    if (
      args.allow404 &&
      (response.status === 404 || json?.error?.status === 'NOT_FOUND')
    ) {
      return undefined;
    }
    if (!response.ok || json?.error) {
      const message =
        json?.error?.message ||
        response.statusText ||
        'Firestore REST request failed';
      throw new Error(message);
    }
    return json;
  }

  return {
    documentUrl,
    documentsUrl,
    request,
  };
}
