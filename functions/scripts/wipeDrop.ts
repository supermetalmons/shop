import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import {
  normalizeDropId,
  readFrontendDropRegistry,
  readFunctionsDropRegistry,
  writeFrontendDeploymentRegistryFile,
  writeFunctionsDeploymentRegistryFile,
  type FrontendDropConfigSerialized,
  type FunctionsDropConfigSerialized,
} from '../../scripts/shared/deploymentRegistry.ts';

type Args = {
  dropId: string;
  dryRun: boolean;
  yes: boolean;
};

type RepoPlan = {
  frontendConfigPath: string;
  functionsConfigPath: string;
  frontendDropsNext: Record<string, FrontendDropConfigSerialized>;
  functionsDropsNext: Record<string, FunctionsDropConfigSerialized>;
  frontendConfigWillChange: boolean;
  functionsConfigWillChange: boolean;
  canonicalDeleteRelPaths: string[];
  canonicalDeleteAbsPaths: string[];
  extraReferences: string[];
};

type FirestorePlan = {
  claimCodesByDropId: string[];
  claimCodesFromAssignments: string[];
  claimCodesFromDeliveryOrders: string[];
  claimCodesToDelete: string[];
  missingClaimCodes: string[];
  recursiveDeletePath: string;
};

type FirestoreDocRecord = {
  path: string;
  id: string;
  data: Record<string, unknown>;
};

type FirestoreClientMode = 'admin' | 'rest';
type FirestoreStringFilter =
  | {
      op?: 'EQUAL';
      value: string;
    }
  | {
      op: 'IN';
      values: string[];
    };

const PROJECT_ID = 'mons-shop';
const DROP_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const FIREBASE_CLI_CLIENT_ID = '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com';
const FIREBASE_CLI_CLIENT_SECRET = 'j9iVZfS8kkCEFUPaAeJV0sAi';
const FIRESTORE_LIST_PAGE_SIZE = 1000;
const FIRESTORE_IN_QUERY_MAX_VALUES = 10;

let firestoreClientMode: FirestoreClientMode | undefined;
let cachedFirebaseCliAccessTokenPromise: Promise<string> | null = null;

function usage(): string {
  return [
    'Wipe one drop from local config/data and Firestore.',
    '',
    'Usage:',
    '  npm run wipe-drop -- --drop-id <dropId>',
    '  npm run wipe-drop -- --drop_id <dropId>',
    '  npm run wipe-drop --drop_id=<dropId>',
    '  npm run wipe-drop -- <dropId>',
    '',
    'Options:',
    '  --drop-id <id>      Drop id to remove',
    '  --drop_id <id>      Alias for --drop-id',
    '  --dry-run           Preview only; do not mutate',
    '  --yes               Skip interactive confirmation',
    '  -h, --help          Show this help',
  ].join('\n');
}

function fail(message: string): never {
  throw new Error(message);
}

function validateDropId(raw: string, label: string): string {
  const normalized = normalizeDropId(raw);
  if (!DROP_ID_PATTERN.test(normalized)) {
    fail(`Invalid ${label}: ${raw}`);
  }
  return normalized;
}

function readNpmConfigString(keys: string[]): string | undefined {
  for (const key of keys) {
    const envKey = `npm_config_${key.replace(/-/g, '_')}`;
    const value = process.env[envKey];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function parseArgs(argv: string[]): Args {
  let dropId: string | undefined;
  let dryRun = false;
  let yes = false;
  const positional: string[] = [];

  function readValue(flag: string, index: number, inlineValue?: string): { value: string; nextIndex: number } {
    if (inlineValue != null) return { value: inlineValue, nextIndex: index };
    const value = argv[index + 1];
    if (!value) fail(`Missing value for ${flag}\n\n${usage()}`);
    return { value, nextIndex: index + 1 };
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '-h' || arg === '--help') {
      console.log(usage());
      process.exit(0);
    }

    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--yes') {
      yes = true;
      continue;
    }

    if (arg === '--drop-id' || arg === '--drop_id' || arg.startsWith('--drop-id=') || arg.startsWith('--drop_id=')) {
      const { value, nextIndex } = readValue(
        arg.startsWith('--drop-id=') ? '--drop-id' : arg.startsWith('--drop_id=') ? '--drop_id' : arg,
        i,
        arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : undefined,
      );
      dropId = value;
      i = nextIndex;
      continue;
    }

    if (arg.startsWith('-')) {
      fail(`Unknown arg: ${arg}\n\n${usage()}`);
    }

    positional.push(arg);
  }

  if (positional.length > 1) {
    fail(`Expected at most one positional drop id.\n\n${usage()}`);
  }

  const positionalDropId = positional[0];
  const dropIdFromNpmConfig = readNpmConfigString(['drop_id', 'drop-id']);
  const finalDropIdRaw = dropId ?? positionalDropId ?? dropIdFromNpmConfig;

  if (!finalDropIdRaw) {
    fail(`Missing drop id.\n\n${usage()}`);
  }

  const normalizedDropId = validateDropId(finalDropIdRaw, 'drop id');
  return {
    dropId: normalizedDropId,
    dryRun,
    yes,
  };
}

