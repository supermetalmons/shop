import { existsSync, readFileSync } from 'node:fs';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getApps, initializeApp } from 'firebase-admin/app';
import { FieldPath, getFirestore, type DocumentSnapshot, type Firestore } from 'firebase-admin/firestore';
import { Resend } from 'resend';
import { FUNCTIONS_DROPS, normalizeDropId, requireFunctionsDrop } from '../src/config/deployment.ts';
import { dropDeliveryOrdersCollectionPath } from '../src/dropPaths.ts';
import {
  NOTIFICATION_EMAIL_FROM,
  buildShipperReadyToShipEmailContent,
  buildStripeCheckoutManualReviewEmailContent,
  fulfillmentAppUrlForOrder,
  summarizeShipperReadyOrderItems,
  type NotificationEmailContent,
} from '../src/notificationEmails.ts';
import { ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE } from '../src/stripeCheckout/contract.ts';
import { toMillisMaybe } from '../src/time.ts';

type TestEmailKind = 'shipper-ready' | 'stripe-manual-review';

type Args = {
  kind: TestEmailKind;
  dropId?: string;
};

type SelectedShipperReadyOrder = {
  docPath: string;
  dropId: string;
  dropName: string;
  deliveryId: number;
  owner: string;
  sortTimeMs?: number;
  storedDropIdMismatch?: string;
};

type ShipperReadyOrderCandidate = SelectedShipperReadyOrder & {
  order: any;
};

type BuiltTestEmail = {
  content: NotificationEmailContent;
  selectedOrder?: SelectedShipperReadyOrder;
};

const PROJECT_ID = 'mons-shop';
const RESEND_SECRET_NAME = 'RESEND_API_KEY';
const TEST_RECIPIENT = 'ivan@ivan.lol';
const TEST_DROP_ID = 'local_resend_test';
const TEST_DROP_NAME = 'Local Resend Test';
const DEFAULT_SHIPPER_READY_DROP_IDS = ['little_swag_boxes', 'poncho_drifella', 'little_swag_hoodies', 'card_nft_2'];
const LATEST_ORDER_QUERY_LIMIT = 50;
const DELIVERY_ORDER_FIELDS = [
  'dropId',
  'deliveryId',
  'source',
  'status',
  'owner',
  'items',
  'createdAt',
  'processingAt',
  'processedAt',
] as const;

function usage(): string {
  return [
    'Send one local Resend notification test email to ivan@ivan.lol.',
    '',
    'Usage:',
    '  npm run test-resend-notification-email',
    '  npm run test-resend-notification-email -- --drop_id card_nft_2',
    '  npm run test-resend-notification-email -- --kind shipper-ready',
    '  npm run test-resend-notification-email -- --kind shipper-ready --drop-id little_swag_hoodies',
    '  npm run test-resend-notification-email -- --kind stripe-manual-review',
    '',
    'Options:',
    '  --kind <kind>    shipper-ready or stripe-manual-review (default: shipper-ready)',
    '  --drop-id <id>   Restrict shipper-ready to one drop',
    '  --drop_id <id>   Alias for --drop-id',
    '  -h, --help       Show this help',
  ].join('\n');
}

function fail(message: string): never {
  throw new Error(message);
}

function normalizeKind(raw: string): TestEmailKind {
  const kind = raw.trim();
  if (kind === 'shipper-ready' || kind === 'stripe-manual-review') return kind;
  fail(`Invalid --kind: ${raw}\n\n${usage()}`);
}

function knownDropIds(): string[] {
  return Object.keys(FUNCTIONS_DROPS).sort((a, b) => a.localeCompare(b));
}

function resolveDropIdArg(raw: string): string {
  const normalized = normalizeDropId(raw);
  if (!normalized) fail(`Missing value for --drop-id\n\n${usage()}`);

  const underscoreAlias = normalized.replace(/-/g, '_');
  const candidates = [normalized, underscoreAlias].filter((candidate, index, all) => candidate && all.indexOf(candidate) === index);
  const found = candidates.find((candidate) => Boolean(FUNCTIONS_DROPS[candidate]));
  if (found) return found;

  fail(`Unknown --drop-id: ${raw}. Known drop IDs: ${knownDropIds().join(', ')}\n\n${usage()}`);
}

