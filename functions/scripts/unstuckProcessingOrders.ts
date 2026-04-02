import { getApps, initializeApp } from 'firebase-admin/app';
import { Timestamp, getFirestore } from 'firebase-admin/firestore';
import { retryIssueReceiptsForDeliveryOrder } from '../lib/index.js';

type Args = {
  dropId?: string;
  deliveryId?: number;
  limit?: number;
};

type ProcessingOrderCandidate = {
  docPath: string;
  dropId: string;
  deliveryId: number;
  ownerWallet: string;
  signature: string;
  status: string;
  createdAt?: string;
  processingAt?: string;
};

function usage(): string {
  return [
    'Retry `issueReceipts` for Firestore delivery orders stuck in `processing`.',
    '',
    'Usage:',
    '  npm run unstuck-processing-orders',
    '  npm run unstuck-processing-orders -- --drop-id <dropId>',
    '  npm run unstuck-processing-orders -- --drop-id <dropId> --delivery-id <id>',
    '  npm run unstuck-processing-orders -- --limit 10',
    '',
    'Options:',
    '  --drop-id <id>      Restrict to one drop',
    '  --delivery-id <id>  Restrict to one delivery id (requires --drop-id)',
    '  --limit <n>         Process at most n matching orders',
    '  -h, --help          Show this help',
  ].join('\n');
}

function fail(message: string): never {
  throw new Error(message);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '-h' || arg === '--help') {
      console.log(usage());
      process.exit(0);
    }

    if (arg === '--drop-id') {
      const value = argv[i + 1];
      if (!value) fail(`Missing value for ${arg}\n\n${usage()}`);
      args.dropId = value.trim().toLowerCase();
      i += 1;
      continue;
    }

    if (arg === '--delivery-id') {
      const value = Number(argv[i + 1]);
      if (!Number.isFinite(value) || value <= 0) fail(`Invalid value for ${arg}\n\n${usage()}`);
      args.deliveryId = Math.floor(value);
      i += 1;
      continue;
    }

    if (arg === '--limit') {
      const value = Number(argv[i + 1]);
      if (!Number.isFinite(value) || value <= 0) fail(`Invalid value for ${arg}\n\n${usage()}`);
      args.limit = Math.floor(value);
      i += 1;
      continue;
    }

    fail(`Unknown arg: ${arg}\n\n${usage()}`);
  }

  if (args.deliveryId != null && !args.dropId) {
    fail(`--delivery-id requires --drop-id\n\n${usage()}`);
  }

  return args;
}

function toIsoMaybe(value: unknown): string | undefined {
  if (!value) return undefined;
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  if (typeof (value as any)?.toDate === 'function') {
    try {
      const date = (value as any).toDate();
      if (date instanceof Date && Number.isFinite(date.getTime())) return date.toISOString();
    } catch {
      // Ignore.
    }
  }
  if (typeof (value as any)?.toMillis === 'function') {
    try {
      const millis = Number((value as any).toMillis());
      if (Number.isFinite(millis)) return new Date(millis).toISOString();
    } catch {
      // Ignore.
    }
  }
  return undefined;
}

