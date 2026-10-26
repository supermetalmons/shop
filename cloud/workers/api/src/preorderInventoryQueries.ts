import { PREORDER_CONFIGS } from '../../../../shared/preorders.js';
import type { CommerceSqlQuery } from './commerceQueries.js';

const PREORDER_INVENTORY_COLUMNS = `preorder.preorder_id, preorder.status, preorder.confirmed_slot,
  (SELECT COALESCE(json_group_array(json_object('id', claim.card_id, 'address', json_extract(asset.value, '$.address'))), '[]')
    FROM json_each(preorder.assets_json) AS asset JOIN commerce_preorder_claims AS claim
      ON claim.order_id = preorder.order_id AND claim.cluster = preorder.cluster AND claim.collection = preorder.collection
        AND claim.card_id = json_extract(asset.value, '$.id')
    WHERE json_type(asset.value, '$.id') = 'integer' AND json_type(asset.value, '$.address') = 'text') AS assets_json`;

function preorderInventoryScope(): { sql: string; values: string[] } {
  const scopes = PREORDER_CONFIGS.filter(config => config.enabled);
  return {
    sql: scopes.map(() => '(preorder.preorder_id = ? AND preorder.cluster = ? AND preorder.collection = ?)').join(' OR ') || '0',
    values: scopes.flatMap(config => [config.preorderId, config.cluster, config.collection]),
  };
}

export function recentPreorderInventoryQuery(buyer: string): CommerceSqlQuery {
  const scope = preorderInventoryScope();
  return {
    sql: `SELECT ${PREORDER_INVENTORY_COLUMNS} FROM commerce_preorder_orders AS preorder
    WHERE (${scope.sql}) AND preorder.buyer = ? AND
      (preorder.status = 'succeeded' OR (preorder.status = 'submitted' AND preorder.confirmed_slot IS NOT NULL))
    ORDER BY preorder.created_at_ms DESC LIMIT 15`,
    bindings: [...scope.values, buyer],
  };
}

export function requestedPreorderInventoryQuery(buyer: string, expected: readonly string[]): CommerceSqlQuery {
  const scope = preorderInventoryScope();
  return {
    sql: `SELECT ${PREORDER_INVENTORY_COLUMNS}
      FROM commerce_preorder_orders AS preorder INDEXED BY sqlite_autoindex_commerce_preorder_orders_1
      WHERE (${scope.sql}) AND (preorder.status = 'succeeded' OR
        (preorder.buyer = ? AND preorder.status = 'submitted' AND preorder.confirmed_slot IS NOT NULL))
        AND preorder.order_id IN (
          SELECT lookup.order_id FROM json_each(?) AS expected
          CROSS JOIN commerce_preorder_asset_lookup AS lookup INDEXED BY commerce_preorder_asset_lookup_address
          WHERE lookup.asset_address = expected.value
        ) LIMIT 15`,
    bindings: [...scope.values, buyer, JSON.stringify(expected)],
  };
}
