import { getApps, initializeApp } from 'firebase-admin/app';
import { Timestamp, getFirestore } from 'firebase-admin/firestore';
import {
  findConfirmedDeliverySignatureForDeliveryOrder,
  hasConfirmedDeliveryRecordForDeliveryOrder,
  retryIssueReceiptsForDeliveryOrder,
} from '../src/index.ts';
import { FUNCTIONS_DROPS } from '../src/config/deployment.ts';

type Args = {
  dropId?: string;
  deliveryId?: number;
  limit?: number;
};

type DeliveryOrderCandidate = {
  docPath: string;
  dropId: string;
  deliveryId: number;
  ownerWallet: string;
  signature: string;
  deliveryPda?: string;
  itemIds: string[];
  status: string;
  createdAt?: string;
  processingAt?: string;
};

type RetryPlan =
  | {
      verification: 'signature';
      signature: string;
      signatureSource: 'stored' | 'discovered';
    }
  | {
      verification: 'delivery_pda';
      signatureSource: 'delivery_pda';
    };

const RECOVERABLE_STATUSES = ['processing', 'prepared', 'prepared_abandoned'] as const;
const RECOVERABLE_STATUS_SET = new Set<string>(RECOVERABLE_STATUSES);
const STATUS_SORT_RANK = new Map<string, number>([
  ['processing', 0],
  ['prepared_abandoned', 1],
  ['prepared', 2],
]);
const KNOWN_DROP_IDS = new Set(Object.keys(FUNCTIONS_DROPS));

