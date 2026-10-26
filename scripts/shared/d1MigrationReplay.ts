import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type D1Migration = Readonly<{
  name: string;
  sql: string;
  checksum: string;
}>;

export function readD1Migrations(directory: string, label: string): D1Migration[] {
  const names = readdirSync(directory).filter((name) => name.endsWith('.sql')).sort();
  if (!names.length) throw new Error(`${label} migration directory is empty.`);
  return names.map((name, index) => {
    if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(name) || Number(name.slice(0, 4)) !== index + 1) {
      throw new Error(`${label} migrations must have consecutive versions: ${name}.`);
    }
    const sql = readFileSync(join(directory, name), 'utf8');
    return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  });
}

export function replayD1Migrations(
  migrations: readonly D1Migration[],
  afterMigration?: (database: DatabaseSync, migration: D1Migration, index: number) => void,
): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec('PRAGMA foreign_keys = ON');
    for (const [index, migration] of migrations.entries()) {
      database.exec('BEGIN');
      database.exec(migration.sql);
      database.exec('COMMIT');
      afterMigration?.(database, migration, index);
    }
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
