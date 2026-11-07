import { commerceD1AuditRows } from './commerceD1Audit.ts';
import { parseCommerceD1DocumentRow, sqlString, type CommerceD1Document, type CommerceD1Row } from './commerceD1Maintenance.ts';
import { inventoryOwnershipValidators, type InventoryDropConfig } from './dudeInventoryMaintenance.ts';

const DOCUMENT_COLUMNS = [
  'document_path', 'document_kind', 'drop_id', 'document_id', 'document_json',
  'version', 'create_time', 'update_time',
] as const;

function documentJson(alias: string): string {
  return `CASE WHEN ${alias}.document_path IS NOT NULL THEN json_object(${DOCUMENT_COLUMNS
    .map((column) => `'${column}', ${alias}.${column}`).join(', ')}) END`;
}

function joinedDocument(value: unknown): CommerceD1Document | null {
  if (value === null) return null;
  const row: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error('Commerce D1 inventory document is invalid.');
  }
  return parseCommerceD1DocumentRow(row as CommerceD1Row);
}

export function auditManifestInventory(query: (sql: string) => CommerceD1Row[], config: InventoryDropConfig): void {
  if (!config.inventoryManifest) return;
  const validators = inventoryOwnershipValidators(config);
  const invalidManifest = (): never => {
    throw new Error(`Available and assigned cards do not exactly match the inventory manifest for ${config.dropId}.`);
  };
  const validateMarker = (document: CommerceD1Document, boxDocument: CommerceD1Document | null, sqlOwner: unknown) => {
    const marker = validators.marker(document);
    if (sqlOwner !== marker.box) validators.invalid(`invalid figure marker ${document.path}.`);
    if (boxDocument) {
      if (boxDocument.documentId !== marker.box || !validators.box(boxDocument).includes(marker.id)) {
        validators.invalid(`figure ${marker.id} is absent from box ${marker.box}.`);
      }
    }
    return marker;
  };
  const dropId = sqlString(config.dropId);
  const markerPrefix = sqlString(`drops/${config.dropId}/dudeAssignments/`);
  const boxPrefix = sqlString(`drops/${config.dropId}/boxAssignments/`);
  const ids = config.inventoryManifest.cardIds;
  for (let offset = 0; offset < ids.length; offset += 100) {
    const page = ids.slice(offset, offset + 100);
    const rows = query(`SELECT expected.value AS manifest_id, expected.key + ${offset} AS manifest_position,
      available.dude_id AS available_id, available.pool_position,
      json_extract(marker.document_json, '$.boxAssetId') AS marker_box_asset_id,
      ${documentJson('marker')} AS marker_json, ${documentJson('box')} AS box_json
      FROM json_each(${sqlString(JSON.stringify(page))}) AS expected
      LEFT JOIN commerce_available_dudes AS available ON available.drop_id = ${dropId} AND available.dude_id = expected.value
      LEFT JOIN commerce_documents AS marker ON marker.document_path = ${markerPrefix} || expected.value
      LEFT JOIN commerce_documents AS box ON box.document_path = ${boxPrefix} || json_extract(marker.document_json, '$.boxAssetId')
      ORDER BY expected.key LIMIT 100`);
    if (!Array.isArray(rows) || rows.length !== page.length) invalidManifest();
    for (const [index, row] of rows.entries()) {
      if (!row || row.manifest_id !== page[index] || row.manifest_position !== offset + index) invalidManifest();
      const marker = joinedDocument(row.marker_json);
      if (row.available_id !== null) {
        if (row.available_id !== page[index] || row.pool_position !== offset + index || marker) invalidManifest();
      } else {
        if (!marker || validateMarker(marker, joinedDocument(row.box_json), row.marker_box_asset_id).id !== page[index]) invalidManifest();
      }
    }
  }
  for (const kind of ['box_assignment', 'dude_assignment', 'dude_pool']) {
    for (const row of commerceD1AuditRows(query, {
      table: 'commerce_documents', alias: 'document', keys: ['document_path'],
      where: `document.drop_id = ${dropId} AND document.document_kind = ${sqlString(kind)}`,
      columns: `${DOCUMENT_COLUMNS.map((column) => `document.${column}`).join(', ')},
        json_extract(document.document_json, '$.boxAssetId') AS marker_box_asset_id,
        ${documentJson('box')} AS box_json,
        (SELECT json_group_array(${documentJson('marker')}) FROM json_each(CASE
          WHEN document.document_kind = 'box_assignment'
            AND json_type(document.document_json, '$.dudeIds') = 'array'
            AND json_array_length(document.document_json, '$.dudeIds') = ${config.itemsPerBox}
          THEN document.document_json -> '$.dudeIds' ELSE '[]' END) AS item
          LEFT JOIN commerce_documents AS marker ON marker.document_path = ${markerPrefix} || CAST(CAST(item.value AS INTEGER) AS TEXT)) AS markers_json`,
      joins: `LEFT JOIN commerce_documents AS box ON document.document_kind = 'dude_assignment'
        AND box.document_path = ${boxPrefix} || json_extract(document.document_json, '$.boxAssetId')`,
    })) {
      const document = parseCommerceD1DocumentRow(row);
      if (document.kind === 'dude_assignment') validateMarker(document, joinedDocument(row.box_json), row.marker_box_asset_id);
      if (document.kind === 'box_assignment') {
        const assignedIds = validators.box(document);
        const markers: unknown = typeof row.markers_json === 'string' ? JSON.parse(row.markers_json) : null;
        if (!Array.isArray(markers) || markers.length !== assignedIds.length) {
          validators.invalid(`invalid box assignment ${document.path}.`);
        }
        const owners = new Map<number, string>();
        for (const value of markers as unknown[]) {
          const markerDocument = joinedDocument(value);
          if (markerDocument) {
            const marker = validators.marker(markerDocument);
            owners.set(marker.id, marker.box);
          }
        }
        for (const id of assignedIds) {
          if (owners.get(id) !== document.documentId) {
            validators.invalid(`box ${document.documentId} and figure ${id} disagree.`);
          }
        }
      }
    }
  }
}