function parseArgs(argv: string[]): Args {
  const args: Args = { kind: 'shipper-ready' };
  let rawDropId: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '-h' || arg === '--help') {
      console.log(usage());
      process.exit(0);
    }

    if (arg === '--kind') {
      const value = argv[index + 1];
      if (!value) fail(`Missing value for --kind\n\n${usage()}`);
      args.kind = normalizeKind(value);
      index += 1;
      continue;
    }

    if (arg.startsWith('--kind=')) {
      args.kind = normalizeKind(arg.slice('--kind='.length));
      continue;
    }

    if (arg === '--drop-id' || arg === '--drop_id') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) fail(`Missing value for ${arg}\n\n${usage()}`);
      rawDropId = value;
      index += 1;
      continue;
    }

    if (arg.startsWith('--drop-id=')) {
      rawDropId = arg.slice('--drop-id='.length);
      continue;
    }

    if (arg.startsWith('--drop_id=')) {
      rawDropId = arg.slice('--drop_id='.length);
      continue;
    }

    fail(`Unknown arg: ${arg}\n\n${usage()}`);
  }

  if (args.kind === 'stripe-manual-review' && rawDropId != null) {
    fail(`--drop-id/--drop_id is only supported with --kind shipper-ready\n\n${usage()}`);
  }
  if (rawDropId != null) args.dropId = resolveDropIdArg(rawDropId);

  return args;
}

function loadEnvFile(filePath: string) {
  if (!existsSync(filePath)) return;

  const content = readFileSync(filePath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const withoutExport = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    let value = withoutExport.slice(eq + 1).trim();
    if (!key || process.env[key]) continue;
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    process.env[key] = value;
  }
}

function loadLocalEnv() {
  [
    fileURLToPath(new URL('../.env', import.meta.url)),
    fileURLToPath(new URL('../.env.local', import.meta.url)),
    fileURLToPath(new URL('../../.env', import.meta.url)),
    fileURLToPath(new URL('../../.env.local', import.meta.url)),
  ].forEach(loadEnvFile);
}

function firebaseSecretAccessCommand(): string[] {
  return ['functions:secrets:access', RESEND_SECRET_NAME, '--project', PROJECT_ID];
}

