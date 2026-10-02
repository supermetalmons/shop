import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCanonicalMiNoteTokenIds, MI_NOTE_CONTRACT_ADDRESSES } from '../../shared/miNoteCards.ts';
import {
  DEFAULT_COMMERCE_MIGRATIONS_DIRECTORY,
  readCommerceMigrations,
  replayCommerceMigrations,
} from './commerceMigrationReplay.ts';

type CatalogGenerationOptions = Readonly<{
  write?: boolean;
  catalogPath?: string;
  generatedPath?: string;
  migrationsDirectory?: string;
}>;

const LEGACY_PREORDER_CARD_IDS = [
  ...Array.from({ length: 1400 }, (_, index) => index + 1),
  ...Array.from({ length: 11 }, (_, index) => index + 1409),
];

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cardId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error('Catalog card IDs must be positive safe integers.');
  }
  return value;
}

function catalogCardIds(value: unknown): number[] {
  if (!record(value) || !Array.isArray(value.ethereumCollections) || !Array.isArray(value.specialCards)) {
    throw new Error('Invalid Mi Note catalog.');
  }
  const contracts = new Set<string>();
  const ids = new Set<number>();
  for (const collection of value.ethereumCollections) {
    if (!record(collection) || typeof collection.contractAddress !== 'string' || !Array.isArray(collection.tokens) ||
      !MI_NOTE_CONTRACT_ADDRESSES.some((address) => address === collection.contractAddress) ||
      contracts.has(collection.contractAddress)) {
      throw new Error('Catalog Ethereum collections must match the supported contracts exactly once.');
    }
    contracts.add(collection.contractAddress);
    const tokenIds = new Set<string>();
    for (const token of collection.tokens) {
      if (!record(token) || typeof token.id !== 'string' || !isCanonicalMiNoteTokenIds([token.id]) || tokenIds.has(token.id)) {
        throw new Error('Catalog Ethereum token IDs must be unique canonical decimal strings within uint256 per collection.');
      }
      tokenIds.add(token.id);
      const id = cardId(token.clean_card_id);
      if (ids.has(id)) throw new Error(`Duplicate catalog card ID: ${id}.`);
      ids.add(id);
    }
  }
  if (contracts.size !== MI_NOTE_CONTRACT_ADDRESSES.length || !ids.size) {
    throw new Error('Catalog must contain every supported Ethereum collection and preorder cards.');
  }
  const specialIds = new Set<number>();
  for (const special of value.specialCards) {
    if (!record(special)) throw new Error('Invalid special-card catalog entry.');
    const id = cardId(special.clean_card_id);
    if (specialIds.has(id)) throw new Error(`Duplicate special-card ID: ${id}.`);
    if (ids.has(id)) throw new Error(`Special card ${id} cannot be eligible for preorder.`);
    specialIds.add(id);
  }
  return [...ids].sort((left, right) => left - right);
}

function lines(values: readonly string[], perLine = 16): string {
  const result: string[] = [];
  for (let offset = 0; offset < values.length; offset += perLine) {
    result.push(`  ${values.slice(offset, offset + perLine).join(', ')}`);
  }
  return result.join(',\n');
}

function renderIds(ids: readonly number[]): string {
  return `export const PREORDER_CARD_IDS: readonly number[] = Object.freeze([\n${lines(ids.map(String))},\n]);\n`;
}

function insertCards(ids: readonly number[]): string {
  return `INSERT INTO commerce_preorder_cards (card_id) VALUES\n${lines(ids.map((id) => `(${id})`))};\n`;
}

