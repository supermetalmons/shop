import {
  shouldDisplayFulfillmentTrackingCode
} from '../../../shared/fulfillmentTracking';
import {
  DeliveryOrderSummary
} from '../../types';

function formatOrderStatus(status: string): string {
  const normalized = String(status || '').replace(/_/g, ' ').trim();
  if (!normalized) return 'Unknown';
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

export function formatOrderDate(order: DeliveryOrderSummary): string {
  const timestamp = order.processedAt ?? order.processingAt ?? order.createdAt;
  if (!timestamp) return 'Date pending';
  return new Date(timestamp).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' });
}

export function displayOrderStatus(order: DeliveryOrderSummary): string {
  const fulfillmentStatus = typeof order.fulfillmentStatus === 'string' ? order.fulfillmentStatus.trim() : '';
  if (fulfillmentStatus) return fulfillmentStatus;
  return formatOrderStatus(order.status === 'ready_to_ship' ? 'Preparing' : order.status);
}

export function shouldShowDeliveryTrackingCode(order: DeliveryOrderSummary): boolean {
  return shouldDisplayFulfillmentTrackingCode(order.fulfillmentStatus, order.fulfillmentTrackingCode);
}

export const ADMIN_OWNER_DOC_PAGE_SIZE = 200;

export const ADMIN_VIEWER_READ_ONLY_MESSAGE = 'Admin viewer mode is read-only.';