function normalizeMaybeDropId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = normalizeDropId(value);
  return normalized || undefined;
}

function normalizeClaimCode(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function sortStrings(values: Iterable<string>): string[] {
  return Array.from(new Set(Array.from(values).filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

function chunkStrings(values: string[], size: number): string[][] {
  if (!values.length || size < 1) return [];
  const out: string[][] = [];
  for (let index = 0; index < values.length; index += size) {
    out.push(values.slice(index, index + size));
  }
  return out;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (!items.length) return [];
  const out = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= items.length) return;
      out[current] = await fn(items[current], current);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return out;
}

function repoRoot(): string {
  return path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
}

function runGit(args: string[], cwd: string, opts?: { allowNoMatch?: boolean; binary?: boolean }) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: opts?.binary ? 'buffer' : 'utf8',
  });
  if (result.status === 0) return result;
  if (opts?.allowNoMatch && result.status === 1) return result;
  const stderr = opts?.binary ? Buffer.from(result.stderr as Buffer).toString('utf8') : String(result.stderr || '');
  const stdout = opts?.binary ? Buffer.from(result.stdout as Buffer).toString('utf8') : String(result.stdout || '');
  throw new Error(`git ${args.join(' ')} failed.\n${stderr || stdout || '(no output)'}`.trim());
}