function usage(): string {
  return [
    'Retry `issueReceipts` for Firestore delivery orders that are stuck in `processing`,',
    '`prepared`, or `prepared_abandoned` even though their delivery transaction already landed on-chain.',
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

function requireEnv(name: string, hint: string): string {
  const value = String(process.env[name] || '').trim();
  if (!value) fail(`${name} is not set. ${hint}`);
  return value;
}

function requireRuntimeEnv() {
  requireEnv('COSIGNER_SECRET', 'Set it in functions/.env.local or export it in your shell before running this script.');
  requireEnv('HELIUS_API_KEY', 'Set it in functions/.env.local or export it in your shell before running this script.');
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
      args.dropId = normalizeDropIdArg(value);
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

function normalizeDropIdArg(value: string): string {
  return String(value || '').trim().toLowerCase();
}

function dropIdSearchIds(dropId: string | undefined): string[] {
  const normalized = normalizeDropIdArg(dropId || '');
  if (!normalized) return [];

  const candidates = [normalized];
  const underscoreAlias = normalized.replace(/-/g, '_');
  if (underscoreAlias !== normalized && KNOWN_DROP_IDS.has(underscoreAlias)) {
    candidates.push(underscoreAlias);
  }

  return [...new Set(candidates)];
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

function buildCandidate(doc: { id: string; ref: { path: string }; data(): any }): DeliveryOrderCandidate {
  const data = doc.data() || {};
  const deliveryId = Number(data.deliveryId ?? doc.id);
  return {
    docPath: doc.ref.path,
    dropId: typeof data.dropId === 'string' && data.dropId.trim() ? data.dropId : dropIdFromDocPath(doc.ref.path),
    deliveryId,
    ownerWallet: typeof data.owner === 'string' ? data.owner : '',
    signature: typeof data.deliverySignature === 'string' ? data.deliverySignature : '',
    deliveryPda: typeof data.deliveryPda === 'string' && data.deliveryPda.trim() ? data.deliveryPda : undefined,
    itemIds: Array.isArray(data.itemIds) ? data.itemIds.filter((id: unknown): id is string => typeof id === 'string' && !!id) : [],
    status: deliveryOrderStatus(data),
    createdAt: toIsoMaybe(data.createdAt),
    processingAt: toIsoMaybe(data.processingAt),
  };
}

function sortCandidates(a: DeliveryOrderCandidate, b: DeliveryOrderCandidate): number {
  if (a.status !== b.status) {
    const aRank = STATUS_SORT_RANK.get(a.status) ?? Number.MAX_SAFE_INTEGER;
    const bRank = STATUS_SORT_RANK.get(b.status) ?? Number.MAX_SAFE_INTEGER;
    if (aRank !== bRank) return aRank - bRank;
  }
  const aTime = Date.parse(a.processingAt || a.createdAt || '') || 0;
  const bTime = Date.parse(b.processingAt || b.createdAt || '') || 0;
  if (aTime !== bTime) return aTime - bTime;
  return a.docPath.localeCompare(b.docPath);
}

function deliveryOrderStatus(data: any): string {
  if (typeof data?.status === 'string' && data.status.trim()) return data.status.trim();
  if (typeof data?.receiptRecovery?.status === 'string' && data.receiptRecovery.status.trim()) {
    return data.receiptRecovery.status.trim();
  }
  return '';
}

function isRecoverableDoc(doc: { data(): any }): boolean {
  return RECOVERABLE_STATUS_SET.has(deliveryOrderStatus(doc.data() || {}));
}

function uniqueDocsByPath<T extends { ref: { path: string } }>(docs: T[]): T[] {
  const byPath = new Map<string, T>();
  for (const doc of docs) {
    if (!byPath.has(doc.ref.path)) byPath.set(doc.ref.path, doc);
  }
  return [...byPath.values()];
}

async function loadDocsForRecoverableStatuses(query: FirebaseFirestore.Query) {
  const snaps = await Promise.all(
    RECOVERABLE_STATUSES.flatMap((status) => [
      query.where('status', '==', status).get(),
      query.where('receiptRecovery.status', '==', status).get(),
    ]),
  );
  return uniqueDocsByPath(snaps.flatMap((snap) => snap.docs)).filter(isRecoverableDoc);
}

async function loadMatchingDocs(args: Args) {
  const app = getApps()[0] || initializeApp();
  const db = getFirestore(app);
  const dropIds = dropIdSearchIds(args.dropId);

  if (dropIds.length && args.deliveryId != null) {
    const docs = await Promise.all(dropIds.map((dropId) => db.doc(`drops/${dropId}/deliveryOrders/${args.deliveryId}`).get()));
    return uniqueDocsByPath(docs.filter((doc) => doc.exists && isRecoverableDoc(doc)));
  }

  if (dropIds.length) {
    const docs = await Promise.all(dropIds.map((dropId) => loadDocsForRecoverableStatuses(db.collection(`drops/${dropId}/deliveryOrders`))));
    return uniqueDocsByPath(docs.flat());
  }

  return loadDocsForRecoverableStatuses(db.collectionGroup('deliveryOrders'));
}

async function buildRetryPlan(candidate: DeliveryOrderCandidate): Promise<RetryPlan | null> {
  if (candidate.status === 'processing') {
    // Preserve the historical processing-order recovery behavior and only add
    // prepared-order probing in this script change.
    return {
      verification: 'delivery_pda',
      signatureSource: 'delivery_pda',
    };
  }

  if (candidate.status !== 'prepared' && candidate.status !== 'prepared_abandoned') return null;

  const hasDeliveryRecord = await hasConfirmedDeliveryRecordForDeliveryOrder({
    dropId: candidate.dropId,
    deliveryId: candidate.deliveryId,
    deliveryPda: candidate.deliveryPda,
  });
  if (!hasDeliveryRecord) return null;

  const discoveredSignature = await findConfirmedDeliverySignatureForDeliveryOrder({
    ownerWallet: candidate.ownerWallet,
    deliveryId: candidate.deliveryId,
    dropId: candidate.dropId,
    deliveryPda: candidate.deliveryPda,
    itemIds: candidate.itemIds,
  });
  if (discoveredSignature) {
    return {
      verification: 'signature',
      signature: discoveredSignature,
      signatureSource: 'discovered',
    };
  }

  return {
    verification: 'delivery_pda',
    signatureSource: 'delivery_pda',
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rawDocs = await loadMatchingDocs(args);
  const candidates = rawDocs.map((doc) => buildCandidate(doc)).sort(sortCandidates);
  const limited = args.limit ? candidates.slice(0, args.limit) : candidates;

  if (!limited.length) {
    console.log('No delivery orders in processing/prepared/prepared_abandoned status matched the requested scope.');
    return;
  }

  requireRuntimeEnv();

  const app = getApps()[0] || initializeApp();
  const db = getFirestore(app);

  console.log(`Found ${limited.length} recoverable delivery order(s).`);

  let attemptedCount = 0;
  let successCount = 0;
  let failureCount = 0;
  let skippedCount = 0;

  for (let index = 0; index < limited.length; index += 1) {
    const candidate = limited[index];
    const startedAt = Date.now();
    let retryPlan: RetryPlan | null = null;

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
          deliveryPda: candidate.deliveryPda || null,
          itemIds: candidate.itemIds,
          statusBefore: candidate.status || null,
          createdAt: candidate.createdAt || null,
          processingAt: candidate.processingAt || null,
        },
        null,
        2,
      ),
    );

    try {
      retryPlan = await buildRetryPlan(candidate);
      if (!retryPlan) {
        console.log(
          JSON.stringify(
            {
              outcome: 'skipped',
              durationMs: Date.now() - startedAt,
              statusAfter: candidate.status || null,
              reason: 'no_confirmed_delivery_found',
            },
            null,
            2,
          ),
        );
        skippedCount += 1;
        continue;
      }

      attemptedCount += 1;
      const result = await retryIssueReceiptsForDeliveryOrder({
        ownerWallet: candidate.ownerWallet,
        deliveryId: candidate.deliveryId,
        dropId: candidate.dropId,
        ...(retryPlan.verification === 'signature'
          ? {
              verification: 'signature' as const,
              signature: retryPlan.signature,
            }
          : {
              verification: 'delivery_pda' as const,
            }),
      });
      const fresh = await db.doc(candidate.docPath).get();
      const freshData = fresh.data() || {};
      console.log(
        JSON.stringify(
          {
            outcome: 'success',
            durationMs: Date.now() - startedAt,
            verification: retryPlan.verification,
            signatureUsed: retryPlan.verification === 'signature' ? retryPlan.signature : null,
            signatureSource: retryPlan.signatureSource,
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
            ...(retryPlan
              ? {
                  verification: retryPlan.verification,
                  signatureUsed: retryPlan.verification === 'signature' ? retryPlan.signature : null,
                  signatureSource: retryPlan.signatureSource,
                }
              : {}),
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
        attempted: attemptedCount,
        succeeded: successCount,
        failed: failureCount,
        skipped: skippedCount,
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
