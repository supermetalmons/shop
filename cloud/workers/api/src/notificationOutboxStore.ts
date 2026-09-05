import type {
  CommerceDocumentKey,
  CommerceDocumentRecord,
  CommerceDocumentWriteData,
  CommerceUnitOfWork,
} from './commerceRepository.js';
import {
  runCommerceTransaction,
  type CommerceConflictRetryOptions,
  type CommerceTransactionTarget,
} from './commerceTransactions.js';
import { planNotificationPublicationClaim } from './notificationOutboxPublication.js';

export type NotificationOutboxTarget = {
  context: CommerceTransactionTarget;
  key: CommerceDocumentKey;
  read?: (transaction: CommerceUnitOfWork) => Promise<CommerceDocumentRecord | null>;
  retry?: Omit<CommerceConflictRetryOptions, 'signal'>;
};

type NotificationPublicationLease = {
  claimId: string;
  attemptCount: number;
  previousAttemptCount: number;
  expiresAtMs: number;
  retryUntilMs: number;
};

export type NotificationOutboxClaim<State> = NotificationPublicationLease & {
  document: CommerceDocumentRecord;
  state: State;
};

type NotificationOutboxClaimResult<State, Skipped> =
  | { outcome: 'claimed'; claim: NotificationOutboxClaim<State> }
  | { outcome: 'skipped'; result: Skipped };

type OutboxMutation<Result> = {
  result: Result;
  values?: CommerceDocumentWriteData;
};

export type NotificationOutboxAdapter<State, Skipped> = {
  missing: Skipped;
  inspect: (document: CommerceDocumentRecord, nowMs: number) => OutboxMutation<Skipped> | {
    state: State;
    attemptCount: number | null;
    retryUntilMs: number | null;
    activeUntilMs: number | null;
  };
  busy: (state: State) => Skipped;
  exhausted: (state: State) => OutboxMutation<Skipped>;
  claim: (state: State, lease: NotificationPublicationLease) => {
    state: State;
    values: CommerceDocumentWriteData;
  };
};

async function mutateNotificationOutbox<Result>(
  target: NotificationOutboxTarget,
  mutate: (document: CommerceDocumentRecord | null) => OutboxMutation<Result>,
): Promise<Result> {
  return runCommerceTransaction(target.context, async (transaction) => {
    const document = await (target.read ? target.read(transaction) : transaction.get(target.key));
    const mutation = mutate(document);
    if (mutation.values && Object.keys(mutation.values).length) {
      await transaction.update(target.key, mutation.values);
    }
    return mutation.result;
  }, target.retry);
}

export async function claimNotificationOutbox<State, Skipped>(args: {
  target: NotificationOutboxTarget;
  adapter: NotificationOutboxAdapter<State, Skipped>;
  nowMs: () => number;
}): Promise<NotificationOutboxClaimResult<State, Skipped>> {
  return mutateNotificationOutbox<NotificationOutboxClaimResult<State, Skipped>>(args.target, (document) => {
    if (!document) return { result: { outcome: 'skipped', result: args.adapter.missing } };
    const nowMs = args.nowMs();
    const inspected = args.adapter.inspect(document, nowMs);
    if ('result' in inspected) {
      return { values: inspected.values, result: { outcome: 'skipped', result: inspected.result } };
    }
    const plan = planNotificationPublicationClaim({
      nowMs,
      attemptCount: inspected.attemptCount,
      retryUntilMs: inspected.retryUntilMs,
      activeUntilMs: inspected.activeUntilMs,
    });
    if (plan.outcome === 'busy') {
      return { result: { outcome: 'skipped', result: args.adapter.busy(inspected.state) } };
    }
    if (plan.outcome === 'exhausted') {
      const exhausted = args.adapter.exhausted(inspected.state);
      return { values: exhausted.values, result: { outcome: 'skipped', result: exhausted.result } };
    }
    const lease: NotificationPublicationLease = {
      claimId: crypto.randomUUID(),
      attemptCount: plan.attemptCount,
      previousAttemptCount: plan.attemptCount - 1,
      expiresAtMs: plan.expiresAtMs,
      retryUntilMs: plan.retryUntilMs,
    };
    const claimed = args.adapter.claim(inspected.state, lease);
    return {
      values: claimed.values,
      result: { outcome: 'claimed', claim: { ...lease, document, state: claimed.state } },
    };
  });
}

export function updateClaimedNotificationOutbox<State, Result>(args: {
  target: NotificationOutboxTarget;
  claimId: string;
  inspect: (document: CommerceDocumentRecord) => { claimId: unknown; state: State } | null;
  lost: () => Result;
  update: (state: State) => OutboxMutation<Result>;
}): Promise<Result> {
  return mutateNotificationOutbox(args.target, (document) => {
    const current = document && args.inspect(document);
    if (!document || !current || current.claimId !== args.claimId) return { result: args.lost() };
    return args.update(current.state);
  });
}
