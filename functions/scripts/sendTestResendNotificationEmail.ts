import { existsSync, readFileSync } from 'node:fs';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getApps, initializeApp } from 'firebase-admin/app';
import { FieldPath, getFirestore, type DocumentSnapshot, type Firestore, type Query } from 'firebase-admin/firestore';
import { Resend } from 'resend';
import { FUNCTIONS_DROPS, normalizeDropId, requireFunctionsDrop } from '../src/config/deployment.ts';
import { dropDeliveryOrdersCollectionPath } from '../src/dropPaths.ts';
import {
  NOTIFICATION_EMAIL_FROM,
  buildBuyerOrderReceivedEmailContent,
  buildBuyerOrderShippedEmailContent,
  buildShipperReadyToShipEmailContent,
  buildStripeCheckoutManualReviewEmailContent,
  fulfillmentAppUrlForOrder,
  summarizeShipperReadyOrderItems,
  type BuyerOrderEmailMessageBase,
  type NotificationEmailContent,
} from '../src/notificationEmails.ts';
import { ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE } from '../src/stripeCheckout/contract.ts';
import { toMillisMaybe } from '../src/time.ts';
import { buildOrderEmailItems } from '../src/orderEmailItems.ts';
import { normalizeFulfillmentStatusOrNull, type FulfillmentStatus } from '../../src/lib/fulfillmentStatus.ts';
import { resolveFulfillmentTrackingHref } from '../../src/lib/fulfillmentTracking.ts';

const ORDER_BACKED_TEST_EMAIL_KINDS = ['shipper-ready', 'order-received', 'order-shipped'] as const;
const TEST_EMAIL_KINDS = [...ORDER_BACKED_TEST_EMAIL_KINDS, 'stripe-manual-review'] as const;

type OrderBackedTestEmailKind = (typeof ORDER_BACKED_TEST_EMAIL_KINDS)[number];
type TestEmailKind = (typeof TEST_EMAIL_KINDS)[number];
type BuyerOrderBackedTestEmailKind = Extract<OrderBackedTestEmailKind, 'order-received' | 'order-shipped'>;

type Args = {
  kind: TestEmailKind;
  dropId?: string;
};

type SelectedDeliveryOrder = {
  docPath: string;
  dropId: string;
  dropName: string;
  deliveryId: number;
  owner: string;
  status: string;
  fulfillmentStatus?: FulfillmentStatus;
  trackingUrl?: string;
  sortTimeMs?: number;
  storedDropIdMismatch?: string;
};

type DeliveryOrderCandidate = SelectedDeliveryOrder & {
  order: any;
};

type BuiltTestEmail = {
  content: NotificationEmailContent;
  selectedOrder?: SelectedDeliveryOrder;
};

const PROJECT_ID = 'mons-shop';
const RESEND_SECRET_NAME = 'RESEND_API_KEY';
const TEST_RECIPIENT = 'ivan@ivan.lol';
const TEST_DROP_ID = 'local_resend_test';
const TEST_DROP_NAME = 'Local Resend Test';
const DEFAULT_ORDER_BACKED_DROP_IDS = ['little_swag_boxes', 'poncho_drifella', 'little_swag_hoodies', 'card_nft_2'];
const ORDER_LOOKUP_PAGE_SIZE = 50;
const ORDER_LOOKUP_MAX_PAGES = 5;
const ORDER_LOOKUP_MAX_DOCS = ORDER_LOOKUP_PAGE_SIZE * ORDER_LOOKUP_MAX_PAGES;
const SHIPPED_FULFILLMENT_STATUS: FulfillmentStatus = 'Shipped';
const DELIVERY_ORDER_LOOKUP_FIELDS = [
  'dropId',
  'deliveryId',
  'source',
  'status',
  'owner',
  'fulfillmentStatus',
  'fulfillmentTrackingCode',
  'fulfillmentUpdatedAt',
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
    '  npm run test-resend-notification-email -- --kind order-received --drop-id card_nft_2',
    '  npm run test-resend-notification-email -- --kind order-shipped --drop-id card_nft_2',
    '',
    'Options:',
    '  --kind <kind>    shipper-ready, stripe-manual-review, order-received, or order-shipped (default: shipper-ready)',
    '  --drop-id <id>   Restrict order-backed tests to one drop',
    '  --drop_id <id>   Alias for --drop-id',
    '  -h, --help       Show this help',
  ].join('\n');
}

