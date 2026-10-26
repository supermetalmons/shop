import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { readD1Migrations, replayD1Migrations, type D1Migration } from './d1MigrationReplay.ts';

export const DEFAULT_COMMERCE_MIGRATIONS_DIRECTORY = fileURLToPath(
  new URL('../../cloud/workers/api/commerce-migrations/', import.meta.url),
);

export type CommerceMigration = D1Migration;

export function readCommerceMigrations(
  directory = DEFAULT_COMMERCE_MIGRATIONS_DIRECTORY,
): CommerceMigration[] {
  return readD1Migrations(directory, 'Commerce');
}

export function replayCommerceMigrations(
  migrations: readonly CommerceMigration[],
  afterMigration?: (database: DatabaseSync, migration: CommerceMigration, index: number) => void,
): DatabaseSync {
  return replayD1Migrations(migrations, afterMigration);
}
