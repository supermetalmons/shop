import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createFirebaseCliFirestoreRestClient,
  decodeFirestoreRestDocument,
  encodeFirestoreRestFields,
  type FirestoreRestDocument,
} from '../shared/firebaseCliFirestoreRest.ts';
import { queryRemoteOpsD1 } from '../shared/opsD1Maintenance.ts';
import { canonicalWalletAddress } from '../../shared/walletLifecycle.ts';

const FIRESTORE_PROJECT_ID = 'mons-shop';
const FIRESTORE_DOCUMENT_PREFIX = `projects/${FIRESTORE_PROJECT_ID}/databases/(default)/documents/`;
const DELIVERY_ORDER_PAGE_SIZE = 250;
const client = createFirebaseCliFirestoreRestClient({ projectId: FIRESTORE_PROJECT_ID });

export type OwnershipMigrationArgs = {
  command: 'status' | 'apply';
  write: boolean;
};

export type WalletBinding = {
  firebaseUid: string;
  wallet: string;
};

export type OwnershipUpdate = {
  document: FirestoreRestDocument;
  firebaseUid: string;
  wallet: string;
};

export type OwnershipPlan = {
  scannedOrders: number;
  mappedUpdates: OwnershipUpdate[];
  unmappedFirebaseOrders: number;
};

export type OwnershipAudit = {
  scannedOrders: number;
  mappedUpdates: number;
  unmappedFirebaseOrders: number;
};

export function parseOwnershipMigrationArgs(argv: string[]): OwnershipMigrationArgs {
  const command = argv.find((value): value is 'status' | 'apply' => value === 'status' || value === 'apply');
  if (!command || argv.some((value) => !['status', 'apply', '--write'].includes(value))) {
    throw new Error('Usage: npm run migrate:firebase-wallet-ownership -- <status|apply> [--write]');
  }
  const write = argv.includes('--write');
  if (command === 'status' && write) throw new Error('The status command does not accept --write.');
  if (command === 'apply' && !write) throw new Error('Applying wallet ownership migration requires --write.');
  return { command, write };
}

export function parseWalletBinding(row: Record<string, unknown>): WalletBinding {
  const firebaseUid = typeof row.firebase_uid === 'string' ? row.firebase_uid : '';
  const wallet = canonicalWalletAddress(row.wallet);
  if (!firebaseUid || firebaseUid.length > 128 || !wallet || wallet !== row.wallet) {
    throw new Error('Ops D1 returned an invalid wallet binding.');
  }
  return { firebaseUid, wallet };
}

function walletBindings(): WalletBinding[] {
  return queryRemoteOpsD1(`SELECT firebase_uid, wallet
    FROM wallet_sessions
    ORDER BY firebase_uid`).map(parseWalletBinding);
}

export function buildDeliveryOrderOwnershipQuery(cursorPath: string | null): Record<string, unknown> {
  return {
    structuredQuery: {
      select: { fields: [{ fieldPath: 'owner' }] },
      from: [{ collectionId: 'deliveryOrders', allDescendants: true }],
      orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
      ...(cursorPath ? {
        startAt: {
          values: [{ referenceValue: `${FIRESTORE_DOCUMENT_PREFIX}${cursorPath}` }],
          before: false,
        },
      } : {}),
      limit: DELIVERY_ORDER_PAGE_SIZE,
    },
  };
}

export function decodeDeliveryOrderOwnershipPage(payload: unknown): FirestoreRestDocument[] {
  if (!Array.isArray(payload)) throw new Error('Firestore delivery-order query returned an invalid response.');
  const documents: FirestoreRestDocument[] = [];
  for (const entry of payload) {
    const document = decodeFirestoreRestDocument(entry?.document);
    if (!document) {
      if (typeof entry?.readTime === 'string' && entry.document === undefined) continue;
      throw new Error('Firestore returned an invalid delivery-order document.');
    }
    if (typeof document.data.owner !== 'string') {
      throw new Error('Firestore returned an invalid delivery-order owner.');
    }
    documents.push(document);
  }
  return documents;
}