function safeJsonValue(value: unknown): unknown {
  if (value == null) return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function summarizeError(err: unknown) {
  const anyErr = err as any;
  return {
    name: err instanceof Error ? err.name : typeof err,
    message: err instanceof Error ? err.message : String(err),
    code: typeof anyErr?.code === 'string' ? anyErr.code : undefined,
    details: anyErr?.details != null ? safeJsonValue(anyErr.details) : undefined,
    logs: Array.isArray(anyErr?.logs) ? anyErr.logs.map((entry: unknown) => String(entry)) : undefined,
    stack: err instanceof Error && typeof err.stack === 'string' ? err.stack.split('\n').slice(0, 8) : undefined,
  };
}

function dropIdFromDocPath(docPath: string): string {
  const parts = String(docPath || '').split('/');
  if (parts.length === 4 && parts[0] === 'drops' && parts[2] === 'deliveryOrders' && parts[1]) {
    return parts[1];
  }
  fail(`Unexpected delivery order path: ${docPath}`);
}

function buildCandidate(doc: { id: string; ref: { path: string }; data(): any }): ProcessingOrderCandidate {
  const data = doc.data() || {};
  const deliveryId = Number(data.deliveryId ?? doc.id);
  return {
    docPath: doc.ref.path,
    dropId: typeof data.dropId === 'string' && data.dropId.trim() ? data.dropId : dropIdFromDocPath(doc.ref.path),
    deliveryId,
    ownerWallet: typeof data.owner === 'string' ? data.owner : '',
    signature: typeof data.deliverySignature === 'string' ? data.deliverySignature : '',
    status: typeof data.status === 'string' ? data.status : '',
    createdAt: toIsoMaybe(data.createdAt),
    processingAt: toIsoMaybe(data.processingAt),
  };
}

function sortCandidates(a: ProcessingOrderCandidate, b: ProcessingOrderCandidate): number {
  const aTime = Date.parse(a.processingAt || a.createdAt || '') || 0;
  const bTime = Date.parse(b.processingAt || b.createdAt || '') || 0;
  if (aTime !== bTime) return aTime - bTime;
  return a.docPath.localeCompare(b.docPath);
}

async function loadMatchingDocs(args: Args) {
  const app = getApps()[0] || initializeApp();
  const db = getFirestore(app);

  if (args.dropId && args.deliveryId != null) {
    const doc = await db.doc(`drops/${args.dropId}/deliveryOrders/${args.deliveryId}`).get();
    if (!doc.exists) return [];
    const status = doc.get('status');
    return status === 'processing' ? [doc] : [];
  }

  if (args.dropId) {
    const snap = await db.collection(`drops/${args.dropId}/deliveryOrders`).where('status', '==', 'processing').get();
    return snap.docs;
  }

  const snap = await db.collectionGroup('deliveryOrders').where('status', '==', 'processing').get();
  return snap.docs;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rawDocs = await loadMatchingDocs(args);
  const candidates = rawDocs.map((doc) => buildCandidate(doc)).sort(sortCandidates);
  const limited = args.limit ? candidates.slice(0, args.limit) : candidates;

  if (!limited.length) {
    console.log('No delivery orders in processing status matched the requested scope.');
    return;
  }

  const app = getApps()[0] || initializeApp();
  const db = getFirestore(app);

  console.log(`Found ${limited.length} processing delivery order(s).`);

  let successCount = 0;
  let failureCount = 0;

  for (let index = 0; index < limited.length; index += 1) {
    const candidate = limited[index];
    const startedAt = Date.now();

    console.log('');
    console.log('='.repeat(80));
    console.log(`[${index + 1}/${limited.length}] ${candidate.docPath}`);
    console.log(
      JSON.stringify(
        {
          dropId: candidate.dropId,
          deliveryId: candidate.deliveryId,
          ownerWallet: candidate.ownerWallet || null,
          signature: candidate.signature || null,
          statusBefore: candidate.status || null,
          createdAt: candidate.createdAt || null,
          processingAt: candidate.processingAt || null,
        },
        null,
        2,
      ),
    );

    try {
      const result = await retryIssueReceiptsForDeliveryOrder({
        ownerWallet: candidate.ownerWallet,
        deliveryId: candidate.deliveryId,
        signature: candidate.signature,
        dropId: candidate.dropId,
      });
      const fresh = await db.doc(candidate.docPath).get();
      const freshData = fresh.data() || {};
      console.log(
        JSON.stringify(
          {
            outcome: 'success',
            durationMs: Date.now() - startedAt,
            statusAfter: typeof freshData.status === 'string' ? freshData.status : null,
            processedAt: toIsoMaybe(freshData.processedAt) || null,
            receiptsMinted: result.receiptsMinted,
            receiptTxCount: result.receiptTxs.length,
            receiptTxs: result.receiptTxs,
            closeDeliveryTx: result.closeDeliveryTx,
          },
          null,
          2,
        ),
      );
      successCount += 1;
    } catch (err) {
      const fresh = await db.doc(candidate.docPath).get().catch(() => null);
      const freshData = fresh?.data() || {};
      console.error(
        JSON.stringify(
          {
            outcome: 'failure',
            durationMs: Date.now() - startedAt,
            statusAfter: typeof freshData.status === 'string' ? freshData.status : null,
            processedAt: toIsoMaybe(freshData.processedAt) || null,
            error: summarizeError(err),
          },
          null,
          2,
        ),
      );
      failureCount += 1;
    }
  }

  console.log('');
  console.log('Summary');
  console.log(
    JSON.stringify(
      {
        matched: limited.length,
        succeeded: successCount,
        failed: failureCount,
      },
      null,
      2,
    ),
  );

  if (failureCount > 0) {
    process.exitCode = 1;
  }
}

void main().catch((err) => {
  console.error(JSON.stringify({ fatal: true, error: summarizeError(err) }, null, 2));
  process.exitCode = 1;
});