function fail(message: string): never {
  throw new Error(message);
}

function assertNever(value: never): never {
  fail(`Unhandled test email kind: ${String(value)}`);
}

function isTestEmailKind(kind: string): kind is TestEmailKind {
  return (TEST_EMAIL_KINDS as readonly string[]).includes(kind);
}

function normalizeKind(raw: string): TestEmailKind {
  const kind = raw.trim();
  if (isTestEmailKind(kind)) return kind;
  fail(`Invalid --kind: ${raw}\n\n${usage()}`);
}

function isOrderBackedKind(kind: TestEmailKind): kind is OrderBackedTestEmailKind {
  return (ORDER_BACKED_TEST_EMAIL_KINDS as readonly string[]).includes(kind);
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

  if (!isOrderBackedKind(args.kind) && rawDropId != null) {
    fail(`--drop-id/--drop_id is only supported with order-backed email kinds\n\n${usage()}`);
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

function deliveryOrderSortTimeMs(order: any, kind: OrderBackedTestEmailKind): number | undefined {
  if (kind === 'order-shipped') {
    return (
      toMillisMaybe(order?.fulfillmentUpdatedAt) ??
      toMillisMaybe(order?.processedAt) ??
      toMillisMaybe(order?.processingAt) ??
      toMillisMaybe(order?.createdAt)
    );
  }
  return toMillisMaybe(order?.processedAt) ?? toMillisMaybe(order?.processingAt) ?? toMillisMaybe(order?.createdAt);
}

type DeliveryOrderLookupOptions = {
  kind: OrderBackedTestEmailKind;
  statuses: readonly string[];
  requireShippedTracking?: boolean;
  noMatchMessage: string;
};

function selectedOrderFromDoc(doc: DocumentSnapshot, options: DeliveryOrderLookupOptions): DeliveryOrderCandidate | null {
  const order = doc.data() || {};
  const status = typeof order.status === 'string' ? order.status : '';
  if (!options.statuses.includes(status)) return null;
  if (order.source === ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE) return null;

  const pathDropId = dropIdFromDeliveryOrderPath(doc.ref.path);
  if (!pathDropId || !FUNCTIONS_DROPS[pathDropId]) return null;
  const storedDropId = typeof order.dropId === 'string' && order.dropId.trim() ? normalizeDropId(order.dropId) : undefined;

  const deliveryId = Math.floor(Number(order.deliveryId ?? doc.id));
  if (!Number.isFinite(deliveryId) || deliveryId <= 0) return null;

  const drop = requireFunctionsDrop(pathDropId);
  const fulfillmentStatus = normalizeFulfillmentStatusOrNull(order.fulfillmentStatus) || undefined;
  const trackingUrl = resolveFulfillmentTrackingHref(order.fulfillmentTrackingCode);
  if (options.requireShippedTracking && (fulfillmentStatus !== SHIPPED_FULFILLMENT_STATUS || !trackingUrl)) return null;

  return {
    order,
    docPath: doc.ref.path,
    dropId: pathDropId,
    dropName: drop.collectionName || pathDropId,
    deliveryId,
    owner: typeof order.owner === 'string' ? order.owner : '',
    status,
    ...(fulfillmentStatus ? { fulfillmentStatus } : {}),
    ...(trackingUrl ? { trackingUrl } : {}),
    sortTimeMs: deliveryOrderSortTimeMs(order, options.kind),
    ...(storedDropId && storedDropId !== pathDropId ? { storedDropIdMismatch: storedDropId } : {}),
  };
}

function compareSelectedOrders(a: SelectedDeliveryOrder, b: SelectedDeliveryOrder): number {
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

function docsToDeliveryOrderCandidates(docs: DocumentSnapshot[], options: DeliveryOrderLookupOptions): DeliveryOrderCandidate[] {
  return docs
    .map((doc) => selectedOrderFromDoc(doc, options))
    .filter((order): order is DeliveryOrderCandidate => Boolean(order));
}

function deliveryOrderLookupOptions(kind: OrderBackedTestEmailKind): DeliveryOrderLookupOptions {
  switch (kind) {
    case 'order-received':
      return {
        kind,
        statuses: ['processing', 'ready_to_ship'],
        noMatchMessage: 'No matching real processing or ready_to_ship delivery order found for order-received test email.',
      };
    case 'order-shipped':
      return {
        kind,
        statuses: ['ready_to_ship'],
        requireShippedTracking: true,
        noMatchMessage: 'No matching real shipped delivery order with HTTPS tracking link found for order-shipped test email.',
      };
    case 'shipper-ready':
      return {
        kind,
        statuses: ['ready_to_ship'],
        noMatchMessage: 'No matching real ready_to_ship delivery order found for shipper-ready test email.',
      };
    default:
      return assertNever(kind);
  }
}

function deliveryOrderQuery(
  db: Firestore,
  dropId: string,
  status: string,
  options: DeliveryOrderLookupOptions,
): Query {
  let query: Query = db.collection(dropDeliveryOrdersCollectionPath(dropId)).where('status', '==', status);
  if (options.requireShippedTracking) query = query.where('fulfillmentStatus', '==', SHIPPED_FULFILLMENT_STATUS);
  const sortField =
    options.kind === 'order-shipped' ? 'fulfillmentUpdatedAt' : status === 'processing' ? 'processingAt' : 'processedAt';
  query = query.orderBy(sortField, 'desc').orderBy(FieldPath.documentId(), 'desc');
  return query.select(...DELIVERY_ORDER_LOOKUP_FIELDS);
}

async function fetchLatestDeliveryOrderCandidatesForStatus(
  db: Firestore,
  dropId: string,
  status: string,
  options: DeliveryOrderLookupOptions,
): Promise<DeliveryOrderCandidate[]> {
  let cursor: DocumentSnapshot | undefined;
  for (let pageIndex = 0; pageIndex < ORDER_LOOKUP_MAX_PAGES; pageIndex += 1) {
    let query = deliveryOrderQuery(db, dropId, status, options).limit(ORDER_LOOKUP_PAGE_SIZE);
    if (cursor) query = query.startAfter(cursor);

    let snap;
    try {
      snap = await query.get();
    } catch (err) {
      fail(
        [
          `Indexed ${options.kind} lookup failed for drop ${dropId}, status ${status}.`,
          `Error: ${summarizeFetchError(err)}`,
          'Required Firestore indexes are declared in firestore.indexes.json.',
          'Deploy them with: firebase deploy --only firestore:indexes',
        ].join('\n'),
      );
    }

    const candidates = docsToDeliveryOrderCandidates(snap.docs, options);
    if (candidates.length) return candidates;

    const lastDoc = snap.docs[snap.docs.length - 1];
    if (!lastDoc || snap.docs.length < ORDER_LOOKUP_PAGE_SIZE) break;
    cursor = lastDoc;
  }

  return [];
}

async function fetchLatestDeliveryOrderCandidates(
  db: Firestore,
  dropId: string,
  options: DeliveryOrderLookupOptions,
): Promise<DeliveryOrderCandidate[]> {
  const candidatesByStatus = await Promise.all(
    options.statuses.map((status) => fetchLatestDeliveryOrderCandidatesForStatus(db, dropId, status, options)),
  );
  return candidatesByStatus.flat();
}

async function hydrateDeliveryOrderCandidate(
  db: Firestore,
  candidate: DeliveryOrderCandidate,
): Promise<DeliveryOrderCandidate> {
  const snap = await db.doc(candidate.docPath).get();
  return {
    ...candidate,
    order: {
      ...candidate.order,
      ...(snap.data() || {}),
    },
  };
}

async function latestDeliveryOrder(kind: OrderBackedTestEmailKind, dropId?: string): Promise<DeliveryOrderCandidate> {
  const options = deliveryOrderLookupOptions(kind);
  const searchedDropIds = dropId ? [dropId] : DEFAULT_ORDER_BACKED_DROP_IDS;
  const db = firestore();
  const candidates = (
    await Promise.all(searchedDropIds.map((searchedDropId) => fetchLatestDeliveryOrderCandidates(db, searchedDropId, options)))
  ).flat();
  candidates.sort(compareSelectedOrders);

  const found = candidates[0];
  if (found) return hydrateDeliveryOrderCandidate(db, found);

  fail(
    [
      options.noMatchMessage,
      `Searched drops: ${searchedDropIds.join(', ')}`,
      `Statuses: ${options.statuses.join(', ')}`,
      options.requireShippedTracking ? 'Required: fulfillmentStatus Shipped with HTTPS fulfillmentTrackingCode' : undefined,
      `Lookup cap: ${ORDER_LOOKUP_MAX_DOCS} docs per status/drop`,
      `Ignored sources: ${ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE}`,
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

async function buildShipperReadyTestEmail(args: Args, idempotencyKey: string): Promise<BuiltTestEmail> {
  const { order, ...selectedOrder } = await latestDeliveryOrder('shipper-ready', args.dropId);
  const itemPreviews = await buildOrderEmailItems(order, selectedOrder);
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
        itemPreviews,
        fulfillmentUrl: fulfillmentAppUrlForOrder(selectedOrder.dropId, selectedOrder.deliveryId),
      },
      { subjectPrefix: '[TEST] ' },
    ),
  };
}

async function buildBuyerOrderTestEmailMessage(
  kind: BuyerOrderBackedTestEmailKind,
  args: Args,
  idempotencyKey: string,
): Promise<{ selectedOrder: SelectedDeliveryOrder; message: BuyerOrderEmailMessageBase }> {
  const { order, ...selectedOrder } = await latestDeliveryOrder(kind, args.dropId);
  const items = await buildOrderEmailItems(order, selectedOrder);
  return {
    selectedOrder,
    message: {
      idempotencyKey,
      recipients: [TEST_RECIPIENT],
      dropId: selectedOrder.dropId,
      dropName: selectedOrder.dropName,
      deliveryId: selectedOrder.deliveryId,
      items,
    },
  };
}

async function buildBuyerOrderReceivedTestEmail(args: Args, idempotencyKey: string): Promise<BuiltTestEmail> {
  const { selectedOrder, message } = await buildBuyerOrderTestEmailMessage('order-received', args, idempotencyKey);
  return {
    selectedOrder,
    content: buildBuyerOrderReceivedEmailContent(message, { subjectPrefix: '[TEST] ' }),
  };
}

async function buildBuyerOrderShippedTestEmail(args: Args, idempotencyKey: string): Promise<BuiltTestEmail> {
  const { selectedOrder, message } = await buildBuyerOrderTestEmailMessage('order-shipped', args, idempotencyKey);
  const trackingUrl = selectedOrder.trackingUrl;
  if (!trackingUrl) {
    fail(`Selected order is missing an HTTPS tracking URL: ${selectedOrder.docPath}`);
  }
  return {
    selectedOrder,
    content: buildBuyerOrderShippedEmailContent({ ...message, trackingUrl }, { subjectPrefix: '[TEST] ' }),
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
  switch (args.kind) {
    case 'stripe-manual-review':
      return buildStripeManualReviewTestEmail(idempotencyKey);
    case 'order-received':
      return buildBuyerOrderReceivedTestEmail(args, idempotencyKey);
    case 'order-shipped':
      return buildBuyerOrderShippedTestEmail(args, idempotencyKey);
    case 'shipper-ready':
      return buildShipperReadyTestEmail(args, idempotencyKey);
    default:
      return assertNever(args.kind);
  }
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
      selectedOrder ? `Selected order status: ${selectedOrder.status}` : undefined,
      selectedOrder?.fulfillmentStatus ? `Selected fulfillment status: ${selectedOrder.fulfillmentStatus}` : undefined,
      selectedOrder?.trackingUrl ? `Selected tracking URL: ${selectedOrder.trackingUrl}` : undefined,
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