function bootstrapSql(ids: readonly number[]): string {
  return `CREATE TABLE commerce_preorder_cards (
  card_id INTEGER PRIMARY KEY CHECK (card_id BETWEEN 1 AND 9007199254740991)
) STRICT;

${insertCards(ids)}
DROP TRIGGER commerce_preorder_expiry_claim_release;

CREATE TABLE commerce_preorder_claims_new (
  cluster TEXT NOT NULL,
  collection TEXT NOT NULL,
  card_id INTEGER NOT NULL REFERENCES commerce_preorder_cards(card_id),
  order_id TEXT NOT NULL REFERENCES commerce_preorder_orders(order_id),
  PRIMARY KEY (cluster, collection, card_id)
) STRICT;

INSERT INTO commerce_preorder_claims_new (cluster, collection, card_id, order_id)
SELECT cluster, collection, card_id, order_id FROM commerce_preorder_claims;

DROP TABLE commerce_preorder_claims;

ALTER TABLE commerce_preorder_claims_new RENAME TO commerce_preorder_claims;

CREATE INDEX commerce_preorder_claim_order ON commerce_preorder_claims (order_id);

CREATE TRIGGER commerce_preorder_claim_insert_guard BEFORE INSERT ON commerce_preorder_claims
BEGIN
  SELECT (CASE WHEN COALESCE((SELECT authority_state FROM commerce_authority_control WHERE singleton = 1), '') <> 'd1'
    THEN RAISE(ABORT, 'commerce authority is not d1') END);
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM commerce_preorder_orders AS orders, json_each(orders.card_ids_json) AS ids
    WHERE orders.order_id = NEW.order_id AND orders.status = 'prepared' AND
      orders.cluster = NEW.cluster AND orders.collection = NEW.collection AND ids.value = NEW.card_id
  ) THEN RAISE(ABORT, 'invalid preorder claim') END);
END;

CREATE TRIGGER commerce_preorder_claim_update_guard BEFORE UPDATE ON commerce_preorder_claims
BEGIN
  SELECT RAISE(ABORT, 'preorder claim is immutable');
END;

CREATE TRIGGER commerce_preorder_claim_delete_guard BEFORE DELETE ON commerce_preorder_claims
BEGIN
  SELECT (CASE WHEN COALESCE((SELECT authority_state FROM commerce_authority_control WHERE singleton = 1), '') <> 'd1'
    THEN RAISE(ABORT, 'commerce authority is not d1') END);
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM commerce_preorder_orders WHERE order_id = OLD.order_id AND status IN ('failed', 'expired', 'cancelled')
  ) THEN RAISE(ABORT, 'active or sold preorder claim is permanent') END);
END;

CREATE TRIGGER commerce_preorder_expiry_claim_release
AFTER UPDATE OF status ON commerce_preorder_orders
WHEN OLD.status = 'prepared' AND NEW.status = 'expired' AND NEW.signature IS NULL
BEGIN
  DELETE FROM commerce_preorder_claims WHERE order_id = NEW.order_id;
END;
`;
}

export function generatePreorderCatalog(options: CatalogGenerationOptions = {}): {
  cardCount: number;
  generatedChanged: boolean;
  migration: string | null;
} {
  const catalogPath = options.catalogPath ?? fileURLToPath(new URL('../../mi_note_cards.json', import.meta.url));
  const generatedPath = options.generatedPath ?? fileURLToPath(new URL('../../shared/preorderCardIds.generated.ts', import.meta.url));
  const migrationsDirectory = options.migrationsDirectory ?? DEFAULT_COMMERCE_MIGRATIONS_DIRECTORY;
  const ids = catalogCardIds(JSON.parse(readFileSync(catalogPath, 'utf8')));
  const source = renderIds(ids);
  const generatedChanged = !existsSync(generatedPath) || readFileSync(generatedPath, 'utf8') !== source;
  const migrations = readCommerceMigrations(migrationsDirectory);
  const database = replayCommerceMigrations(migrations);
  let sql: string | null = null;
  try {
    const hasCatalog = Boolean(database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'commerce_preorder_cards'").get());
    if (!hasCatalog && migrations.at(-1)?.name !== '0031_preorder_card_range_1419.sql') {
      throw new Error('Preorder catalog bootstrap requires the complete 0031 commerce baseline.');
    }
    const existing = hasCatalog
      ? database.prepare('SELECT card_id FROM commerce_preorder_cards ORDER BY card_id').all().map((row) => cardId(row.card_id))
      : LEGACY_PREORDER_CARD_IDS;
    const desired = new Set(ids);
    const removed = existing.filter((id) => !desired.has(id));
    if (removed.length) throw new Error(`Preorder catalog updates must be additive; removed card IDs: ${removed.join(', ')}.`);
    const existingIds = new Set(existing);
    const added = ids.filter((id) => !existingIds.has(id));
    sql = !hasCatalog ? bootstrapSql(ids) : added.length ? insertCards(added) : null;
    if (!options.write) {
      if (sql || generatedChanged) throw new Error('Generated preorder catalog is stale. Run npm run generate:preorder-catalog, then regenerate commerce schema manifests.');
      return { cardCount: ids.length, generatedChanged: false, migration: null };
    }
    if (sql) database.exec(sql);
    const actual = database.prepare('SELECT card_id FROM commerce_preorder_cards ORDER BY card_id').all().map((row) => row.card_id);
    if (JSON.stringify(actual) !== JSON.stringify(ids) || database.prepare('PRAGMA foreign_key_check').all().length) {
      throw new Error('Generated preorder catalog migration does not match the canonical catalog.');
    }
  } finally {
    database.close();
  }
  const migration = sql ? `${String(migrations.length + 1).padStart(4, '0')}_preorder_catalog.sql` : null;
  if (migration) writeFileSync(join(migrationsDirectory, migration), sql!, { flag: 'wx' });
  if (generatedChanged) writeFileSync(generatedPath, source);
  return { cardCount: ids.length, generatedChanged, migration };
}
