import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { API_DROPS, normalizeDropId, requireApiDrop } from '../../cloud/workers/api/src/dropConfig.ts';
import { dropDeliveryOrderPath } from '../../cloud/workers/api/src/dropPaths.ts';
import {
  buildBuyerOrderReceivedEmailContent,
  buildBuyerOrderShippedEmailContent,
  buildBuyerOrderUpdateEmailContent,
  buildShipperReadyToShipEmailContent,
  buildStripeCheckoutManualReviewEmailContent,
  fulfillmentAppUrlForOrder,
  summarizeShipperReadyOrderItems,
  type BuyerOrderEmailMessageBase,
  type NotificationEmailContent,
} from '../../cloud/workers/api/src/notificationEmails.ts';
import { ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE } from '../../shared/fulfillmentSources.ts';
import { toMillisMaybe } from '../../cloud/workers/api/src/time.ts';
import {
  buildBuyerVisibleOrderEmailItems,
  buildShipperVisibleOrderEmailItems,
} from '../../cloud/workers/api/src/orderEmailItems.ts';
import { enqueueNotificationEmailJob } from '../shared/notificationEnqueueClient.ts';
import {
  createNotificationEmailJobV1,
  type NotificationEmailKind,
} from '../../shared/notificationEmailJob.ts';
import { normalizeFulfillmentStatus, type FulfillmentStatus } from '../../shared/fulfillmentStatus.ts';
import { resolveFulfillmentTrackingHref } from '../../shared/fulfillmentTracking.ts';
import {
  queryRemoteCommerceDocuments,
  sqlString,
  type CommerceD1Document,
} from '../shared/commerceD1Maintenance.ts';

const ORDER_BACKED_TEST_EMAIL_KINDS = ['shipper-ready', 'order-received', 'order-update', 'order-shipped'] as const;
const TEST_EMAIL_KINDS = [...ORDER_BACKED_TEST_EMAIL_KINDS, 'stripe-manual-review'] as const;

type OrderBackedTestEmailKind = (typeof ORDER_BACKED_TEST_EMAIL_KINDS)[number];
type TestEmailKind = (typeof TEST_EMAIL_KINDS)[number];
type BuyerOrderBackedTestEmailKind = Extract<
  OrderBackedTestEmailKind,
  'order-received' | 'order-update' | 'order-shipped'
>;

type Args = {
  kind: TestEmailKind;
  dropId?: string;
  orderId?: number;
};

