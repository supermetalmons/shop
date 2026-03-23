import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, type QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { FUNCTIONS_DEPLOYMENT } from '../src/config/deployment.ts';

type Args = {
  dropId: string;
  json: boolean;
};

type DeliveryOrderStatusRow = {
  deliveryId: number | null;
  path: string;
  hasStatus: boolean;
  rawStatus?: unknown;
};

type InvalidRow = {
  deliveryId: number | null;
  path: string;
  raw: unknown;
};

type ScanSummary = {
  dropId: string;
  collectionPath: string;
  totalScanned: number;
  validCount: number;
  invalidCount: number;
};

type ScanResult = {
  summary: ScanSummary;
  invalidRows: InvalidRow[];
};

const DEFAULT_PROJECT_ID = 'mons-shop';
const FIREBASE_CLI_CLIENT_ID = '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com';
const FIREBASE_CLI_CLIENT_SECRET = 'j9iVZfS8kkCEFUPaAeJV0sAi';
const VALID_FULFILLMENT_STATUSES = new Set(['Pending', 'Shipped']);

function usage() {
  return [
    'Check deliveryOrders for non-conforming fulfillmentStatus values.',
    '',
    'Usage:',
    '  npm run check-fulfillment-statuses',
    '  npm run check-fulfillment-statuses -- --drop-id little_swag_boxes',
    '  npm run check-fulfillment-statuses -- --json',
    '',
    'Behavior:',
    '  - Report-only for data violations (always exits 0 when scan succeeds).',
    '  - Exits non-zero only for operational failures (auth/query errors).',
  ].join('\n');
}

function fail(message: string): never {
  throw new Error(message);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    dropId: FUNCTIONS_DEPLOYMENT.dropId,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      console.log(usage());
      process.exit(0);
    }
    if (arg === '--json') {
      args.json = true;
      continue;
    }
    if (arg === '--drop-id') {
      const next = (argv[i + 1] || '').trim();
      if (!next) fail('Missing value for --drop-id');
      args.dropId = next;
      i += 1;
      continue;
    }
    fail(`Unknown arg: ${arg}\n\n${usage()}`);
  }

  if (!args.dropId.trim()) fail('dropId must be non-empty');
  return args;
}

function loadLocalEnv() {
  const envPaths = [
    fileURLToPath(new URL('../../.env', import.meta.url)),
    fileURLToPath(new URL('../../.env.local', import.meta.url)),
    fileURLToPath(new URL('../.env', import.meta.url)),
    fileURLToPath(new URL('../.env.local', import.meta.url)),
  ];

  const loadEnvFile = (process as any).loadEnvFile as ((path: string) => void) | undefined;

  for (const envPath of envPaths) {
    if (!existsSync(envPath)) continue;

    try {
      if (typeof loadEnvFile === 'function') {
        loadEnvFile(envPath);
        continue;
      }
    } catch {
      // Fall back to the minimal parser below.
    }

    const content = readFileSync(envPath, 'utf8');
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const withoutExport = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
      const eq = withoutExport.indexOf('=');
      if (eq <= 0) continue;
      const key = withoutExport.slice(0, eq).trim();
      let value = withoutExport.slice(eq + 1).trim();
      if (!key || key in process.env) continue;
      if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
      if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
      process.env[key] = value;
    }
  }
}

function collectionPathForDrop(dropId: string): string {
  return `drops/${dropId}/deliveryOrders`;
}

function projectId(): string {
  const value = (process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || DEFAULT_PROJECT_ID).trim();
  if (!value) fail('Missing Firebase project id (FIREBASE_PROJECT_ID or GCLOUD_PROJECT)');
  return value;
}

function parseDeliveryId(value: unknown): number | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const floored = Math.floor(numeric);
  return floored > 0 ? floored : null;
}

function isValidFulfillmentStatus(value: unknown): value is 'Pending' | 'Shipped' {
  return typeof value === 'string' && VALID_FULFILLMENT_STATUSES.has(value);
}