function listTrackedFiles(root: string): string[] {
  const result = runGit(['ls-files', '-z'], root, { binary: true });
  return Buffer.from(result.stdout as Buffer)
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildDropIdTokenRegex(dropId: string): RegExp {
  const escapedDropId = escapeRegExp(dropId);
  // A drop id token must not be surrounded by drop-id characters, so `abc` does not match `abc_devnet`.
  return new RegExp(`(^|[^A-Za-z0-9_-])${escapedDropId}($|[^A-Za-z0-9_-])`);
}

function hasDropIdToken(text: string, dropIdTokenRegex: RegExp): boolean {
  return dropIdTokenRegex.test(text);
}

function fileContainsDropIdToken(filePath: string, dropIdTokenRegex: RegExp): boolean {
  let bytes: Buffer;
  try {
    bytes = readFileSync(filePath);
  } catch {
    return false;
  }
  if (bytes.includes(0)) return false;
  return hasDropIdToken(bytes.toString('utf8'), dropIdTokenRegex);
}

function isCanonicalDropFile(relPath: string, dropId: string): boolean {
  if (!relPath.startsWith('src/drops/')) return false;
  return path.parse(relPath).name === dropId;
}

function isPreservedDropConfigFile(relPath: string): boolean {
  return relPath.startsWith('scripts/newDrops/');
}

function adminDb() {
  const app = getApps()[0] || initializeApp({ projectId: PROJECT_ID });
  return getFirestore(app);
}

function firestorePathUrl(pathValue: string, suffix = ''): URL {
  const encodedPath = String(pathValue || '')
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return new URL(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${encodedPath}${suffix}`);
}

function firestoreDocumentsUrl(suffix = ''): URL {
  return new URL(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents${suffix}`);
}

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

async function firestoreRestRequest(args: {
  url: URL;
  method?: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  allow404?: boolean;
}): Promise<any> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${await firebaseCliAccessToken()}`,
  };
  if (args.body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(args.url, {
    method: args.method ?? (args.body === undefined ? 'GET' : 'POST'),
    headers,
    ...(args.body !== undefined ? { body: JSON.stringify(args.body) } : {}),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};

  if (args.allow404 && (res.status === 404 || json?.error?.status === 'NOT_FOUND')) {
    return undefined;
  }

  if (!res.ok || json?.error) {
    const message = json?.error?.message || res.statusText || 'Firestore REST request failed';
    throw new Error(message);
  }

  return json;
}

function relativeFirestoreDocumentPath(name: unknown): string | undefined {
  if (typeof name !== 'string') return undefined;
  const marker = '/documents/';
  const index = name.indexOf(marker);
  if (index < 0) return undefined;
  return name.slice(index + marker.length);
}

function decodeFirestoreValue(value: any): unknown {
  if (!value || typeof value !== 'object') return undefined;
  if ('nullValue' in value) return null;
  if ('stringValue' in value) return String(value.stringValue || '');
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('booleanValue' in value) return value.booleanValue === true;
  if ('timestampValue' in value) return String(value.timestampValue || '');
  if ('referenceValue' in value) return String(value.referenceValue || '');
  if ('bytesValue' in value) return String(value.bytesValue || '');
  if ('arrayValue' in value) {
    const values = Array.isArray(value.arrayValue?.values) ? value.arrayValue.values : [];
    return values.map((entry: any) => decodeFirestoreValue(entry));
  }
  if ('mapValue' in value) {
    const fields = value.mapValue?.fields && typeof value.mapValue.fields === 'object' ? value.mapValue.fields : {};
    return Object.fromEntries(Object.entries(fields).map(([key, entry]) => [key, decodeFirestoreValue(entry)]));
  }
  return undefined;
}

function decodeFirestoreDocument(doc: any): FirestoreDocRecord | undefined {
  const pathValue = relativeFirestoreDocumentPath(doc?.name);
  if (!pathValue) return undefined;
  const fields = doc?.fields && typeof doc.fields === 'object' ? doc.fields : {};
  return {
    path: pathValue,
    id: pathValue.split('/').pop() || pathValue,
    data: Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, decodeFirestoreValue(value)])),
  };
}

function normalizeFirestoreDocPath(pathValue: string): string {
  return String(pathValue || '').replace(/^\/+/, '');
}

async function listCollectionDocumentsViaRest(
  collectionPath: string,
  opts?: { maskFieldPaths?: string[]; showMissing?: boolean },
): Promise<FirestoreDocRecord[]> {
  const docs: FirestoreDocRecord[] = [];
  let pageToken: string | undefined;

  do {
    const url = firestorePathUrl(collectionPath);
    url.searchParams.set('pageSize', String(FIRESTORE_LIST_PAGE_SIZE));
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    if (opts?.showMissing) url.searchParams.set('showMissing', 'true');
    (opts?.maskFieldPaths || []).forEach((fieldPath) => {
      url.searchParams.append('mask.fieldPaths', fieldPath);
    });
    const json = await firestoreRestRequest({ url, allow404: true });
    const pageDocs = Array.isArray(json?.documents) ? json.documents : [];
    pageDocs.forEach((doc) => {
      const decoded = decodeFirestoreDocument(doc);
      if (decoded) docs.push(decoded);
    });
    pageToken = typeof json?.nextPageToken === 'string' && json.nextPageToken ? json.nextPageToken : undefined;
  } while (pageToken);

  return docs;
}

async function getDocumentViaRest(documentPath: string): Promise<FirestoreDocRecord | null> {
  const json = await firestoreRestRequest({ url: firestorePathUrl(documentPath), allow404: true });
  if (!json) return null;
  return decodeFirestoreDocument(json) || null;
}

async function runCollectionQueryViaRest(args: {
  collectionId: string;
  fieldPath: string;
  filter: FirestoreStringFilter;
  parentPath?: string;
  allDescendants?: boolean;
  maskFieldPaths?: string[];
  limit?: number;
}): Promise<FirestoreDocRecord[]> {
  const url = args.parentPath
    ? firestorePathUrl(args.parentPath, ':runQuery')
    : firestoreDocumentsUrl(':runQuery');
  const json = await firestoreRestRequest({
    url,
    method: 'POST',
    body: {
      structuredQuery: {
        from: [
          {
            collectionId: args.collectionId,
            ...(args.allDescendants ? { allDescendants: true } : {}),
          },
        ],
        where: {
          fieldFilter: {
            field: { fieldPath: args.fieldPath },
            op: args.filter.op || 'EQUAL',
            value:
              args.filter.op === 'IN'
                ? {
                    arrayValue: {
                      values: args.filter.values.map((value) => ({ stringValue: value })),
                    },
                  }
                : { stringValue: args.filter.value },
          },
        },
        ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
        ...(args.maskFieldPaths?.length
          ? {
              select: {
                fields: args.maskFieldPaths.map((fieldPath) => ({ fieldPath })),
              },
            }
          : {}),
      },
    },
  });
  return (Array.isArray(json) ? json : [])
    .map((entry) => decodeFirestoreDocument(entry?.document))
    .filter((doc): doc is FirestoreDocRecord => Boolean(doc));
}

async function listCollectionIdsViaRest(documentPath: string): Promise<string[]> {
  const collectionIds: string[] = [];
  let pageToken: string | undefined;

  do {
    const json = await firestoreRestRequest({
      url: firestorePathUrl(documentPath, ':listCollectionIds'),
      method: 'POST',
      body: {
        pageSize: FIRESTORE_LIST_PAGE_SIZE,
        ...(pageToken ? { pageToken } : {}),
      },
      allow404: true,
    });
    collectionIds.push(...((Array.isArray(json?.collectionIds) ? json.collectionIds : []).filter(Boolean) as string[]));
    pageToken = typeof json?.nextPageToken === 'string' && json.nextPageToken ? json.nextPageToken : undefined;
  } while (pageToken);

  return sortStrings(collectionIds);
}

async function deleteDocumentViaRest(documentPath: string): Promise<void> {
  await firestoreRestRequest({
    url: firestorePathUrl(documentPath),
    method: 'DELETE',
    allow404: true,
  });
}

async function recursiveDeleteDocumentViaRest(documentPath: string): Promise<void> {
  const normalizedPath = normalizeFirestoreDocPath(documentPath);
  const subcollectionIds = await listCollectionIdsViaRest(normalizedPath);

  for (const subcollectionId of subcollectionIds) {
    const nestedDocs = await listCollectionDocumentsViaRest(`${normalizedPath}/${subcollectionId}`, {
      maskFieldPaths: ['__name__'],
      showMissing: true,
    });
    await mapLimit(
      nestedDocs.map((doc) => doc.path),
      8,
      async (childDocPath) => recursiveDeleteDocumentViaRest(childDocPath),
    );
  }

  await deleteDocumentViaRest(normalizedPath);
}

function looksLikeFirestorePermissionError(message: string): boolean {
  return /permission[-_\s]?denied|missing or insufficient permissions/i.test(message);
}

async function withFirestoreFallback<T>(adminOp: () => Promise<T>, restOp: () => Promise<T>): Promise<T> {
  if (firestoreClientMode !== 'rest') {
    try {
      const result = await adminOp();
      firestoreClientMode = 'admin';
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!looksLikeFirestorePermissionError(message)) throw err;
      firestoreClientMode = 'rest';
    }
  }

  return restOp();
}

async function listDropIds(): Promise<string[]> {
  return withFirestoreFallback(
    async () => {
      const refs = await adminDb().collection('drops').listDocuments();
      return sortStrings(refs.map((ref) => normalizeMaybeDropId(ref.id)).filter((dropId): dropId is string => Boolean(dropId)));
    },
    async () => {
      const docs = await listCollectionDocumentsViaRest('drops', { maskFieldPaths: ['__name__'], showMissing: true });
      return sortStrings(docs.map((doc) => normalizeMaybeDropId(doc.id)).filter((dropId): dropId is string => Boolean(dropId)));
    },
  );
}

async function listClaimCodesByDropId(dropId: string): Promise<string[]> {
  return withFirestoreFallback(
    async () => {
      const snap = await adminDb().collection('claimCodes').where('dropId', '==', dropId).get();
      return sortStrings(snap.docs.map((doc) => doc.id));
    },
    async () => {
      const docs = await runCollectionQueryViaRest({
        collectionId: 'claimCodes',
        fieldPath: 'dropId',
        filter: { value: dropId },
        maskFieldPaths: ['dropId'],
      });
      return sortStrings(docs.map((doc) => doc.id));
    },
  );
}

async function listBoxAssignmentClaimCodes(dropId: string): Promise<string[]> {
  return withFirestoreFallback(
    async () => {
      const snap = await adminDb().collection(`drops/${dropId}/boxAssignments`).select('irlClaimCode').get();
      return sortStrings(
        snap.docs.map((doc) => normalizeClaimCode(doc.get('irlClaimCode'))).filter((code): code is string => Boolean(code)),
      );
    },
    async () => {
      const docs = await listCollectionDocumentsViaRest(`drops/${dropId}/boxAssignments`, { maskFieldPaths: ['irlClaimCode'] });
      return sortStrings(docs.map((doc) => normalizeClaimCode(doc.data.irlClaimCode)).filter((code): code is string => Boolean(code)));
    },
  );
}

async function listDeliveryOrderClaimCodes(dropId: string): Promise<string[]> {
  return withFirestoreFallback(
    async () => {
      const snap = await adminDb().collection(`drops/${dropId}/deliveryOrders`).select('irlClaims').get();
      return sortStrings(snap.docs.flatMap((doc) => extractClaimCodesFromDeliveryOrders(doc.data())));
    },
    async () => {
      const docs = await listCollectionDocumentsViaRest(`drops/${dropId}/deliveryOrders`, { maskFieldPaths: ['irlClaims'] });
      return sortStrings(docs.flatMap((doc) => extractClaimCodesFromDeliveryOrders(doc.data)));
    },
  );
}

async function findClaimCodesInBoxAssignments(dropId: string, codes: string[]): Promise<string[]> {
  const normalizedCodes = sortStrings(codes);
  if (!normalizedCodes.length) return [];

  return withFirestoreFallback(
    async () => {
      const chunks = chunkStrings(normalizedCodes, FIRESTORE_IN_QUERY_MAX_VALUES);
      const matches = await mapLimit(chunks, 4, async (chunk) => {
        const snap = await adminDb()
          .collection(`drops/${dropId}/boxAssignments`)
          .where('irlClaimCode', 'in', chunk)
          .select('irlClaimCode')
          .get();
        return snap.docs.map((doc) => normalizeClaimCode(doc.get('irlClaimCode'))).filter((code): code is string => Boolean(code));
      });
      return sortStrings(matches.flat());
    },
    async () => {
      const chunks = chunkStrings(normalizedCodes, FIRESTORE_IN_QUERY_MAX_VALUES);
      const matches = await mapLimit(chunks, 4, async (chunk) => {
        const docs = await runCollectionQueryViaRest({
          parentPath: `drops/${dropId}`,
          collectionId: 'boxAssignments',
          fieldPath: 'irlClaimCode',
          filter: { op: 'IN', values: chunk },
          maskFieldPaths: ['irlClaimCode'],
        });
        return docs.map((doc) => normalizeClaimCode(doc.data.irlClaimCode)).filter((code): code is string => Boolean(code));
      });
      return sortStrings(matches.flat());
    },
  );
}

async function findAssignmentOwnerDropIdsByCode(args: {
  dropIds: string[];
  targetDropId: string;
  targetClaimCodes: string[];
  codesToInspect: string[];
}): Promise<Map<string, Set<string>>> {
  const ownership = new Map<string, Set<string>>();

  const addOwners = (ownerDropId: string, codes: string[]) => {
    codes.forEach((code) => {
      const owners = ownership.get(code) || new Set<string>();
      owners.add(ownerDropId);
      ownership.set(code, owners);
    });
  };

  addOwners(args.targetDropId, args.targetClaimCodes);

  const foreignDropIds = sortStrings(args.dropIds.filter((dropId) => dropId && dropId !== args.targetDropId));
  const codeChunks = chunkStrings(sortStrings(args.codesToInspect), FIRESTORE_IN_QUERY_MAX_VALUES);
  const queryTasks = foreignDropIds.flatMap((ownerDropId) => codeChunks.map((codes) => ({ ownerDropId, codes })));

  const results = await mapLimit(queryTasks, 8, async ({ ownerDropId, codes }) => ({
    ownerDropId,
    codes: await findClaimCodesInBoxAssignments(ownerDropId, codes),
  }));

  results.forEach(({ ownerDropId, codes }) => addOwners(ownerDropId, codes));
  return ownership;
}

async function loadClaimDocs(codes: string[]): Promise<Map<string, FirestoreDocRecord>> {
  if (!codes.length) return new Map<string, FirestoreDocRecord>();

  return withFirestoreFallback(
    async () => {
      const docs = await adminDb().getAll(...codes.map((code) => adminDb().doc(`claimCodes/${code}`)));
      return new Map<string, FirestoreDocRecord>(
        docs
          .filter((snap) => snap.exists)
          .map((snap) => [snap.id, { path: snap.ref.path, id: snap.id, data: snap.data() || {} }]),
      );
    },
    async () => {
      const docs = await mapLimit(codes, 8, async (code) => getDocumentViaRest(`claimCodes/${code}`));
      return new Map<string, FirestoreDocRecord>(
        docs.filter((doc): doc is FirestoreDocRecord => Boolean(doc)).map((doc) => [doc.id, doc]),
      );
    },
  );
}

async function buildRepoPlan(args: {
  root: string;
  dropId: string;
}): Promise<RepoPlan> {
  const frontendConfigPath = path.join(args.root, 'src', 'config', 'deployment.ts');
  const functionsConfigPath = path.join(args.root, 'functions', 'src', 'config', 'deployment.ts');

  const [frontendRegistry, functionsRegistry] = await Promise.all([
    readFrontendDropRegistry(frontendConfigPath),
    readFunctionsDropRegistry(functionsConfigPath),
  ]);

  const frontendDropsNext = { ...frontendRegistry.drops };
  delete frontendDropsNext[args.dropId];
  const functionsDropsNext = { ...functionsRegistry.drops };
  delete functionsDropsNext[args.dropId];

  const nextFrontendDropIds = Object.keys(frontendDropsNext).sort((a, b) => a.localeCompare(b));
  const nextFunctionsDropIds = Object.keys(functionsDropsNext).sort((a, b) => a.localeCompare(b));

  if (!nextFrontendDropIds.length || !nextFunctionsDropIds.length) {
    fail(
      `Refusing to wipe ${args.dropId}: this would leave ${
        !nextFrontendDropIds.length && !nextFunctionsDropIds.length
          ? 'no configured drops'
          : !nextFrontendDropIds.length
            ? 'the frontend deployment config with no drops'
            : 'the functions deployment config with no drops'
      }.`,
    );
  }

  const trackedFiles = listTrackedFiles(args.root);
  const canonicalDeleteRelPaths = sortStrings(
    trackedFiles.filter((relPath) => isCanonicalDropFile(relPath, args.dropId) || relPath === `scripts/discounts/${args.dropId}.csv`),
  );
  const allowedReferencePaths = new Set<string>([
    path.relative(args.root, frontendConfigPath),
    path.relative(args.root, functionsConfigPath),
    ...canonicalDeleteRelPaths,
  ]);
  const dropIdTokenRegex = buildDropIdTokenRegex(args.dropId);
  const extraReferences = sortStrings(
    trackedFiles.filter((relPath) => {
      if (allowedReferencePaths.has(relPath)) return false;
      if (isPreservedDropConfigFile(relPath)) return false;
      if (hasDropIdToken(relPath, dropIdTokenRegex)) return true;
      return fileContainsDropIdToken(path.join(args.root, relPath), dropIdTokenRegex);
    }),
  );

  return {
    frontendConfigPath,
    functionsConfigPath,
    frontendDropsNext,
    functionsDropsNext,
    frontendConfigWillChange: Boolean(frontendRegistry.drops[args.dropId]),
    functionsConfigWillChange: Boolean(functionsRegistry.drops[args.dropId]),
    canonicalDeleteRelPaths,
    canonicalDeleteAbsPaths: canonicalDeleteRelPaths.map((relPath) => path.join(args.root, relPath)),
    extraReferences,
  };
}

function extractClaimCodesFromDeliveryOrders(orderData: unknown): string[] {
  if (!orderData || typeof orderData !== 'object') return [];
  const irlClaims = Array.isArray((orderData as any).irlClaims) ? (orderData as any).irlClaims : [];
  return irlClaims
    .map((entry) => normalizeClaimCode((entry as any)?.code))
    .filter((code): code is string => Boolean(code));
}

async function buildFirestorePlan(dropId: string, knownDropIds: string[]): Promise<FirestorePlan> {
  const [claimCodesByDropId, claimCodesFromAssignments, claimCodesFromDeliveryOrders, firestoreDropIds] = await Promise.all([
    listClaimCodesByDropId(dropId),
    listBoxAssignmentClaimCodes(dropId),
    listDeliveryOrderClaimCodes(dropId),
    listDropIds(),
  ]);

  const claimCodesByDropIdSet = new Set<string>(claimCodesByDropId);
  const claimCodesFromAssignmentsSet = new Set<string>(claimCodesFromAssignments);
  const claimCodesFromDeliveryOrdersSet = new Set<string>(claimCodesFromDeliveryOrders);
  const claimCodesToInspect = sortStrings([
    ...claimCodesByDropId,
    ...claimCodesFromAssignments,
    ...claimCodesFromDeliveryOrders,
  ]);

  const dropIdsToInspect = sortStrings([...knownDropIds, ...firestoreDropIds]);
  const assignmentOwnerDropIdsByCode = await findAssignmentOwnerDropIdsByCode({
    dropIds: dropIdsToInspect,
    targetDropId: dropId,
    targetClaimCodes: claimCodesFromAssignments,
    codesToInspect: claimCodesToInspect,
  });
  const claimDocByCode = await loadClaimDocs(claimCodesToInspect);

  const conflicts: string[] = [];
  for (const code of claimCodesToInspect) {
    const doc = claimDocByCode.get(code);
    if (!doc) continue;

    const assignmentOwnerDropIds = sortStrings(assignmentOwnerDropIdsByCode.get(code) || []);
    const foreignAssignmentOwners = assignmentOwnerDropIds.filter((ownerDropId) => ownerDropId !== dropId);
    if (foreignAssignmentOwners.length) {
      conflicts.push(`claimCodes/${code} is referenced by drop(s): ${foreignAssignmentOwners.join(', ')}`);
      continue;
    }

    const explicitDropId = normalizeMaybeDropId(doc.data.dropId);
    if (explicitDropId && explicitDropId !== dropId) {
      conflicts.push(`claimCodes/${code} belongs to ${explicitDropId}`);
      continue;
    }

    if (!explicitDropId && !assignmentOwnerDropIds.includes(dropId)) {
      const sources = sortStrings([
        ...(claimCodesByDropIdSet.has(code) ? ['claimCodes.dropId query'] : []),
        ...(claimCodesFromAssignmentsSet.has(code) ? ['drops/<drop>/boxAssignments'] : []),
        ...(claimCodesFromDeliveryOrdersSet.has(code) ? ['drops/<drop>/deliveryOrders.irlClaims'] : []),
      ]);
      conflicts.push(
        `claimCodes/${code} has no dropId and no boxAssignments ownership signal (sources: ${sources.join(', ') || 'unknown'})`,
      );
    }
  }

  if (conflicts.length) {
    fail(
      `Refusing to wipe ${dropId} because some claim codes are not uniquely owned by that drop:\n` +
        conflicts.map((entry) => `- ${entry}`).join('\n'),
    );
  }

  return {
    claimCodesByDropId,
    claimCodesFromAssignments,
    claimCodesFromDeliveryOrders,
    claimCodesToDelete: sortStrings(claimDocByCode.keys()),
    missingClaimCodes: sortStrings(claimCodesToInspect.filter((code) => !claimDocByCode.has(code))),
    recursiveDeletePath: `drops/${dropId}`,
  };
}

function printPlan(args: {
  dropId: string;
  dryRun: boolean;
  repoPlan: RepoPlan;
  firestorePlan: FirestorePlan;
}) {
  const { repoPlan, firestorePlan } = args;

  console.log(`wipe-drop plan for ${args.dropId}`);
  console.log(`mode: ${args.dryRun ? 'dry-run' : 'execute after confirmation'}`);
  console.log('');

  console.log('codebase');
  if (repoPlan.frontendConfigWillChange) {
    console.log(`- update src/config/deployment.ts`);
  } else {
    console.log('- src/config/deployment.ts: no changes');
  }
  if (repoPlan.functionsConfigWillChange) {
    console.log(`- update functions/src/config/deployment.ts`);
  } else {
    console.log('- functions/src/config/deployment.ts: no changes');
  }
  if (repoPlan.canonicalDeleteRelPaths.length) {
    repoPlan.canonicalDeleteRelPaths.forEach((relPath) => {
      console.log(`- delete ${relPath}`);
    });
  } else {
    console.log('- canonical drop files: none found');
  }

  console.log('');
  console.log('firestore');
  console.log(`- claimCodes where dropId == ${args.dropId}: ${firestorePlan.claimCodesByDropId.length}`);
  console.log(`- claim codes from boxAssignments: ${firestorePlan.claimCodesFromAssignments.length}`);
  console.log(`- claim codes from deliveryOrders.irlClaims: ${firestorePlan.claimCodesFromDeliveryOrders.length}`);
  console.log(`- claimCodes docs to delete: ${firestorePlan.claimCodesToDelete.length}`);
  if (firestorePlan.missingClaimCodes.length) {
    console.log(`- referenced claimCodes already absent: ${firestorePlan.missingClaimCodes.length}`);
  }
  console.log(`- recursive delete: ${firestorePlan.recursiveDeletePath}`);
}

async function promptForConfirmation(): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail('Interactive confirmation requires a TTY. Re-run with --yes or --dry-run.');
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question("Type 'wipe' to continue: ")).trim().toLowerCase();
    return answer === 'wipe';
  } finally {
    rl.close();
  }
}

function applyRepoWipe(plan: RepoPlan): void {
  if (plan.frontendConfigWillChange) {
    writeFrontendDeploymentRegistryFile({
      filePath: plan.frontendConfigPath,
      drops: plan.frontendDropsNext,
    });
  }
  if (plan.functionsConfigWillChange) {
    writeFunctionsDeploymentRegistryFile({
      filePath: plan.functionsConfigPath,
      drops: plan.functionsDropsNext,
    });
  }
  plan.canonicalDeleteAbsPaths.forEach((absPath) => {
    if (existsSync(absPath)) rmSync(absPath, { force: true });
  });
}

async function applyFirestoreWipe(dropId: string, plan: FirestorePlan): Promise<void> {
  await withFirestoreFallback(
    async () => {
      const db = adminDb();

      if (plan.claimCodesToDelete.length) {
        const writer = db.bulkWriter();
        writer.onWriteError((err) => {
          console.error(`claimCodes delete failed for ${err.documentRef.path}: ${err.message}`);
          return false;
        });
        plan.claimCodesToDelete.forEach((code) => {
          writer.delete(db.doc(`claimCodes/${code}`));
        });
        await writer.close();
      }

      await db.recursiveDelete(db.doc(`drops/${dropId}`));
    },
    async () => {
      await mapLimit(plan.claimCodesToDelete, 8, async (code) => deleteDocumentViaRest(`claimCodes/${code}`));
      await recursiveDeleteDocumentViaRest(`drops/${dropId}`);
    },
  );
}

function looksLikeCredentialError(message: string): boolean {
  return /Could not load the default credentials|Failed to determine service account|credential implementation provided|Failed to read credentials from file|No Firebase CLI refresh token available|firebase login:list failed/i.test(
    message,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = repoRoot();
  const repoPlan = await buildRepoPlan({ root, dropId: args.dropId });

  if (repoPlan.extraReferences.length) {
    fail(
      `Found additional tracked references to ${args.dropId} outside the canonical wipe paths:\n` +
        repoPlan.extraReferences.map((relPath) => `- ${relPath}`).join('\n') +
        `\nRemove or rename those references first, then retry.`,
    );
  }

  const knownDropIds = sortStrings([
    ...Object.keys(repoPlan.frontendDropsNext),
    ...Object.keys(repoPlan.functionsDropsNext),
    args.dropId,
  ]);
  const firestorePlan = await buildFirestorePlan(args.dropId, knownDropIds);
  printPlan({ dropId: args.dropId, dryRun: args.dryRun, repoPlan, firestorePlan });

  if (args.dryRun) {
    console.log('');
    console.log('dry-run complete; no changes made');
    return;
  }

  if (!args.yes) {
    console.log('');
    const confirmed = await promptForConfirmation();
    if (!confirmed) {
      console.log('cancelled');
      return;
    }
  }

  await applyFirestoreWipe(args.dropId, firestorePlan);
  applyRepoWipe(repoPlan);

  console.log('');
  console.log(
    `wipe complete: removed ${args.dropId} from local config, deleted ${repoPlan.canonicalDeleteRelPaths.length} canonical file(s), ` +
      `deleted ${firestorePlan.claimCodesToDelete.length} claimCodes doc(s), and recursively deleted ${firestorePlan.recursiveDeletePath}`,
  );
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  if (looksLikeCredentialError(message)) {
    console.error(
      'Firestore access is unavailable. Set GOOGLE_APPLICATION_CREDENTIALS/local ADC or authenticate with `firebase login`, then retry.',
    );
  }
  console.error(message);
  process.exit(1);
});