type ParsedOrderIdArg = {
  dropId?: string;
  deliveryId: number;
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

type DeliveryOrderDocLike = {
  exists?: boolean;
  id: string;
  ref: {
    path: string;
  };
  data(): any;
};

type DeliveryOrderDocLoader = (docPath: string) => Promise<DeliveryOrderDocLike>;

type BuiltTestEmail = {
  content: NotificationEmailContent;
  selectedOrder?: SelectedDeliveryOrder;
};

const ENQUEUE_SECRET_NAME = 'NOTIFICATION_ENQUEUE_SECRET';
const TEST_RECIPIENT = 'development@support.mons.shop';
const TEST_DROP_ID = 'local_resend_test';
const TEST_DROP_NAME = 'Local Resend Test';
const DEFAULT_ORDER_BACKED_DROP_IDS = ['little_swag_boxes', 'poncho_drifella', 'little_swag_hoodies', 'card_nft_2'];
const ORDER_LOOKUP_PAGE_SIZE = 50;
const ORDER_LOOKUP_MAX_PAGES = 5;
const ORDER_LOOKUP_MAX_DOCS = ORDER_LOOKUP_PAGE_SIZE * ORDER_LOOKUP_MAX_PAGES;
const SHIPPED_FULFILLMENT_STATUS: FulfillmentStatus = 'Shipped';
function usage(): string {
  return [
    'Queue one Resend notification test email to development@support.mons.shop through Cloudflare.',
    '',
    'Usage:',
    '  npm run test-resend-notification-email',
    '  npm run test-resend-notification-email -- --drop_id card_nft_2',
    '  npm run test-resend-notification-email -- --kind shipper-ready',
    '  npm run test-resend-notification-email -- --kind shipper-ready --drop-id little_swag_hoodies',
    '  npm run test-resend-notification-email -- --kind stripe-manual-review',
    '  npm run test-resend-notification-email -- --kind order-received --drop-id card_nft_2',
    '  npm run test-resend-notification-email -- --kind order-received --drop-id card_nft_2 --order-id 123',
    '  npm run test-resend-notification-email -- --kind order-received --order-id card_nft_2:123',
    '  npm run test-resend-notification-email -- --kind order-update --drop-id card_nft_2 --order-id 123',
    '  npm run test-resend-notification-email -- --kind order-shipped --drop-id card_nft_2',
    '',
    'Options:',
    '  --kind <kind>    shipper-ready, stripe-manual-review, order-received, order-update, or order-shipped (default: shipper-ready)',
    '  --drop-id <id>   Restrict order-backed tests to one drop',
    '  --drop_id <id>   Alias for --drop-id',
    '  --order-id <id>  Target one order by delivery id, <dropId>:<id>, or drops/<dropId>/deliveryOrders/<id>',
    '  --order_id <id>  Alias for --order-id',
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
  return Object.keys(API_DROPS).sort((a, b) => a.localeCompare(b));
}

function resolveDropIdArg(raw: string): string {
  const normalized = normalizeDropId(raw);
  if (!normalized) fail(`Missing value for --drop-id\n\n${usage()}`);

  const underscoreAlias = normalized.replace(/-/g, '_');
  const candidates = [normalized, underscoreAlias].filter((candidate, index, all) => candidate && all.indexOf(candidate) === index);
  const found = candidates.find((candidate) => Boolean(API_DROPS[candidate]));
  if (found) return found;

  fail(`Unknown --drop-id: ${raw}. Known drop IDs: ${knownDropIds().join(', ')}\n\n${usage()}`);
}

function resolveDeliveryIdArg(raw: string): number {
  const normalized = String(raw || '').trim();
  if (!normalized) fail(`Missing value for --order-id\n\n${usage()}`);
  if (!/^\d+$/.test(normalized)) fail(`Invalid --order-id: ${raw}. Expected a positive integer.\n\n${usage()}`);

  const deliveryId = Number(normalized);
  if (!Number.isSafeInteger(deliveryId) || deliveryId <= 0) {
    fail(`Invalid --order-id: ${raw}. Expected a positive integer.\n\n${usage()}`);
  }
  return deliveryId;
}

function parseOrderIdArg(raw: string): ParsedOrderIdArg {
  const normalized = String(raw || '').trim();
  if (!normalized) fail(`Missing value for --order-id\n\n${usage()}`);

  const pathMatch = normalized.match(/^drops\/([^/]+)\/deliveryOrders\/([^/]+)$/);
  if (pathMatch) {
    return {
      dropId: resolveDropIdArg(pathMatch[1]),
      deliveryId: resolveDeliveryIdArg(pathMatch[2]),
    };
  }

  if (normalized.includes(':')) {
    const parts = normalized.split(':');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      fail(`Invalid --order-id: ${raw}. Expected <dropId>:<id>.\n\n${usage()}`);
    }
    return {
      dropId: resolveDropIdArg(parts[0]),
      deliveryId: resolveDeliveryIdArg(parts[1]),
    };
  }

  return { deliveryId: resolveDeliveryIdArg(normalized) };
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { kind: 'shipper-ready' };
  let rawDropId: string | undefined;
  let rawOrderId: string | undefined;

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

    if (arg === '--order-id' || arg === '--order_id') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) fail(`Missing value for ${arg}\n\n${usage()}`);
      rawOrderId = value;
      index += 1;
      continue;
    }

    if (arg.startsWith('--order-id=')) {
      rawOrderId = arg.slice('--order-id='.length);
      continue;
    }

    if (arg.startsWith('--order_id=')) {
      rawOrderId = arg.slice('--order_id='.length);
      continue;
    }

    fail(`Unknown arg: ${arg}\n\n${usage()}`);
  }

  if (!isOrderBackedKind(args.kind) && rawDropId != null) {
    fail(`--drop-id/--drop_id is only supported with order-backed email kinds\n\n${usage()}`);
  }
  if (!isOrderBackedKind(args.kind) && rawOrderId != null) {
    fail(`--order-id/--order_id is only supported with order-backed email kinds\n\n${usage()}`);
  }

  const dropId = rawDropId != null ? resolveDropIdArg(rawDropId) : undefined;
  const parsedOrderId = rawOrderId != null ? parseOrderIdArg(rawOrderId) : undefined;
  if (dropId && parsedOrderId?.dropId && dropId !== parsedOrderId.dropId) {
    fail(`--drop-id (${dropId}) does not match --order-id drop (${parsedOrderId.dropId})\n\n${usage()}`);
  }

  if (parsedOrderId) {
    const orderDropId = parsedOrderId.dropId || dropId;
    if (!orderDropId) {
      fail(`--order-id ${rawOrderId} requires --drop-id unless it includes a drop id\n\n${usage()}`);
    }
    args.dropId = orderDropId;
    args.orderId = parsedOrderId.deliveryId;
  } else if (dropId) {
    args.dropId = dropId;
  }

  return args;
}