function analyzeRows(dropId: string, rows: DeliveryOrderStatusRow[]): ScanResult {
  const invalidRows: InvalidRow[] = [];
  let validCount = 0;

  for (const row of rows) {
    if (!row.hasStatus) {
      validCount += 1;
      continue;
    }
    if (isValidFulfillmentStatus(row.rawStatus)) {
      validCount += 1;
      continue;
    }
    invalidRows.push({
      deliveryId: row.deliveryId,
      path: row.path,
      raw: row.rawStatus,
    });
  }

  return {
    summary: {
      dropId,
      collectionPath: collectionPathForDrop(dropId),
      totalScanned: rows.length,
      validCount,
      invalidCount: invalidRows.length,
    },
    invalidRows,
  };
}

function looksLikeAdminReadFailure(message: string): boolean {
  return /permission[-_\s]?denied|missing or insufficient permissions|Could not load the default credentials|Failed to determine service account|credential implementation provided/i.test(
    message,
  );
}

let cachedFirebaseCliAccessTokenPromise: Promise<string> | null = null;

function firebaseCliAuthState(): { refreshToken: string; scope?: string } {
  const result = spawnSync('firebase', ['login:list', '--json'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      FIREBASE_CLI_DISABLE_UPDATE_CHECK: '1',
    },
  });

  if (result.status !== 0) {
    const message = result.stderr?.trim() || result.stdout?.trim() || 'firebase login:list failed';
    throw new Error(message);
  }

  const payload = JSON.parse(result.stdout || '{}') as any;
  const refreshToken = payload?.result?.[0]?.tokens?.refresh_token;
  const scope = payload?.result?.[0]?.tokens?.scope;
  if (typeof refreshToken !== 'string' || !refreshToken) {
    throw new Error('No Firebase CLI refresh token available');
  }
  return { refreshToken, ...(typeof scope === 'string' && scope ? { scope } : {}) };
}

async function firebaseCliAccessToken(): Promise<string> {
  if (!cachedFirebaseCliAccessTokenPromise) {
    cachedFirebaseCliAccessTokenPromise = (async () => {
      const authState = firebaseCliAuthState();
      const body = new URLSearchParams({
        refresh_token: authState.refreshToken,
        client_id: FIREBASE_CLI_CLIENT_ID,
        client_secret: FIREBASE_CLI_CLIENT_SECRET,
        grant_type: 'refresh_token',
        ...(authState.scope ? { scope: authState.scope } : {}),
      });

      const res = await fetch('https://www.googleapis.com/oauth2/v3/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || typeof (json as any)?.access_token !== 'string') {
        const message = (json as any)?.error_description || (json as any)?.error || res.statusText || 'OAuth token refresh failed';
        throw new Error(message);
      }
      return String((json as any).access_token);
    })().catch((err) => {
      cachedFirebaseCliAccessTokenPromise = null;
      throw err;
    });
  }

  return cachedFirebaseCliAccessTokenPromise;
}

