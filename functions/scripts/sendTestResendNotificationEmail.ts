import { existsSync, readFileSync } from 'node:fs';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Resend } from 'resend';
import {
  NOTIFICATION_EMAIL_FROM,
  buildShipperReadyToShipEmailContent,
  buildStripeCheckoutManualReviewEmailContent,
  fulfillmentAppUrlForOrder,
  type NotificationEmailContent,
} from '../src/notificationEmails.ts';

type TestEmailKind = 'shipper-ready' | 'stripe-manual-review';

type Args = {
  kind: TestEmailKind;
};

const PROJECT_ID = 'mons-shop';
const RESEND_SECRET_NAME = 'RESEND_API_KEY';
const TEST_RECIPIENT = 'ivan@ivan.lol';
const TEST_DROP_ID = 'local_resend_test';
const TEST_DROP_NAME = 'Local Resend Test';
const TEST_DELIVERY_ID = 999999;

function usage(): string {
  return [
    'Send one local Resend notification test email to ivan@ivan.lol.',
    '',
    'Usage:',
    '  npm run test-resend-notification-email',
    '  npm run test-resend-notification-email -- --kind shipper-ready',
    '  npm run test-resend-notification-email -- --kind stripe-manual-review',
    '',
    'Options:',
    '  --kind <kind>  shipper-ready or stripe-manual-review (default: shipper-ready)',
    '  -h, --help     Show this help',
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

function parseArgs(argv: string[]): Args {
  const args: Args = { kind: 'shipper-ready' };

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

    fail(`Unknown arg: ${arg}\n\n${usage()}`);
  }

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

function buildTestEmail(kind: TestEmailKind, idempotencyKey: string): NotificationEmailContent {
  const now = Date.now();
  if (kind === 'stripe-manual-review') {
    const sessionId = `cs_test_local_${now}`;
    return buildStripeCheckoutManualReviewEmailContent(
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
    );
  }

  return buildShipperReadyToShipEmailContent(
    {
      idempotencyKey,
      recipients: [TEST_RECIPIENT],
      dropId: TEST_DROP_ID,
      dropName: TEST_DROP_NAME,
      deliveryId: TEST_DELIVERY_ID,
      owner: 'local-test-owner',
      items: {
        itemCount: 3,
        boxCount: 1,
        dudeCount: 2,
      },
      fulfillmentUrl: fulfillmentAppUrlForOrder(TEST_DROP_ID, TEST_DELIVERY_ID),
    },
    { subjectPrefix: '[TEST] ' },
  );
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
  const email = buildTestEmail(args.kind, idempotencyKey);
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
