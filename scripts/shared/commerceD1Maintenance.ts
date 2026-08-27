import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCommerceDocumentSegment } from '../../shared/commerceDocumentPath.ts';

export type CommerceD1Row = Record<string, unknown>;

export type CommerceD1DocumentKind =
  | 'delivery_order'
  | 'stripe_checkout'
  | 'claim_code'
  | 'box_assignment'
  | 'dude_assignment'
  | 'dude_pool'
  | 'offchain_order'
  | 'admin_irl_redeem_request'
  | 'admin_irl_redeem_pack_marker'
  | 'admin_irl_redeem_receipt_marker';

export type CommerceD1Document = {
  data: Record<string, unknown>;
  documentId: string;
  dropId: string | null;
  kind: CommerceD1DocumentKind;
  path: string;
  version: number;
  createTime: string;
  updateTime: string;
};

export type CommerceD1Authority = {
  state: 'paused' | 'd1';
  revision: number;
  documentsRevision: number;
  pausedAtMs: number | null;
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const configPath = 'cloud/workers/api/wrangler.jsonc';
const envFilePath = 'cloud/workers/api/release.env';
const databaseName = 'mons-shop-commerce';
const WRANGLER_COMMAND_TIMEOUT_MS = 10 * 60_000;
const wranglerBinary = resolve(
  repoRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler',
);

function fail(message: string): never {
  throw new Error(message);
}

function runWrangler(args: string[], json = true): string {
  try {
    return execFileSync(
      wranglerBinary,
      [
        ...args,
        '--config',
        configPath,
        '--env-file',
        envFilePath,
        ...(json ? ['--json'] : []),
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: process.env,
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: WRANGLER_COMMAND_TIMEOUT_MS,
      },
    ).trim();
  } catch (error) {
    const output = error && typeof error === 'object'
      ? [
          'stdout' in error ? (error as { stdout?: unknown }).stdout : '',
          'stderr' in error ? (error as { stderr?: unknown }).stderr : '',
        ]
          .map((value) => String(value || '').replace(/\u001b\[[0-9;]*m/g, '').trim())
          .filter(Boolean)
          .join('\n')
      : '';
    return fail(output || 'Wrangler Commerce D1 command failed.');
  }
}

function parseEnvelope(output: string): CommerceD1Row[][] {
  let parsed: unknown;
  try {
    const jsonStart = output.indexOf('[');
    parsed = JSON.parse(jsonStart >= 0 ? output.slice(jsonStart) : output);
  } catch {
    return fail('Commerce D1 returned invalid JSON.');
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return fail('Commerce D1 returned an invalid result envelope.');
  return parsed.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return fail('Commerce D1 returned an invalid result.');
    const result = entry as { results?: unknown; success?: unknown };
    if (result.success !== true || !Array.isArray(result.results)) return fail('Commerce D1 query failed.');
    return result.results as CommerceD1Row[];
  });
}

export function queryRemoteCommerceD1(sql: string): CommerceD1Row[] {
  const results = parseEnvelope(runWrangler([
    'd1',
    'execute',
    databaseName,
    '--remote',
    '--command',
    sql,
  ]));
  if (results.length !== 1) return fail('Expected exactly one Commerce D1 statement result.');
  return results[0];
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) return fail(`${label} is invalid.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function commerceD1DocumentIdentity(path: string): {
  documentId: string;
  dropId: string | null;
  kind: CommerceD1DocumentKind;
} | null {
  const segments = path.split('/');
  if (segments.length === 2 && segments[0] === 'claimCodes' && isCommerceDocumentSegment(segments[1])) {
    return { kind: 'claim_code', dropId: null, documentId: segments[1] };
  }
  if (segments.length !== 4 || segments[0] !== 'drops' ||
    !isCommerceDocumentSegment(segments[1]) || !isCommerceDocumentSegment(segments[3])) return null;
  const kind = new Map<string, CommerceD1DocumentKind>([
    ['deliveryOrders', 'delivery_order'],
    ['stripeCheckouts', 'stripe_checkout'],
    ['boxAssignments', 'box_assignment'],
    ['dudeAssignments', 'dude_assignment'],
    ['offchainOrders', 'offchain_order'],
    ['adminIrlRedeemRequests', 'admin_irl_redeem_request'],
    ['adminIrlRedeemPackMarkers', 'admin_irl_redeem_pack_marker'],
    ['adminIrlRedeemReceiptMarkers', 'admin_irl_redeem_receipt_marker'],
  ]).get(segments[2]);
  if (kind) return { kind, dropId: segments[1], documentId: segments[3] };
  if (segments[2] === 'meta' && segments[3] === 'dudePool') {
    return { kind: 'dude_pool', dropId: segments[1], documentId: segments[3] };
  }
  return null;
}

export function parseCommerceD1DocumentRow(row: CommerceD1Row): CommerceD1Document {
  const path = requiredString(row.document_path, 'Commerce D1 document path');
  const identity = commerceD1DocumentIdentity(path);
  if (!identity) return fail(`Commerce D1 document path is unsupported: ${path}.`);
  const kind = requiredString(row.document_kind, `${path} document kind`);
  const documentId = requiredString(row.document_id, `${path} document id`);
  const dropId = row.drop_id === null ? null : requiredString(row.drop_id, `${path} drop id`);
  const version = safeInteger(row.version, `${path} version`);
  if (version < 1) return fail(`${path} version is invalid.`);
  const createTime = requiredString(row.create_time, `${path} creation time`);
  const updateTime = requiredString(row.update_time, `${path} update time`);
  if (
    kind !== identity.kind ||
    documentId !== identity.documentId ||
    dropId !== identity.dropId ||
    !Number.isFinite(Date.parse(createTime)) ||
    !Number.isFinite(Date.parse(updateTime))
  ) return fail(`Commerce D1 document identity is inconsistent: ${path}.`);
  let data: unknown;
  try {
    data = JSON.parse(requiredString(row.document_json, `${path} document JSON`));
  } catch {
    return fail(`Commerce D1 document JSON is invalid: ${path}.`);
  }
  if (!isRecord(data)) return fail(`Commerce D1 document JSON is invalid: ${path}.`);
  return {
    data,
    documentId,
    dropId,
    kind: identity.kind,
    path,
    version,
    createTime,
    updateTime,
  };
}

export function queryRemoteCommerceDocuments(sql: string): CommerceD1Document[] {
  return queryRemoteCommerceD1(sql).map(parseCommerceD1DocumentRow);
}

export function readRemoteCommerceAuthority(): CommerceD1Authority {
  const rows = queryRemoteCommerceD1(`SELECT authority_state, revision, documents_revision, paused_at_ms
    FROM commerce_authority_control WHERE singleton = 1`);
  if (rows.length !== 1) return fail('Commerce D1 authority control is invalid.');
  const state = rows[0].authority_state;
  if (state !== 'paused' && state !== 'd1') {
    return fail('Commerce D1 authority state is invalid.');
  }
  return {
    state,
    revision: safeInteger(rows[0].revision, 'Commerce D1 authority revision'),
    documentsRevision: safeInteger(rows[0].documents_revision, 'Commerce D1 documents revision'),
    pausedAtMs: rows[0].paused_at_ms === null
      ? null
      : safeInteger(rows[0].paused_at_ms, 'Commerce D1 pause timestamp'),
  };
}

export function executeRemoteCommerceD1File(filePath: string): CommerceD1Row[][] {
  return parseEnvelope(runWrangler([
    'd1',
    'execute',
    databaseName,
    '--remote',
    '--file',
    filePath,
  ]));
}

export function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function safeInteger(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) return fail(`${label} is invalid.`);
  return number;
}
