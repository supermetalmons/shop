import { pathToFileURL } from 'node:url';
import {
  buildCommerceIdentityManifest,
  type CommerceIdentityDocument,
} from '../shared/commerceIdentityCanonicalization.ts';
import {
  commerceD1DocumentIdentity,
  queryRemoteCommerceD1,
} from '../shared/commerceD1Maintenance.ts';

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${label} is invalid.`);
  return value;
}

function parseDocument(row: Record<string, unknown>): CommerceIdentityDocument {
  const path = requiredString(row.document_path, 'Commerce document path');
  const kind = requiredString(row.document_kind, `${path} kind`);
  if (commerceD1DocumentIdentity(path)?.kind !== kind) throw new Error(`${path} identity is invalid.`);
  const createTime = requiredString(row.create_time, `${path} create time`);
  const updateTime = requiredString(row.update_time, `${path} update time`);
  const version = Number(row.version);
  if (!Number.isSafeInteger(version) || version < 1) throw new Error(`${path} version is invalid.`);
  let data: unknown;
  try {
    data = JSON.parse(requiredString(row.document_json, `${path} JSON`));
  } catch {
    throw new Error(`${path} JSON is invalid.`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${path} JSON is invalid.`);
  return { createTime, data: data as Record<string, unknown>, kind, path, updateTime, version };
}

export function readRemoteCommerceIdentityManifest() {
  const rows = queryRemoteCommerceD1(`SELECT
    document_path,
    document_kind,
    document_json,
    version,
    create_time,
    update_time
  FROM commerce_documents
  ORDER BY document_path`);
  return buildCommerceIdentityManifest(rows.map(parseDocument));
}

async function main(): Promise<void> {
  console.log(JSON.stringify(readRemoteCommerceIdentityManifest(), null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) await main();