export function buildOwnershipPlan(
  bindings: readonly WalletBinding[],
  orders: readonly FirestoreRestDocument[],
): OwnershipPlan {
  const walletByOwner = new Map(bindings.map(({ firebaseUid, wallet }) => [`firebase:${firebaseUid}`, { firebaseUid, wallet }]));
  const mappedUpdates: OwnershipUpdate[] = [];
  let unmappedFirebaseOrders = 0;
  for (const document of orders) {
    const owner = typeof document.data.owner === 'string' ? document.data.owner : '';
    if (!owner.startsWith('firebase:')) continue;
    const binding = walletByOwner.get(owner);
    if (!binding) {
      unmappedFirebaseOrders += 1;
      continue;
    }
    if (!/^drops\/[^/]+\/deliveryOrders\/[1-9]\d*$/.test(document.path) || !document.updateTime) {
      throw new Error('Firestore returned an invalid delivery-order document.');
    }
    mappedUpdates.push({ document, ...binding });
  }
  return { scannedOrders: orders.length, mappedUpdates, unmappedFirebaseOrders };
}

async function updateOwnership(update: OwnershipUpdate): Promise<void> {
  const fields = {
    owner: update.wallet,
    mergedFirebaseUid: update.firebaseUid,
    previousOwner: `firebase:${update.firebaseUid}`,
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await client.request({
        method: 'POST',
        url: client.documentsUrl(':commit'),
        body: {
          writes: [{
            update: {
              name: `${FIRESTORE_DOCUMENT_PREFIX}${update.document.path}`,
              fields: encodeFirestoreRestFields(fields),
            },
            updateMask: { fieldPaths: Object.keys(fields) },
            updateTransforms: [{ fieldPath: 'ownerMergedAt', setToServerValue: 'REQUEST_TIME' }],
            currentDocument: { updateTime: update.document.updateTime },
          }],
        },
      });
      return;
    } catch (error) {
      const currentRaw = await client.request({
        url: client.documentUrl(update.document.path),
        allow404: true,
      });
      const current = decodeFirestoreRestDocument(currentRaw);
      if (current?.data.owner === update.wallet) return;
      if (!current || current.data.owner !== `firebase:${update.firebaseUid}` || !current.updateTime || attempt === 2) throw error;
      update = { ...update, document: current };
    }
  }
}

async function mapLimit<T>(values: readonly T[], limit: number, operation: (value: T) => Promise<void>): Promise<void> {
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (index < values.length) {
      const current = values[index];
      index += 1;
      await operation(current);
    }
  }));
}

async function scanOwnership(
  applyUpdates: boolean,
): Promise<OwnershipAudit> {
  const bindings = walletBindings();
  const audit: OwnershipAudit = {
    scannedOrders: 0,
    mappedUpdates: 0,
    unmappedFirebaseOrders: 0,
  };
  let cursorPath: string | null = null;
  while (true) {
    const payload = await client.request({
      method: 'POST',
      url: client.documentsUrl(':runQuery'),
      body: buildDeliveryOrderOwnershipQuery(cursorPath),
    });
    const page = decodeDeliveryOrderOwnershipPage(payload);
    if (!page.length) break;
    const plan = buildOwnershipPlan(bindings, page);
    if (applyUpdates) await mapLimit(plan.mappedUpdates, 4, updateOwnership);
    audit.scannedOrders += plan.scannedOrders;
    audit.mappedUpdates += plan.mappedUpdates.length;
    audit.unmappedFirebaseOrders += plan.unmappedFirebaseOrders;
    const nextCursorPath = page.at(-1)!.path;
    if (nextCursorPath === cursorPath) {
      throw new Error('Firestore delivery-order pagination did not advance.');
    }
    cursorPath = nextCursorPath;
    if (page.length < DELIVERY_ORDER_PAGE_SIZE) break;
  }
  return audit;
}

export async function readOwnershipAudit(): Promise<OwnershipAudit> {
  return scanOwnership(false);
}

export async function runOwnershipMigration(args: OwnershipMigrationArgs): Promise<string> {
  const audit = await scanOwnership(args.command === 'apply');
  return [
    `Scanned delivery orders: ${audit.scannedOrders}.`,
    `${args.command === 'apply' ? 'Updated' : 'Mapped updates pending'}: ${audit.mappedUpdates}.`,
    `Unmapped Firebase-owned orders retained: ${audit.unmappedFirebaseOrders}.`,
  ].join(' ');
}

function isDirectRun(): boolean {
  return Boolean(process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href);
}

if (isDirectRun()) {
  runOwnershipMigration(parseOwnershipMigrationArgs(process.argv.slice(2)))
    .then((report) => console.log(report))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