async function firestoreRest(path: string, params?: Record<string, string>): Promise<any> {
  const url = new URL(`https://firestore.googleapis.com/v1/projects/${projectId()}/databases/(default)/documents/${path}`);
  for (const [key, value] of Object.entries(params || {})) {
    url.searchParams.set(key, value);
  }

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${await firebaseCliAccessToken()}`,
    },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || (json as any)?.error) {
    const message = (json as any)?.error?.message || res.statusText || 'Firestore REST request failed';
    throw new Error(message);
  }
  return json;
}

function decodeFirestoreValue(value: any): unknown {
  if (!value || typeof value !== 'object') return undefined;
  if ('nullValue' in value) return null;
  if ('stringValue' in value) return String(value.stringValue || '');
  if ('booleanValue' in value) return Boolean(value.booleanValue);
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('timestampValue' in value) return value.timestampValue;
  if ('referenceValue' in value) return value.referenceValue;
  if ('arrayValue' in value) {
    const values = Array.isArray(value.arrayValue?.values) ? value.arrayValue.values : [];
    return values.map((entry: any) => decodeFirestoreValue(entry));
  }
  if ('mapValue' in value) {
    const fields = value.mapValue?.fields && typeof value.mapValue.fields === 'object' ? value.mapValue.fields : {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
      out[k] = decodeFirestoreValue(v);
    }
    return out;
  }
  return undefined;
}

function parsePathFromRestDocName(name: unknown): string {
  const raw = typeof name === 'string' ? name : '';
  const marker = '/documents/';
  const idx = raw.indexOf(marker);
  if (idx < 0) return raw;
  return raw.slice(idx + marker.length);
}

function parseRestRow(doc: any): DeliveryOrderStatusRow {
  const path = parsePathFromRestDocName(doc?.name);
  const fields = doc?.fields && typeof doc.fields === 'object' ? doc.fields : {};
  const docId = path.split('/').pop() || '';
  const deliveryId = parseDeliveryId(decodeFirestoreValue((fields as any).deliveryId)) ?? parseDeliveryId(docId);
  const hasStatus = Object.prototype.hasOwnProperty.call(fields, 'fulfillmentStatus');
  const rawStatus = hasStatus ? decodeFirestoreValue((fields as any).fulfillmentStatus) : undefined;
  return { deliveryId, path, hasStatus, rawStatus };
}

async function loadRowsViaRest(dropId: string): Promise<DeliveryOrderStatusRow[]> {
  const rows: DeliveryOrderStatusRow[] = [];
  const path = collectionPathForDrop(dropId);
  let pageToken: string | undefined;

  do {
    const json = await firestoreRest(path, {
      pageSize: '1000',
      ...(pageToken ? { pageToken } : {}),
    });
    const docs = Array.isArray(json?.documents) ? json.documents : [];
    docs.forEach((doc: any) => rows.push(parseRestRow(doc)));
    pageToken = typeof json?.nextPageToken === 'string' && json.nextPageToken ? json.nextPageToken : undefined;
  } while (pageToken);

  return rows;
}

function parseAdminRow(doc: QueryDocumentSnapshot): DeliveryOrderStatusRow {
  const data = doc.data() as Record<string, unknown>;
  const deliveryId = parseDeliveryId(data.deliveryId) ?? parseDeliveryId(doc.id);
  const hasStatus = Object.prototype.hasOwnProperty.call(data, 'fulfillmentStatus');
  const rawStatus = hasStatus ? data.fulfillmentStatus : undefined;
  return { deliveryId, path: doc.ref.path, hasStatus, rawStatus };
}

async function loadRowsViaAdmin(dropId: string): Promise<DeliveryOrderStatusRow[]> {
  const app = initializeApp({ projectId: projectId() });
  const db = getFirestore(app);
  const snap = await db.collection(collectionPathForDrop(dropId)).select('deliveryId', 'fulfillmentStatus').get();
  return snap.docs.map(parseAdminRow);
}

async function loadRows(dropId: string): Promise<DeliveryOrderStatusRow[]> {
  try {
    return await loadRowsViaAdmin(dropId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!looksLikeAdminReadFailure(message)) throw err;
    return loadRowsViaRest(dropId);
  }
}

function formatRawValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function printText(result: ScanResult) {
  const { summary, invalidRows } = result;
  console.log(`Drop: ${summary.dropId}`);
  console.log(`Collection: ${summary.collectionPath}`);
  console.log(`Total scanned: ${summary.totalScanned}`);
  console.log(`Valid statuses (including not set): ${summary.validCount}`);
  console.log(`Invalid statuses: ${summary.invalidCount}`);

  if (!invalidRows.length) {
    console.log('');
    console.log('No non-conforming fulfillmentStatus values found.');
    return;
  }

  console.log('');
  console.log('Invalid rows:');
  invalidRows.forEach((row) => {
    const delivery = row.deliveryId == null ? '-' : String(row.deliveryId);
    console.log(`- deliveryId=${delivery} path=${row.path} raw=${formatRawValue(row.raw)}`);
  });
}

async function main() {
  loadLocalEnv();
  const args = parseArgs(process.argv.slice(2));
  const rows = await loadRows(args.dropId);
  const result = analyzeRows(args.dropId, rows);

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  printText(result);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
});
