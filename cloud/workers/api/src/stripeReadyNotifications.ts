import {
  createReadyToShipNotificationJobs,
  planReadyToShipNotifications,
} from './readyToShipNotifications.js';
import { STRIPE_OFFCHAIN_DELIVERY_ORDER_SOURCE } from '../../../../shared/fulfillmentSources.js';
import {
  isNotificationEmailJobId,
  type NotificationEmailJobV1,
} from '../../../../shared/notificationEmailJob.js';

export async function createStripeReadyToShipNotificationJobs(args: {
  order: Record<string, unknown>;
  dropId: string;
  deliveryId: number;
  createJobId?: () => string;
  jobIds?: Partial<Record<'buyer_order_received' | 'shipper_ready_to_ship', string>>;
}): Promise<NotificationEmailJobV1[]> {
  if (args.order.source !== STRIPE_OFFCHAIN_DELIVERY_ORDER_SOURCE || args.order.status !== 'ready_to_ship') {
    return [];
  }
  const planned = planReadyToShipNotifications({
    before: {},
    after: args.order,
    deliveryId: args.deliveryId,
    dropId: args.dropId,
    createJobId: args.createJobId,
  });
  const pending = planned.map((marker) => {
    const jobId = args.jobIds?.[marker.kind];
    if (jobId === undefined) return marker;
    if (!isNotificationEmailJobId(jobId)) throw new Error('Stripe ready-to-ship notification job ID is invalid');
    return { ...marker, jobId };
  });
  return createReadyToShipNotificationJobs({
    order: args.order,
    dropId: args.dropId,
    deliveryId: args.deliveryId,
    pending,
  });
}
