import { DatabaseSync } from 'node:sqlite';
import { readCommerceMigrations } from '../../scripts/shared/commerceMigrationReplay.ts';
import { runBootstrapCommerce } from '../../scripts/ops/bootstrapCommerce.ts';
import type { InventoryDropConfig } from '../../scripts/shared/dudeInventoryMaintenance.ts';

export const commerceTestNow = "CAST(strftime('%s', 'now') AS INTEGER) * 1000";
export const commerceTestConfig = { dropId: 'drop', dropFamily: 'poncho_drifella', itemsPerBox: 1, maxDudeId: 3 };

export function commerceTestQuery(database: DatabaseSync) {
  return (sql: string) => database.prepare(sql).all().map((row) => ({ ...row }));
}

export function commerceTestLease(database: DatabaseSync, operation: () => void): void {
  database.exec(`INSERT INTO commerce_authority_control_lease VALUES
    (1, '00000000-0000-4000-8000-000000001099', ${commerceTestNow}, ${commerceTestNow} + 60000)`);
  try { operation(); } finally { database.exec('DELETE FROM commerce_authority_control_lease'); }
}

export function createCurrentCommerceDatabase(context: { after: (cleanup: () => void) => void }, drained = true): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  context.after(() => database.close());
  database.exec('PRAGMA foreign_keys = ON; CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT)');
  for (const [index, migration] of readCommerceMigrations().entries()) {
    database.exec(migration.sql);
    database.prepare('INSERT INTO d1_migrations VALUES (?, ?)').run(index + 1, migration.name);
  }
  if (drained) commerceTestLease(database, () => database.exec(`UPDATE commerce_authority_control
    SET paused_at_ms = ${commerceTestNow}, updated_at_ms = ${commerceTestNow}`));
  return database;
}

export function bootstrapTestCommerce(database: DatabaseSync, configs: readonly InventoryDropConfig[] = [commerceTestConfig]) {
  const query = commerceTestQuery(database);
  return runBootstrapCommerce(['--expected-revision', String(query('SELECT revision FROM commerce_authority_control')[0].revision), '--write'], { query, configs });
}