function runFirebaseCli(args: string[]): SpawnSyncReturns<string> {
  return spawnSync('firebase', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function readResendApiKeyFromFirebaseSecret(): string {
  const result = runFirebaseCli(firebaseSecretAccessCommand());
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === 'ENOENT') {
      fail('Firebase CLI is not installed or is not on PATH. Install/login to Firebase CLI before accessing RESEND_API_KEY.');
    }
    fail(`Unable to run Firebase CLI: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = String(result.stderr || '').trim();
    const stdout = String(result.stdout || '').trim();
    fail(
      [
        `Unable to access Firebase secret ${RESEND_SECRET_NAME} for project ${PROJECT_ID}.`,
        stderr || stdout || `Firebase CLI exited with status ${result.status}.`,
      ].join('\n'),
    );
  }

  const value = String(result.stdout || '').trim();
  if (!value) fail(`Firebase secret ${RESEND_SECRET_NAME} is empty or unavailable.`);
  return value;
}

function resendApiKey(): string {
  const fromEnv = String(process.env.RESEND_API_KEY || '').trim();
  if (fromEnv) return fromEnv;
  return readResendApiKeyFromFirebaseSecret();
}

function firestore(): Firestore {
  const app = getApps()[0] || initializeApp({ projectId: PROJECT_ID });
  return getFirestore(app);
}

function dropIdFromDeliveryOrderPath(path: string): string | undefined {
  const parts = String(path || '').split('/');
  if (parts.length !== 4 || parts[0] !== 'drops' || parts[2] !== 'deliveryOrders') return undefined;
  const dropId = normalizeDropId(parts[1]);
  return dropId || undefined;
}

function deliveryOrderSortTimeMs(order: any): number | undefined {
  return toMillisMaybe(order?.processedAt) ?? toMillisMaybe(order?.processingAt) ?? toMillisMaybe(order?.createdAt);
}

function selectedOrderFromDoc(doc: DocumentSnapshot): ShipperReadyOrderCandidate | null {
  const order = doc.data() || {};
  if (order.status !== 'ready_to_ship') return null;
  if (order.source === ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE) return null;

  const pathDropId = dropIdFromDeliveryOrderPath(doc.ref.path);
  if (!pathDropId || !FUNCTIONS_DROPS[pathDropId]) return null;
  const storedDropId = typeof order.dropId === 'string' && order.dropId.trim() ? normalizeDropId(order.dropId) : undefined;

  const deliveryId = Math.floor(Number(order.deliveryId ?? doc.id));
  if (!Number.isFinite(deliveryId) || deliveryId <= 0) return null;

  const drop = requireFunctionsDrop(pathDropId);
  return {
    order,
    docPath: doc.ref.path,
    dropId: pathDropId,
    dropName: drop.collectionName || pathDropId,
    deliveryId,
    owner: typeof order.owner === 'string' ? order.owner : '',
    sortTimeMs: deliveryOrderSortTimeMs(order),
    ...(storedDropId && storedDropId !== pathDropId ? { storedDropIdMismatch: storedDropId } : {}),
  };
}

function compareSelectedOrders(a: SelectedShipperReadyOrder, b: SelectedShipperReadyOrder): number {
  const timeDelta = (b.sortTimeMs || 0) - (a.sortTimeMs || 0);
  if (timeDelta !== 0) return timeDelta;

  const deliveryDelta = b.deliveryId - a.deliveryId;
  if (deliveryDelta !== 0) return deliveryDelta;

  return a.docPath.localeCompare(b.docPath);
}

function summarizeFetchError(err: unknown): string {
  const anyErr = err as any;
  const code = typeof anyErr?.code === 'string' || typeof anyErr?.code === 'number' ? String(anyErr.code) : undefined;
  const message = err instanceof Error ? err.message : String(err);
  return [code, message].filter(Boolean).join(': ');
}

function docsToShipperReadyCandidates(docs: DocumentSnapshot[]): ShipperReadyOrderCandidate[] {
  return docs
    .map((doc) => selectedOrderFromDoc(doc))
    .filter((order): order is ShipperReadyOrderCandidate => Boolean(order));
}

async function fetchAllShipperReadyCandidates(db: Firestore, dropId: string): Promise<ShipperReadyOrderCandidate[]> {
  const snap = await db
    .collection(dropDeliveryOrdersCollectionPath(dropId))
    .where('status', '==', 'ready_to_ship')
    .select(...DELIVERY_ORDER_FIELDS)
    .get();
  return docsToShipperReadyCandidates(snap.docs);
}

async function fetchLatestShipperReadyCandidates(
  db: Firestore,
  dropId: string,
): Promise<ShipperReadyOrderCandidate[]> {
  try {
    const snap = await db
      .collection(dropDeliveryOrdersCollectionPath(dropId))
      .where('status', '==', 'ready_to_ship')
      .orderBy('processedAt', 'desc')
      .orderBy(FieldPath.documentId(), 'desc')
      .limit(LATEST_ORDER_QUERY_LIMIT)
      .select(...DELIVERY_ORDER_FIELDS)
      .get();
    const candidates = docsToShipperReadyCandidates(snap.docs);
    if (candidates.length) return candidates;
  } catch (err) {
    console.warn(
      `Optimized latest ready-to-ship lookup failed for ${dropId}; falling back to full ready-order scan. ${summarizeFetchError(err)}`,
    );
  }

  return fetchAllShipperReadyCandidates(db, dropId);
}

async function latestShipperReadyOrder(dropId?: string): Promise<ShipperReadyOrderCandidate> {
  const searchedDropIds = dropId ? [dropId] : DEFAULT_SHIPPER_READY_DROP_IDS;
  const db = firestore();
  const candidates = (await Promise.all(searchedDropIds.map((searchedDropId) => fetchLatestShipperReadyCandidates(db, searchedDropId)))).flat();
  candidates.sort(compareSelectedOrders);

  const found = candidates[0];
  if (found) return found;

  fail(
    [
      'No matching real ready_to_ship delivery order found for shipper-ready test email.',
      `Searched drops: ${searchedDropIds.join(', ')}`,
      `Ignored sources: ${ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE}`,
    ].join('\n'),
  );
}

async function buildShipperReadyTestEmail(args: Args, idempotencyKey: string): Promise<BuiltTestEmail> {
  const { order, ...selectedOrder } = await latestShipperReadyOrder(args.dropId);
  return {
    selectedOrder,
    content: buildShipperReadyToShipEmailContent(
      {
        idempotencyKey,
        recipients: [TEST_RECIPIENT],
        dropId: selectedOrder.dropId,
        dropName: selectedOrder.dropName,
        deliveryId: selectedOrder.deliveryId,
        owner: selectedOrder.owner,
        items: summarizeShipperReadyOrderItems(order),
        fulfillmentUrl: fulfillmentAppUrlForOrder(selectedOrder.dropId, selectedOrder.deliveryId),
      },
      { subjectPrefix: '[TEST] ' },
    ),
  };
}

function buildStripeManualReviewTestEmail(idempotencyKey: string): BuiltTestEmail {
  const now = Date.now();
  const sessionId = `cs_test_local_${now}`;
  return {
    content: buildStripeCheckoutManualReviewEmailContent(
      {
        idempotencyKey,
        recipients: [TEST_RECIPIENT],
        dropId: TEST_DROP_ID,
        dropName: TEST_DROP_NAME,
        sessionId,
        checkoutPath: `drops/${TEST_DROP_ID}/stripeCheckouts/${sessionId}`,
        livemode: false,
        variantKey: 'local-test',
        owner: 'local-test-owner',
        firebaseUid: 'local-test-firebase-uid',
        manualRefundReviewReason: 'Local Resend notification test',
        lastFulfillmentError: {
          message: 'Synthetic Stripe manual-review notification test',
          generatedAt: new Date(now).toISOString(),
        },
        createdAt: now - 5 * 60 * 1000,
        fulfillmentRequestedAt: now - 4 * 60 * 1000,
        processingStartedAt: now - 3 * 60 * 1000,
        failedAt: now - 2 * 60 * 1000,
      },
      { subjectPrefix: '[TEST] ' },
    ),
  };
}

async function buildTestEmail(args: Args, idempotencyKey: string): Promise<BuiltTestEmail> {
  if (args.kind === 'stripe-manual-review') return buildStripeManualReviewTestEmail(idempotencyKey);
  return buildShipperReadyTestEmail(args, idempotencyKey);
}

function summarizeResendError(error: any): string {
  const name = typeof error?.name === 'string' && error.name ? error.name : 'unknown_resend_error';
  const message = typeof error?.message === 'string' && error.message ? error.message : 'Unknown Resend error';
  const statusCode = typeof error?.statusCode === 'number' && Number.isFinite(error.statusCode) ? error.statusCode : undefined;
  return [name, statusCode ? `status ${statusCode}` : '', message].filter(Boolean).join(': ');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadLocalEnv();

  const idempotencyKey = `local-resend-test:${args.kind}:${Date.now()}:${randomUUID()}`;
  const builtEmail = await buildTestEmail(args, idempotencyKey);
  const email = builtEmail.content;
  const selectedOrder = builtEmail.selectedOrder;
  const resend = new Resend(resendApiKey());
  const result = await resend.emails.send(
    {
      from: NOTIFICATION_EMAIL_FROM,
      to: [TEST_RECIPIENT],
      subject: email.subject,
      text: email.text,
      html: email.html,
    },
    { idempotencyKey },
  );

  if (result.error) {
    fail(`Resend send failed: ${summarizeResendError(result.error)}`);
  }

  console.log(
    [
      'Sent Resend notification test email.',
      `Kind: ${args.kind}`,
      `To: ${TEST_RECIPIENT}`,
      `Subject: ${email.subject}`,
      selectedOrder ? `Selected order: ${selectedOrder.docPath}` : undefined,
      selectedOrder ? `Selected drop: ${selectedOrder.dropId}` : undefined,
      selectedOrder?.storedDropIdMismatch
        ? `Stored order dropId mismatch: ${selectedOrder.storedDropIdMismatch} (using path drop ${selectedOrder.dropId})`
        : undefined,
      selectedOrder ? `Selected delivery ID: ${selectedOrder.deliveryId}` : undefined,
      selectedOrder
        ? `Selected order timestamp: ${selectedOrder.sortTimeMs ? new Date(selectedOrder.sortTimeMs).toISOString() : 'unknown'}`
        : undefined,
      result.data?.id ? `Message ID: ${result.data.id}` : undefined,
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