const LOCAL_ENV_PATHS = [
  fileURLToPath(new URL('../../.env', import.meta.url)),
  fileURLToPath(new URL('../../.env.local', import.meta.url)),
];

export function notificationEnqueueSecret(
  env: NodeJS.ProcessEnv = process.env,
  envPaths: readonly string[] = LOCAL_ENV_PATHS,
): string {
  const secret = String(env[ENQUEUE_SECRET_NAME] || '').trim();
  if (secret) return secret;
  for (const envPath of envPaths) {
    if (!existsSync(envPath)) continue;
    let parsed: NodeJS.Dict<string>;
    try {
      parsed = parseEnv(readFileSync(envPath, 'utf8'));
    } catch {
      fail(`Could not parse ${envPath} while resolving ${ENQUEUE_SECRET_NAME}.`);
    }
    const fromFile = String(parsed[ENQUEUE_SECRET_NAME] || '').trim();
    if (fromFile) return fromFile;
  }
  fail(`${ENQUEUE_SECRET_NAME} is not configured. Set it in the invoking environment or root .env.local.`);
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

export type DeliveryOrderLookupOptions = {
  kind: OrderBackedTestEmailKind;
  statuses: readonly string[];
  requireShippedTracking?: boolean;
  noMatchMessage: string;
};

export function selectedOrderFromDoc(doc: DeliveryOrderDocLike, options: DeliveryOrderLookupOptions): DeliveryOrderCandidate | null {
  const order = doc.data() || {};
  const status = typeof order.status === 'string' ? order.status : '';
  if (!options.statuses.includes(status)) return null;
  if (order.source === ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE) return null;

  const pathDropId = dropIdFromDeliveryOrderPath(doc.ref.path);
  if (!pathDropId || !API_DROPS[pathDropId]) return null;
  const storedDropId = typeof order.dropId === 'string' && order.dropId.trim() ? normalizeDropId(order.dropId) : undefined;

  const deliveryId = Math.floor(Number(order.deliveryId ?? doc.id));
  if (!Number.isFinite(deliveryId) || deliveryId <= 0) return null;

  const drop = requireApiDrop(pathDropId);
  const fulfillmentStatus = normalizeFulfillmentStatus(order.fulfillmentStatus);
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

function docsToDeliveryOrderCandidates(docs: DeliveryOrderDocLike[], options: DeliveryOrderLookupOptions): DeliveryOrderCandidate[] {
  return docs
    .map((doc) => selectedOrderFromDoc(doc, options))
    .filter((order): order is DeliveryOrderCandidate => Boolean(order));
}

function deliveryOrderLookupOptions(kind: OrderBackedTestEmailKind): DeliveryOrderLookupOptions {
  switch (kind) {
    case 'order-received':
    case 'order-update':
      return {
        kind,
        statuses: ['processing', 'ready_to_ship'],
        noMatchMessage: `No matching real processing or ready_to_ship delivery order found for ${kind} test email.`,
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

function deliveryOrderDocument(document: CommerceD1Document | undefined, path: string): DeliveryOrderDocLike {
  if (!document) {
    return {
      exists: false,
      id: path.split('/').pop() || '',
      ref: { path },
      data: () => ({}),
    };
  }
  return {
    exists: true,
    id: document.documentId,
    ref: { path: document.path },
    data: () => document.data,
  };
}

export function deliveryOrderQuerySql(
  dropId: string,
  status: string,
  options: DeliveryOrderLookupOptions,
): string {
  const sortField =
    options.kind === 'order-shipped' ? 'fulfillmentUpdatedAt' : status === 'processing' ? 'processingAt' : 'processedAt';
  return `SELECT document_path, document_kind, drop_id, document_id,
    document_json, version, create_time, update_time FROM commerce_documents
    WHERE document_kind = 'delivery_order'
      AND drop_id = ${sqlString(dropId)}
      AND status = ${sqlString(status)}
      ${options.requireShippedTracking ? `AND fulfillment_status = ${sqlString(SHIPPED_FULFILLMENT_STATUS)}` : ''}
      AND json_type(document_json, '$.${sortField}') IS NOT NULL
    ORDER BY CAST(json_extract(document_json, '$.${sortField}') AS INTEGER) DESC, document_path DESC
    LIMIT ${ORDER_LOOKUP_MAX_DOCS}`;
}

async function fetchLatestDeliveryOrderCandidatesForStatus(
  dropId: string,
  status: string,
  options: DeliveryOrderLookupOptions,
): Promise<DeliveryOrderCandidate[]> {
  const documents = queryRemoteCommerceDocuments(deliveryOrderQuerySql(dropId, status, options));
  return docsToDeliveryOrderCandidates(
    documents.map((document) => deliveryOrderDocument(document, document.path)),
    options,
  );
}

async function fetchLatestDeliveryOrderCandidates(
  dropId: string,
  options: DeliveryOrderLookupOptions,
): Promise<DeliveryOrderCandidate[]> {
  const candidatesByStatus = await Promise.all(
    options.statuses.map((status) => fetchLatestDeliveryOrderCandidatesForStatus(dropId, status, options)),
  );
  return candidatesByStatus.flat();
}

async function latestDeliveryOrder(kind: OrderBackedTestEmailKind, dropId?: string): Promise<DeliveryOrderCandidate> {
  const options = deliveryOrderLookupOptions(kind);
  const searchedDropIds = dropId ? [dropId] : DEFAULT_ORDER_BACKED_DROP_IDS;
  const candidates = (
    await Promise.all(searchedDropIds.map((searchedDropId) => fetchLatestDeliveryOrderCandidates(searchedDropId, options)))
  ).flat();
  candidates.sort(compareSelectedOrders);

  const found = candidates[0];
  if (found) return found;

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

async function loadDeliveryOrderDoc(docPath: string): Promise<DeliveryOrderDocLike> {
  const documents = queryRemoteCommerceDocuments(`SELECT document_path, document_kind, drop_id, document_id,
    document_json, version, create_time, update_time FROM commerce_documents
    WHERE document_kind = 'delivery_order' AND document_path = ${sqlString(docPath)}
    ORDER BY document_path LIMIT 1`);
  return deliveryOrderDocument(documents[0], docPath);
}

export async function deliveryOrderById(
  kind: OrderBackedTestEmailKind,
  dropId: string,
  deliveryId: number,
  loadDoc: DeliveryOrderDocLoader = loadDeliveryOrderDoc,
): Promise<DeliveryOrderCandidate> {
  const options = deliveryOrderLookupOptions(kind);
  const docPath = dropDeliveryOrderPath(dropId, deliveryId);
  const snap = await loadDoc(docPath);
  if (!snap.exists) {
    fail(`Delivery order not found: ${docPath}`);
  }

  const selected = selectedOrderFromDoc(snap, options);
  if (selected) {
    if (selected.deliveryId !== deliveryId) {
      fail(`Delivery order ${docPath} stores deliveryId ${selected.deliveryId}, which does not match requested --order-id ${deliveryId}.`);
    }
    return selected;
  }

  fail(
    [
      `Delivery order does not match ${kind} test email requirements: ${docPath}`,
      `Statuses: ${options.statuses.join(', ')}`,
      options.requireShippedTracking ? 'Required: fulfillmentStatus Shipped with HTTPS fulfillmentTrackingCode' : undefined,
      `Ignored sources: ${ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE}`,
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

async function deliveryOrderForArgs(kind: OrderBackedTestEmailKind, args: Args): Promise<DeliveryOrderCandidate> {
  if (args.orderId != null) {
    if (!args.dropId) fail('--order-id requires --drop-id or a composite order id');
    return deliveryOrderById(kind, args.dropId, args.orderId);
  }
  return latestDeliveryOrder(kind, args.dropId);
}

async function buildShipperReadyTestEmail(args: Args, idempotencyKey: string): Promise<BuiltTestEmail> {
  const { order, ...selectedOrder } = await deliveryOrderForArgs('shipper-ready', args);
  const itemPreviews = await buildShipperVisibleOrderEmailItems(order, selectedOrder);
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
  const { order, ...selectedOrder } = await deliveryOrderForArgs(kind, args);
  const items = await buildBuyerVisibleOrderEmailItems(order, selectedOrder);
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

async function buildBuyerOrderUpdateTestEmail(args: Args, idempotencyKey: string): Promise<BuiltTestEmail> {
  const { selectedOrder, message } = await buildBuyerOrderTestEmailMessage('order-update', args, idempotencyKey);
  return {
    selectedOrder,
    content: buildBuyerOrderUpdateEmailContent(message, { subjectPrefix: '[TEST] ' }),
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
        authSubject: 'local-test-auth-subject',
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
    case 'order-update':
      return buildBuyerOrderUpdateTestEmail(args, idempotencyKey);
    case 'order-shipped':
      return buildBuyerOrderShippedTestEmail(args, idempotencyKey);
    case 'shipper-ready':
      return buildShipperReadyTestEmail(args, idempotencyKey);
    default:
      return assertNever(args.kind);
  }
}

function notificationKindForTest(kind: TestEmailKind): NotificationEmailKind {
  if (kind === 'shipper-ready') return 'shipper_ready_to_ship';
  if (kind === 'order-shipped') return 'buyer_order_shipped';
  if (kind === 'stripe-manual-review') return 'stripe_checkout_manual_review';
  return 'buyer_order_received';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const enqueueSecret = notificationEnqueueSecret();

  const idempotencyKey = `local-resend-test:${args.kind}:${Date.now()}:${randomUUID()}`;
  const builtEmail = await buildTestEmail(args, idempotencyKey);
  const email = builtEmail.content;
  const selectedOrder = builtEmail.selectedOrder;
  const notificationKind = notificationKindForTest(args.kind);
  const deliveryId = selectedOrder?.deliveryId || Math.max(1, Date.now());
  const sessionId = `cs_test_local_${Date.now()}`;
  const job = createNotificationEmailJobV1({
    jobId: randomUUID(),
    kind: notificationKind,
    idempotencyKey,
    recipients: [TEST_RECIPIENT],
    subject: email.subject,
    text: email.text,
    html: email.html,
    context: notificationKind === 'stripe_checkout_manual_review'
      ? { dropId: TEST_DROP_ID, sessionId }
      : { dropId: selectedOrder?.dropId || TEST_DROP_ID, deliveryId },
  });
  await enqueueNotificationEmailJob({ job, secret: enqueueSecret });

  console.log(
    [
      'Queued Resend notification test email.',
      `Job ID: ${job.jobId}`,
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
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
