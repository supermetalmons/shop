import type { NotificationEmailJobV1 } from '../../../../../shared/notificationEmailJob.js';
import type { NotificationOutboxRecord } from '../../../../../shared/notificationOutbox.js';
import { commerceKeys } from '../commerceRepository.js';
import { runCommerceTransaction } from '../commerceTransactions.js';
import {
  claimNotificationOutbox, markClaimedNotificationQueued, persistClaimedNotificationJobs,
  releaseNotificationOutboxClaim,
} from '../notificationOutboxStore.js';
import { getStripeCheckout, type StripeCheckoutCommerceContext } from './commerce.js';
import type { StripeCheckoutNotificationView } from './readModel.js';
import { enqueueStripeTerminalNotifications, stripeTerminalNotificationOutcome, type StripeTerminalNotificationOutcome } from './notificationOutboxState.js';

export type StripeTerminalNotificationStoreOptions = {
  dropId: string;
  sessionId: string;
  commerce: StripeCheckoutCommerceContext;
  signal: AbortSignal;
  initializeMissing?: boolean;
  nowMs?: () => number;
};

export type StripeCheckoutTerminalPublicationResult = {
  outcome: StripeTerminalNotificationOutcome | 'not_terminal' | 'invalid';
  publication: 'queued' | 'busy' | 'failed' | 'none';
  queuedJobs: number;
  reason?: string;
};

export type NotificationClaim = {
  record: NotificationOutboxRecord;
  checkout: StripeCheckoutNotificationView;
  parentVersion: number;
};

type ClaimResult = { claim: NotificationClaim } | { result: StripeCheckoutTerminalPublicationResult };

function skipped(
  outcome: StripeCheckoutTerminalPublicationResult['outcome'],
  publication: StripeCheckoutTerminalPublicationResult['publication'],
  reason?: string,
): StripeCheckoutTerminalPublicationResult {
  return { outcome, publication, queuedJobs: 0, ...(reason ? { reason } : {}) };
}

export async function claimStripeTerminalNotifications(args: StripeTerminalNotificationStoreOptions): Promise<ClaimResult> {
  args.signal.throwIfAborted();
  const key = commerceKeys.stripeCheckout(args.dropId, args.sessionId);
  const document = await getStripeCheckout(args.commerce.repository, key);
  if (!document) return { result: skipped('invalid', 'none', 'missing_checkout') };
  const outcome = stripeTerminalNotificationOutcome(document);
  if (!outcome) return { result: skipped('not_terminal', 'none') };
  let record = await args.commerce.repository.notificationOutbox.get(key.path, 'stripe_terminal');
  if (record && record.outcome !== outcome && record.state === 'pending') {
    await args.commerce.repository.notificationOutbox.compareAndSet({
      expected: record, parentVersion: document.version, nowMs: (args.nowMs || args.commerce.nowMs)(),
      changes: { state: 'cancelled', claimId: null, claimExpiresAtMs: null, nextAttemptAtMs: null,
        lastErrorCode: 'checkout-not-terminal', entries: record.entries.map(({ payload: _payload, ...entry }) => entry) },
    });
  }
  if (!record && args.initializeMissing) {
    await runCommerceTransaction(args.commerce, async (transaction) => {
      const current = await getStripeCheckout(transaction, key);
      if (!current || stripeTerminalNotificationOutcome(current) !== outcome) return;
      await enqueueStripeTerminalNotifications({
        transaction, key, before: current, outcome, deliveryId: current.notification.deliveryId,
        nowMs: (args.nowMs || args.commerce.nowMs)(), initializeMissing: true,
      });
    });
    record = await args.commerce.repository.notificationOutbox.get(key.path, 'stripe_terminal');
  }
  if (!record) return { result: skipped(outcome, 'none', 'missing_outbox') };
  if (record.outcome !== outcome || record.state === 'cancelled') {
    return { result: skipped(outcome, 'none', 'obsolete_outbox') };
  }
  if (record.state !== 'pending') return { result: skipped(outcome, record.state) };
  const result = await claimNotificationOutbox({
    repository: args.commerce.repository, parentPath: key.path, family: 'stripe_terminal',
    nowMs: args.nowMs || args.commerce.nowMs, signal: args.signal, parentVersion: document.version,
    initialRecord: record,
  });
  if (result.outcome !== 'claimed') return { result: skipped(outcome,
    result.outcome === 'none' ? result.record?.state === 'queued' ? 'queued' : 'none' : result.outcome,
    result.outcome === 'failed' ? result.record?.lastErrorCode || 'manual-review-required' : undefined) };
  return { claim: { record: result.claim, checkout: document.notification, parentVersion: document.version } };
}

function claimOptions(args: StripeTerminalNotificationStoreOptions, claim: NotificationClaim) {
  return { repository: args.commerce.repository, claim: claim.record, nowMs: args.nowMs || args.commerce.nowMs };
}

export async function persistStripeTerminalNotificationJobs(
  args: StripeTerminalNotificationStoreOptions,
  claim: NotificationClaim,
  jobs: NotificationEmailJobV1[],
): Promise<NotificationOutboxRecord | null> {
  const key = commerceKeys.stripeCheckout(args.dropId, args.sessionId);
  const current = await getStripeCheckout(args.commerce.repository, key);
  if (!current || stripeTerminalNotificationOutcome(current) !== claim.record.outcome) return null;
  return persistClaimedNotificationJobs({ ...claimOptions(args, claim), jobs, parentVersion: current.version, completeMissing: true });
}

export async function markStripeTerminalNotificationsQueued(
  args: StripeTerminalNotificationStoreOptions,
  claim: NotificationClaim,
  jobs: readonly NotificationEmailJobV1[],
): Promise<boolean> {
  if (!jobs.length) {
    const current = await args.commerce.repository.notificationOutbox.get(claim.record.parentPath, 'stripe_terminal');
    if (current?.generation !== claim.record.generation || current.state !== 'queued') return false;
    claim.record = current;
    return true;
  }
  const updated = await markClaimedNotificationQueued({ ...claimOptions(args, claim), jobs });
  if (updated) claim.record = updated;
  return Boolean(updated);
}

export async function releaseStripeTerminalNotificationClaim(
  args: StripeTerminalNotificationStoreOptions,
  claim: NotificationClaim,
): Promise<boolean> {
  const released = await releaseNotificationOutboxClaim(claimOptions(args, claim));
  if (released) claim.record = released;
  return Boolean(released);
}
