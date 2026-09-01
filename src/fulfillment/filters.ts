import { normalizeDropId } from '../config/deployment';
import {
  DEFAULT_FULFILLMENT_ORDER_VISIBILITY_FILTER,
  normalizeFulfillmentOrderVisibilityFilter,
  type FulfillmentOrderVisibilityFilter,
} from '../lib/fulfillmentOrderVisibility';

const FULFILLMENT_DROP_QUERY_PARAM = 'dropId';
const FULFILLMENT_STATUS_QUERY_PARAM = 'status';

export type FulfillmentFilters = {
  dropId: string;
  status: FulfillmentOrderVisibilityFilter;
};

type FulfillmentLocation = {
  pathname: string;
  search?: string;
  hash?: string;
};

export function parseFulfillmentFilters(search: string): FulfillmentFilters {
  const params = new URLSearchParams(search);
  return {
    dropId: normalizeDropId(params.get(FULFILLMENT_DROP_QUERY_PARAM) || ''),
    status:
      normalizeFulfillmentOrderVisibilityFilter(params.get(FULFILLMENT_STATUS_QUERY_PARAM)) ||
      DEFAULT_FULFILLMENT_ORDER_VISIBILITY_FILTER,
  };
}

export function buildFulfillmentFiltersHref(
  location: FulfillmentLocation,
  filters: FulfillmentFilters,
): string {
  const params = new URLSearchParams(location.search || '');
  const dropId = normalizeDropId(filters.dropId);

  if (dropId) params.set(FULFILLMENT_DROP_QUERY_PARAM, dropId);
  else params.delete(FULFILLMENT_DROP_QUERY_PARAM);

  if (filters.status === DEFAULT_FULFILLMENT_ORDER_VISIBILITY_FILTER) {
    params.delete(FULFILLMENT_STATUS_QUERY_PARAM);
  } else {
    params.set(FULFILLMENT_STATUS_QUERY_PARAM, filters.status);
  }

  const search = params.toString();
  return `${location.pathname}${search ? `?${search}` : ''}${location.hash || ''}`;
}
